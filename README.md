# beatlink-core

Shared backend framework for collaborative music/sound web apps — the common core behind
`chaotic-pedalboard` (formerly midisocket), `count-me-in`, `sonar2024`, `dbass`, and
`HootBeat`. Node.js + Express + Socket.IO.

**Status: v0.2.** Implements from [BEATLINK-SPEC.md](BEATLINK-SPEC.md): runtime bootstrap,
session registry & lifecycle (preserve-by-default, explicit teardown, idle reaper),
participant slots, the host/public/participant role model, Lobby/Veil, the declarative
relay bus, ping/pong, standardized logging, the five-point plugin API, **turn-taking
(unified eviction counter, time | rounds | none) with waiting queue + promotion (§5.6)**,
the **protocol-neutral routed-message transport (§5.10)**, **Transport (§5.7: shared
tempo/startedAt coordination — clients schedule locally, no server playhead)**, and
**Pattern (§5.8: opaque tracks×steps grid, slot-scoped writes, snapshot on join)**.
Still to come: resource catalog + host upload, QR service.

## Usage

```js
const { createServer } = require('beatlink-core');

createServer({
  staticDir: __dirname + '/public',
  roles: ['host', 'public', 'participant'],
  session: {
    numParticipants: 10,
    allocation: 'random',        // or 'sequential'
    hostDisconnect: 'preserve',  // or 'destroy'
    veilWhileHostAway: false,
    idleReapMinutes: 30,
    // Unified eviction counter (§5.6). Queue defaults to on when counting.
    turnTaking: { count: 'time', threshold: 90 },  // or { count: 'rounds', threshold: 16 } or { count: 'none' }
  },
  relay: { 'track data': 'broadcast' },
  // Protocol-neutral routed envelopes (§5.10); payload semantics live in plugins.
  routedMessages: { enabled: true, defaultTarget: 'host', allowedTargets: ['host'] },
  plugins: [require('./server/myPlugin')],
  logging: { label: 'my-app' },
}).listen(process.env.PORT || 3000);
```

Clients declare their role explicitly in the Socket.IO handshake:

```js
const socket = io({ query: { role: 'participant', session: 'gig', initials: 'JP' } });
```

## Canonical events (core)

| Event | Direction | Meaning |
|---|---|---|
| `host-accepted` / `host-exists` | server → host | host slot claimed / name collision |
| `participant-joined` / `participant-left` | server → session | slot changes |
| `session-unavailable` / `session-full` / `connection-rejected` | server → client | join refusals |
| `veil-on` / `veil-off` / `session-mode` | server → clients | Lobby state |
| `session-play` / `session-pause` | host → server | run-state control |
| `end-session` | host → server | explicit teardown |
| `session-ended` | server → session | teardown/reap notification |
| `session-snapshot` | server → public | current state for displays |
| `ping` / `pong` | client ↔ server | latency primitive |
| `queue-status` | server → queued client | 1-based position in the line |
| `queue-updated` | server → host+public | queue length, active slots, next in line |
| `slot-expired` | server → evicted client | turn is over (moved back to the line) |
| `turn-tick` | host → server | rounds-mode increment (once per app loop) |
| `set-turn-duration` / `turn-duration-updated` | host → server / server → session | time-mode threshold control |
| `routed-message` | client → server → target | opaque typed envelope (`{type, message, socketID, timestamp, source}`) |
| `routed-message-error` | server → sender | invalid envelope or disallowed target |

## Plugin API

```js
module.exports = function myPlugin(ctx) {
  ctx.defineAttributes({ myState: [] });                  // 1. session state defaults
  ctx.relay({ 'my-event': 'broadcast' });                 // 2. declarative passthrough
  ctx.on('my-cmd', (socket, session, msg, ctx) => {});    // 3. imperative handlers
  ctx.route('get', '/api/mine', (req, res) => {});        // 4. HTTP routes
  ctx.onConnect((socket, session, role, ctx) => {});      // 5. lifecycle hooks

  // module-scoped hooks:
  ctx.activationGate(session => true);                    // §5.6: veto slot activation/promotion
  ctx.onRoutedMessage((socket, session, envelope) => {}); // §5.10: observe/veto envelopes (return false to drop)
};
```

Runtime surface on `ctx`: `io`, `app`, `sessions`, `logger`, `config`,
`emitToSession`, `emitToHost`, `emitToRole`, `requireHost`, and `turnTaking`
(the manager: `tick`, `evict`, `tryPromote`, `forceAllToQueue`, `markActive`,
`setDuration` — e.g. a takeover plugin calls `forceAllToQueue`).

## Tests

```bash
npm test
```

The Jest suite is the **contract**: consuming apps track `main`, and these tests are what
makes that safe. Extend them with every core change.
