---
name: verify
description: Build, launch and drive the BetterCrewLink signaling server to observe changes at its real surface (HTTP endpoints + socket.io events). Use when verifying changes to src/index.ts, src/turnCredentials.ts, or peer/lobby behaviour.
---

# Verifying the BetterCrewLink server

The surface is a **socket.io v4 server running `allowEIO3: true`, plus four HTTP endpoints**.
Both client generations must keep working: desktop BetterCrewLink is pinned to
`socket.io-client` 2.4.0 (EIO=3), the web/mobile client is on 4.8 (EIO=4). Drive it with a
real client connection — `socket.io-client` (v4) and `socket.io-client-v2` (an npm alias of
2.4.0) are explicit devDependencies, since socket.io v4 no longer pulls a client in.

```js
const { io: ioV4 } = require('socket.io-client'); // v4 no longer exports a callable default
const ioV2 = require('socket.io-client-v2');
```

## Build and launch

```bash
yarn install --frozen-lockfile     # node_modules is not checked in
yarn compile                       # tsc -> dist/, fails hard (noEmitOnError)
NODE_ENV=production PORT=29736 node dist/index.js > /tmp/verify/server.log 2>&1 &
```

Use a high port (29736+) — the default 9736 may collide. Poll `GET /health` until it
answers; startup is ~1s but is not instant.

## HTTP surface

- `GET /health` — JSON. Carries `uptime`, `connectionCount`, `lobbiesCount`,
  `eventLoopDelayMs`, `turn` (credential status), and `events.{in,emits,recipients,dropped}`
  counters. This is the fastest way to confirm behaviour without instrumenting the client.
- `GET /lobbies` — array of public lobbies.
- `GET /` — pug page.
- `GET /app` — the self-hosted web client, only present when `webclient/` was built
  (see web/README.md). `/health` reports `webClient: true|false`.

**Protocol check — run this before anything else after touching socket.io setup:**

```bash
curl -s "http://127.0.0.1:29736/socket.io/?EIO=3&transport=polling"   # v3 framing: 117:0{...}
curl -s "http://127.0.0.1:29736/socket.io/?EIO=4&transport=polling"   # v4 framing: 0{...}
curl -si -H "Origin: https://example.com" "http://127.0.0.1:29736/socket.io/?EIO=4&transport=polling" | grep -i access-control
```

The first two must *both* answer. A server that only answers one has broken half its client
base, and the client just spins on "connecting" with nothing in the logs. CORS must reflect
the origin and send `Access-Control-Allow-Credentials: true`: v2 did this by default via
`origins: '*:*'`, v4 only does it because of the explicit `cors` option.

**`events.recipients / events.emits` is the key ratio** for fan-out changes. `new_lobbies`
must be **1.0** (one recipient per emit); anything higher means the lobby-browser broadcast
regressed to hitting every browser client.

## Driving the socket

Wrap `onevent` to record everything the server pushes, otherwise you miss events you didn't
pre-register a listener for:

```js
const s = io(URL, { transports: ['websocket'], forceNew: true });
s.seen = [];
const onevent = s.onevent.bind(s);
s.onevent = (p) => { s.seen.push({ ev: p.data[0], args: p.data.slice(1) }); onevent(p); };
await new Promise((r) => s.on('connect', () => r()));
```

`clientPeerConfig` is pushed **immediately on connect**, so register for it before awaiting
the connect event or it is lost.

Minimum flow to make lobby code execute:
`join(code, playerId, clientId, isHost)` → `id(playerId, clientId)` → then `VAD`,
`signal({to, data})`, `lobby(code, payload)`, `lobbybrowser(true)`.

## Gotchas

- **Timers are slow to observe.** Browser resync is 30s; the lobby TTL sweep runs every 60s.
  Shorten the TTL with `LOBBY_TTL_MINUTES=0.05`, but the 60s sweep interval is hardcoded —
  budget ~70s of waiting.
- **`socket.disconnect()` on malformed input.** Bad `signal.to`, bad `join` args, or a
  reserved/oversized lobby code drop the socket. Rate-limited events are *dropped silently*
  instead — the socket stays up, and the drop only shows in `events.dropped`.
- **Rate limiting is a registration wrapper, not middleware.** `socket.use()` is gone in v4,
  so handlers register through the local `on(...)` helper; one registered straight on
  `socket` silently loses its rate limit. `eventsIn` is counted separately in `onAny`, which
  is why it also counts events no handler is listening for.
- **Verify both protocols.** A regression that only breaks EIO=3 is invisible to a v4-only
  test, and vice versa. `/health` splits live connections as `protocols.{eio3,eio4}`, and
  `io.engine.on('connection_error')` logs handshakes that never reached `connection`.
- **A lobby spans two rooms, and the host addresses one by name.** The phone joins
  `<CODE>_mobile` to find the desktop Mobile Host, then joins `<CODE>` for voice **while staying
  in `<CODE>_mobile`**. The desktop never joins `_mobile` and never learns the phone's socket
  id: it stays in `<CODE>` and sends `signal { to: '<CODE>_mobile', ... }` — a *room name* — for
  both its 5s `mobileHostInfo` beacon and the `gameState` stream. Two things must therefore
  hold: `signal.to` may name the `_mobile` half of the sender's own lobby (that one direction
  only), and `join(<CODE>)` must not evict the phone from `<CODE>_mobile` (`mobileRoom`). Break
  either and every phone sits forever on *"Searching for bettercrewlink PC players"*, with
  `/health` showing `events.in.signal` climbing while `events.emits.signal` stays absent.
- **SIGTERM is not deliverable on Windows** (`child.kill` uses TerminateProcess), so the
  graceful-shutdown path can only be verified on Linux/Docker.
- **Idle event-loop delay reads ~15ms p50 on Windows** because of timer granularity. That is
  the floor, not a stalled loop. Expect near-zero on Linux.
- Kill instances by port: `netstat -ano | grep ":<port> "` then `Stop-Process -Id <pid> -Force`.

## Cloudflare TURN

Set `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` to bogus values to exercise the degraded path
without credentials — Cloudflare answers `HTTP 404 cannot find specified key`, which also
confirms the endpoint and auth header are still correct. The server must start anyway and
serve STUN only. Unset both to check the inert path.

`yarn smoke` exists and drives the same surface, but it is the author's own test — for
independent verification, drive the running server directly.
