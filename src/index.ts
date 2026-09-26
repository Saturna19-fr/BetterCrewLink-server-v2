import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { Server } from 'http';
import { Server as HttpsServer } from 'https';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Server as IOServer, Socket as IOSocket } from 'socket.io';
import Tracer from 'tracer';
import morgan from 'morgan';
import peerConfig from './peerConfig';
import { ICEServer } from './ICEServer';
import { PublicLobby } from './interfaces/publicLobby';
import { GameState } from './interfaces/gameState';
import { lobbyInfo } from './interfaces/lobbyInfo';
import { createTurnCredentialProvider } from './turnCredentials';
let TurnServer = require('node-turn');

const httpsEnabled = !!process.env.HTTPS;

const port = process.env.PORT || (httpsEnabled ? '443' : '9736');

const sslCertificatePath = process.env.SSLPATH || process.cwd();

/** Room name reserved by the server; clients must never be able to join it as a lobby. */
const LOBBY_BROWSER_ROOM = 'lobbybrowser';
const RESERVED_ROOMS = new Set([LOBBY_BROWSER_ROOM]);
const MAX_LOBBY_CODE_LENGTH = 32;

/**
 * Grace period before an *orphaned* public lobby (one whose socket.io room is
 * already empty) is dropped from the browser. Lobbies with players still in them
 * are never evicted on this timer -- see the sweep below.
 */
const LOBBY_TTL_MS = (Number(process.env.LOBBY_TTL_MINUTES) || 15) * 60000;
const LOBBY_SWEEP_INTERVAL_MS = 60000;
/** Full lobby-list resync for browser clients, replacing the old per-open broadcast. */
const BROWSER_RESYNC_INTERVAL_MS = 30000;
const STATS_INTERVAL_MS = 30000;

const logger = Tracer.colorConsole({
	format: '{{timestamp}} <{{title}}> {{message}}',
});

const turnLogger = Tracer.colorConsole({
	format: '{{timestamp}} <{{title}}> <ice> {{message}}',
	level: peerConfig.integratedRelay.debugLevel.toLowerCase(),
});

const app = express();
let server: HttpsServer | Server;
if (httpsEnabled) {
	server = new HttpsServer(
		{
			key: readFileSync(join(sslCertificatePath, 'privkey.pem')),
			cert: readFileSync(join(sslCertificatePath, 'fullchain.pem')),
		},
		app
	);
} else {
	server = new Server(app);
}

// node-turn invokes the debug callback regardless of the configured level, so
// gate here rather than paying message formatting for suppressed events.
const TURN_LEVELS = ['ALL', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'OFF'];
const minTurnLevel = TURN_LEVELS.indexOf(peerConfig.integratedRelay.debugLevel);

let turnServer: any | null = null;
if (peerConfig.integratedRelay.enabled) {
	turnServer = new TurnServer({
		listeningIps: peerConfig.integratedRelay.listeningIps,
		relayIps: peerConfig.integratedRelay.relayIps,
		externalIps: peerConfig.integratedRelay.externalIps,
		minPort: peerConfig.integratedRelay.minPort,
		maxPort: peerConfig.integratedRelay.maxPort,
		listeningPort: peerConfig.integratedRelay.listeningPort,
		authMech: 'long-term',
		debugLevel: peerConfig.integratedRelay.debugLevel,
		realm: 'crewlink',
		debug: (level: string, message: string) => {
			if (TURN_LEVELS.indexOf(level) < minTurnLevel) return;
			turnLogger[level.toLowerCase()](message);
		},
	});

	turnServer.addUser(peerConfig.integratedRelay.defaultUsername, peerConfig.integratedRelay.defaultPassword);

	turnServer.start();
}

const io = new IOServer(server, {
	// Desktop BetterCrewLink is pinned to socket.io-client 2.4.0 (EIO=3) while the
	// web/mobile client is on 4.8 (EIO=4). Both have to reach this server, so keep
	// the v2 protocol enabled -- this is what the official server does.
	allowEIO3: true,
	// v2 defaulted to `origins: '*:*'`, accepting every browser origin. v3+ rejects
	// cross-origin requests unless CORS is spelled out. The bundled client at /app is
	// same-origin, but the Android app is not, and neither is anyone pointing
	// web.bettercrewl.ink at this server.
	cors: { origin: true, credentials: true },
	// No native client loads the served bundle.
	serveClient: false,
	// engine.io v3 enables permessage-deflate by default at a 1 KB threshold,
	// putting zlib on the main thread for every signal / lobby-list payload.
	perMessageDeflate: false,
	httpCompression: { threshold: 4096 },
	// socket.io v2 defaults to 1e8 (100 MB), letting one client force a huge allocation.
	maxHttpBufferSize: 1e5,
	// The 5s v2 default is tight for mobile clients, and spurious drops cause
	// costly full reconnects (polling handshake then upgrade).
	pingInterval: 25000,
	pingTimeout: 20000,
});

