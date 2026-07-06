const Client = require('socket.io-client');
const { createServer } = require('../index');
const { WaitingQueue } = require('../lib/queue');

// Contract tests for the unified eviction counter + waiting queue (spec §5.6):
// one mechanism, pluggable count source (time | rounds | none).

const BASE_OPTIONS = {
    handleSignals: false,
    logging: { silent: true, file: false }
};

describe('WaitingQueue (unit)', () => {
    test('enqueue returns 1-based position; re-enqueue is idempotent', () => {
        const queue = new WaitingQueue();
        expect(queue.enqueue('a', 'AA')).toBe(1);
        expect(queue.enqueue('b', 'BB')).toBe(2);
        expect(queue.enqueue('a', 'AA')).toBe(1); // already queued
        expect(queue.length()).toBe(2);
    });

    test('dequeue/peek/prepend/remove/positionOf', () => {
        const queue = new WaitingQueue();
        queue.enqueue('a', 'AA');
        queue.enqueue('b', 'BB');
        expect(queue.peek().socketID).toBe('a');
        const first = queue.dequeue();
        expect(first.socketID).toBe('a');
        queue.prepend(first);
        expect(queue.positionOf('a')).toBe(1);
        expect(queue.remove('b')).toBe(true);
        expect(queue.remove('ghost')).toBe(false);
        expect(queue.nextInitials()).toBe('AA');
    });
});

function makeSuite(name, serverOptions, plugins = []) {
    return { name, serverOptions, plugins };
}

function setupServer(options) {
    const server = createServer({ ...BASE_OPTIONS, ...options });
    return new Promise(resolve => {
        server.httpServer.listen(0, () => resolve(server));
    });
}

function connect(port, query, clients) {
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

// Collects events until one matches the predicate.
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

function expectNoEvent(socket, event, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, onEvent);
            resolve();
        }, ms);
        const onEvent = (msg) => {
            clearTimeout(timer);
            reject(new Error(`Unexpected '${event}': ${JSON.stringify(msg)}`));
        };
        socket.once(event, onEvent);
    });
}

describe('time-based eviction + queue', () => {
    let server, port, clients = [];

    beforeAll(async () => {
        server = await setupServer({
            session: {
                numParticipants: 1,
                allocation: 'sequential',
                turnTaking: { count: 'time', threshold: 0.15 }
            }
        });
        port = server.httpServer.address().port;
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        server.sessions.all().forEach(s => {
            server.turnTaking.clearSession(s.name);
            server.sessions.remove(s.name);
        });
    });

    afterAll(async () => {
        await server.close();
    });

    test('overflow joiner is queued with position; promoted when slot frees on disconnect', async () => {
        const host = connect(port, { role: 'host', session: 't1' }, clients);
        await waitFor(host, 'host-accepted');

        const p1 = connect(port, { role: 'participant', session: 't1', initials: 'P1' }, clients);
        await waitFor(p1, 'veil-on');

        const p2 = connect(port, { role: 'participant', session: 't1', initials: 'P2' }, clients);
        const status = await waitFor(p2, 'queue-status');
        expect(status.position).toBe(1);
        expect(status.total).toBe(1);

        const queueUpdate = await waitForMatch(host, 'queue-updated', msg => msg.length === 1);
        expect(queueUpdate.nextInitials).toBe('P2');

        p1.disconnect();
        const joined = await waitForMatch(host, 'participant-joined', msg => msg.initials === 'P2');
        expect(joined.slot).toBe(0);
    });

    test('slot expires, holder is moved to the line, next in line is promoted', async () => {
        const host = connect(port, { role: 'host', session: 't2' }, clients);
        await waitFor(host, 'host-accepted');

        const p1 = connect(port, { role: 'participant', session: 't2', initials: 'P1' }, clients);
        await waitFor(p1, 'veil-on');
        const p2 = connect(port, { role: 'participant', session: 't2', initials: 'P2' }, clients);
        await waitFor(p2, 'queue-status');

        // Register listeners before the eviction fires: its packets are
        // emitted in one synchronous burst and can arrive batched.
        const expiredPromise = waitFor(p1, 'slot-expired');
        const promotedPromise = waitForMatch(host, 'participant-joined', msg => msg.initials === 'P2');
        const requeuedPromise = waitForMatch(p1, 'queue-status', msg => msg.position === 1);

        const expired = await expiredPromise; // ~150ms
        expect(expired.reason).toContain('time is up');

        // P2 takes the slot; evicted P1 re-queues at position 1.
        await promotedPromise;
        const requeued = await requeuedPromise;
        expect(requeued.total).toBe(1);
    });

    test('host can update turn duration; active timers are re-armed', async () => {
        const host = connect(port, { role: 'host', session: 't3' }, clients);
        await waitFor(host, 'host-accepted');
        const p1 = connect(port, { role: 'participant', session: 't3', initials: 'P1' }, clients);
        await waitFor(p1, 'veil-on');

        host.emit('set-turn-duration', { seconds: 300 });
        const updated = await waitFor(host, 'turn-duration-updated');
        expect(updated.seconds).toBe(300);
        expect(server.sessions.get('t3').config.turnTaking.threshold).toBe(300);

        // Original 150ms timer must no longer fire.
        await expectNoEvent(p1, 'slot-expired', 300);
    });
});

