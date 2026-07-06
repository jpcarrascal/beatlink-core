const { emitVeilState } = require('./lobby');

// Turn-taking (spec §5.6): ONE mechanism — a per-participant eviction counter
// with a threshold — where the count source is pluggable:
//
//   turnTaking: { count: 'time',   threshold: 90 }  // seconds of wall-clock
//   turnTaking: { count: 'rounds', threshold: 16 }  // domain events (turn-tick)
//   turnTaking: { count: 'none' }                   // no eviction
//
// The waiting queue + promotion sits on top and is identical regardless of
// count source. Rounds only start counting once a participant has actually
// interacted (markActive), so idle joiners aren't evicted before playing.
//
// This manager owns participant join/leave, the queue, eviction timers and
// promotion. Plugins can veto activation via activation gates (e.g. "only
// activate when an unassigned device exists") and can call the manager
// through ctx.turnTaking (e.g. a takeover plugin using forceAllToQueue).
class TurnTakingManager {
    constructor({ io, sessions, logger, registry }) {
        this.io = io;
        this.sessions = sessions;
        this.logger = logger;
        this.registry = registry;
        this.timers = new Map(); // `${sessionName}:${slot}` -> timeout id
    }

    // --- join / leave -----------------------------------------------------

    join(sessionName, session, socket, initials) {
        const queueEnabled = session.queueEnabled();
        // Fairness: if people are already waiting, a newcomer goes behind
        // them even if a slot happens to be free.
        const backlog = queueEnabled && session.queue.length() > 0;

        if (!backlog && this.passesGates(session)) {
            const slot = session.participants.allocate(socket.id, initials);
            if (slot >= 0) {
                this.activate(sessionName, session, socket.id, slot, initials);
                return { joined: true, slot };
            }
        }

        if (!queueEnabled) {
            this.io.to(socket.id).emit('session-full', { reason: 'No slots available right now.' });
            return { joined: false };
        }

        const position = session.queue.enqueue(socket.id, initials);
        session.touch();
        this.io.to(socket.id).emit('queue-status', this.queueStatusPayload(session, position));
        emitVeilState(this.io, socket.id, session);
        this.emitQueueUpdates(sessionName, session);
        this.logger.info(`#${sessionName} @[${initials}] queued at position ${position}.`);
        return { joined: false, queued: true, position };
    }

    leave(sessionName, socketID, initials) {
        const session = this.sessions.get(sessionName);
        if (!session) return;

        const slot = session.participants.slotOf(socketID);
        if (slot >= 0) {
            this.clearTimer(sessionName, slot);
            session.participants.release(socketID);
            session.touch();
            this.io.to(sessionName).emit('participant-left', { slot, initials, socketID });
            this.logger.info(`#${sessionName} @[${initials}] (${socketID}) disconnected, clearing slot ${slot}.`);
            this.tryPromote(sessionName);
        }

        if (session.queue.remove(socketID)) {
            session.touch();
            this.emitQueueUpdates(sessionName, session);
            this.logger.info(`#${sessionName} @[${initials}] (${socketID}) left queue.`);
        }
    }

    // --- activation -------------------------------------------------------

    activate(sessionName, session, socketID, slot, initials) {
        session.touch();
        this.io.to(sessionName).emit('participant-joined', { slot, initials, socketID });
        emitVeilState(this.io, socketID, session);

        const turnTaking = session.config.turnTaking;
        const participant = session.participants.get(slot);
        if (participant) {
            participant.rounds = 0;
            participant.countingRounds = false;
            participant.expiresAt = null;
            if (turnTaking.count === 'time' && turnTaking.threshold > 0) {
                participant.expiresAt = Date.now() + turnTaking.threshold * 1000;
                this.scheduleExpiration(sessionName, slot, socketID, initials);
            }
        }

        this.emitQueueUpdates(sessionName, session);
        this.logger.info(`#${sessionName} @[${initials}] joined session on slot ${slot}.`);
    }

    passesGates(session) {
        return this.registry.activationGates.every(gate => gate(session) !== false);
    }

    // --- eviction ---------------------------------------------------------

    scheduleExpiration(sessionName, slot, socketID, initials) {
        this.clearTimer(sessionName, slot);
        const session = this.sessions.get(sessionName);
        const participant = session ? session.participants.get(slot) : null;
        if (!participant || !participant.expiresAt) return;

        const delayMs = Math.max(0, participant.expiresAt - Date.now());
        const timer = setTimeout(() => {
            const current = this.sessions.get(sessionName);
            if (!current) return;
            const occupant = current.participants.get(slot);
            if (!occupant || occupant.socketID !== socketID) return;
            this.clearTimer(sessionName, slot);
            this.evict(sessionName, current, socketID, 'Your time is up. You have been moved to the line.');
        }, delayMs);
        if (timer.unref) timer.unref();
        this.timers.set(`${sessionName}:${slot}`, timer);
    }

    evict(sessionName, session, socketID, reason) {
        const slot = session.participants.slotOf(socketID);
        if (slot < 0) return;
        const initials = session.participants.initialsOf(socketID);

        this.clearTimer(sessionName, slot);
        session.participants.release(socketID);
        session.touch();
        this.io.to(sessionName).emit('participant-left', { slot, initials, socketID });

        const socket = this.io.sockets.sockets.get(socketID);
        if (socket && socket.connected) {
            socket.emit('slot-expired', { reason });
            if (session.queueEnabled()) {
                session.queue.enqueue(socketID, initials);
            }
        }

        this.emitQueueUpdates(sessionName, session);
        // Exclude the just-evicted participant so they can't instantly
        // reclaim the slot ahead of others already waiting.
        this.tryPromote(sessionName, socketID);
        this.logger.info(`#${sessionName} @[${initials}] evicted from slot ${slot}.`);
    }

