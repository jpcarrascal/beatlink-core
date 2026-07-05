const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { createLogger } = require('./lib/logging');
const { SessionRegistry, SESSION_DEFAULTS } = require('./lib/sessions');
const { ROLES, parseHandshake } = require('./lib/roles');
const { wireRelays } = require('./lib/relay');
const { emitVeilState, wireHostLobbyControls } = require('./lib/lobby');
const { createPluginRegistry, buildPluginContext } = require('./lib/pluginContext');

function normalizeConfig(options = {}) {
    return {
        staticDir: options.staticDir || null,
        roles: options.roles || [...ROLES],
        session: { ...SESSION_DEFAULTS, ...(options.session || {}) },
        relay: options.relay || {},
        logging: { label: 'beatlink', file: 'info.log', ...(options.logging || {}) },
        plugins: options.plugins || [],
        handleSignals: options.handleSignals !== false
    };
}

function createServer(options = {}) {
    const config = normalizeConfig(options);
    const logger = createLogger(config.logging);

    const app = express();
    const httpServer = http.createServer(app);
    const io = new Server(httpServer);
    const sessions = new SessionRegistry(config.session);

    if (config.staticDir) {
        app.use(express.static(config.staticDir));
    }

    // --- plugins ---
    const registry = createPluginRegistry();
    const ctx = buildPluginContext(registry, { io, app, sessions, logger, config });
    config.plugins.forEach(plugin => plugin(ctx));

    sessions.defineAttributeDefaults(registry.attributeDefaults);
    registry.routes.forEach(({ method, path, handler }) => app[method](path, handler));
    const relayMap = { ...config.relay, ...registry.relayMap };

    // --- session reaper (backstop GC, spec §4) ---
    sessions.onReap = (session) => {
        io.to(session.name).emit('session-ended', { reason: 'idle' });
        logger.info(`#${session.name} reaped (idle).`);
    };
    sessions.startReaper();

    io.on('connection', (socket) => {
        const parsed = parseHandshake(socket, config.roles);
        if (parsed.error) {
            socket.emit('connection-rejected', { reason: parsed.error });
            socket.disconnect(true);
            return;
        }
        const { role, sessionName, initials } = parsed;

        socket.join(sessionName);
        socket.join(`${sessionName}:${role}`);

        const getSession = () => sessions.get(sessionName);

        if (role === 'host') {
            const existing = getSession();
            if (existing && existing.hasHost()) {
                socket.emit('host-exists', {
                    reason: `Session '${sessionName}' already has a host. Choose a different name.`
                });
                logger.info(`#${sessionName} @HOST exists already.`);
                return;
            }

            const session = existing || sessions.create(sessionName);
            session.setHost(socket.id);
            logger.info(`#${sessionName} @HOST joined session.`);

            socket.emit('host-accepted', {
                session: sessionName,
                isPlaying: session.isPlaying(),
                participants: session.participants.snapshot()
            });

            wireHostLobbyControls(io, socket, sessionName, getSession, logger);

            // Explicit teardown — the deliberate destroy control (spec §4).
            socket.on('end-session', () => {
                const current = getSession();
                if (!current || current.hostId !== socket.id) return;
                io.to(sessionName).emit('session-ended', { reason: 'ended-by-host' });
                sessions.remove(sessionName);
                logger.info(`#${sessionName} ended by host.`);
            });

            socket.on('disconnect', () => {
                const current = getSession();
                if (!current || current.hostId !== socket.id) return;

                if (current.config.hostDisconnect === 'destroy') {
                    io.to(sessionName).emit('session-ended', { reason: 'host-disconnected' });
                    sessions.remove(sessionName);
                    logger.info(`#${sessionName} @HOST disconnected. Session destroyed.`);
                } else {
                    current.clearHost();
                    if (current.config.veilWhileHostAway) {
                        io.to(sessionName).emit('veil-on', { reason: 'host-away' });
                    }
                    logger.info(`#${sessionName} @HOST disconnected. Session preserved.`);
                }
            });
        } else if (role === 'participant') {
            const session = getSession();
            if (!session || !session.isReady()) {
                socket.emit('session-unavailable', {
                    reason: 'Session not available.'
                });
                return;
            }

            const slot = session.participants.allocate(socket.id, initials);
            if (slot === -1) {
                socket.emit('session-full', {
                    reason: 'No slots available right now.'
                });
                return;
            }
            session.touch();

            io.to(sessionName).emit('participant-joined', { slot, initials, socketID: socket.id });
            emitVeilState(io, socket.id, session);
            logger.info(`#${sessionName} @[${initials}] joined session on slot ${slot}.`);

            socket.on('disconnect', () => {
                const current = getSession();
                if (!current) return;
                const freed = current.participants.release(socket.id);
                if (freed >= 0) {
                    current.touch();
                    io.to(sessionName).emit('participant-left', { slot: freed, initials, socketID: socket.id });
                    logger.info(`#${sessionName} @[${initials}] (${socket.id}) disconnected, clearing slot ${freed}.`);
                }
            });
        } else { // public
            const session = getSession();
            if (!session || !session.isReady()) {
                socket.emit('session-unavailable', {
                    reason: 'Session not available.'
                });
                return;
            }

            socket.emit('session-snapshot', {
                session: sessionName,
                isPlaying: session.isPlaying(),
                participants: session.participants.snapshot()
            });
        }

        // Latency primitive (spec §5.12).
        socket.on('ping', (msg) => {
            socket.emit('pong', msg);
        });

        wireRelays(io, socket, sessionName, relayMap, () => {
            const session = getSession();
            if (session) session.touch();
        });

        for (const [event, handlers] of registry.handlers) {
            socket.on(event, (msg) => {
                const session = getSession();
                if (session) session.touch();
                handlers.forEach(handler => handler(socket, session, msg, ctx));
            });
        }

        registry.connectHooks.forEach(hook => hook(socket, getSession(), role, ctx));
        socket.on('disconnect', () => {
            registry.disconnectHooks.forEach(hook => hook(socket, getSession(), role, ctx));
        });
    });

    const server = {
        app,
        io,
        httpServer,
        sessions,
        logger,
        config,
        listen(port, callback) {
            httpServer.listen(port, () => {
                logger.info(`listening on *:${port}`);
                if (callback) callback();
            });
            return httpServer;
        },
        close() {
            sessions.stopReaper();
            return new Promise((resolve) => io.close(() => resolve()));
        }
    };

    if (config.handleSignals) {
        process.once('SIGINT', () => {
            logger.info('Bye!!!');
            server.close().then(() => process.exit(0));
        });
    }

    return server;
}

module.exports = { createServer, ROLES };
