# BeatLink Manual

**How to build (and migrate) collaborative music/sound apps on beatlink-core.**

This is the practitioner's guide. For architecture rationale and design decisions, see
[BEATLINK-SPEC.md](BEATLINK-SPEC.md). Everything here is distilled from the four apps
already running on the framework — `chaotic-pedalboard`, `count-me-in`, `dbass`, and
`HootBeat/audience-control` — whose plugins double as reference implementations (§9).

---

## 1. Mental model

A BeatLink app is three things:

1. **A thin server entrypoint** (~50 lines): `createServer(config)` + your HTML routes +
   static mounts. It contains *no* session, role, queue, or realtime logic.
2. **A plugin** (`server/<app>Plugin.js`): everything app-specific on the server —
   custom events, custom session state, HTTP endpoints — written against the plugin API (§7).
3. **Browser clients** that connect with an explicit role handshake (§8).

Core owns: sessions and their lifecycle, the three roles, the Lobby/Veil, turn-taking and
the waiting queue, the shared clock (Transport), the shared grid (Pattern), the
protocol-neutral message transport, resource catalogs, QR generation, logging, and ping.

**The boundary rule (memorize this one):** if a behavior fits the plugin API, it is
app-specific and lives in your plugin. If you cannot express it there, that is the signal
it's a general improvement — extend beatlink-core (with contract tests) instead of working
around it in the app. Both directions of this rule were used repeatedly during the
migrations (`onActivate`/`onRelease` and `sessionOverrides` exist because ports needed them).

### Consumption model

Apps declare core as a git dependency tracking `main`:

```json
"dependencies": { "beatlink-core": "github:jpcarrascal/beatlink-core#main" }
```

There is no version pinning ceremony. The safety net is core's contract test suite
(75+ tests) plus CI on every push — a core change that breaks the contract doesn't land.
Refresh an app with `npm update beatlink-core`.

---

## 2. Quickstart: a new app in five files

```
my-app/
├── index.js               # entrypoint (below)
├── server/myPlugin.js     # app logic (see §7)
├── html/…                 # your pages
├── scripts/…              # your client js
└── package.json           # beatlink-core + express; engines node >=24
```

```js
// index.js
const path = require('path');
const express = require('express');
const { createServer } = require('beatlink-core');
const myPlugin = require('./server/myPlugin.js');

const server = createServer({
    roles: ['host', 'public', 'participant'],
    session: { numParticipants: 10 },
    plugins: [myPlugin],
    logging: { label: 'my-app' }
});

const { app } = server;
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'html/index.html')));
app.use('/scripts', express.static(path.join(__dirname, 'scripts')));

if (require.main === module) {
    server.listen(process.env.PORT || 3000);
}
module.exports = { server };   // <- lets tests boot the app in-process
```

```js
// browser
const socket = io({ query: { role: 'participant', session: 'gig', initials: 'JP' } });
```

The `require.main` guard + `module.exports = { server }` pattern is what makes the
integration-test harness (§10) work — don't skip it.

---

## 3. Configuration reference

All `createServer(options)` keys, with defaults:

