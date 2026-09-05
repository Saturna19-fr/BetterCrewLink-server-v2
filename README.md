[![GPL-3.0 License][license-shield]][license-url] [![Docker Pulls][docker-shield]][docker-url] [![Run on Repl.it][replit-shield]][replit-url] [![Discord Server][discord-shield]][discord-url] [![Contributors][contributors-shield]][contributors-url]

<br />
<p align="center">
  <a href="https://github.com/OhMyGuus/BetterCrewLink-server">
    <img src="logo.png" alt="Logo" width="80" height="80">
  </a>

  <h3 align="center">BetterCrewLink Server</h3>

  <p align="center">
    Voice Relay server for <a href="https://github.com/OhMyGuus/BetterCrewLink">BetterCrewLink</a>.
    <br />
    <a href="https://github.com/OhMyGuus/BetterCrewLink-server/issues">Report Bug</a>
    ·
    <a href="https://github.com/OhMyGuus/BetterCrewLink-server/issues">Request Feature</a>
  </p>
</p>
<hr />

<p>

<!-- NOTES -->
<b>Notes:</b><br />

- This is an unofficial fork of CrewLink, for any problem, issue or suggestion you have with BetterCrewLink talk to us on our [Discord](https://discord.gg/qDqTzvj4SH), or [GitHub](https://github.com/OhMyGuus/BetterCrewLink-server/issues) or message me on Discord ([ThaGuus#2140](https://discordapp.com/users/508426414387757057)) do not report any problems to the official Discord or GitHub project of CrewLink as they will not support you.

- I recommend you use my BetterCrewLink server: <a href="https://bettercrewl.ink">`https://bettercrewl.ink`</a>, it is quite stable and most people are using it and I highly recommend it if you don't know a lot about how to host servers, but if you do and how to host anyway, feel free with the open source.

<!-- TABLE OF CONTENTS -->
## Table of Contents

* [About the Project](#about-the-project)
* [Web Client for Phones](#web-client-for-phones)
* [Deploy to Heroku](#deploy-to-heroku)
* [Deploy to Repl.it](#deploy-to-replit)
* [Docker Quickstart](#docker-quickstart)
  * [Building the Docker Image](#building-the-docker-image)
* [Manual Installation](#manual-installation)
  * [Prerequisites](#prerequisites)
  * [Installation](#installation)
  * [Customizing Peer to Peer Behavior](#customizing-peer-to-peer-behavior)
* [Contributing](#contributing)
  * [Contributors](#contributors)
* [License](#license)

<!-- ABOUT THE PROJECT -->
## About The Project

This is the relay server for CrewLink, an Among Us proximity voice chat program. I am currently hosting a server at <a href="https://bettercrewl.ink">`https://bettercrewl.ink`</a>, but if you want to make your own server, feel free to open source the server.

## Environment Variables

All of these are optional; the server starts with sensible defaults.

 - `PORT`: Specifies the port that the server runs on. Defaults to `443` if `HTTPS` is enabled, and `9736` if not.
 - `NAME`: Specifies the server name, shown on the index page and in `GET /health`.
 - `HTTPS`: Makes the server terminate TLS itself. You must place `privkey.pem` and `fullchain.pem` in your CWD.
   **Leave this unset if you run behind a reverse proxy** (Traefik, nginx, Caddy, Cloudflare Tunnel): the proxy
   terminates TLS and the server should speak plain HTTP on `PORT`. Setting it there makes the server fail to
   start looking for certificates it does not have.
 - `SSLPATH`: Specifies an alternate path to SSL certificates. Only read when `HTTPS` is set.
 - `HOSTNAME`: Public hostname or IP advertised to clients, **used only by the integrated TURN relay**. It has
   to resolve straight to the server, so with Cloudflare you need a separate DNS record (for example
   `direct.domain.com`) with the proxy disabled. Ignored entirely unless `integratedRelay.enabled` is `true`.
   **In a container, be careful:** Docker sets `HOSTNAME` automatically to the container ID, so the startup
   check that is supposed to stop you enabling the relay without a real hostname can never fire. The relay
   starts anyway and advertises an unroutable address, which fails silently. Set it explicitly, or use a
   managed TURN service (below).
 - `FORCE_RELAY_ONLY`: Route every connection through TURN instead of letting players connect directly.
   Overrides `forceRelayOnly` in `config/peerConfig.yml`, which container deployments cannot easily mount.
   Two uses: set it temporarily to confirm your relay works for everyone without waiting for a player with a
   restrictive NAT, or leave it on so players never learn each other's IP addresses. Costs relay bandwidth
   and adds a hop of latency. Accepts `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`); a blank or
   unrecognised value is ignored rather than treated as `false`.
 - `LOBBY_TTL_MINUTES`: Grace period, default `15`, before an *orphaned* public lobby (one whose room is
   already empty) is dropped from the lobby browser. A lobby that still has players in it is never evicted.

### Managed TURN (recommended)

Players behind symmetric NAT or CGNAT (mobile carriers, some ISPs) cannot establish a direct
peer connection and need a TURN relay to hear anyone. Rather than running the integrated relay --
which needs UDP ports published directly on the host, and cannot be put behind a reverse proxy
such as Traefik or nginx -- you can point clients at a managed TURN service.

Set these and leave `integratedRelay.enabled` at `false`:

 - `CF_TURN_KEY_ID`: Cloudflare Realtime TURN key ID.
 - `CF_TURN_API_TOKEN`: API token for that key. **This is a secret** -- put it in the environment,
   never in `config/peerConfig.yml`, and keep it out of git.
 - `CF_TURN_TTL_SECONDS`: Credential lifetime, default `86400` (24h). Clamped to Cloudflare's accepted
   range: minimum `600`, maximum `172800` (48h, above which the API rejects the request). Credentials
   are refreshed automatically at half-life.

Create a key at Cloudflare dashboard -> Realtime -> TURN. If these are unset the server behaves
exactly as before and clients get STUN only. If the API is unreachable the server keeps running and
degrades to STUN only rather than failing to start; check `turn` in `GET /health` for status.

## Web Client for Phones

Players on a phone cannot run the desktop client, and the game itself is not what carries
the voice — so this server can serve its own build of the BetterCrewLink web client at
`/app`. A player opens `https://your-server/app`, types the lobby code and a name, and
talks. The index page links to it when it is present.

Two things are required, and both are easy to miss:

 - **One player on PC with "Mobile Host" enabled** in BetterCrewLink, in the same lobby.
   A phone has no way to read the game state itself, so without a host it sits on
   *"connecting to voice server"* forever — by design, not a fault.
 - **HTTPS.** Browsers only grant microphone access in a secure context, so a bare
   `http://ip:9736` will never work from a browser. Put the server behind a reverse proxy
   or a Cloudflare Tunnel (leave `HTTPS` unset in that case — see above).

The page is built from upstream sources at a pinned commit with two local patches, one of
which makes phones use *this* server's TURN credentials instead of the ones frozen into
the upstream bundle. See [web/README.md](web/README.md). `docker build .` includes it;
without Docker, run `bash web/build-local.sh`. If it was never built the server still runs
and `GET /health` reports `webClient: false`.

### Client protocol compatibility

This server runs socket.io 4 with `allowEIO3: true`, so both client generations connect:
desktop BetterCrewLink (`socket.io-client` 2.x, EIO=3) and the web/mobile client
(`socket.io-client` 4.x, EIO=4). `GET /health` splits live connections as
`protocols.{eio3,eio4}`. This is worth knowing if you run an older fork of this server:
those are socket.io 2 only, and the official web client hangs on *"connecting to voice
server"* against them with nothing in the logs, because the handshake itself never
completes.

## Deploy to Heroku

To get up and running quickly, you can deploy to Heroku clicking on the button below:

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

This will deploy an instance of the BetterCrewLink-server. You can get the URL of your server by using the app name that you gave when you launched the app on Heroku and appending `.herokuapp.com`. You can also find the URL of your server by going to "Settings", scrolling down to "Domains". Using this URL, follow step 4 of the [installation instructions](https://github.com/OhMyGuus/BetterCrewLink-server#manual-installation) to connect your client to your server instance.

## Deploy to Repl.it

Another way to host your server besides using Heroku it's the Repl.it that provide you to host servers completely free without having time per month, and you can deploy it by clicking on this button below:

[![Run on Repl.it][replit-shield]][replit-url]

This will deploy an instance of the BetterCrewLink-server. You can get the URL of your server by using the app name that you gave when you launched the app on Repl.it and appending `[your-username.repl.co]`. You can also find the URL of your server by going to "Web View". Using this URL, follow step 4 of the [installation instructions](https://github.com/OhMyGuus/BetterCrewLink-server#manual-installation) to connect your client to your server instance.

## Docker Quickstart

Run the server with [Docker](https://docs.docker.com/get-docker/) by running the following command:

```
docker run -d -p 9736:9736 ohmyguus/bettercrewlink-server:latest
```

To change the external port the server uses, change the *first* instance of the port. For example, to use port 8123:

```
docker run -d -p 8123:9736 ohmyguus/bettercrewlink-server:latest
```

### Building the Docker Image

To build your own Docker image, do the following:

1. Clone the repo
```sh
git clone https://github.com/OhMyGuus/BetterCrewLink-server.git
cd BetterCrewLink-server
```

2. Run the Docker build command:
```sh
docker build -t ohmyguus/bettercrewlink-server:build .
```

## Manual Installation

### Prerequisites

This is an example of how to list things you need to use the software and how to install them.
* [node.js](https://nodejs.org/en/download/)
* yarn
```sh
npm install yarn -g
```

### Installation

1. Clone the repo
```sh
git clone https://github.com/OhMyGuus/BetterCrewLink-server.git
cd BetterCrewLink-server
```
2. Install NPM packages
```sh
yarn install
```
3. Compile and run the project
```JS
yarn start
```
4. Copy your server URL into CrewLink settings. Make sure everyone in your lobby is using the same server.
### Customizing Peer to Peer Behavior
By default CrewLink clients will attempt to establish connections directly to each other for sending voice and game 
state data. As a fallback mechanism, CrewLink-server ships with an integrated TURN server in the event clients cannot
directly connect to each other. You may want to customize this behavior to, for example, exclusively use the TURN relay
to protect player IP addresses. To do so, head into the ``config`` folder and rename ``peerConfig.example.yml`` to
``peerConfig.yml`` and make the desired changes.

<!-- CONTRIBUTING -->
## Contributing

Any contributions you make are greatly appreciated.

1. [Fork the Project](https://github.com/OhMyGuus/BetterCrewLink-server/fork)
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Contributors

[![Contributors][contributors-shield]][contributors-url]

* [OhMyGuus](https://github.com/OhMyGuus) for make various things for [BetterCrewLink](https://github.com/OhMyGuus/BetterCrewLink), example: NAT Fix, more overlays, support for Mobile and owner of project
* [ottomated](https://github.com/ottomated) for make [CrewLink](https://github.com/ottomated/CrewLink)
* [vrnagy](https://github.com/vrnagy) for make WebRTC reconnects automatically for [BetterCrewLink](https://github.com/OhMyGuus/BetterCrewLink)
* [TheGreatMcPain](https://github.com/TheGreatMcPain) & [Donokami](https://github.com/Donokami) for make support for Linux
* [squarebracket](https://github.com/squarebracket) for make support overlay for Linux
* [JKohlman](https://github.com/JKohlman) for make various things for [BetterCrewLink](https://github.com/OhMyGuus/BetterCrewLink), example: push to mute, visual changes and making Multi Stage builds for [BetterCrewLink Server](https://github.com/OhMyGuus/BetterCrewLink-server)
* [Diemo-zz](https://github.com/Diemo-zz) for make the default Voice Server for: <a href="https://bettercrewl.ink">`https://bettercrewl.ink`</a>
* [KadenBiel](https://github.com/KadenBiel) for make various things for [BetterCrewLink Mobile](https://github.com/OhMyGuus/BetterCrewlink-mobile), example: Better UI, Settings page
* [adofou](https://github.com/adofou) for make new parameters for node-turn server for [BetterCrewLink-Server](https://github.com/OhMyGuus/BetterCrewLink-server)
* [Kore-Development](https://github.com/Kore-Development) for make support for Repl.it and gitignore changes for [BetterCrewLink-Server](https://github.com/OhMyGuus/BetterCrewLink-server)
* [cybershard](https://github.com/cybershard) & [edqx](https://github.com/edqx) for make Only hear people in vision, Walls block voice and Hear through cameras
* [electron-overlay-window](https://github.com/SnosMe/electron-overlay-window) for make it easier to do overlays
* [node-keyboard-watcher](https://github.com/OhMyGuus/node-keyboard-watcher) for make it easy to push to talk and push to mute
* [MatadorProBr](https://github.com/MatadorProBr) for make this list of Contribuators, better README.md, wiki

A big thank you to all those people who contributed and still contribute to this project to stay alive, thank you for being part of this BetterCrewLink community!

## License

Distributed under the GNU General Public License v3.0. See <a href="https://github.com/OhMyGuus/BetterCrewLink-server/blob/master/LICENSE">`LICENSE`</a> for more information.

[license-shield]: https://img.shields.io/github/license/OhMyGuus/BetterCrewLink-server?label=License
[license-url]: https://github.com/OhMyGuus/BetterCrewLink-server/blob/master/LICENSE
[docker-shield]: https://img.shields.io/docker/pulls/ohmyguus/bettercrewlink-server?label=Docker%20Pulls
[docker-url]: https://hub.docker.com/repository/docker/ohmyguus/bettercrewlink-server
[replit-shield]: https://repl.it/badge/github/OhMyGuus/BetterCrewLink-server
[replit-url]: https://repl.it/github/OhMyGuus/BetterCrewLink-server
[discord-shield]: https://img.shields.io/discord/791516611143270410?color=cornflowerblue&label=Discord&logo=Discord&logoColor=white
[discord-url]: https://discord.gg/qDqTzvj4SH
[contributors-shield]: https://img.shields.io/github/contributors/OhMyGuus/BetterCrewLink-server?label=Contributors
[contributors-url]: https://github.com/OhMyGuus/BetterCrewLink-server/graphs/contributors
