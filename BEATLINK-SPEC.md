# BeatLink — Shared Backend Framework Specification

> Status: **Draft for review** · Derived from analysis of `midisocket`, `count-me-in`,
> `sonar2024`, `dbass`, and `HootBeat/audience-control`.
>
> This document specifies a single, shared Node.js + Socket.IO backend ("BeatLink core")
> that powers multiple collaborative music/sound applications, replacing the ~70% of
> copy-pasted server code currently duplicated across those repos.

---

## 1. Goals & Principles

1. **One shared server codebase, many apps.** The generic backend lives once, in its own
   repo; each app consumes it as a versioned dependency and adds only app-specific logic.
2. **Protocol- and domain-neutral core.** Nothing MIDI-, sound-, or sequencer-specific
   lives in core. (Consistent with the existing `CLAUDE.md` rule: MIDI-specific logic
   belongs in client/app code, not `index.js`/session objects.)
3. **Robust "in the wild."** The framework assumes unreliable venues — sleeping laptops,
   dropped Wi-Fi, phones that lock. Defaults favor session survival over strictness.
4. **Clear app ⇄ core boundary.** A bounded plugin API defines what apps can do without
   touching core. Reaching past it is the signal that a change belongs *in* core.
5. **Low release ceremony, backed by tests.** Apps track the core's `main`; a contract
   test suite is the safety net that makes that safe (see §12).

---

## 2. Deployment & Consumption Model

- **Core repo:** `beatlink-core` (working name). Exports a factory, not a running server.
- **App repos:** stay **separate**. Each app repo contains its frontend (`public/`) plus a
  thin (~20-line) server entrypoint that imports the core, supplies config + plugins, and
  starts listening. Frontend and backend are **co-located and deployed together** to the
  same Azure App Service instance (**same-origin** — no CORS, no third-party cookies).
- **Dependency form:** git dependency pinned to a branch/tag (repos are public), e.g.
  `"beatlink-core": "github:jpcarrascal/beatlink-core#main"`. A registry (GitHub Packages)
  is a later option if semver ranges are wanted.
- **Upstreaming rule:** if a change fits the plugin API → it stays in the app's plugin.
  If it requires editing core → that is itself the signal it's a general improvement →
  PR to `beatlink-core`, land it behind the contract tests, apps pick it up.

```js
// app repo: server.js  (the entire app-side server)
const { createServer } = require('beatlink-core');
const midiPlugin = require('./server/midiPlugin');

createServer({
  staticDir: __dirname + '/public',
  roles: ['host', 'participant'],
  session: { numParticipants: 10, turnTaking: { count: 'time', threshold: 90 } },
  transport: { enabled: true, defaultTempo: 120 },
  plugins: [midiPlugin],
}).listen(process.env.PORT || 3000);
```

---

## 3. Role Model

Three connection roles. An app uses only the ones it needs.

| Role | Cardinality | Authority | Meant for | Legacy equivalent |
|---|---|---|---|---|
| **host** | 0..1 per session | Yes — creates/controls the session, issues privileged commands | The organizer's eyes only (private admin surface) | `sequencer` (as control) / count-me-in `admin` |
| **public** | 0..n | No (read-mostly) | Everyone — shared displays, projections, visualizations, QR | count-me-in big-screen sequencer / midisocket `public` |
| **participant** | 0..n (bounded by `numParticipants`) | No | The individual's own device | `track` |

Rules:

- **Authority lives with `host`, never with `public`.** "Sequencer" historically conflated
  the two; BeatLink separates them.
- **Exactly one host slot** (`hostId`). Multiple `public` screens are allowed and are an
  app-level choice.
- **Roles are per-connection, not per-app.** One physical machine may open both a `host`
  and a `public` connection.
- **Role is declared explicitly** in the Socket.IO handshake (`query.role`), never inferred
  from `Referer` (which is unreliable and breaks under modern referrer policies).

---

## 4. Session Lifecycle

- **Creation.** A session is created by a connecting `host`, **or** pre-provisioned via an
  admin API/config (host-optional). Session name is the key; name collision on a live host
  is rejected (`host exists`).
