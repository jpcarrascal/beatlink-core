const Client = require('socket.io-client');
const { createServer } = require('../index');

// Contract tests for the protocol-neutral routed-message transport (spec §5.10):
// opaque envelopes with a `type` discriminator, stamped and routed by core;
// payload semantics (MIDI/OSC/UI) stay in plugins.

describe('routed-message transport', () => {
    let server, port, clients = [];
    const tapped = [];

    function tapPlugin(ctx) {
        ctx.onRoutedMessage((socket, session, envelope) => {
            tapped.push(envelope.type);
            if (envelope.type === 'BLOCKED') return false; // veto
        });
    }

    beforeAll((done) => {
        server = createServer({
            handleSignals: false,
            logging: { silent: true, file: false },
            session: { numParticipants: 4, allocation: 'sequential' },
            routedMessages: {
                enabled: true,
                defaultTarget: 'host',
                allowedTargets: ['host', 'public', 'broadcast']
            },
            plugins: [tapPlugin]
        });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        tapped.length = 0;
        server.sessions.all().forEach(s => server.sessions.remove(s.name));
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

    async function setupSession(name) {
        const host = connect({ role: 'host', session: name });
        await waitFor(host, 'host-accepted');
        const participant = connect({ role: 'participant', session: name, initials: 'JP' });
        await waitFor(participant, 'veil-on');
        return { host, participant };
    }

    test('participant envelope reaches the host, stamped with identity and timestamp', async () => {
        const { host, participant } = await setupSession('m1');

        participant.emit('routed-message', { type: 'MIDI', message: [0x90, 60, 100] });
        const envelope = await waitFor(host, 'routed-message');

        expect(envelope.type).toBe('MIDI');
        expect(envelope.message).toEqual([0x90, 60, 100]);
        expect(envelope.socketID).toBe(participant.id);
        expect(typeof envelope.timestamp).toBe('number');
        expect(envelope.source).toBe('participant');
    });

    test('client-supplied timestamp and source are preserved', async () => {
        const { host, participant } = await setupSession('m2');

        participant.emit('routed-message', { type: 'OSC', message: { addr: '/x' }, timestamp: 42, source: 'sensor' });
        const envelope = await waitFor(host, 'routed-message');
        expect(envelope.timestamp).toBe(42);
        expect(envelope.source).toBe('sensor');
    });

    test('envelope without a type is rejected', async () => {
        const { participant } = await setupSession('m3');

        participant.emit('routed-message', { message: [1, 2, 3] });
        const error = await waitFor(participant, 'routed-message-error');
        expect(error.reason).toBe('invalid-envelope');
    });

    test('target outside the allowlist is rejected', async () => {
        const { participant } = await setupSession('m4');

        participant.emit('routed-message', { type: 'UI', message: 1, target: 'session' });
        const error = await waitFor(participant, 'routed-message-error');
        expect(error).toEqual({ reason: 'invalid-target', target: 'session' });
    });

    test('a plugin tap can veto delivery', async () => {
        const { host, participant } = await setupSession('m5');

        participant.emit('routed-message', { type: 'BLOCKED', message: 'nope' });
        participant.emit('routed-message', { type: 'MIDI', message: [1] });

        // Socket.IO preserves per-connection ordering: if the MIDI envelope
        // arrived, the BLOCKED one (sent first) was definitively dropped.
        const envelope = await waitFor(host, 'routed-message');
        expect(envelope.type).toBe('MIDI');
        expect(tapped).toEqual(['BLOCKED', 'MIDI']); // tap saw both
    });

    test('broadcast target reaches peers but not the sender', async () => {
        const { host, participant } = await setupSession('m6');
        const peer = connect({ role: 'participant', session: 'm6', initials: 'PE' });
        await waitFor(peer, 'veil-on');

        let senderGotIt = false;
        participant.on('routed-message', () => { senderGotIt = true; });

        participant.emit('routed-message', { type: 'UI', message: 'flash', target: 'broadcast' });
        const [toPeer, toHost] = await Promise.all([
            waitFor(peer, 'routed-message'),
            waitFor(host, 'routed-message')
        ]);
        expect(toPeer.message).toBe('flash');
        expect(toHost.message).toBe('flash');
        expect(senderGotIt).toBe(false);
    });

    test('public target reaches only public displays', async () => {
        const { participant } = await setupSession('m7');
        const display = connect({ role: 'public', session: 'm7' });
        await waitFor(display, 'session-snapshot');

        participant.emit('routed-message', { type: 'UI', message: 'viz', target: 'public' });
        const envelope = await waitFor(display, 'routed-message');
        expect(envelope.message).toBe('viz');
    });
});
