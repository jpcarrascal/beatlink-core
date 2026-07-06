// Routed-message transport (spec §5.10): protocol-neutral point-to-target
// delivery. A client emits an opaque envelope; core stamps and routes it.
// MIDI bytes, OSC bundles, or UI payloads ride it unchanged — payload
// *interpretation* lives in app plugins, never here.
//
// Inbound:  { type: 'MIDI'|'OSC'|'UI'|..., message: <payload>, target?, timestamp?, source? }
// Outbound: { type, message, socketID, timestamp, source }
//
// Plugins can observe (or veto, by returning false) every envelope via
// ctx.onRoutedMessage — e.g. maintaining CC runtime state, or dropping
// participant messages while a host takeover is active.
const TARGETS = ['host', 'public', 'session', 'broadcast'];

function wireRoutedMessages(io, socket, sessionName, getSession, { config, registry, ctx, logger, onActivity }) {
    const routing = config.routedMessages;

    socket.on('routed-message', (raw) => {
        const session = getSession();
        if (!session) return;

        if (!raw || typeof raw.type !== 'string' || raw.type.trim() === '' || !('message' in raw)) {
            socket.emit('routed-message-error', { reason: 'invalid-envelope' });
            return;
        }

        const target = raw.target || routing.defaultTarget;
        if (!TARGETS.includes(target) || !routing.allowedTargets.includes(target)) {
            socket.emit('routed-message-error', { reason: 'invalid-target', target });
            return;
        }

        const envelope = {
            type: raw.type,
            message: raw.message,
            socketID: socket.id,
            timestamp: raw.timestamp || Date.now(),
            source: raw.source || 'participant'
        };

        session.touch();
        if (onActivity) onActivity();

        for (const tap of registry.routedMessageTaps) {
            if (tap(socket, session, envelope, ctx) === false) return;
        }

        if (target === 'host') {
            if (session.hasHost()) io.to(session.hostId).emit('routed-message', envelope);
        } else if (target === 'public') {
            io.to(`${sessionName}:public`).emit('routed-message', envelope);
        } else if (target === 'session') {
            io.to(sessionName).emit('routed-message', envelope);
        } else {
            socket.broadcast.to(sessionName).emit('routed-message', envelope);
        }

        const initials = session.participants.initialsOf(socket.id) || 'UNKNOWN';
        logger.info(`#${sessionName} @[${initials}] routed ${envelope.type} message to ${target}.`);
    });
}

module.exports = { wireRoutedMessages, TARGETS };
