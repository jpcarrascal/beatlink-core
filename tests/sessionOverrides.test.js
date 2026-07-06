const Client = require('socket.io-client');
const { createServer } = require('../index');
const { SessionRegistry } = require('../lib/sessions');

describe('sessionOverrides + nested config merge', () => {
    test('create() merges nested module configs key-by-key', () => {
        const registry = new SessionRegistry({
            pattern: { enabled: true, tracks: 10, steps: 16 },
            transport: { enabled: true, defaultTempo: 98 }
        });
        const session = registry.create('gig', { pattern: { tracks: 12 } });
        // Partial override keeps registry settings (enabled stays true).
        expect(session.config.pattern).toMatchObject({ enabled: true, tracks: 12, steps: 16 });
        expect(session.pattern.tracks).toBe(12);
        expect(session.transport.tempo).toBe(98);
    });

    describe('host handshake drives per-session config', () => {
        let server, port, clients = [];

        beforeAll((done) => {
            server = createServer({
                handleSignals: false,
                logging: { silent: true, file: false },
                session: { numParticipants: 10, allocation: 'sequential' },
                pattern: { enabled: true, tracks: 10, steps: 16 },
                sessionOverrides: (socket) => {
                    const size = parseInt(socket.handshake.query.size, 10);
                    if (!Number.isFinite(size)) return {};
                    return { numParticipants: size, pattern: { tracks: size } };
                }
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

        test('session is sized from the host query parameter', async () => {
            const host = Client(`http://localhost:${port}`, {
                query: { role: 'host', session: 'sized', size: 4 },
                forceNew: true,
                transports: ['websocket']
            });
            clients.push(host);
            const snapshot = await new Promise(resolve => host.once('pattern-snapshot', resolve));
            expect(snapshot.tracks).toBe(4);
            const session = server.sessions.get('sized');
            expect(session.config.numParticipants).toBe(4);
            expect(session.config.pattern.enabled).toBe(true); // kept from registry config
        });
    });
});
