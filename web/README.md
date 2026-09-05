# Self-hosted web client

The page served at `/app` — the one a player opens on a phone to join a lobby and talk.

It is the upstream [BetterCrewlink-mobile](https://github.com/OhMyGuus/BetterCrewlink-mobile)
Angular/Ionic client, cloned at a pinned commit and rebuilt with two local patches. Nothing
is vendored: this repo stays a signaling server rather than carrying a second copy of a
30k-line app.

## Why not just use web.bettercrewl.ink

You can, but only against a server that speaks its protocol. That client is on
`socket.io-client` 4.x (EIO=4). This server was on socket.io 2.4.1 (EIO=3) and answered EIO=4
handshakes with v3 framing, so the page hung forever on *"connecting to voice server"*. The
server now runs socket.io 4 with `allowEIO3: true`, which serves both — desktop
BetterCrewLink is still on `socket.io-client` 2.4.0 and must keep working.

Hosting it here buys two more things: the page is same-origin with the socket (no CORS, no
second certificate, no second tunnel), and it can use *this* server's TURN credentials.

## The patches

Both live in `patches/` and are applied with `git apply` during the build.

- **`01-default-voice-server.patch`** — defaults the voice server to `window.location.origin`
  instead of `https://bettercrewl.ink`, so a player only types a lobby code and a name. Also
  drops upstream's rewrite of `//crewl.ink` to a server of its own: a self-hosted build must
  never silently redirect players elsewhere.
- **`02-ice-from-server.patch`** — takes ICE servers from the `clientPeerConfig` this server
  pushes on connect, instead of `turnServers.ts`, which points at `turn.bettercrewl.ink` with
  credentials frozen into the bundle. Without this your Cloudflare TURN key is never used by
  phones — which matters, because a phone on mobile data is usually behind CGNAT and cannot
  connect directly to anyone. Falls back to upstream's constants if the server sends nothing.

## Building

**With Docker** (the normal path) — nothing to do, the repo-root `Dockerfile` has a
`webclient` stage that does all of it, and the production image ships the result:

```sh
docker build -t bettercrewlink-server .
```

**Without Docker**, to iterate locally:

```sh
bash web/build-local.sh     # needs node >= 24.15 and git
yarn start
```

It builds into `webclient/` at the repo root, which `src/index.ts` picks up automatically and
serves at `/app`. Both `webclient/` and `web/.build/` are gitignored. If `webclient/` is
absent the server still runs — it hides the link on the index page and `/health` reports
`webClient: false`.

## Updating the client

The commit is pinned in two places that must stay in step: `WEBCLIENT_COMMIT` in the root
`Dockerfile` and `COMMIT` in `build-local.sh`. After bumping, re-run a build: `git apply`
fails loudly if a patch no longer matches, which is the point of keeping them small.

## Using it

One player on PC must have **Mobile Host** enabled in BetterCrewLink and be in the lobby —
the phone has no way to read the game state itself, so without a host it sits at
*"connecting to voice server"* by design. Then, on the phone: open `https://<your-server>/app`,
enter the lobby code and a name unique in that lobby, and connect.

The page needs a secure context for microphone access, so the server must be reachable over
HTTPS (a reverse proxy or a Cloudflare Tunnel in front of it — see the root README).