describe('rounds-based eviction', () => {
    let server, port, clients = [];

    beforeAll(async () => {
        server = await setupServer({
            session: {
                numParticipants: 1,
                allocation: 'sequential',
                turnTaking: { count: 'rounds', threshold: 2 }
            },
            relay: { 'activity': 'broadcast' }
        });
        port = server.httpServer.address().port;
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        server.sessions.all().forEach(s => server.sessions.remove(s.name));
    });

    afterAll(async () => {
        await server.close();
    });

    test('rounds only count after the participant interacts; threshold evicts and re-queues', async () => {
        const host = connect(port, { role: 'host', session: 'r1' }, clients);
        await waitFor(host, 'host-accepted');
        const p1 = connect(port, { role: 'participant', session: 'r1', initials: 'P1' }, clients);
        await waitFor(p1, 'veil-on');

        // Idle participant: ticks must not evict.
        host.emit('turn-tick');
        host.emit('turn-tick');
        host.emit('turn-tick');
        await expectNoEvent(p1, 'slot-expired', 150);

        // Interaction (any relayed event) starts the counter.
        p1.emit('activity', {});
        await waitFor(host, 'activity');

        // Register listeners before the eviction fires: its packets are
        // emitted in one synchronous burst and can arrive batched.
        const expiredPromise = waitFor(p1, 'slot-expired');
        const statusPromise = waitForMatch(p1, 'queue-status', msg => msg.position === 1);

        host.emit('turn-tick'); // rounds: 1
        host.emit('turn-tick'); // rounds: 2
        host.emit('turn-tick'); // rounds: 3 > threshold 2 -> evict
        const expired = await expiredPromise;
        expect(expired.reason).toContain('turn is over');

        // Evicted participant lands back in the line.
        const status = await statusPromise;
        expect(status.total).toBe(1);
    });
});

describe('activation gates and plugin queue control', () => {
    let server, port, clients = [];

    beforeAll(async () => {
        const gatePlugin = (ctx) => {
            ctx.activationGate(session => session.getAttribute('gateOpen') === true);
        };
        server = await setupServer({
            session: {
                numParticipants: 2,
                allocation: 'sequential',
                turnTaking: { count: 'none', queue: true }
            },
            plugins: [gatePlugin]
        });
        port = server.httpServer.address().port;
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        server.sessions.all().forEach(s => server.sessions.remove(s.name));
    });

    afterAll(async () => {
        await server.close();
    });

    test('closed gate queues joiners; opening the gate + promote activates them', async () => {
        const host = connect(port, { role: 'host', session: 'g1' }, clients);
        await waitFor(host, 'host-accepted');

        const p1 = connect(port, { role: 'participant', session: 'g1', initials: 'P1' }, clients);
        const status = await waitFor(p1, 'queue-status'); // gate closed -> queued despite free slots
        expect(status.position).toBe(1);

        server.sessions.get('g1').setAttribute('gateOpen', true);
        server.turnTaking.tryPromote('g1');

        const joined = await waitForMatch(host, 'participant-joined', msg => msg.initials === 'P1');
        expect(joined.slot).toBe(0);
    });

    test('forceAllToQueue moves active participants back to the line (takeover primitive)', async () => {
        const host = connect(port, { role: 'host', session: 'g2' }, clients);
        await waitFor(host, 'host-accepted');
        server.sessions.get('g2').setAttribute('gateOpen', true);

        const p1 = connect(port, { role: 'participant', session: 'g2', initials: 'P1' }, clients);
        await waitFor(p1, 'veil-on');

        server.turnTaking.forceAllToQueue('g2', 'Host takeover.');
        const [left, status] = await Promise.all([
            waitFor(host, 'participant-left'),
            waitFor(p1, 'queue-status')
        ]);
        expect(left.initials).toBe('P1');
        expect(status.message).toBe('Host takeover.');
        expect(server.sessions.get('g2').participants.activeCount()).toBe(0);
        expect(server.sessions.get('g2').queue.length()).toBe(1);
    });
});

describe('queue disabled (count: none, default)', () => {
    let server, port, clients = [];

    beforeAll(async () => {
        server = await setupServer({
            session: { numParticipants: 1, allocation: 'sequential' }
        });
        port = server.httpServer.address().port;
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        server.sessions.all().forEach(s => server.sessions.remove(s.name));
    });

    afterAll(async () => {
        await server.close();
    });

    test('overflow still yields session-full, exactly as before', async () => {
        const host = connect(port, { role: 'host', session: 'n1' }, clients);
        await waitFor(host, 'host-accepted');
        const p1 = connect(port, { role: 'participant', session: 'n1', initials: 'P1' }, clients);
        await waitFor(p1, 'veil-on');
        const p2 = connect(port, { role: 'participant', session: 'n1', initials: 'P2' }, clients);
        const full = await waitFor(p2, 'session-full');
        expect(full.reason).toBeDefined();
    });
});
