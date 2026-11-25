const Client = require('socket.io-client');
const { createServer } = require('../index');
const { latencyStats } = require('../lib/latencyStats');

describe('latency tool (spec §5.12)', () => {
    let server, port, clients = [];
    const onConnect = jest.fn();

    beforeAll((done) => {
        server = createServer({
            handleSignals: false,
            logging: { silent: true, file: false },
            plugins: [ctx => ctx.onConnect(onConnect)]
        });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterEach(() => {
        clients.forEach(s => s.disconnect());
        clients = [];
        onConnect.mockClear();
    });

    afterAll(() => server.close());

    function connect() {
        const socket = Client(`http://localhost:${port}/beatlink-latency`, {
            forceNew: true, transports: ['websocket']
        });
        clients.push(socket);
        return socket;
    }

    test('echoes with no session, touching neither sessions nor plugins', async () => {
        const socket = connect();
        const pong = new Promise(resolve => socket.once('pong', resolve));
        socket.emit('ping', 7);
        expect(await pong).toBe(7);
        expect(server.sessions.all()).toHaveLength(0);
        expect(onConnect).not.toHaveBeenCalled();
    });

    test('ignores anything but sequence numbers', async () => {
        const socket = connect();
        const received = [];
        const last = new Promise(resolve => socket.on('pong', (seq) => {
            received.push(seq);
            if (seq === 2) resolve();
        }));
        ['x', { a: 1 }, null, 1.5, 2].forEach(v => socket.emit('ping', v));
        await last;
        expect(received).toEqual([2]);
    });

    test('a main-namespace connection without a session is still rejected', async () => {
        const socket = Client(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] });
        clients.push(socket);
        const msg = await new Promise(resolve => socket.once('connection-rejected', resolve));
        expect(msg.reason).toBe('missing-session');
    });

    test('serves the page (cross-origin isolated) and its stats script', async () => {
        const page = await fetch(`http://localhost:${port}/latency`);
        expect(page.status).toBe(200);
        expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
        expect(page.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
        expect(await page.text()).toContain('/beatlink-latency');
        const script = await fetch(`http://localhost:${port}/beatlink/latency-stats.js`);
        expect(script.status).toBe(200);
    });

    test('statistics', () => {
        expect(latencyStats([])).toBeNull();
        expect(latencyStats([5])).toMatchObject({ min: 5, max: 5, median: 5, p95: 5, jitter: 0 });
        expect(latencyStats([4, 1, 3, 2])).toEqual({
            count: 4, min: 1, max: 4, mean: 2.5, median: 2.5, p95: 4, jitter: 2
        });
        const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(latencyStats(hundred)).toMatchObject({ p95: 95, jitter: 1 });
    });
});
