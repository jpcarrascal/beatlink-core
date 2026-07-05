// Declarative relay bus (spec §5.9). Most app events are pure forwards;
// apps declare them instead of hand-writing handlers.
//
//   relay: {
//     'track data':  'broadcast',  // everyone else in the session
//     'ui-state':    'session',    // whole session including sender
//     'note-preview':'sender'      // echo back to sender only
//   }
const RELAY_MODES = ['broadcast', 'session', 'sender'];

function wireRelays(io, socket, sessionName, relayMap = {}, onEvent = null) {
    for (const [event, mode] of Object.entries(relayMap)) {
        if (!RELAY_MODES.includes(mode)) {
            throw new Error(`Unknown relay mode '${mode}' for event '${event}'`);
        }
        socket.on(event, (msg) => {
            if (mode === 'broadcast') {
                socket.broadcast.to(sessionName).emit(event, msg);
            } else if (mode === 'session') {
                io.to(sessionName).emit(event, msg);
            } else {
                io.to(socket.id).emit(event, msg);
            }
            if (onEvent) onEvent(event, msg);
        });
    }
}

module.exports = { wireRelays, RELAY_MODES };
