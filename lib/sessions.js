const { ParticipantSlots } = require('./participants');
const { WaitingQueue } = require('./queue');
const { Pattern } = require('./pattern');

const SESSION_DEFAULTS = {
    numParticipants: 10,
    allocation: 'random',        // 'random' | 'sequential'
    hostDisconnect: 'preserve',  // 'preserve' | 'destroy'
    veilWhileHostAway: false,
    hostOptional: true,          // ready without a live host (spec §4)
    idleReapMinutes: 30,
    // Unified eviction counter (spec §5.6). `queue` defaults to enabled
    // whenever counting is active; set explicitly to override.
    turnTaking: { count: 'none', threshold: 0 },
    // Transport (spec §5.7): coordination signal, not sample-accurate sync.
    transport: { enabled: false, defaultTempo: 120 },
    // Pattern (spec §5.8): opaque tracks × steps shared grid.
    pattern: { enabled: false, tracks: 10, steps: 16, clearOnRelease: true }
};

class Session {
    constructor(name, config = {}) {
        this.name = name;
        this.config = { ...SESSION_DEFAULTS, ...config };
        this.config.turnTaking = { ...SESSION_DEFAULTS.turnTaking, ...(config.turnTaking || {}) };
        this.config.transport = { ...SESSION_DEFAULTS.transport, ...(config.transport || {}) };
        this.config.pattern = { ...SESSION_DEFAULTS.pattern, ...(config.pattern || {}) };
        this.participants = new ParticipantSlots(this.config.numParticipants, this.config.allocation);
        this.queue = new WaitingQueue();
        this.hostId = null;
        this.attributes = {};
        this.playing = false;
        this.createdAt = Date.now();
        this.lastActivityAt = Date.now();
        this.transport = this.config.transport.enabled
            ? { tempo: this.config.transport.defaultTempo, startedAt: null }
            : null;
        this.pattern = this.config.pattern.enabled
            ? new Pattern(this.config.pattern.tracks, this.config.pattern.steps)
            : null;
    }

    queueEnabled() {
        const turnTaking = this.config.turnTaking;
        return turnTaking.queue !== undefined
            ? Boolean(turnTaking.queue)
            : turnTaking.count !== 'none';
    }

    touch() {
        this.lastActivityAt = Date.now();
    }

    hasHost() {
        return Boolean(this.hostId);
    }

    setHost(socketID) {
        this.hostId = socketID;
        this.touch();
    }

    clearHost() {
        this.hostId = null;
        this.touch();
    }

    // A session is ready once created/provisioned; a live host connection is
    // not required unless the app opts out of hostOptional (spec §4).
    isReady() {
        return this.config.hostOptional ? true : this.hasHost();
    }

    play() {
        this.playing = true;
        if (this.transport && this.transport.startedAt === null) {
            this.transport.startedAt = Date.now();
        }
        this.touch();
    }

    pause() {
        this.playing = false;
        if (this.transport) {
            this.transport.startedAt = null;
        }
        this.touch();
    }

    isPlaying() {
        return this.playing;
    }

    // Coordination-grade shared clock (spec §5.7): clients schedule locally
    // against startedAt/tempo; the server never runs a playhead loop.
    getTransportState() {
        if (!this.transport) return null;
        return {
            isPlaying: this.playing,
            tempo: this.transport.tempo,
            startedAt: this.transport.startedAt,
            serverTime: Date.now()
        };
    }

    setTempo(tempo) {
        if (!this.transport) return false;
        const parsed = Number(tempo);
        if (!Number.isFinite(parsed) || parsed <= 0) return false;
        this.transport.tempo = parsed;
        this.touch();
        return true;
    }

    setAttribute(key, value) {
        this.attributes[key] = value;
        this.touch();
    }

    getAttribute(key) {
        return this.attributes[key];
    }

    // Plugin-declared attribute defaults; never overwrites existing values.
    defineAttributes(defaults) {
        for (const [key, value] of Object.entries(defaults)) {
            if (!(key in this.attributes)) {
                this.attributes[key] = (typeof value === 'object' && value !== null)
                    ? structuredClone(value)
                    : value;
            }
        }
    }
}

class SessionRegistry {
    constructor(config = {}) {
        this.config = { ...SESSION_DEFAULTS, ...config };
        this.sessions = new Map();
        this.attributeDefaults = {};
        this.onReap = null;
        this._reaper = null;
    }

    defineAttributeDefaults(defaults) {
        Object.assign(this.attributeDefaults, defaults);
    }

    create(name, overrides = {}) {
        if (this.sessions.has(name)) {
            return this.sessions.get(name);
        }
        const merged = { ...this.config, ...overrides };
        // Nested module configs merge key-by-key so a partial override
        // (e.g. { pattern: { tracks: 12 } }) keeps the registry's settings.
        for (const key of ['turnTaking', 'transport', 'pattern']) {
            if (overrides[key]) {
                merged[key] = { ...this.config[key], ...overrides[key] };
            }
        }
        const session = new Session(name, merged);
        session.defineAttributes(this.attributeDefaults);
        this.sessions.set(name, session);
        return session;
    }

    get(name) {
        return this.sessions.get(name) || null;
    }

    has(name) {
        return this.sessions.has(name);
    }

    remove(name) {
        return this.sessions.delete(name);
    }

    all() {
        return [...this.sessions.values()];
    }

    startReaper(intervalMs = 60000) {
        if (this._reaper) return;
        this._reaper = setInterval(() => this.reapIdle(), intervalMs);
        if (this._reaper.unref) this._reaper.unref();
    }

    stopReaper() {
        if (this._reaper) clearInterval(this._reaper);
        this._reaper = null;
    }

    // Backstop GC only (spec §4): a session is reaped after being idle —
    // no host AND no participants — for its full idle window. Any activity
    // (touch) resets the clock, so "create early, wait for the audience"
    // sessions are never killed prematurely.
    reapIdle(now = Date.now()) {
        const reaped = [];
        for (const [name, session] of this.sessions) {
            const unattended = !session.hasHost() && session.participants.activeCount() === 0;
            const maxIdleMs = session.config.idleReapMinutes * 60 * 1000;
            if (unattended && now - session.lastActivityAt > maxIdleMs) {
                this.sessions.delete(name);
                reaped.push(session);
            }
        }
        if (this.onReap) {
            reaped.forEach(session => this.onReap(session));
        }
        return reaped;
    }
}

module.exports = { Session, SessionRegistry, SESSION_DEFAULTS };