```js
createServer({
  staticDir: null,                    // optional: one static root served at /
  roles: ['host','public','participant'], // roles this app accepts

  session: {                          // per-session defaults
    numParticipants: 10,              // participant slot count
    allocation: 'random',             // 'random' | 'sequential'
    hostDisconnect: 'preserve',       // 'preserve' | 'destroy'  (mutable at runtime, §9.3)
    veilWhileHostAway: false,         // veil participants while host is gone
    hostOptional: true,               // session is 'ready' without a live host
    idleReapMinutes: 30,              // GC: reap after this long with no host AND no participants
    turnTaking: {
      count: 'none',                  // 'none' | 'time' | 'rounds'
      threshold: 0,                   // seconds (time) or loops (rounds)
      // queue: true|false            // default: enabled iff count !== 'none'
    },
    transport: { enabled: false, defaultTempo: 120 },
    pattern:   { enabled: false, tracks: 10, steps: 16, clearOnRelease: true },
  },

  // Called when a host CREATES a session; returns per-session config overrides.
  // Nested module configs (turnTaking/transport/pattern) merge key-by-key.
  sessionOverrides: (socket) => ({ /* e.g. numParticipants from a handshake param */ }),

  relay: { 'my-event': 'broadcast' }, // declarative passthrough: 'broadcast'|'session'|'sender'

  routedMessages: {                   // protocol-neutral typed envelopes (§6.5)
    enabled: false,
    defaultTarget: 'host',
    allowedTargets: ['host'],         // subset of 'host'|'public'|'session'|'broadcast'
  },

  resources: {                        // declarative asset catalogs (§6.6)
    sounds: { dir: './sounds', ext: ['.mp3','.wav'], group: 'subdirs',
              uploadable: false, maxUploadBytes: 10485760 },
  },

  logging: { label: 'beatlink', file: 'info.log', silent: false },
  plugins: [],
  handleSignals: true,                // SIGINT handler; set false in tests
})
```

`createServer` returns `{ app, io, httpServer, sessions, turnTaking, logger, config,
listen(port, cb), close() }`.

---

## 4. Roles

| Role | Cardinality | Authority | Typical surface |
|---|---|---|---|
| `host` | 0..1 per session | **all of it** | organizer console / band sequencer / routing matrix |
| `public` | 0..n | none (read-mostly) | projections, QR screens, dashboards, admin views |
| `participant` | 0..n (slot-bounded) | own slot only | the audience's phones |

- Role is declared in the handshake (`query.role`); missing role defaults to
  `participant`; an invalid/disabled role gets `connection-rejected`.
- Only a **host** connection creates a session. A second host gets `host-exists` but
  stays in the room as a passive observer and receives `transport-state` +
  `pattern-snapshot` — this is how **secondary display sequencers** work (count-me-in).
- Privileged core commands (`session-play/pause`, `end-session`, `set-tempo`,
  `set-turn-duration`, `turn-tick`) are host-only, enforced server-side. In plugins, guard
  your own privileged events with `ctx.requireHost(socket, session)`.
- **An "admin" is not a fourth role.** The pattern (count-me-in): connect as `public`
  with an extra handshake flag (`admin: "true"`), have the plugin check
  `socket.handshake.query.admin` and join an `admin:<session>` room. See §9.2.
- `host-accepted` delivers a per-session **`hostToken`** — proof of host identity for
  non-socket surfaces (currently: resource uploads).

## 5. Session lifecycle

- **Created** by the first host connection (with `sessionOverrides` applied).
- **Ready** immediately if `hostOptional: true` (default); otherwise only while a host is
  connected. Participants/public joining a non-ready session get `session-unavailable` —
  **clients must handle this** (usually: show a message, retry; see §8).
- **Host disconnect** → `preserve` (default): everything survives, a reconnecting host
  reclaims the session (and gets current participants/queue in `host-accepted`).
  With `destroy`: `session-ended` to everyone and the session is gone.
  Plugins may flip `session.config.hostDisconnect` at runtime (dbass's keep-alive checkbox).
- **Explicit teardown**: host emits `end-session` → `session-ended {reason:'ended-by-host'}`.
  This is the deliberate "clear a fixed-name session" control (e.g. baked-in-QR sessions).
- **Reaper**: sessions idle past `idleReapMinutes` with no host and no participants are
  GC'd (`session-ended {reason:'idle'}`). Any activity resets the clock, so "create early,
  wait for the audience" is safe.

---

## 6. Core modules

### 6.1 Lobby / Veil
Participants joining a paused session receive `veil-on`; `session-play` broadcasts
`veil-off` to everyone at once (the synchronized start); late joiners while playing skip
the lobby. `session-mode {isPlaying}` accompanies changes. Apps that manage their own veil
(dbass) simply don't emit `session-play/pause` and relay their own `veil-*` events instead.

### 6.2 Turn-taking + queue
One mechanism, pluggable count source:

- `count:'time'` — slot expires `threshold` seconds after activation. Host can retune live
  with `set-turn-duration {seconds}` (re-arms active timers; `turn-duration-updated`).
- `count:'rounds'` — the host (or plugin) emits `turn-tick` once per app loop; a
  participant's counter only starts after their **first interaction** (any relay/plugin/
  routed/pattern event), so idle joiners aren't evicted before playing.