// A client that cannot complete the handshake never reaches io.on('connection'),
// so without this a protocol mismatch looks like silence from the server side
// while the client spins forever on "connecting".
io.engine.on('connection_error', (err: { code: number; message: string }) => {
	logger.warn('Handshake failed: %s (%s)', err.message, err.code);
});

const clients = new Map<string, Client>();
const publicLobbies = new Map<string, PublicLobby>();
const lobbyCodes = new Map<number, string>();
const allLobbies = new Map<string, lobbyInfo>();
/** Last time each public lobby was advertised. Kept out of PublicLobby to preserve its wire shape. */
const lobbyLastSeen = new Map<string, number>();
let lobbyCount = 0;

interface Client {
	playerId: number;
	clientId: number;
}

interface Signal {
	data: string;
	to: string;
}

interface ClientPeerConfig {
	forceRelayOnly: boolean;
	iceServers: ICEServer[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

const eventsIn: { [event: string]: number } = Object.create(null);
const emitsOut: { [event: string]: number } = Object.create(null);
const recipientsOut: { [event: string]: number } = Object.create(null);
const droppedEvents: { [event: string]: number } = Object.create(null);
let connectionCount = 0;
/** Live connections split by engine.io protocol; see the note in GET /health. */
const protocolCounts = { eio3: 0, eio4: 0 };

function roomSize(room: string | null): number {
	if (!room) return 0;
	const r = io.sockets.adapter.rooms.get(room);
	return r ? r.size : 0;
}

function countEmit(event: string, recipients: number) {
	emitsOut[event] = (emitsOut[event] || 0) + 1;
	recipientsOut[event] = (recipientsOut[event] || 0) + recipients;
}

/** Broadcast to everyone in the room except the sender, recording fan-out size. */
function broadcastToRoom(socket: IOSocket, room: string, event: string, ...args: any[]) {
	socket.to(room).emit(event, ...args);
	countEmit(event, Math.max(0, roomSize(room) - 1));
}

function broadcastToBrowsers(event: string, ...args: any[]) {
	const size = roomSize(LOBBY_BROWSER_ROOM);
	if (size === 0) return;
	io.sockets.in(LOBBY_BROWSER_ROOM).emit(event, ...args);
	countEmit(event, size);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface RateLimit {
	capacity: number;
	refillPerSec: number;
}

const RATE_LIMITS: { [event: string]: RateLimit } = {
	// VAD carries *state* (talking / not talking), so a dropped packet leaves a peer's
	// indicator stuck rather than just losing one frame. Real clients emit it in bursts
	// well above any transition rate -- a production server dropped 171 of 213 at 20/s --
	// so this budget only exists to bound a malicious flood. The duplicate suppression in
	// the handler is what actually keeps the broadcast rate down.
	VAD: { capacity: 200, refillPerSec: 100 },
	// Joining a 10-player lobby negotiates with 9 peers at once, which with trickle
	// ICE is a legitimate burst of ~90-130 packets. Dropping one silently breaks
	// that peer link, so this is set well above any real burst -- it exists to stop
	// a flood, not to shape normal traffic. Payload size is capped separately by
	// maxHttpBufferSize.
	signal: { capacity: 400, refillPerSec: 200 },
	join: { capacity: 10, refillPerSec: 5 },
	id: { capacity: 10, refillPerSec: 5 },
	setHost: { capacity: 10, refillPerSec: 5 },
	lobby: { capacity: 10, refillPerSec: 5 },
	remove_lobby: { capacity: 10, refillPerSec: 5 },
	join_lobby: { capacity: 10, refillPerSec: 5 },
	lobbybrowser: { capacity: 4, refillPerSec: 2 },
};

/**
 * Per-socket token bucket. Over-budget packets are dropped silently rather than
 * answered with an error, which would tear the socket down over a burst.
 */
function createRateLimiter() {
	const buckets = new Map<string, { tokens: number; last: number }>();
	return (event: string): boolean => {
		const limit = RATE_LIMITS[event];
		if (!limit) return true;
		const now = Date.now();
		let bucket = buckets.get(event);
		if (!bucket) {
			bucket = { tokens: limit.capacity, last: now };
			buckets.set(event, bucket);
		}
		bucket.tokens = Math.min(limit.capacity, bucket.tokens + ((now - bucket.last) / 1000) * limit.refillPerSec);
		bucket.last = now;
		if (bucket.tokens < 1) return false;
		bucket.tokens -= 1;
		return true;
	};
}

// ---------------------------------------------------------------------------
// Lobby helpers
// ---------------------------------------------------------------------------

function isValidLobbyCode(c: unknown): c is string {
	return typeof c === 'string' && c.length > 0 && c.length <= MAX_LOBBY_CODE_LENGTH && !RESERVED_ROOMS.has(c);
}

const MOBILE_ROOM_SUFFIX = '_mobile';

/** An OBS overlay room: the desktop's obsSecret, 9 chars of uppercase base36. */
const OBS_ROOM = /^[0-9A-Z]{9}$/;

/**
 * The second room a lobby spans. The mobile client discovers the desktop "Mobile
 * Host" in `<CODE>_mobile`, then re-joins the real lobby `<CODE>` for voice.
 *
 * Returns null when the paired name would not itself be a joinable lobby, which is
 * what stops a client joining `lobbybrowser_mobile` -- a perfectly valid code --
 * from pairing into the reserved browser room and reaching every browser client.
 */
function pairedRoom(code: string): string | null {
	const paired = code.endsWith(MOBILE_ROOM_SUFFIX)
		? code.slice(0, -MOBILE_ROOM_SUFFIX.length)
		: code + MOBILE_ROOM_SUFFIX;
	return isValidLobbyCode(paired) ? paired : null;
}

function removePublicLobby(c: string) {
	const lobby = publicLobbies.get(c);
	if (!lobby) return;
	broadcastToBrowsers('remove_lobby', lobby.id);
	lobbyCodes.delete(lobby.id);
	publicLobbies.delete(c);
	lobbyLastSeen.delete(c);
}

app.enable('trust proxy');
app.set('views', join(__dirname, '../views'));
app.use('/public', express.static(join(__dirname, '../public'), { maxAge: '7d', immutable: true }));

// The self-hosted web client, so a player on a phone just opens this server's URL
// (see web/README.md). Serving it here rather than from a second container keeps it
// same-origin with the socket: no CORS, no second certificate, and the client can
// default its "voice server" field to wherever it was loaded from.
const webClientDir = join(__dirname, '../webclient');
const hasWebClient = existsSync(join(webClientDir, 'index.html'));
app.use(
	'/app',
	express.static(webClientDir, {
		maxAge: '7d',
		immutable: true,
		setHeaders: (res, filePath) => {
			// Angular's bundles are content-hashed and safe to cache hard. These are
			// not: a stale ngsw.json pins every returning visitor to an old build.
			if (/(index\.html|ngsw\.json|ngsw-worker\.js|manifest\.webmanifest)$/.test(filePath)) {
				res.setHeader('Cache-Control', 'no-cache');
			}
		},
	})
);
// Angular routes are resolved client-side, so anything still unmatched under /app
// is a deep link into the app rather than a missing file.
app.get('/app/*', (req, res, next) => {
	res.sendFile(join(webClientDir, 'index.html'), (err) => {
		if (err) next();
	});
});
app.set('view engine', 'pug');
app.use(morgan('combined', { skip: (req) => req.url === '/health' }));

let hostname = process.env.HOSTNAME;
if (!hostname && peerConfig.integratedRelay.enabled) {
	logger.error('You must set the HOSTNAME environment variable to use the TURN server.');
	process.exit(1);
}

const turnCredentials = createTurnCredentialProvider(logger);

/**
 * Composed once per credential refresh rather than per connection, so the
 * hot path stays a single frozen object shared by every client.
 *
 * Managed TURN credentials are short-lived, so this can no longer be a boot-time
 * constant -- but it still must not be rebuilt on every connect.
 */
let currentPeerConfig: ClientPeerConfig;
function rebuildPeerConfig() {
	const iceServers: ICEServer[] = [...(peerConfig.iceServers || [])];

	if (turnServer) {
		iceServers.push({
			urls: `turn:${hostname}:${peerConfig.integratedRelay.listeningPort}`,
			username: peerConfig.integratedRelay.defaultUsername,
			credential: peerConfig.integratedRelay.defaultPassword,
		});
	}

	iceServers.push(...turnCredentials.getIceServers());

	currentPeerConfig = Object.freeze({
		forceRelayOnly: peerConfig.forceRelayOnly,
		iceServers,
	});
}
rebuildPeerConfig();
turnCredentials.start(rebuildPeerConfig);

app.get('/', (req, res) => {
	let address = req.protocol + '://' + req.hostname;
	res.render('index', { connectionCount, address, lobbiesCount: allLobbies.size, hasWebClient });
});

app.get('/health', (req, res) => {
	let address = req.protocol + '://' + req.hostname;
	const mem = process.memoryUsage();
	res.json({
		uptime: process.uptime(),
		connectionCount,
		// EIO=3 is the desktop client (socket.io-client v2), EIO=4 the web/mobile one.
		// This is how you tell whether phones are actually landing, and the signal for
		// whether allowEIO3 is still carrying anyone.
		protocols: { ...protocolCounts },
		lobbiesCount: allLobbies.size,
		address,
		name: process.env.NAME,
		// Whether this build actually shipped the web client -- the difference between
		// "phones can join here" and a 404 at /app.
		webClient: hasWebClient,
		publicLobbiesCount: publicLobbies.size,
		browserClients: roomSize(LOBBY_BROWSER_ROOM),
		eventLoopDelayMs: {
			p50: loopDelay.percentile(50) / 1e6,
			p99: loopDelay.percentile(99) / 1e6,
			max: loopDelay.max / 1e6,
		},
		memory: { rss: mem.rss, heapUsed: mem.heapUsed },
		events: { in: eventsIn, emits: emitsOut, recipients: recipientsOut, dropped: droppedEvents },
		// Status only -- never the credential itself.
		turn: turnCredentials.getStatus(),
		iceServerCount: currentPeerConfig.iceServers.length,
	});
});

app.get('/lobbies', (req, res) => {
	res.json(Array.from(publicLobbies.values()));
});

const leaveroom = (socket: IOSocket, code: string | null) => {
	if (!code) {
		return;
	}
	// Unconditional: the old code.length === 4 || 6 guard skipped the leave for any
	// other code, which then also skipped the cleanup below and desynced room state.
	socket.leave(code);

	if (roomSize(code) <= 0) {
		allLobbies.delete(code);
		removePublicLobby(code);
	}
};

io.on('connection', (socket: IOSocket) => {
	connectionCount++;
	const protocol = socket.conn.protocol === 3 ? 'eio3' : 'eio4';
	protocolCounts[protocol]++;
	let code: string | null = null;
	/**
	 * The `<CODE>_mobile` discovery room this socket stays a member of after moving to
	 * `<CODE>`. Only a phone ever has one; see the mobile note in the join handler.
	 */
	let mobileRoom: string | null = null;
	/** Last VAD state broadcast for this socket; null means "unknown, always send". */
	let lastVad: boolean | null = null;
	const allow = createRateLimiter();

	// socket.use() was removed in socket.io v3. onAny still runs ahead of the regular
	// listeners, so counting here keeps the v2 middleware's behaviour of recording
	// every inbound packet -- including events nobody registered a handler for.
	socket.onAny((event: string) => {
		eventsIn[event] = (eventsIn[event] || 0) + 1;
	});

	// onAny cannot stop propagation, though, so the token bucket has to wrap each
	// registration instead. Every handler below MUST go through `on`: one registered
	// straight on `socket` silently loses its rate limit. The exception is
	// 'disconnect', a local lifecycle event that the v2 middleware never saw either.
	const on = (event: string, handler: (...args: any[]) => void) => {
		socket.on(event, (...args: any[]) => {
			if (!allow(event)) {
				// Counted per event rather than in aggregate: a silently dropped signal
				// breaks a peer connection, and that has to be visible on /health.
				droppedEvents[event] = (droppedEvents[event] || 0) + 1;
				return;
			}
			handler(...args);
		});
	};

	socket.emit('clientPeerConfig', currentPeerConfig);

	on('join', (c: string, id: number, clientId: number, isHost?: boolean) => {
		if (!isValidLobbyCode(c) || typeof id !== 'number' || typeof clientId !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid join command: %s %s %s`, socket.id, c, id, clientId);
			return;
		}

		// Snapshot the peers already present before joining the room ourselves.
		let otherClients: any = {};
		const existingRoom = io.sockets.adapter.rooms.get(c);
		if (existingRoom) {
			for (let s of existingRoom) {
				if (s !== socket.id) otherClients[s] = clients.get(s);
			}
		}

		// A phone joins `<CODE>_mobile` to find the desktop Mobile Host, then joins `<CODE>`
		// for voice once it has spotted itself in the game state. The host keeps streaming
		// that state to the *room* `<CODE>_mobile` (see the signal handler), so the phone
		// has to stay a member of it. Upstream's server only ever left 4/6-char codes,
		// which is what kept it there; an unconditional leave here hands the phone exactly
		// one gameState and then freezes it.
		if (code !== null && code === c + MOBILE_ROOM_SUFFIX) {
			mobileRoom = code;
		} else {
			if (code != c) leaveroom(socket, code);
			if (mobileRoom) {
				if (mobileRoom !== c) leaveroom(socket, mobileRoom);
				mobileRoom = null;
			}
		}
		code = c;
		lastVad = null;
		socket.join(code);

		const lobby = allLobbies.get(c);
		if (!lobby) {
			allLobbies.set(c, { code: c, hostId: isHost ? clientId : -1 });
		} else {
			if (isHost) {
				lobby.hostId = clientId;
				// Was socket.to(code) with the *previous* code, which is assigned below
				// the original emit, so the v2 adapter dropped the packet entirely.
				broadcastToRoom(socket, c, 'setHost', clientId);
			}
			socket.emit('setHost', lobby.hostId);
		}

		broadcastToRoom(socket, code, 'join', socket.id, {
			playerId: id,
			clientId: clientId,
		});
		socket.emit('setClients', otherClients);
	});

	on('setHost', (c: string, clientId: number) => {
		if (code === c && typeof clientId === 'number') {
			const lobby = allLobbies.get(c);
			if (lobby) {
				lobby.hostId = clientId;
				broadcastToRoom(socket, c, 'setHost', clientId);
			}
		}
	});

	on('id', (id: number, clientId: number) => {
		if (typeof id !== 'number' || typeof clientId !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command: %d %d`, socket.id, id, clientId);
			return;
		}
		let client = clients.get(socket.id);
		if (client != null && client.clientId != null && client.clientId !== clientId) {
			///			socket.disconnect();
			logger.error(
				`Socket ${socket.id}->${client.clientId}->${clientId}->${id} sent invalid id command, attempted spoofing another client`
			);
			//			return;
		}
		client = {
			playerId: id,
			clientId: clientId,
		};
		clients.set(socket.id, client);
		if (code) broadcastToRoom(socket, code, 'setClient', socket.id, client);
	});

	on('leave', () => {
		if (code) {
			leaveroom(socket, code);
			// Was never reset, so the socket kept broadcasting into a room it had left.
			code = null;
		}
		leaveroom(socket, mobileRoom);
		mobileRoom = null;
		lastVad = null;
		clients.delete(socket.id);
	});

	on('VAD', (activity: boolean) => {
		if (typeof activity !== 'boolean') return;
		// Clients re-send the current state continuously rather than only on change, so
		// collapse repeats: only a genuine transition is worth a room-wide broadcast.
		// This bounds fan-out by how often someone actually starts or stops talking,
		// without adding any latency to the transition itself.
		if (activity === lastVad) return;
		lastVad = activity;

		let client = clients.get(socket.id);
		if (code && client) {
			broadcastToRoom(socket, code, 'VAD', {
				activity,
				client,
				socketId: socket.id,
			});
		}
	});

	on('join_lobby', (id: number, callbackFn) => {
		if (typeof callbackFn !== 'function') return;
		//ban check etc...
		const lobbyCode = lobbyCodes.get(id);
		const publicLobby = lobbyCode !== undefined ? publicLobbies.get(lobbyCode) : undefined;
		if (lobbyCode !== undefined && publicLobby) {
			if (publicLobby.isPublic && publicLobby.gameState === GameState.LOBBY) {
				callbackFn(0, lobbyCode, publicLobby.server, publicLobby);
				return;
			} else {
				callbackFn(1, 'Lobby is not public anymore');
				return;
			}
		}
		callbackFn(1, 'Lobby not found :C');
	});

	on('lobby', (c: string, publicLobby: PublicLobby) => {
		if (code != c) {
			logger.error(`Got request to host lobby while not in it %s`, c, code);
			return;
		}
		if (typeof publicLobby !== 'object' || publicLobby === null) return;
		if (!publicLobby.isPublic && !publicLobby.isPublic2) {
			removePublicLobby(c);
		} else {
			const publobby = publicLobbies.has(c) ? publicLobbies.get(c) : undefined;
			const id = publobby ? publobby.id : lobbyCount++;
			const stateTime =
				publobby &&
				((publobby.gameState === GameState.LOBBY && publicLobby.gameState === GameState.LOBBY) ||
					(publobby.gameState !== GameState.LOBBY && publicLobby.gameState !== GameState.LOBBY))
					? publobby.stateTime
					: Date.now();
			let lobby: PublicLobby = {
				id,
				title: publicLobby.title?.substring(0, 20) ?? 'ERROR',
				host: publicLobby.host?.substring(0, 10) ?? '',
				current_players: publicLobby.current_players ?? 0,
				max_players: publicLobby.max_players ?? 0,
				language: publicLobby.language?.substring(0, 5) ?? '',
				mods: publicLobby.mods?.substring(0, 20)?.toUpperCase() ?? '',
				isPublic: publicLobby.isPublic || publicLobby.isPublic2,
				server: publicLobby.server,
				gameState: publicLobby.gameState,
				stateTime,
			};
			lobbyCodes.set(id, c);
			publicLobbies.set(c, lobby);
			lobbyLastSeen.set(c, Date.now());
			broadcastToBrowsers('update_lobby', lobby);
		}
	});

	on('remove_lobby', (c: string) => {
		if (code != c) {
			logger.error(`Got request to host lobby while not in it %s`, c, code);
			return;
		}
		removePublicLobby(c);
	});

	on('signal', (signal: Signal) => {
		if (typeof signal !== 'object' || !signal.data || !signal.to || typeof signal.to !== 'string') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid signal command: %j`, socket.id, signal);
			return;
		}
		const { to, data } = signal;
		// Desktop 3.2+ reads `client` off every signal and dereferences it when an offer
		// creates the answering peer (ConnectionController createPeerConnection). Without
		// it that throws as soon as the receiver knows 2+ other peers, the offer is lost,
		// and nobody in a 3+ player lobby ever hears anyone. Older clients ignore it.
		const client = clients.get(socket.id);

		// The desktop's OBS overlay feed: BetterCrewlink-obs joins a room named after the
		// 9-char obsSecret, and the desktop streams to it with `signal { to: obsSecret }` --
		// a room name, from outside that room. Among Us codes are 4 or 6 characters and
		// the reserved/mobile rooms are longer, so this shape only ever names an overlay,
		// and reaching one needs its secret. Checked before the lobby guard so the final
		// MENU frame still reaches the overlay after the desktop has left its lobby.
		if (OBS_ROOM.test(to) && to !== code && !socket.rooms.has(to)) {
			const size = roomSize(to);
			if (size === 0) return;
			socket.to(to).emit('signal', { data, from: socket.id });
			countEmit('signal', size);
			return;
		}

		// `to === code` closes the corner where a client joins a lobby named after
		// somebody's socket id, since every socket also sits in a room named by its own id.
		if (!code || to === code) return;

		// The desktop Mobile Host addresses the discovery room by *name* -- Voice.tsx
		// notifyMobilePlayers() and its gameState tick both send `to: code + '_mobile'`.
		// It never learns a phone's socket id. This is the one place a room name is
		// accepted, and only in this direction: a socket in `<CODE>` reaching the
		// `<CODE>_mobile` half of its own lobby. Getting into either half already needs
		// the lobby code, so this grants no new reach -- unlike the old unvalidated `to`,
		// which could name 'lobbybrowser' and fan a payload out to every browser client.
		if (to === code + MOBILE_ROOM_SUFFIX && isValidLobbyCode(to)) {
			socket.to(to).emit('signal', { data, from: socket.id, client });
			countEmit('signal', roomSize(to) - (socket.rooms.has(to) ? 1 : 0));
			return;
		}

		// Anything else must resolve to a live socket in the sender's lobby, which is
		// what stops a peer in another lobby being forced into a connection attempt
		// that exposes their IP.
		const target = io.sockets.sockets.get(to);
		if (!target) return;
		const paired = pairedRoom(code);
		// The pair is crossed by socket id in one case: the phone, still only in
		// `<CODE>_mobile`, answers the host's broadcast with `askingForHost` addressed
		// to the host's socket id -- and the host sits in `<CODE>`. Allowing the paired
		// room grants no new reach either, for the same reason as above.
		if (!target.rooms.has(code) && !(paired && paired !== to && target.rooms.has(paired))) return;
		io.to(to).emit('signal', {
			data,
			from: socket.id,
			client,
		});
		countEmit('signal', 1);
	});

	on('lobbybrowser', (open) => {
		if (!open) {
			socket.leave(LOBBY_BROWSER_ROOM);
		} else {
			socket.join(LOBBY_BROWSER_ROOM);
			// Was io.sockets.in(...), which re-sent the entire lobby list to *every*
			// browser client whenever any one of them opened the browser.
			socket.emit('new_lobbies', Array.from(publicLobbies.values()));
			countEmit('new_lobbies', 1);
		}
	});

	socket.on('disconnect', () => {
		leaveroom(socket, code);
		code = null;
		leaveroom(socket, mobileRoom);
		mobileRoom = null;
		clients.delete(socket.id);
		connectionCount--;
		protocolCounts[protocol]--;

		// if (turnServer) {
		// 	logger.info(`Removing socket "${socket.id}" as TURN user.`);
		// 	turnServer.removeUser(socket.id);
		// }
	});
});

// ---------------------------------------------------------------------------
// Periodic tasks
// ---------------------------------------------------------------------------

// Replaces the accidental full-state resync that the old per-open broadcast
// provided, at a bounded rate rather than once per browser-open.
setInterval(() => {
	if (roomSize(LOBBY_BROWSER_ROOM) === 0) return;
	broadcastToBrowsers('new_lobbies', Array.from(publicLobbies.values()));
}, BROWSER_RESYNC_INTERVAL_MS).unref();

// Safety net for orphaned browser entries. leaveroom already drops a public lobby
// when its room empties, so this only catches entries that outlived their room.
//
// A lobby whose room still has members is LIVE and must never be evicted, even if
// nobody has re-advertised it recently: hosts only emit `lobby` on state change, so
// a lobby sitting idle waiting for players would otherwise delist itself -- which is
// exactly the lobby that most needs to stay listed.
setInterval(() => {
	const cutoff = Date.now() - LOBBY_TTL_MS;
	for (const entry of lobbyLastSeen) {
		if (roomSize(entry[0]) > 0) continue;
		if (entry[1] < cutoff) removePublicLobby(entry[0]);
	}
}, LOBBY_SWEEP_INTERVAL_MS).unref();

// Periodic summary instead of a log line (and a tracer stack capture) on every
// connect and disconnect.
setInterval(() => {
	logger.info(
		'Total connected: %d in %d lobbies (%d public, %d browsers), loop p99 %sms',
		connectionCount,
		allLobbies.size,
		publicLobbies.size,
		roomSize(LOBBY_BROWSER_ROOM),
		(loopDelay.percentile(99) / 1e6).toFixed(1)
	);
}, STATS_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
	logger.error('Unhandled rejection: %s', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
	logger.error('Uncaught exception: %s', err.stack || err.message);
});

let shuttingDown = false;
function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info('Received %s, shutting down', signal);
	// Without a handler, Node as PID 1 ignores SIGTERM and `docker stop` waits the
	// full grace period before SIGKILL, dropping every client at once.
	const force = setTimeout(() => process.exit(1), 10000);
	force.unref();
	// io.close() force-closes every namespace socket -- which runs the disconnect
	// handler above, so lobby cleanup still happens -- then closes the HTTP server.
	turnCredentials.stop();
	io.close(() => {
		try {
			if (turnServer) turnServer.stop();
		} catch (err) {
			logger.error('Failed to stop TURN server: %s', err);
		}
		process.exit(0);
	});
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(port);
logger.info('BetterCrewLink Server started on port %s', port);
