const Client = require('socket.io-client');
const { createServer } = require('../index');

// Contract tests for onActivate/onRelease plugin hooks: fired on every slot
// change — direct join, queue promotion, disconnect, eviction, force-to-queue.

describe('onActivate / onRelease plugin hooks', () => {
    let server, port, clients = [];
    const events = [];

    function trackingPlugin(ctx) {
        ctx.onActivate((session, info) => {
            events.push({ kind: 'activate', session: session.name, slot: info.slot, initials: info.initials });
        });
        ctx.onRelease((session, info) => {
            events.push({ kind: 'release', session: session.name, slot: info.slot, initials: info.initials, reason: info.reason });
        });
    }

    beforeAll((done) => {
        server = createServer({
            handleSignals: false,
            logging: { silent: true, file: false },
            session: {
                numParticipants: 1,
                allocation: 'sequential',
                turnTaking: { count: 'time', threshold: 0.15 }
            },
            plugins: [trackingPlugin]
        });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        events.length = 0;
        server.sessions.all().forEach(s => {
            server.turnTaking.clearSession(s.name);
            server.sessions.remove(s.name);
        });
    });

    afterAll(async () => {
        await server.close();
    });

    function connect(query) {
        const socket = Client(`http://localhost:${port}`, {
            query,
            forceNew: true,
            transports: ['websocket']
        });
        clients.push(socket);
        return socket;
    }

    function waitFor(socket, event) {
        return new Promise(resolve => socket.once(event, resolve));
    }

    test('direct join activates; disconnect releases with reason', async () => {
        const host = connect({ role: 'host', session: 'h1' });
        await waitFor(host, 'host-accepted');

        const p1 = connect({ role: 'participant', session: 'h1', initials: 'P1' });
        await waitFor(p1, 'veil-on');
        expect(events).toEqual([
            { kind: 'activate', session: 'h1', slot: 0, initials: 'P1' }
        ]);

        const leftPromise = waitFor(host, 'participant-left');
        p1.disconnect();
        await leftPromise;
        expect(events[1]).toEqual(
            { kind: 'release', session: 'h1', slot: 0, initials: 'P1', reason: 'disconnect' }
        );
    });

    test('eviction releases with reason and promotion re-activates', async () => {
        const host = connect({ role: 'host', session: 'h2' });
        await waitFor(host, 'host-accepted');

        const p1 = connect({ role: 'participant', session: 'h2', initials: 'P1' });
        await waitFor(p1, 'veil-on');
        const p2 = connect({ role: 'participant', session: 'h2', initials: 'P2' });
        await waitFor(p2, 'queue-status');

        await waitFor(p1, 'slot-expired'); // ~150ms
        await waitFor(p2, 'veil-on');      // p2 promoted into the slot

        expect(events).toEqual([
            { kind: 'activate', session: 'h2', slot: 0, initials: 'P1' },
            { kind: 'release', session: 'h2', slot: 0, initials: 'P1', reason: 'evicted' },
            { kind: 'activate', session: 'h2', slot: 0, initials: 'P2' }
        ]);
    });

    test('forceAllToQueue releases with reason "forced"', async () => {
        const host = connect({ role: 'host', session: 'h3' });
        await waitFor(host, 'host-accepted');
        const p1 = connect({ role: 'participant', session: 'h3', initials: 'P1' });
        await waitFor(p1, 'veil-on');

        const statusPromise = waitFor(p1, 'queue-status');
        server.turnTaking.forceAllToQueue('h3');
        await statusPromise;

        expect(events[1]).toEqual(
            { kind: 'release', session: 'h3', slot: 0, initials: 'P1', reason: 'forced' }
        );
    });
});
