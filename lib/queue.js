// FIFO waiting queue for participants who can't take a slot yet (spec §5.6).
// Positions reported to clients are 1-based.
class WaitingQueue {
    constructor() {
        this.entries = [];
    }

    enqueue(socketID, initials) {
        const existing = this.positionOf(socketID);
        if (existing > 0) return existing;
        this.entries.push({ socketID, initials, queuedAt: Date.now() });
        return this.entries.length;
    }

    dequeue() {
        return this.entries.shift() || null;
    }

    peek() {
        return this.entries[0] || null;
    }

    prepend(entry) {
        if (entry) this.entries.unshift(entry);
    }

    remove(socketID) {
        const index = this.entries.findIndex(entry => entry.socketID === socketID);
        if (index >= 0) {
            this.entries.splice(index, 1);
            return true;
        }
        return false;
    }

    positionOf(socketID) {
        const index = this.entries.findIndex(entry => entry.socketID === socketID);
        return index >= 0 ? index + 1 : -1;
    }

    has(socketID) {
        return this.positionOf(socketID) > 0;
    }

    length() {
        return this.entries.length;
    }

    snapshot() {
        return this.entries.map(entry => ({ ...entry }));
    }

    nextInitials() {
        const next = this.peek();
        return next ? next.initials : null;
    }
}

module.exports = { WaitingQueue };
