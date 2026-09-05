import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { Server } from 'http';
import { Server as HttpsServer } from 'https';
import { readFileSync } from 'fs';
import { join } from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import socketIO from 'socket.io';
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

const io = socketIO(server, {
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

function roomSize(room: string | null): number {
	if (!room) return 0;
	const r = io.sockets.adapter.rooms[room];
	return r ? r.length : 0;
}

function countEmit(event: string, recipients: number) {
	emitsOut[event] = (emitsOut[event] || 0) + 1;
	recipientsOut[event] = (recipientsOut[event] || 0) + recipients;
}

/** Broadcast to everyone in the room except the sender, recording fan-out size. */
function broadcastToRoom(socket: socketIO.Socket, room: string, event: string, ...args: any[]) {
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
	VAD: { capacity: 40, refillPerSec: 20 },
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
 * Per-socket token bucket. Over-budget packets are dropped silently: passing an
 * error to next() in socket.io v2 emits an error event and can tear the socket down.
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
	res.render('index', { connectionCount, address, lobbiesCount: allLobbies.size });
});

app.get('/health', (req, res) => {
	let address = req.protocol + '://' + req.hostname;
	const mem = process.memoryUsage();
	res.json({
		uptime: process.uptime(),
		connectionCount,
		lobbiesCount: allLobbies.size,
		address,
		name: process.env.NAME,
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

const leaveroom = (socket: socketIO.Socket, code: string | null) => {
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

io.on('connection', (socket: socketIO.Socket) => {
	connectionCount++;
	let code: string | null = null;
	const allow = createRateLimiter();

	socket.use((packet, next) => {
		const event = packet[0];
		eventsIn[event] = (eventsIn[event] || 0) + 1;
		if (!allow(event)) {
			// Counted per event rather than in aggregate: a silently dropped signal
			// breaks a peer connection, and that has to be visible on /health.
			droppedEvents[event] = (droppedEvents[event] || 0) + 1;
			return;
		}
		next();
	});

	socket.emit('clientPeerConfig', currentPeerConfig);

	socket.on('join', (c: string, id: number, clientId: number, isHost?: boolean) => {
		if (!isValidLobbyCode(c) || typeof id !== 'number' || typeof clientId !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid join command: %s %s %s`, socket.id, c, id, clientId);
			return;
		}

		// Snapshot the peers already present before joining the room ourselves.
		let otherClients: any = {};
		const existingRoom = io.sockets.adapter.rooms[c];
		if (existingRoom) {
			for (let s of Object.keys(existingRoom.sockets)) {
				if (s !== socket.id) otherClients[s] = clients.get(s);
			}
		}

		if (code != c) leaveroom(socket, code);
		code = c;
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

	socket.on('setHost', (c: string, clientId: number) => {
		if (code === c && typeof clientId === 'number') {
			const lobby = allLobbies.get(c);
			if (lobby) {
				lobby.hostId = clientId;
				broadcastToRoom(socket, c, 'setHost', clientId);
			}
		}
	});

	socket.on('id', (id: number, clientId: number) => {
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

	socket.on('leave', () => {
		if (code) {
			leaveroom(socket, code);
			// Was never reset, so the socket kept broadcasting into a room it had left.
			code = null;
		}
		clients.delete(socket.id);
	});

	socket.on('VAD', (activity: boolean) => {
		let client = clients.get(socket.id);
		if (code && client) {
			broadcastToRoom(socket, code, 'VAD', {
				activity,
				client,
				socketId: socket.id,
			});
		}
	});

	socket.on('join_lobby', (id: number, callbackFn) => {
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
			}
		}
		callbackFn(1, 'Lobby not found :C');
	});

	socket.on('lobby', (c: string, publicLobby: PublicLobby) => {
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

	socket.on('remove_lobby', (c: string) => {
		if (code != c) {
			logger.error(`Got request to host lobby while not in it %s`, c, code);
			return;
		}
		removePublicLobby(c);
	});

	socket.on('signal', (signal: Signal) => {
		if (typeof signal !== 'object' || !signal.data || !signal.to || typeof signal.to !== 'string') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid signal command: %j`, socket.id, signal);
			return;
		}
		const { to, data } = signal;
		// `to` was previously unvalidated, so it could name a *room* (e.g.
		// 'lobbybrowser') and fan a payload out to everyone in it, or target a peer
		// in another lobby to force a connection attempt and expose their IP.
		const room = code ? io.sockets.adapter.rooms[code] : null;
		if (!room || !room.sockets[to]) return;
		io.to(to).emit('signal', {
			data,
			from: socket.id,
		});
		countEmit('signal', 1);
	});

	socket.on('lobbybrowser', (open) => {
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
		clients.delete(socket.id);
		connectionCount--;

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
	// v2's io.close() also closes the underlying HTTP server.
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
