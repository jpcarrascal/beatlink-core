# beatlink-core

Shared backend framework for collaborative music/sound web apps — the common core behind
`chaotic-pedalboard` (formerly midisocket), `count-me-in`, `sonar2024`, `dbass`, and
`HootBeat`. Node.js + Express + Socket.IO.

**Status: scaffold (v0.1).** Implements the settled foundation from
[BEATLINK-SPEC.md](BEATLINK-SPEC.md): runtime bootstrap, session registry & lifecycle
(preserve-by-default, explicit teardown, idle reaper), participant slots, the
host/public/participant role model, Lobby/Veil, the declarative relay bus, ping/pong,
standardized logging, and the five-point plugin API. Opt-in modules (turn-taking + queue,
Transport, Pattern, resource catalog, QR service) come next.

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
  },
  relay: { 'track data': 'broadcast' },
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

## Plugin API

```js
module.exports = function myPlugin(ctx) {
  ctx.defineAttributes({ myState: [] });                  // 1. session state defaults
  ctx.relay({ 'my-event': 'broadcast' });                 // 2. declarative passthrough
  ctx.on('my-cmd', (socket, session, msg, ctx) => {});    // 3. imperative handlers
  ctx.route('get', '/api/mine', (req, res) => {});        // 4. HTTP routes
  ctx.onConnect((socket, session, role, ctx) => {});      // 5. lifecycle hooks
};
```

Runtime surface on `ctx`: `io`, `app`, `sessions`, `logger`, `config`,
`emitToSession`, `emitToHost`, `emitToRole`, `requireHost`.

## Tests

```bash
npm test
```

The Jest suite is the **contract**: consuming apps track `main`, and these tests are what
makes that safe. Extend them with every core change.