- Eviction: `slot-expired {reason}` to the evictee, `participant-left` to the session,
  re-queue at the back (if queue on), and the evictee can't instantly reclaim the slot.
- Queue (default on when counting): overflow joiners get `queue-status {position,total,
  message}`; host+public get `queue-updated {queue,length,activeSlots,nextInitials}`;
  freed slots promote the next eligible entry. Fairness: a newcomer goes behind the queue
  even if a slot is momentarily free.
- **Activation gates** (plugin): every gate must pass for a participant to take a slot —
  the queue holds them otherwise. chaotic-pedalboard gates on "an unassigned pedal exists".
- Plugin controls via `ctx.turnTaking`: `tick(name)`, `evict(name, session, socketID,
  reason)`, `tryPromote(name)`, `forceAllToQueue(name, reason)` (the takeover primitive),
  `markActive(session, socketID)`, `setDuration(name, seconds)`.

### 6.3 Transport (opt-in)
Per-session `{ tempo, startedAt }`; `transport-state {isPlaying, tempo, startedAt,
serverTime}` is sent on join and on every play/pause/`set-tempo {tempo}` (host-only).
**Coordination signal, not sample-accurate sync**: clients schedule audio locally against
`startedAt` (e.g. `step = floor((now-startedAt)/stepMs) % steps`); the server never runs a
playhead loop. Plugins may call `session.setTempo(n)` / read `session.transport.tempo`.

### 6.4 Pattern (opt-in)
Authoritative tracks×steps grid of **opaque** cell values (core never interprets them).

- Everyone gets `pattern-snapshot {tracks,steps,grid}` on join (and via
  `request-pattern-snapshot`). **This is how late joiners / reloaded screens restore state.**
- Writes: `pattern-update {step,value[,track]}`, `pattern-row {values[,track]}`,
  `pattern-clear {[track]}`. Participants write **their own slot's row only** (a supplied
  `track` is ignored); the host writes any row and `pattern-clear` with no track clears all.
  Broadcasts: `pattern-updated`, `pattern-row-updated`, `pattern-cleared`.
- `clearOnRelease` (default true) wipes a row when its slot frees. **Think before keeping
  the default**: count-me-in sets it `false` so the loop keeps sounding when someone
  leaves and the next occupant inherits the pattern.
- Plugins may write directly (`session.pattern.setCell/setRow/clear/snapshot`) — plugin
  writes bypass role scoping (plugins are trusted). count-me-in does this to back its
  legacy `step update` wire format with the grid.
- **Browser SDK**: core serves the identical class at `GET /beatlink/pattern.js`
  (script-tag load → `window.beatlink.Pattern`), so client mirrors share the server's
  exact semantics.

### 6.5 Routed messages (opt-in)
Protocol-neutral point-to-target envelopes; MIDI/OSC/UI payloads ride unchanged.

- In: `routed-message { type, message, target?, timestamp?, source? }` — `type` is a
  required discriminator string (`'MIDI'`, `'OSC'`, `'UI'`, …).
- Core stamps `{socketID, timestamp, source}` and delivers to the target
  (default `host`; allowlist enforced; bad envelopes get `routed-message-error`).
- Plugins observe/veto every envelope with `ctx.onRoutedMessage(fn)` — return `false` to
  drop. chaotic-pedalboard uses this to maintain per-device CC state and to silence
  participants during a host takeover.

### 6.6 Resource catalog (§5.11)
Declarative asset directories: extension filter, optional `group:'subdirs'`, optional
host-only upload.

