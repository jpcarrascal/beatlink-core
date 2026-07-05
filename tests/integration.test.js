const Client = require('socket.io-client');
const { createServer } = require('../index');

// End-to-end contract tests over real sockets: host/participant/public roles,
// lobby veil, relay bus, plugin API, explicit teardown, preserve-on-disconnect.

const TEST_OPTIONS = {
    handleSignals: false,
    logging: { silent: true, file: false },
    session: { numParticipants: 2, allocation: 'sequential' },
    relay: { 'note-event': 'broadcast' }
};

function testPlugin(ctx) {
    ctx.defineAttributes({ pluginFlag: 'default' });
    ctx.relay({ 'plugin-relayed': 'broadcast' });
    ctx.on('custom-hello', (socket, session, msg) => {
        socket.emit('custom-reply', { echoed: msg.text, session: session ? session.name : null });
    });
    ctx.route('get', '/api/plugin-check', (req, res) => {
        res.json({ ok: true });
    });
}

describe('beatlink-core integration', () => {
    let server;
    let port;
    let clients = [];

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

    beforeAll((done) => {
        server = createServer({ ...TEST_OPTIONS, plugins: [testPlugin] });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterEach(() => {
        clients.forEach(socket => socket.connected && socket.disconnect());
        clients = [];
        server.sessions.all().forEach(session => server.sessions.remove(session.name));
    });

    afterAll(async () => {
        await server.close();
    });

    test('host connects and is accepted; duplicate host is rejected', async () => {
        const host = connect({ role: 'host', session: 'gig1' });
        const accepted = await waitFor(host, 'host-accepted');
        expect(accepted.session).toBe('gig1');
        expect(accepted.isPlaying).toBe(false);

        const impostor = connect({ role: 'host', session: 'gig1' });
        const rejection = await waitFor(impostor, 'host-exists');
        expect(rejection.reason).toContain('gig1');
    });

    test('participant joins, gets veiled while paused, unveiled on session-play', async () => {
        const host = connect({ role: 'host', session: 'gig2' });
        await waitFor(host, 'host-accepted');

        const participant = connect({ role: 'participant', session: 'gig2', initials: 'JP' });
        const [joined, veil] = await Promise.all([
            waitFor(host, 'participant-joined'),
            waitFor(participant, 'veil-on')
        ]);
        expect(joined).toMatchObject({ slot: 0, initials: 'JP' });
        expect(veil.socketID).toBeDefined();

        host.emit('session-play');
        await waitFor(participant, 'veil-off');

        // Late joiner while playing skips the Lobby.
        const late = connect({ role: 'participant', session: 'gig2', initials: 'LT' });
        await waitFor(late, 'veil-off');
    });

    test('participant joining a nonexistent session is turned away', async () => {
        const participant = connect({ role: 'participant', session: 'ghost-session' });
        const msg = await waitFor(participant, 'session-unavailable');
        expect(msg.reason).toBeDefined();
    });

    test('session-full when slots are exhausted', async () => {
        const host = connect({ role: 'host', session: 'gig3' });
        await waitFor(host, 'host-accepted');

        const p1 = connect({ role: 'participant', session: 'gig3', initials: 'P1' });
        await waitFor(p1, 'veil-on');
        const p2 = connect({ role: 'participant', session: 'gig3', initials: 'P2' });
        await waitFor(p2, 'veil-on');
        const p3 = connect({ role: 'participant', session: 'gig3', initials: 'P3' });
        await waitFor(p3, 'session-full');
    });

    test('public client receives a session snapshot', async () => {
        const host = connect({ role: 'host', session: 'gig4' });
        await waitFor(host, 'host-accepted');
        const participant = connect({ role: 'participant', session: 'gig4', initials: 'JP' });
        await waitFor(participant, 'veil-on');

        const display = connect({ role: 'public', session: 'gig4' });
        const snapshot = await waitFor(display, 'session-snapshot');
        expect(snapshot.session).toBe('gig4');
        expect(snapshot.participants).toEqual([
            expect.objectContaining({ slot: 0, initials: 'JP' })
        ]);
    });

    test('declarative relay broadcasts to everyone else in the session', async () => {
        const host = connect({ role: 'host', session: 'gig5' });
        await waitFor(host, 'host-accepted');
        const p1 = connect({ role: 'participant', session: 'gig5', initials: 'P1' });
        await waitFor(p1, 'veil-on');
        const p2 = connect({ role: 'participant', session: 'gig5', initials: 'P2' });
        await waitFor(p2, 'veil-on');

        p1.emit('note-event', { note: 60 });
        const [toHost, toPeer] = await Promise.all([
            waitFor(host, 'note-event'),
            waitFor(p2, 'note-event')
        ]);
        expect(toHost).toEqual({ note: 60 });
        expect(toPeer).toEqual({ note: 60 });
    });

    test('plugin: attributes, imperative handler, relay, and HTTP route', async () => {
        const host = connect({ role: 'host', session: 'gig6' });
        await waitFor(host, 'host-accepted');

        expect(server.sessions.get('gig6').getAttribute('pluginFlag')).toBe('default');

        host.emit('custom-hello', { text: 'hi' });
        const reply = await waitFor(host, 'custom-reply');
        expect(reply).toEqual({ echoed: 'hi', session: 'gig6' });

        const participant = connect({ role: 'participant', session: 'gig6', initials: 'JP' });
        await waitFor(participant, 'veil-on');
        host.emit('plugin-relayed', { x: 1 });
        expect(await waitFor(participant, 'plugin-relayed')).toEqual({ x: 1 });

        const response = await fetch(`http://localhost:${port}/api/plugin-check`);
        expect(await response.json()).toEqual({ ok: true });
    });

    test('ping/pong latency primitive', async () => {
        const host = connect({ role: 'host', session: 'gig7' });
        await waitFor(host, 'host-accepted');
        host.emit('ping', { t: 123 });
        expect(await waitFor(host, 'pong')).toEqual({ t: 123 });
    });

    test('explicit end-session tears down for everyone', async () => {
        const host = connect({ role: 'host', session: 'gig8' });
        await waitFor(host, 'host-accepted');
        const participant = connect({ role: 'participant', session: 'gig8', initials: 'JP' });
        await waitFor(participant, 'veil-on');

        host.emit('end-session');
        const ended = await waitFor(participant, 'session-ended');
        expect(ended.reason).toBe('ended-by-host');
        expect(server.sessions.has('gig8')).toBe(false);
    });

    test('host disconnect preserves the session; a new host reclaims it', async () => {
        const host = connect({ role: 'host', session: 'gig9' });
        await waitFor(host, 'host-accepted');
        const participant = connect({ role: 'participant', session: 'gig9', initials: 'JP' });
        await waitFor(participant, 'veil-on');

        host.disconnect();
        await new Promise(resolve => setTimeout(resolve, 100));

        const session = server.sessions.get('gig9');
        expect(session).not.toBeNull();
        expect(session.hasHost()).toBe(false);
        expect(session.participants.activeCount()).toBe(1); // participant survived

        const successor = connect({ role: 'host', session: 'gig9' });
        const accepted = await waitFor(successor, 'host-accepted');
        expect(accepted.participants).toEqual([
            expect.objectContaining({ initials: 'JP' })
        ]);
    });

    test('connection without a session name is rejected', async () => {
        const stray = connect({ role: 'participant' });
        const rejection = await waitFor(stray, 'connection-rejected');
        expect(rejection.reason).toBe('missing-session');
    });
});
