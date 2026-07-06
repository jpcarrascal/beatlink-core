const { createServer } = require('../index');

// The Pattern class doubles as a browser library served at
// /beatlink/pattern.js (socket.io-style client SDK).

describe('client SDK: /beatlink/pattern.js', () => {
    let server, port;

    beforeAll((done) => {
        server = createServer({
            handleSignals: false,
            logging: { silent: true, file: false }
        });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterAll(async () => {
        await server.close();
    });

    test('serves the Pattern source as JavaScript', async () => {
        const response = await fetch(`http://localhost:${port}/beatlink/pattern.js`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('javascript');
        const source = await response.text();
        expect(source).toContain('class Pattern');
    });

    test('evaluates in a browser-like environment and exposes window.beatlink.Pattern', async () => {
        const source = await (await fetch(`http://localhost:${port}/beatlink/pattern.js`)).text();

        // No `module` in scope, a `window` object present — like a <script> tag.
        const fakeWindow = {};
        new Function('window', source)(fakeWindow);

        expect(fakeWindow.beatlink).toBeDefined();
        const grid = new fakeWindow.beatlink.Pattern(2, 4);
        expect(grid.setCell(1, 3, { note: 60 })).toBe(true);
        expect(grid.snapshot().grid[1][3]).toEqual({ note: 60 });
    });
});