- HTTP: `GET /beatlink/resources/:name` (grouped catalogs list groups; add `?group=x` for
  files). Socket: `request-resource-catalog {name, group?}` → `resource-catalog` /
  `resource-error`.
- Upload: `POST /beatlink/resources/:name/upload?session=S&token=HOSTTOKEN&filename=F[&group=G]`
  with a raw body. Auth = the session's `hostToken`. Filenames are sanitized, extension
  and size validated, traversal blocked. Success broadcasts `resource-updated {name,file}`.
- Plugins get the catalogs as `ctx.resources` (Map name → catalog with `list/groups/
  files/saveUpload`). dbass backs its sound-set selection with this (§9.3).
- Serving the actual files remains a normal static mount in your entrypoint.

### 6.7 QR service (§5.14)
`GET /beatlink/qr.png?text=<url-encoded>&size=<64..1024>` → PNG, generated in-house so a
live session never depends on a third-party generator.

### 6.8 Relay bus, ping, logging
- `relay: { event: mode }` — `broadcast` (everyone else), `session` (everyone incl.
  sender), `sender` (echo). Use for pure passthroughs with no server state; the moment you
  need logging detail or state, use a plugin handler instead.
- `ping`/`pong` echo for the latency tool.
- Logging: winston, `#session @[initials] …` convention — keep it, cross-app log tooling
  depends on it.

---

## 7. Plugin API

A plugin is `module.exports = function (ctx) { … }`, run once at server creation.

```js
module.exports = function myPlugin(ctx) {
  // ---- the five general extension points ----
  ctx.defineAttributes({ myState: {} });               // 1. per-session state defaults (deep-copied per session)
  ctx.relay({ 'my-event': 'broadcast' });              // 2. declarative passthrough
  ctx.on('my-cmd', (socket, session, msg, ctx) => {}); // 3. imperative handlers (any role emits)
  ctx.route('get', '/api/mine', (req, res) => {});     // 4. HTTP routes
  ctx.onConnect((socket, session, role, ctx) => {});   // 5. lifecycle hooks
  ctx.onDisconnect((socket, session, role, ctx) => {});

  // ---- module-scoped hooks ----
  ctx.activationGate(session => true);                    // veto slot activation/promotion (§6.2)
  ctx.onRoutedMessage((socket, session, env, ctx) => {}); // observe/veto envelopes; false = drop (§6.5)
  ctx.onActivate((session, {slot, socketID, initials}, ctx) => {});          // slot taken (join OR promotion)
  ctx.onRelease((session, {slot, socketID, initials, reason}, ctx) => {});   // slot freed: 'disconnect'|'evicted'|'forced'
};
```

**Runtime surface on `ctx`:** `io`, `app`, `sessions`, `logger`, `config`, `turnTaking`
(§6.2), `resources` (§6.6), `emitToSession(name, ev, msg)`, `emitToHost(session, ev, msg)`,
`emitToRole(name, role, ev, msg)` (roles have rooms `<session>:<role>`), and
`requireHost(socket, session)`.

**Session object surface plugins use:** `name`, `config` (mutable), `participants`
(`snapshot() → [{slot,socketID,initials}]`, `slotOf(socketID)`, `initialsOf`, `get(slot)`,
`activeCount()`), `queue` (`snapshot/length/positionOf`), `hostId`, `hostToken`,
`getAttribute/setAttribute`, `play()/pause()/isPlaying()`, `getTransportState()/setTempo()`,
`pattern`, `touch()`.

Handler notes:
- Every plugin `ctx.on` event automatically counts as participant *activity* (touches the
  session, starts rounds counting).
- `session` may be `null` in handlers (rejected/roomless sockets) — guard for it.
- Emitting to "everyone except one socket": `ctx.io.to(session.name).except(socketID)`.

## 8. Clients

