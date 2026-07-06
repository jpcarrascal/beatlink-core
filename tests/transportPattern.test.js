const Client = require('socket.io-client');
const { createServer } = require('../index');
const { Pattern } = require('../lib/pattern');

// Contract tests for Transport (§5.7) and Pattern (§5.8).

describe('Pattern (unit)', () => {
    test('setCell/getCell respect bounds', () => {
        const pattern = new Pattern(2, 4);
        expect(pattern.setCell(0, 0, { note: 60 })).toBe(true);
        expect(pattern.getCell(0, 0)).toEqual({ note: 60 });
        expect(pattern.setCell(2, 0, 'x')).toBe(false); // track out of range
        expect(pattern.setCell(0, 4, 'x')).toBe(false); // step out of range
        expect(pattern.setCell('0', 0, 'x')).toBe(false);
    });

    test('setRow pads/truncates to step count', () => {
        const pattern = new Pattern(1, 3);
        expect(pattern.setRow(0, ['a', 'b', 'c', 'd'])).toBe(true);
        expect(pattern.getRow(0)).toEqual(['a', 'b', 'c']);
        pattern.setRow(0, ['x']);
        expect(pattern.getRow(0)).toEqual(['x', null, null]);
    });

    test('clear(track) empties one row; clear() empties everything', () => {
        const pattern = new Pattern(2, 2);
        pattern.setRow(0, [1, 2]);
        pattern.setRow(1, [3, 4]);
        pattern.clear(0);
        expect(pattern.getRow(0)).toEqual([null, null]);
        expect(pattern.getRow(1)).toEqual([3, 4]);
        pattern.clear();
        expect(pattern.getRow(1)).toEqual([null, null]);
    });

    test('snapshot returns a deep copy', () => {
        const pattern = new Pattern(1, 2);
        pattern.setCell(0, 0, 'v');
        const snap = pattern.snapshot();
        snap.grid[0][0] = 'mutated';
        expect(pattern.getCell(0, 0)).toBe('v');
        expect(snap).toMatchObject({ tracks: 1, steps: 2 });
    });
});

describe('Transport + Pattern integration', () => {
    let server, port, clients = [];

    beforeAll((done) => {
        server = createServer({
            handleSignals: false,
            logging: { silent: true, file: false },
            session: { numParticipants: 3, allocation: 'sequential' },
            transport: { enabled: true, defaultTempo: 120 },
            pattern: { enabled: true, tracks: 3, steps: 4 }
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

    function waitForMatch(socket, event, predicate) {
        return new Promise(resolve => {
            const listener = (msg) => {
                if (predicate(msg)) {
                    socket.off(event, listener);
                    resolve(msg);
                }
            };
            socket.on(event, listener);
        });
    }

    test('joining clients receive transport state and pattern snapshot', async () => {
        const host = connect({ role: 'host', session: 'tp1' });
        const [state, snapshot] = await Promise.all([
            waitFor(host, 'transport-state'),
            waitFor(host, 'pattern-snapshot')
        ]);
        expect(state).toMatchObject({ isPlaying: false, tempo: 120, startedAt: null });
        expect(typeof state.serverTime).toBe('number');
        expect(snapshot).toMatchObject({ tracks: 3, steps: 4 });
        expect(snapshot.grid).toHaveLength(3);
    });

    test('host sets tempo; play/pause set and clear startedAt for everyone', async () => {
        const host = connect({ role: 'host', session: 'tp2' });
        await waitFor(host, 'transport-state');
        const p1 = connect({ role: 'participant', session: 'tp2', initials: 'P1' });
        await waitFor(p1, 'transport-state');

        const tempoPromise = waitForMatch(p1, 'transport-state', s => s.tempo === 140);
        host.emit('set-tempo', { tempo: 140 });
        await tempoPromise;

        const playPromise = waitForMatch(p1, 'transport-state', s => s.isPlaying);
        host.emit('session-play');
        const playing = await playPromise;
        expect(typeof playing.startedAt).toBe('number');

        const pausePromise = waitForMatch(p1, 'transport-state', s => !s.isPlaying);
        host.emit('session-pause');
        const paused = await pausePromise;
        expect(paused.startedAt).toBeNull();
    });

    test('invalid or non-host tempo changes are ignored', async () => {
        const host = connect({ role: 'host', session: 'tp3' });
        await waitFor(host, 'transport-state');
        const p1 = connect({ role: 'participant', session: 'tp3', initials: 'P1' });
        await waitFor(p1, 'transport-state');

        host.emit('set-tempo', { tempo: 'fast' });
        p1.emit('set-tempo', { tempo: 999 });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(server.sessions.get('tp3').transport.tempo).toBe(120);
    });

    test('participant writes its own row; supplied track is ignored', async () => {
        const host = connect({ role: 'host', session: 'tp4' });
        await waitFor(host, 'pattern-snapshot');
        const p1 = connect({ role: 'participant', session: 'tp4', initials: 'P1' }); // slot 0
        await waitFor(p1, 'pattern-snapshot');

        const updatePromise = waitFor(host, 'pattern-updated');
        p1.emit('pattern-update', { track: 2, step: 1, value: { note: 62 } }); // track 2 ignored
        const update = await updatePromise;
        expect(update).toMatchObject({ track: 0, step: 1, value: { note: 62 } });
        expect(server.sessions.get('tp4').pattern.getCell(0, 1)).toEqual({ note: 62 });
        expect(server.sessions.get('tp4').pattern.getCell(2, 1)).toBeNull();
    });

    test('host writes any row and can clear the whole grid', async () => {
        const host = connect({ role: 'host', session: 'tp5' });
        await waitFor(host, 'pattern-snapshot');
        const p1 = connect({ role: 'participant', session: 'tp5', initials: 'P1' });
        await waitFor(p1, 'pattern-snapshot');

        const rowPromise = waitFor(p1, 'pattern-row-updated');
        host.emit('pattern-row', { track: 2, values: [1, 2, 3, 4] });
        expect(await rowPromise).toMatchObject({ track: 2, values: [1, 2, 3, 4] });

        const clearPromise = waitFor(p1, 'pattern-cleared');
        host.emit('pattern-clear', {}); // no track -> clear all
        expect((await clearPromise).track).toBeNull();
        expect(server.sessions.get('tp5').pattern.getCell(2, 0)).toBeNull();
    });

    test('late joiner sees existing pattern state in its snapshot', async () => {
        const host = connect({ role: 'host', session: 'tp6' });
        await waitFor(host, 'pattern-snapshot');
        const ackPromise = waitFor(host, 'pattern-updated');
        host.emit('pattern-update', { track: 1, step: 2, value: 'late' });
        await ackPromise;

        const display = connect({ role: 'public', session: 'tp6' });
        const snapshot = await waitFor(display, 'pattern-snapshot');
        expect(snapshot.grid[1][2]).toBe('late');
    });

    test('a released slot clears its pattern row and notifies the session', async () => {
        const host = connect({ role: 'host', session: 'tp7' });
        await waitFor(host, 'pattern-snapshot');
        const p1 = connect({ role: 'participant', session: 'tp7', initials: 'P1' }); // slot 0
        await waitFor(p1, 'pattern-snapshot');

        const ackPromise = waitFor(host, 'pattern-updated');
        p1.emit('pattern-update', { step: 0, value: 'mine' });
        await ackPromise;

        const clearedPromise = waitForMatch(host, 'pattern-cleared', msg => msg.track === 0);
        p1.disconnect();
        await clearedPromise;
        expect(server.sessions.get('tp7').pattern.getCell(0, 0)).toBeNull();
    });
});
