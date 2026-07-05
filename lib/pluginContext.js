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
        routes: []             // { method, path, handler }
    };
}

function buildPluginContext(registry, runtime) {
    const { io, app, sessions, logger, config } = runtime;

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

        // --- runtime surface available to handlers ---
        io,
        app,
        sessions,
        logger,
        config,

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