- **Readiness.** A session is `ready` (participants may join) once **created/provisioned** —
  **a live host connection is not required.** (Rationale: the SoS/dbass-at-Ars case — the
  organizer drove an admin from a phone that could sleep while the audience joined.)
- **Host disconnect → preserve (default).** The session, its participants, attributes,
  queue, slot timers, transport, and pattern state all survive. The `hostId` slot is
  cleared so a reconnecting host reclaims it. Policy is configurable:
  `hostDisconnect: 'preserve' | 'destroy'` (default `preserve`).
- **Explicit teardown.** A host-only command **ends/destroys** a session deliberately
  (kicks all clients, frees state). This — not a persistence flag — is how an organizer
  clears a fixed-name session (e.g. a baked-in-QR session tested in situ before the event).
- **Idle reaper (backstop).** Sessions idle for `idleReapMinutes` (configurable, minutes)
  are garbage-collected. **Must be lenient:** a freshly created, host-away,
  no-participants-yet session is exempt until it has been idle for the full window — so the
  "create early, wait for the audience" workflow is never killed prematurely. (This closes
  a real gap: none of the current apps GC sessions today.)
- **`veilWhileHostAway`** (default `false`): whether participants are parked in the Lobby
  (veiled) while the host is absent, or keep playing.

---

## 5. Core Modules

Modules marked **(opt-in)** are off unless enabled in config.

### 5.1 Runtime & bootstrap
Wires Express + Socket.IO + Winston, static serving, `PORT`, and graceful `SIGINT`
shutdown. The standardized Winston setup (currently copy-pasted across all five repos)
lives here once.

### 5.2 Session registry & lifecycle
`create / find / select / remove`, attribute bag (`get/setAttribute`), host-collision
handling, preserve/destroy policy, explicit teardown, idle reaper. (See §4.)

### 5.3 Participant management
Fixed-capacity participant slots. Allocation strategy: `allocation: 'random' | 'sequential'`.
`allocate / release / getSlotForSocket / getInitials / getAvailable`. Initials come from
the handshake (`query.initials`), not a `user-agent` hack.

### 5.4 Role model
Implements §3: role parsing, the single host slot, public fan-out, participant slots.

### 5.5 Lobby / Veil
The synchronized-start mechanism. Participants joining while paused are held ("veiled");
`play` releases everyone at once; `pause` re-veils. Late joiners (session already playing)
skip the Lobby. Backed by session run-state (see Transport).

### 5.6 Turn-taking (unified eviction counter)
One mechanism: a per-participant counter with a threshold; on threshold the participant is
evicted and the slot recycled. The **count source is pluggable**:

```js
turnTaking: { count: 'time',   threshold: 90 }  // seconds of wall-clock
turnTaking: { count: 'rounds', threshold: 16 }  // domain events (e.g. loop iterations)
turnTaking: { count: 'none' }                   // no eviction
```

The **waiting queue + promotion** logic (from `midisocket`) sits on top and is identical
regardless of count source: evicted/overflow users queue; slots freeing up promote the next
in line; queue position/status is emitted to waiting clients and the host.

### 5.7 Transport (opt-in)
Authoritative shared **coordination** signal for a session:
`{ isPlaying, tempo, startedAt }`. Provides play/pause/stop and tempo control, plus an
optional periodic tick broadcast. **Clients schedule locally** against `startedAt`
(e.g. a step playhead is `floor((now − startedAt) / stepDuration) % steps`).

> **Explicitly a coordination signal, not sample-accurate sync.** Per the project's own
> latency findings, apps design *around* latency (schedule ahead) rather than trusting
> per-tick arrival times. The server does **not** run a per-session playhead loop.

### 5.8 Pattern / Grid (opt-in)
Authoritative per-session shared state for grid-style apps: a `tracks × steps` store of
**opaque** cell values. Write access to a row is scoped to the participant holding that
slot. Emits change broadcasts and a full snapshot on join (so late joiners and
slot-reclaiming participants see current state). Cell *meaning* (a MIDI note, a sample, a
color) is app-side. Generalizes the "shared partitioned state" pattern also seen in
midisocket device assignments and dbass color.

