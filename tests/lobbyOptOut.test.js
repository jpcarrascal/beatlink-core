const Client = require('socket.io-client');
const { createServer } = require('../index');

// Contract tests for `lobby: false` (spec §5.5, §7): apps that manage their
// own veil (dbass) must not get an automatic veil-on when participants join
// a session that isn't playing — on direct join or via the queue.

describe('lobby: false (app-managed veil)', () => {
    let server, port, clients = [];

    beforeAll((done) => {
        server = createServer({
            handleSignals: false,
            logging: { silent: true, file: false },
            lobby: false, // top-level form, as in spec §7
            session: {
                numParticipants: 1,
                allocation: 'sequential',
                turnTaking: { count: 'none', queue: true }
            },
            relay: { 'veil-on': 'broadcast' }
        });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        server.sessions.all().forEach(s => server.sessions.remove(s.name));
    });

    afterAll(async () => {
        await server.close();
    });

    function connect(query) {
        const socket = Client(`http://localhost:${port}`, {
            query, forceNew: true, transports: ['websocket']
        });
        clients.push(socket);
        return socket;
    }

    function waitFor(socket, event) {
        return new Promise(resolve => socket.once(event, resolve));
    }

    function collectVeilEvents(socket) {
        const seen = [];
        socket.on('veil-on', () => seen.push('veil-on'));
        socket.on('veil-off', () => seen.push('veil-off'));
        return seen;
    }

    test('top-level lobby:false lands in the session config', async () => {
        const host = connect({ role: 'host', session: 'l1' });
        await waitFor(host, 'host-accepted');
        expect(server.sessions.get('l1').config.lobby).toBe(false);
    });

    test('participant joining a paused session gets no automatic veil', async () => {
        const host = connect({ role: 'host', session: 'l2' });
        await waitFor(host, 'host-accepted');

        const joinedPromise = waitFor(host, 'participant-joined');
        const track = connect({ role: 'participant', session: 'l2', initials: 'A' });
        const seen = collectVeilEvents(track);
        await joinedPromise;
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(seen).toEqual([]);
    });

    test('queued participant gets queue-status but no automatic veil', async () => {
        const host = connect({ role: 'host', session: 'l3' });
        await waitFor(host, 'host-accepted');
        const first = connect({ role: 'participant', session: 'l3', initials: 'A' });
        await waitFor(host, 'participant-joined');

        const second = connect({ role: 'participant', session: 'l3', initials: 'B' });
        const seen = collectVeilEvents(second);
        await waitFor(second, 'queue-status');
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(seen).toEqual([]);
        expect(first.connected).toBe(true);
    });

    test('the app can still drive the veil explicitly (e.g. via a relay)', async () => {
        const host = connect({ role: 'host', session: 'l4' });
        await waitFor(host, 'host-accepted');
        const track = connect({ role: 'participant', session: 'l4', initials: 'A' });
        await waitFor(host, 'participant-joined');

        const veilPromise = waitFor(track, 'veil-on');
        host.emit('veil-on', { socketID: host.id });
        await veilPromise;
    });
});