- **Handshake**: `io({ query: { role, session, initials } })`. Never rely on referer.
- **Handle refusals**: every client should listen for `session-unavailable` (session
  missing/not ready → show message + retry/reload) and `session-ended` (teardown/reap).
  Participants should also handle `session-full`, and — when turn-taking is on —
  `queue-status` and `slot-expired`.
- **Snapshot-on-join beats request/response**: prefer consuming `pattern-snapshot`,
  `transport-state`, `session-snapshot`, `host-accepted.participants` over bespoke
  "give me my state" dances. Watch for one race: snapshots can arrive **before your DOM
  is built** (e.g. rows created after an async asset load) — buffer and retry
  (count-me-in's `applyPatternSnapshot` is the reference).
- **Pattern mirror**: `<script src="/beatlink/pattern.js">` → `window.beatlink.Pattern`.
- **QR**: point an `<img>` at `/beatlink/qr.png?text=…`.
- One page may open multiple connections/roles, but audit legacy pages for accidental
  duplicate `io()` calls (HootBeat's band page had a live one and a commented one).

---

## 9. The four reference plugins

Patterns proven in production; steal liberally.

### 9.1 chaotic-pedalboard — `server/midiPlugin.js`
*Roles:* routing console = host · queue/QR dashboard = public · phones = participant.
*Core config:* `turnTaking {count:'time', threshold:60}` (+queue), `routedMessages`
enabled (MIDI to host).

| Pattern | How |
|---|---|
| **Asset-slot assignment** | `activationGate` = "an unassigned device exists"; `onActivate` picks a random free device, emits the app's `track-assignment`; `onRelease` returns it to the pool. Queue + promotion come free. |
| **Shared controller state** | `onRoutedMessage` parses CC messages into per-device runtime state (session attribute) so a newly assigned user inherits current knob values. |
| **Host takeover** | `set-takeover-state` (host-guarded): pause + `ctx.turnTaking.forceAllToQueue()`; the routed-message tap returns `false` while takeover is on (participants silenced); disabling calls `tryPromote`. |
| **Host-pushed config** | `devices-configured` stores the device list, prunes stale assignments, re-emits, then `tryPromote` (new devices may unblock the queue). |

### 9.2 count-me-in — `server/countMeInPlugin.js`
*Roles:* big-screen sequencer = host (extra screens become secondaries via `host-exists`) ·
admin remote = public + `admin` flag · phones = participant.
*Core config:* `turnTaking {count:'rounds', threshold:16, queue:false}`, `transport
{defaultTempo:98}`, `pattern {clearOnRelease:false}`, `sessionOverrides` sizes
slots+pattern from the host's `sounds` handshake param.

| Pattern | How |
|---|---|
| **Legacy-adapter migration** | The plugin keeps the old wire format (`step update`, `play`/`stop`, `create track`, `clear track`, `tempo update`) and backs it with Pattern/Transport/session state — client changes shrink to the handshake. **This is the recommended way to migrate an old app.** |
| **Rounds from the host loop** | `ctx.on('step tick')` (host-guarded) relays the visual tick and calls `ctx.turnTaking.tick()` on loop wrap. |
| **Admin surface** | `onConnect` for `public` + `query.admin`: join `admin:<session>` room, emit state; admin commands are `ctx.on` handlers guarded by the flag, forwarding authority-needing actions to the host (`ctx.emitToHost`). |
| **Snapshot restore** | Client fills its grid from `pattern-snapshot` (DOM-retry buffer) and its labels from `host-accepted.participants`. |

### 9.3 dbass — `server/dbassPlugin.js`
*Roles:* control panel = host · QR screen = public (no longer burns a slot) · phones =
participant (user-agent as initials). *Core config:* `hostDisconnect:'destroy'` (legacy
default), `hostOptional:true`, resources: grouped `sounds` catalog.

| Pattern | How |
|---|---|
| **Runtime lifecycle switch** | The keep-alive checkbox → `ctx.on('keep-alive')` sets `session.config.hostDisconnect = 'preserve'|'destroy'` live. Explicit teardown stays available via `end-session`. |
| **Catalog-backed selection** | `sound-dir-change` validates the group against `ctx.resources.get('sounds')`, stores `soundDirectory`/`soundList` attributes, broadcasts the legacy `sound-list-changed`. |
| **State-on-join** | `onConnect` emits role-appropriate `session-data` snapshots (host gets directories + selection + playing; participant/public get list + color). |
| **External controllers** | Unguarded `ext-*` handlers let any client drive play/stop/color/flash — a deliberate authority exception, kept as-is. |

### 9.4 HootBeat — `audience-control/server/hootbeatPlugin.js`
*Roles:* band page = host · audience = participant (`who` = initials).
*Core config:* defaults (no turn-taking/transport/pattern) — near-minimal plugin.

| Pattern | How |
|---|---|
| **Identity claiming** | Per-session `band` attribute maps `who → socketID`. `onActivate`: claiming an occupied identity broadcasts `kick-out {who}` to everyone *except* the claimant (old holder self-exits); `onRelease` frees it and emits `audience-exit`. |
| **Logged relays** | `flash`/`set-color` are `ctx.on` handlers rather than relay-map entries purely to keep the diagnostic log lines. |

## 10. Testing an app

Use the harness proven across all four apps (jest + socket.io-client):

```js
const { server } = require('../index.js');           // in-process boot (§2 export pattern)
beforeAll(done => { server.logger.transports.forEach(t => t.silent = true);
                    server.httpServer.listen(0, () => { port = …; done(); }); });
afterEach(() => { clients.forEach(s => s.connected && s.disconnect()); clients = [];
                  server.sessions.all().forEach(s => server.sessions.remove(s.name)); });
afterAll(() => server.close());
```

Hard-won rules:
- **Register listeners BEFORE triggering server emissions.** Packets emitted in one
  synchronous server burst can arrive batched in a single TCP chunk and dispatch before an
  `await`'s continuation registers the next listener. Create the `waitFor` promises first,
  then emit.
- Use `transports: ['websocket'], forceNew: true` on test clients.
- Time-based turn-taking accepts fractional thresholds (e.g. `0.15`s) for fast tests.
- Jest proves protocol; it does **not** prove the browser. Do at least one real-browser
  smoke test per surface — DOM-timing races (§8) are invisible to socket tests.

## 11. Deployment (Azure App Service)

- **Node 24**: `engines >= 24` in package.json, `node-version: '24.x'` in the deploy
  workflow, **and** the App Service Stack setting (portal) — the workflow only controls
  the build container; the portal controls the runtime.
- The deploy `npm install` pulls beatlink-core from GitHub (public, no credentials).
- Azure-generated workflows run `npm test` before deploying — your integration suite
  gates production. Keep it green.
- OIDC federated credentials bind to the exact repo path: renaming a repo breaks
  `azure/login` until the Entra credential subject is updated.
- Legacy hygiene when adopting an old repo: delete workflows pointing at retired App
  Services; check for branch-protection rules before pushing directly.

## 12. Migration checklist (old socket app → BeatLink)

1. Inventory reality first: grep every `socket.emit`/`socket.on` in server **and**
   clients — dead server events (no client emitter) get dropped, not ported.
2. Map roles: who is the authority (host)? what's display-only (public)? who are the
   many (participants)? Admin = public + flag.
3. Sort every server behavior into: core config / relay entry / plugin handler / delete.
4. **Prefer legacy adapters** (§9.2) — keep the wire format in the plugin, change only
   the client handshake + refusal handling. Full client modernization is a separate pass.
5. Watch payload renames: core says `slot`, legacy often said `track`; core emits
   `participant-joined`, legacy UIs may want a compat `track joined` from `onActivate`.
6. Note deliberate behavior changes in the commit message (eviction enabled? preserve
   instead of destroy? per-session instead of global?). Get them approved.
7. Tests (§10), browser smoke every surface, commit locally, **ask before pushing**
   anything with a deploy workflow.