### 5.9 Relay bus (declarative)
Most existing handlers are pure forwards. Core takes a config map instead of hand-written
handlers:

```js
relay: {
  'track data':  'broadcast',  // to everyone else in session
  'track ready': 'broadcast',
  'ui-state':    'session',    // to whole session incl. sender
  'note-preview':'sender',     // echo to sender only
}
```

### 5.10 Routed-message transport (protocol-neutral)
Generic point-to-target message routing: a participant emits an opaque, timestamped,
source-tagged envelope; core delivers it to the host (or another routing target). Carries
MIDI, OSC, or UI payloads unchanged.

```js
// envelope shape (schema TBD, but includes a discriminator)
{ type: 'MIDI' | 'OSC' | 'UI' | ..., message: <payload>, socketID, timestamp, source }
```

Interpretation of the payload (MIDI type parsing, OSC address routing, the device×channel
matrix, CC runtime state) is **app/plugin**, not core. OSC-out to external services
(e.g. Ableton/PD in HootBeat) is just another routing target on this transport.

### 5.11 Resource catalog + host upload
Declarative asset catalogs. Core lists/groups/serves assets and tracks a per-session
selection; the app supplies directories and their meaning.

```js
resources: {
  sounds: { dir: './sounds',        ext: ['.mp3','.wav'], group: 'subdirs', uploadable: true },
  pedals: { dir: './images/pedals', ext: ['.png','.jpg','.svg'] },
}
```

- Lists files by extension; optional grouping into sub-collections (dbass `soundDirectories`).
- Exposes catalog over a socket event + HTTP endpoint.
- **Host-only upload** into a session/app asset dir, with type/size validation and filename
  sanitizing. Non-host roles cannot upload.
- Remote URL fetch-and-cache (count-me-in) is out of core → plugin.

### 5.12 Latency (ping/pong)
`ping → pong` round-trip primitive plus the shared latency-measurement client surface
(`/latency`) used to characterize a venue before an event.

### 5.13 Diagnostics logging
The standardized structured log line (`#session @[initials] <event> …`) centralized so
cross-app analysis tooling works uniformly. Console + file transports.

### 5.14 QR / session-URL service
In-house QR/session-URL generation (the apps moved off a third-party API). Given a session,
produce its join URL and QR. Public clients render it; repositionable/resizable is an
app-side UI concern.

---

## 6. Plugin API (the app ⇄ core boundary)

A plugin is a function receiving a context object. **Five extension points** cover every
app-specific behavior found across the five repos:

```js
function midiPlugin(ctx) {
  // 1. custom session state (initialized per session)
  ctx.defineAttributes({ configuredDevices: [], takeover: { enabled: false } });

  // 2. declarative passthrough (same as core relay bus)
  ctx.relay({ 'routing-updated': 'broadcast' });

  // 3. imperative event handlers, with session + role context
  ctx.on('track-midi-message', (socket, session, msg) => { /* ... */ });

  // 4. custom HTTP routes / APIs
  ctx.route('get', '/api/pedal-images', (req, res) => { /* ... */ });

  // 5. connect / disconnect hooks
  ctx.onConnect((socket, session, role) => { /* ... */ });
  ctx.onDisconnect((socket, session, role) => { /* ... */ });
}
```

**`ctx` surface (provided by core):**

- `ctx.sessions` — session registry (create/find/select, attributes).
- `ctx.emitToSession(session, event, msg)` / `ctx.emitToHost(...)` / `ctx.emitToRole(role, ...)`
  / access to `io`.
- `ctx.logger` — the standardized logger.
- `ctx.config` — resolved server config.
- Guard helpers, e.g. `ctx.requireHost(socket, session)` for privileged commands.

**Rule of thumb:** if it fits these five hooks, it's app-specific. If it can't be expressed
here, core needs extending — do that upstream (§2).

---

## 7. Configuration Reference (`createServer` options)

