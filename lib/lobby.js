// Lobby / Veil (spec §5.5): the synchronized-start mechanism. Participants
// joining while paused are held behind the veil; `session-play` releases
// everyone at once; `session-pause` re-veils. Late joiners while playing
// skip the Lobby (they immediately get veil-off).

function veilEventFor(session) {
    return session.isPlaying() ? 'veil-off' : 'veil-on';
}

// Emits the current veil state to a single joining client.
function emitVeilState(io, socketID, session) {
    io.to(socketID).emit(veilEventFor(session), { socketID });
}

// Host-only transport-lite controls. The full Transport module (tempo,
// startedAt, ticks — spec §5.7) builds on this in a later pass.
function wireHostLobbyControls(io, socket, sessionName, getSession, logger) {
    socket.on('session-play', () => {
        const session = getSession();
        if (!session || session.hostId !== socket.id) return;
        session.play();
        socket.broadcast.to(sessionName).emit('veil-off', {});
        io.to(sessionName).emit('session-mode', { isPlaying: true });
        logger.info(`#${sessionName} Veil OFF (play).`);
    });

    socket.on('session-pause', () => {
        const session = getSession();
        if (!session || session.hostId !== socket.id) return;
        session.pause();
        socket.broadcast.to(sessionName).emit('veil-on', {});
        io.to(sessionName).emit('session-mode', { isPlaying: false });
        logger.info(`#${sessionName} Veil ON (pause).`);
    });
}

module.exports = { veilEventFor, emitVeilState, wireHostLobbyControls };