    // Rounds-mode increment; called by the host's `turn-tick` or by a plugin
    // via ctx.turnTaking.tick() on its own domain event (e.g. loop wrap).
    tick(sessionName) {
        const session = this.sessions.get(sessionName);
        if (!session) return;
        const turnTaking = session.config.turnTaking;
        if (turnTaking.count !== 'rounds') return;

        const expired = [];
        for (const { participant } of session.participants.activeEntries()) {
            if (!participant.countingRounds) continue;
            participant.rounds++;
            if (participant.rounds > turnTaking.threshold) {
                expired.push(participant.socketID);
            }
        }
        session.touch();
        expired.forEach(socketID =>
            this.evict(sessionName, session, socketID, 'Your turn is over. You have been moved to the line.')
        );
    }

    // A participant's rounds only count once they have interacted.
    markActive(session, socketID) {
        if (session.config.turnTaking.count !== 'rounds') return;
        const slot = session.participants.slotOf(socketID);
        if (slot >= 0) {
            session.participants.get(slot).countingRounds = true;
        }
    }

    // --- promotion --------------------------------------------------------

    tryPromote(sessionName, excludedSocketID = null) {
        const session = this.sessions.get(sessionName);
        if (!session || !session.queueEnabled()) return;

        const deferred = [];
        while (session.queue.length() > 0) {
            if (session.participants.available().length === 0) break;
            if (!this.passesGates(session)) break;

            const entry = session.queue.dequeue();
            if (!entry) break;

            if (excludedSocketID && entry.socketID === excludedSocketID) {
                deferred.push(entry);
                continue;
            }

            const socket = this.io.sockets.sockets.get(entry.socketID);
            if (!socket || !socket.connected) continue; // stale entry, drop

            const slot = session.participants.allocate(entry.socketID, entry.initials);
            if (slot < 0) {
                session.queue.prepend(entry);
                break;
            }
            this.activate(sessionName, session, entry.socketID, slot, entry.initials);
        }

        deferred.forEach(entry => session.queue.enqueue(entry.socketID, entry.initials));
        this.emitQueueUpdates(sessionName, session);
    }

    // Move every active participant back to the queue (e.g. host takeover).
    forceAllToQueue(sessionName, reason = 'Session is temporarily suspended by the host.') {
        const session = this.sessions.get(sessionName);
        if (!session) return;

        session.participants.snapshot().forEach(({ slot, socketID, initials }) => {
            this.clearTimer(sessionName, slot);
            session.participants.release(socketID);
            this.io.to(sessionName).emit('participant-left', { slot, initials, socketID });

            const socket = this.io.sockets.sockets.get(socketID);
            if (socket && socket.connected) {
                const position = session.queue.enqueue(socketID, initials);
                socket.emit('queue-status', {
                    ...this.queueStatusPayload(session, position),
                    message: reason
                });
            }
        });

        session.touch();
        this.emitQueueUpdates(sessionName, session);
        this.logger.info(`#${sessionName} all active participants forced to queue.`);
    }

    // --- host controls ----------------------------------------------------

    // Update the time-mode threshold and re-arm active timers.
    setDuration(sessionName, seconds) {
        const session = this.sessions.get(sessionName);
        if (!session) return;
        const parsed = Number(seconds);
        if (!Number.isFinite(parsed) || parsed <= 0) return;

        session.config.turnTaking.threshold = parsed;
        if (session.config.turnTaking.count === 'time') {
            for (const { slot, participant } of session.participants.activeEntries()) {
                participant.expiresAt = Date.now() + parsed * 1000;
                this.scheduleExpiration(sessionName, slot, participant.socketID, participant.initials);
            }
        }
        session.touch();
        this.io.to(sessionName).emit('turn-duration-updated', { seconds: parsed });
        this.logger.info(`#${sessionName} turn duration updated to ${parsed}s.`);
    }

    // --- queue notifications ----------------------------------------------

    queueStatusPayload(session, position) {
        return {
            position,
            total: session.queue.length(),
            message: `You are #${position} in line.`
        };
    }

    emitQueueUpdates(sessionName, session) {
        const stale = [];
        session.queue.snapshot().forEach((entry, index) => {
            const socket = this.io.sockets.sockets.get(entry.socketID);
            if (!socket || !socket.connected) {
                stale.push(entry.socketID);
                return;
            }
            socket.emit('queue-status', this.queueStatusPayload(session, index + 1));
        });
        stale.forEach(socketID => session.queue.remove(socketID));

        const payload = {
            queue: session.queue.snapshot(),
            length: session.queue.length(),
            activeSlots: session.participants.activeCount(),
            nextInitials: session.queue.nextInitials()
        };
        this.io.to(`${sessionName}:host`).emit('queue-updated', payload);
        this.io.to(`${sessionName}:public`).emit('queue-updated', payload);
    }

    // --- timers -----------------------------------------------------------

    clearTimer(sessionName, slot) {
        const key = `${sessionName}:${slot}`;
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
    }

    clearSession(sessionName) {
        for (const [key, timer] of this.timers.entries()) {
            if (key.startsWith(`${sessionName}:`)) {
                clearTimeout(timer);
                this.timers.delete(key);
            }
        }
    }
}

module.exports = { TurnTakingManager };
