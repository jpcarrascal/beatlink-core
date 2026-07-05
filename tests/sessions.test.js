const { Session, SessionRegistry } = require('../lib/sessions');

describe('Session', () => {
    test('starts with no host, not playing, ready when hostOptional', () => {
        const session = new Session('gig');
        expect(session.hasHost()).toBe(false);
        expect(session.isPlaying()).toBe(false);
        expect(session.isReady()).toBe(true); // hostOptional default true
    });

    test('requires host for readiness when hostOptional is false', () => {
        const session = new Session('gig', { hostOptional: false });
        expect(session.isReady()).toBe(false);
        session.setHost('sock-1');
        expect(session.isReady()).toBe(true);
        session.clearHost();
        expect(session.isReady()).toBe(false);
    });

    test('attribute bag get/set', () => {
        const session = new Session('gig');
        session.setAttribute('color', 'green');
        expect(session.getAttribute('color')).toBe('green');
        expect(session.getAttribute('missing')).toBeUndefined();
    });

    test('defineAttributes sets defaults without overwriting, deep-copies objects', () => {
        const session = new Session('gig');
        session.setAttribute('kept', 'original');
        const shared = { list: [1, 2] };
        session.defineAttributes({ kept: 'default', fresh: shared });
        expect(session.getAttribute('kept')).toBe('original');
        expect(session.getAttribute('fresh')).toEqual({ list: [1, 2] });
        expect(session.getAttribute('fresh')).not.toBe(shared); // cloned per session
    });

    test('play/pause toggles playing state and touches activity', () => {
        const session = new Session('gig');
        const before = session.lastActivityAt;
        session.play();
        expect(session.isPlaying()).toBe(true);
        session.pause();
        expect(session.isPlaying()).toBe(false);
        expect(session.lastActivityAt).toBeGreaterThanOrEqual(before);
    });
});

describe('SessionRegistry', () => {
    test('create/get/has/remove lifecycle', () => {
        const registry = new SessionRegistry();
        const session = registry.create('gig');
        expect(registry.get('gig')).toBe(session);
        expect(registry.has('gig')).toBe(true);
        registry.remove('gig');
        expect(registry.get('gig')).toBeNull();
    });

    test('create is idempotent for an existing name', () => {
        const registry = new SessionRegistry();
        const first = registry.create('gig');
        const second = registry.create('gig');
        expect(second).toBe(first);
    });

    test('applies plugin attribute defaults on creation', () => {
        const registry = new SessionRegistry();
        registry.defineAttributeDefaults({ devices: [] });
        const session = registry.create('gig');
        expect(session.getAttribute('devices')).toEqual([]);
    });

    describe('idle reaper (lenient backstop)', () => {
        const MINUTES = 60 * 1000;

        test('reaps a session idle past its window with no host and no participants', () => {
            const registry = new SessionRegistry({ idleReapMinutes: 30 });
            const session = registry.create('abandoned');
            const later = session.lastActivityAt + 31 * MINUTES;
            const reaped = registry.reapIdle(later);
            expect(reaped.map(s => s.name)).toEqual(['abandoned']);
            expect(registry.has('abandoned')).toBe(false);
        });

        test('never reaps within the idle window (create early, wait for audience)', () => {
            const registry = new SessionRegistry({ idleReapMinutes: 30 });
            const session = registry.create('preprovisioned');
            const soon = session.lastActivityAt + 29 * MINUTES;
            expect(registry.reapIdle(soon)).toEqual([]);
            expect(registry.has('preprovisioned')).toBe(true);
        });

        test('does not reap while a host is connected', () => {
            const registry = new SessionRegistry({ idleReapMinutes: 30 });
            const session = registry.create('hosted');
            session.setHost('sock-1');
            const later = session.lastActivityAt + 120 * MINUTES;
            expect(registry.reapIdle(later)).toEqual([]);
        });

        test('does not reap while participants are present', () => {
            const registry = new SessionRegistry({ idleReapMinutes: 30 });
            const session = registry.create('occupied');
            session.participants.allocate('sock-2', 'AB');
            const later = session.lastActivityAt + 120 * MINUTES;
            expect(registry.reapIdle(later)).toEqual([]);
        });

        test('activity resets the idle clock', () => {
            const registry = new SessionRegistry({ idleReapMinutes: 30 });
            const session = registry.create('active');
            session.touch();
            const justUnderWindow = session.lastActivityAt + 29 * MINUTES;
            expect(registry.reapIdle(justUnderWindow)).toEqual([]);
        });

        test('invokes onReap callback for reaped sessions', () => {
            const registry = new SessionRegistry({ idleReapMinutes: 30 });
            const session = registry.create('abandoned');
            const seen = [];
            registry.onReap = (s) => seen.push(s.name);
            registry.reapIdle(session.lastActivityAt + 31 * MINUTES);
            expect(seen).toEqual(['abandoned']);
        });
    });
});
