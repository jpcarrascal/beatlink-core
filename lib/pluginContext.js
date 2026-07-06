// Plugin API (spec §6): five extension points. If an app behavior fits these
// hooks, it is app-specific and belongs in the app's plugin. If it can't be
// expressed here, that is the signal the core needs extending — upstream it.

function createPluginRegistry() {
    return {
        attributeDefaults: {},
        relayMap: {},
        handlers: new Map(),   // event -> [handler(socket, session, msg, ctx)]
        connectHooks: [],      // (socket, session, role, ctx)
        disconnectHooks: [],   // (socket, session, role, ctx)
        routes: [],            // { method, path, handler }
        activationGates: [],   // (session) => boolean — veto slot activation (§5.6)
        routedMessageTaps: [], // (socket, session, envelope, ctx) => boolean — veto delivery (§5.10)
        activateHooks: [],     // (session, { slot, socketID, initials }, ctx)
        releaseHooks: []       // (session, { slot, socketID, initials, reason }, ctx)
    };
}

function buildPluginContext(registry, runtime) {
    const { io, app, sessions, logger, config, turnTaking } = runtime;

    return {
        // --- the five extension points ---

        // 1. custom session state (applied as defaults on session creation)
        defineAttributes(defaults) {
            Object.assign(registry.attributeDefaults, defaults);
        },

        // 2. declarative passthrough (merged with the core relay map)
        relay(map) {
            Object.assign(registry.relayMap, map);
        },

        // 3. imperative event handlers with session context
        on(event, handler) {
            if (!registry.handlers.has(event)) {
                registry.handlers.set(event, []);
            }
            registry.handlers.get(event).push(handler);
        },

        // 4. custom HTTP routes / APIs
        route(method, path, handler) {
            registry.routes.push({ method: method.toLowerCase(), path, handler });
        },

        // 5. connect / disconnect hooks
        onConnect(hook) {
            registry.connectHooks.push(hook);
        },
        onDisconnect(hook) {
            registry.disconnectHooks.push(hook);
        },

        // --- module-scoped hooks (turn-taking §5.6, routed transport §5.10) ---

        // Veto participant activation/promotion; all gates must pass.
        // e.g. midi plugin: ctx.activationGate(s => hasUnassignedDevice(s))
        activationGate(gate) {
            registry.activationGates.push(gate);
        },

        // Observe every routed-message envelope before delivery; return
        // false to drop it (e.g. while a host takeover is active).
        onRoutedMessage(tap) {
            registry.routedMessageTaps.push(tap);
        },

        // Fired when a participant takes a slot — direct join AND queue
        // promotion (e.g. assign a device and push its state to the client).
        onActivate(hook) {
            registry.activateHooks.push(hook);
        },

        // Fired when a slot is freed; reason: 'disconnect' | 'evicted' | 'forced'.
        onRelease(hook) {
            registry.releaseHooks.push(hook);
        },

        // --- runtime surface available to handlers ---
        io,
        app,
        sessions,
        logger,
        config,
        turnTaking, // TurnTakingManager: tick, evict, tryPromote, forceAllToQueue, markActive, setDuration

        emitToSession(sessionName, event, msg) {
            io.to(sessionName).emit(event, msg);
        },

        emitToHost(session, event, msg) {
            if (session && session.hasHost()) {
                io.to(session.hostId).emit(event, msg);
            }
        },

        emitToRole(sessionName, role, event, msg) {
            io.to(`${sessionName}:${role}`).emit(event, msg);
        },

        // Guard for privileged (host-only) commands.
        requireHost(socket, session) {
            return Boolean(session && session.hostId === socket.id);
        }
    };
}

module.exports = { createPluginRegistry, buildPluginContext };
