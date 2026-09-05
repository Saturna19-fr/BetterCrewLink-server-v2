---
name: verify
description: Build, launch and drive the BetterCrewLink signaling server to observe changes at its real surface (HTTP endpoints + socket.io events). Use when verifying changes to src/index.ts, src/turnCredentials.ts, or peer/lobby behaviour.
---

# Verifying the BetterCrewLink server

The surface is a **socket.io v2 server plus three HTTP endpoints**. Drive it with a real
`socket.io-client` connection — it ships as a transitive dep of `socket.io`, so
`require('socket.io-client')` resolves with no extra install.

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