```js
createServer({
  staticDir,                          // path to app's frontend
  roles: ['host','public','participant'],

  session: {
    numParticipants: 10,
    allocation: 'random',             // 'random' | 'sequential'
    turnTaking: { count: 'none' },    // see §5.6
    hostDisconnect: 'preserve',       // 'preserve' | 'destroy'
    veilWhileHostAway: false,
    hostOptional: true,               // ready without a live host
    idleReapMinutes: 30,
  },

  lobby: true,
  transport: { enabled: false, defaultTempo: 120 },   // §5.7
  pattern:   { enabled: false, tracks: 10, steps: 16 },// §5.8
  queue:     { enabled: false },                       // turn-taking queue

  relay: { /* event: 'broadcast'|'session'|'sender' */ },
  resources: { /* name: { dir, ext, group, uploadable } */ },

  logging: { label: 'beatlink', file: 'info.log' },
  plugins: [ /* ... */ ],
})
```

---

## 8. App → Role/Module Mapping (migration sketch)

| App | host | public | participant | Core modules used | App plugin(s) |
|---|---|---|---|---|---|
| **midisocket** | routing control | queue/QR display | track | turn-taking(time)+queue, transport, routed-transport, resources(pedals) | MIDI device matrix, CC runtime state, takeover |
| **count-me-in** | admin remote | big-screen sequencer | track | transport, pattern, turn-taking(rounds), resources(sounds) | audio engine, expert-mode, mood-matching, sample fetch/cache |
| **sonar2024** | host control | display | track | pattern, relay | audio, face-detection (client), midi relay |
| **dbass** | admin (phone) | — / display | track | resources(sounds), relay | soundscape audio, color/flash, `ext-*` remote |
| **HootBeat** | host control | out display | participant | relay, routed-transport(OSC-out) | lighting (flash/set-color), kick-out |

(Notes: count-me-in migrates by splitting its sequencer screen into a `public` display +
a `host` control; its audio engine stays app-side.)

---

## 9. Testing & Release Model

- **Contract test suite in core.** Every core capability above has tests (extend the
  existing Jest + `socket.io-client` setup already in midisocket). These are the contract
  all apps depend on.
- **Low ceremony.** Apps track core `main`; a red contract test blocks the push. This is
  the trade for skipping per-app version pinning (§2).
- **CI on core.** Run the suite on every push/PR to `beatlink-core`.

---

## 10. Security Notes (same-origin deployment)

Same-origin co-location removes CORS/third-party-cookie/referer hazards. Remaining items:

- Session name is the only "secret" for joining — acceptable for public art contexts, but a
  **conscious** decision. Privileged (`host`) commands must be guarded by `hostId` identity
  (already the pattern in midisocket's takeover/slot handlers).
- Validate inbound event payload shape/size; cap sessions/participants; basic
  connection-rate limiting to blunt floods.
- Host upload: enforce type/size, sanitize filenames, scope to the session's asset dir.

---

## 11. Open Items / Deferred

- Exact **routed-message envelope schema** (the `type` discriminator set and payload shapes).
- Whether OSC-out to external services is a core routing target or a thin plugin.
- Pre-provisioning/admin API surface for host-optional session creation.
- Registry vs git-dependency final call (git-dependency for v1).
- count-me-in's audio-engine migration details (out of scope for core).

---

## 12. Summary of Decisions (this design pass)

1. Separate app repos; core as a git-dependency; same-origin co-located deploys.
2. Roles: **host / public / participant**; authority = host only; roles per-connection.
3. Session **ready without a live host**; **preserve-by-default**; explicit host teardown;
   lenient idle reaper; `veilWhileHostAway` default `false`.
4. Turn-taking = **one eviction-counter** with pluggable count (`time | rounds | none`) + queue.
5. **Transport** (opt-in) = coordination signal; clients schedule locally; no server playhead loop.
6. **Pattern** (opt-in) = authoritative opaque tracks×steps state; slot-scoped writes.
7. Event routing **split**: protocol-neutral routed transport (with `type` field) in core;
   MIDI/OSC/UI semantics in plugins.
8. **Resource catalog** in core + host-only upload; URL fetch/cache stays plugin.
9. Plugin API = **five extension points**; contract tests enable low-ceremony releases.
</content>
</invoke>
