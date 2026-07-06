class Participant {
    constructor(socketID, initials) {
        this.socketID = socketID;
        this.initials = initials;
        this.joinedAt = Date.now();
        // Turn-taking eviction state (spec §5.6); managed by TurnTakingManager.
        this.rounds = 0;
        this.countingRounds = false;
        this.expiresAt = null;
    }
}

// Fixed-capacity participant slots with pluggable allocation (spec §5.3).
class ParticipantSlots {
    constructor(capacity, allocation = 'random') {
        this.slots = new Array(capacity).fill(null);
        this.allocation = allocation;
    }

    allocate(socketID, initials) {
        const available = this.available();
        if (available.length === 0) return -1;

        let index;
        if (this.allocation === 'sequential') {
            index = available[0];
        } else {
            index = available[Math.floor(Math.random() * available.length)];
        }

        this.slots[index] = new Participant(socketID, initials);
        return index;
    }

    release(socketID) {
        const index = this.slotOf(socketID);
        if (index >= 0) {
            this.slots[index] = null;
        }
        return index;
    }

    releaseAll() {
        this.slots.fill(null);
    }

    slotOf(socketID) {
        return this.slots.findIndex(p => p && p.socketID === socketID);
    }

    get(index) {
        return this.slots[index] || null;
    }

    initialsOf(socketID) {
        const index = this.slotOf(socketID);
        return index >= 0 ? this.slots[index].initials : null;
    }

    available() {
        return this.slots
            .map((p, i) => (p ? -1 : i))
            .filter(i => i >= 0);
    }

    activeCount() {
        return this.slots.filter(Boolean).length;
    }

    activeEntries() {
        return this.slots
            .map((participant, slot) => participant ? { slot, participant } : null)
            .filter(Boolean);
    }

    snapshot() {
        return this.slots
            .map((p, slot) => p ? { slot, socketID: p.socketID, initials: p.initials } : null)
            .filter(Boolean);
    }
}

module.exports = { ParticipantSlots, Participant };
