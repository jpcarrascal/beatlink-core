const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { createLogger } = require('./lib/logging');
const { SessionRegistry, SESSION_DEFAULTS } = require('./lib/sessions');
const { ROLES, parseHandshake } = require('./lib/roles');
const { wireRelays } = require('./lib/relay');
const { wireHostLobbyControls } = require('./lib/lobby');
const { TurnTakingManager } = require('./lib/turnTaking');
const { wireRoutedMessages } = require('./lib/routedMessages');
const { createPluginRegistry, buildPluginContext } = require('./lib/pluginContext');

function normalizeConfig(options = {}) {
    return {
        staticDir: options.staticDir || null,
        roles: options.roles || [...ROLES],
        session: { ...SESSION_DEFAULTS, ...(options.session || {}) },
        relay: options.relay || {},
        routedMessages: {
            enabled: false,
            defaultTarget: 'host',
            allowedTargets: ['host'],
            ...(options.routedMessages || {})
        },
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
    const turnTaking = new TurnTakingManager({ io, sessions, logger, registry });
    const ctx = buildPluginContext(registry, { io, app, sessions, logger, config, turnTaking });
    turnTaking.ctx = ctx;
    config.plugins.forEach(plugin => plugin(ctx));

    sessions.defineAttributeDefaults(registry.attributeDefaults);
    registry.routes.forEach(({ method, path, handler }) => app[method](path, handler));
    const relayMap = { ...config.relay, ...registry.relayMap };

    // --- session reaper (backstop GC, spec §4) ---
    sessions.onReap = (session) => {
        turnTaking.clearSession(session.name);
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
                participants: session.participants.snapshot(),
                queue: session.queue.snapshot()
            });

            wireHostLobbyControls(io, socket, sessionName, getSession, logger);

            // Queued users may become eligible when the session starts.
            socket.on('session-play', () => {
                const current = getSession();
                if (!current || current.hostId !== socket.id) return;
                turnTaking.tryPromote(sessionName);
            });

            // Rounds-mode increment (spec §5.6); apps whose loop runs on the
            // host emit this once per iteration.
            socket.on('turn-tick', () => {
                const current = getSession();
                if (!current || current.hostId !== socket.id) return;
                turnTaking.tick(sessionName);
            });

            socket.on('set-turn-duration', (msg) => {
                const current = getSession();
                if (!current || current.hostId !== socket.id) return;
                turnTaking.setDuration(sessionName, msg && msg.seconds);
            });

            // Explicit teardown — the deliberate destroy control (spec §4).
            socket.on('end-session', () => {
                const current = getSession();
                if (!current || current.hostId !== socket.id) return;
                turnTaking.clearSession(sessionName);
                io.to(sessionName).emit('session-ended', { reason: 'ended-by-host' });
                sessions.remove(sessionName);
                logger.info(`#${sessionName} ended by host.`);
            });

            socket.on('disconnect', () => {
                const current = getSession();
                if (!current || current.hostId !== socket.id) return;

                if (current.config.hostDisconnect === 'destroy') {
                    turnTaking.clearSession(sessionName);
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

            // Slot allocation, overflow queueing, eviction and promotion all
            // live in the turn-taking manager (spec §5.6).
            turnTaking.join(sessionName, session, socket, initials);

            socket.on('disconnect', () => {
                turnTaking.leave(sessionName, socket.id, initials);
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
                participants: session.participants.snapshot(),
                queue: session.queue.snapshot()
            });
        }

        // Latency primitive (spec §5.12).
        socket.on('ping', (msg) => {
            socket.emit('pong', msg);
        });

        // Any app activity counts as interaction for rounds-based eviction.
        const onActivity = () => {
            const session = getSession();
            if (!session) return;
            session.touch();
            turnTaking.markActive(session, socket.id);
        };

        wireRelays(io, socket, sessionName, relayMap, onActivity);

        if (config.routedMessages.enabled) {
            wireRoutedMessages(io, socket, sessionName, getSession, {
                config, registry, ctx, logger, onActivity
            });
        }

        for (const [event, handlers] of registry.handlers) {
            socket.on(event, (msg) => {
                onActivity();
                handlers.forEach(handler => handler(socket, getSession(), msg, ctx));
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
        turnTaking,
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
