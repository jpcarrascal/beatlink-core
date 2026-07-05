const { ParticipantSlots } = require('../lib/participants');

describe('ParticipantSlots', () => {
    test('sequential allocation fills slots in order', () => {
        const slots = new ParticipantSlots(3, 'sequential');
        expect(slots.allocate('a', 'AA')).toBe(0);
        expect(slots.allocate('b', 'BB')).toBe(1);
        expect(slots.allocate('c', 'CC')).toBe(2);
    });

    test('random allocation returns a valid free slot', () => {
        const slots = new ParticipantSlots(5, 'random');
        const index = slots.allocate('a', 'AA');
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(5);
        expect(slots.get(index).socketID).toBe('a');
    });

    test('returns -1 when full', () => {
        const slots = new ParticipantSlots(1, 'sequential');
        slots.allocate('a', 'AA');
        expect(slots.allocate('b', 'BB')).toBe(-1);
    });

    test('release frees the slot for reuse', () => {
        const slots = new ParticipantSlots(2, 'sequential');
        slots.allocate('a', 'AA');
        slots.allocate('b', 'BB');
        expect(slots.release('a')).toBe(0);
        expect(slots.activeCount()).toBe(1);
        expect(slots.allocate('c', 'CC')).toBe(0);
    });

    test('release of unknown socket returns -1 and changes nothing', () => {
        const slots = new ParticipantSlots(2, 'sequential');
        slots.allocate('a', 'AA');
        expect(slots.release('ghost')).toBe(-1);
        expect(slots.activeCount()).toBe(1);
    });

    test('lookups: slotOf, initialsOf, available, snapshot', () => {
        const slots = new ParticipantSlots(3, 'sequential');
        slots.allocate('a', 'AA');
        slots.allocate('b', 'BB');
        expect(slots.slotOf('b')).toBe(1);
        expect(slots.initialsOf('a')).toBe('AA');
        expect(slots.initialsOf('ghost')).toBeNull();
        expect(slots.available()).toEqual([2]);
        expect(slots.snapshot()).toEqual([
            { slot: 0, socketID: 'a', initials: 'AA' },
            { slot: 1, socketID: 'b', initials: 'BB' }
        ]);
    });

    test('releaseAll empties every slot', () => {
        const slots = new ParticipantSlots(3, 'sequential');
        slots.allocate('a', 'AA');
        slots.allocate('b', 'BB');
        slots.releaseAll();
        expect(slots.activeCount()).toBe(0);
        expect(slots.available()).toEqual([0, 1, 2]);
    });
});
