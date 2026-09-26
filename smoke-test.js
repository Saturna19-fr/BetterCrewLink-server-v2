/* Temporary smoke test: verifies the wire protocol still works and the fixes fire. */
const { fork } = require('child_process');
const http = require('http');
const { io: ioClient } = require('socket.io-client');
// Desktop BetterCrewLink is pinned to socket.io-client 2.4.0. Driving a real one is
// the only way to prove allowEIO3 still carries it; a v4 client cannot fake EIO=3.
const ioClientV2 = require('socket.io-client-v2');

const PORT = 19736;
const URL = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function get(path) {
	return new Promise((resolve) => {
		http.get(URL + path, (res) => {
			let d = '';
			res.on('data', (c) => (d += c));
			res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
		}).on('error', () => resolve(null));
	});
}
async function waitForServer() {
	for (let i = 0; i < 60; i++) {
		if (await get('/health')) return true;
		await wait(250);
	}
	return false;
}
/** Connect and wait until the socket is actually established. */
function connect() {
	const s = ioClient(URL, { transports: ['websocket'], forceNew: true });
	// clientPeerConfig arrives immediately on connect, so capture it up front.
	s.peerConfig = new Promise((r) => s.once('clientPeerConfig', r));
	return new Promise((resolve) => s.on('connect', () => resolve(s)));
}
/** Same as connect(), but with the desktop client's generation (EIO=3). */
function connectV2() {
	// Default transports on purpose: this exercises the polling handshake and the
	// websocket upgrade, which is the path desktop clients actually take.
	const s = ioClientV2(URL, { forceNew: true });
	s.peerConfig = new Promise((r) => s.once('clientPeerConfig', r));
	return new Promise((resolve) => s.on('connect', () => resolve(s)));
}
function headers(path, hdrs) {
	return new Promise((resolve) => {
		http.get(URL + path, { headers: hdrs }, (res) => {
			res.resume();
			resolve(res.headers);
		}).on('error', () => resolve({}));
	});
}
function once(sock, ev, ms = 1500) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(undefined), ms);
		sock.once(ev, (...args) => {
			clearTimeout(t);
			resolve(args.length > 1 ? args : args[0]);
		});
	});
}

// The INERT checks below need a server with no TURN provider. Blanking the vars
// explicitly is what makes that true on a developer machine: the server calls
// dotenv.config(), which would otherwise load real credentials out of .env --
// dotenv never overrides a variable that is already set, even to an empty string.
const server = fork('dist/index.js', [], {
	env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', CF_TURN_KEY_ID: '', CF_TURN_API_TOKEN: '' },
	stdio: 'inherit',
});

(async () => {
	check('server became ready', await waitForServer());

	// --- clientPeerConfig on connect ---
	const a = await connect();
	const cfg = await a.peerConfig;
	check('clientPeerConfig sent on connect', !!cfg && Array.isArray(cfg.iceServers), JSON.stringify(cfg));
	const hasTurn = (c) => !!c && c.iceServers.some((s) => JSON.stringify(s.urls).includes('turn'));
	check('INERT no TURN entry when Cloudflare env vars are unset', !hasTurn(cfg));

	// --- A joins first (creates the lobby) ---
	a.emit('join', 'ABCDEF', 1, 101, false);
	const aSetClients = await once(a, 'setClients');
	check('first joiner gets setClients', aSetClients !== undefined && Object.keys(aSetClients).length === 0);
	a.emit('id', 1, 101);
	await wait(200);

	// --- B joins as host: A must receive BOTH join and setHost (the :194 fix) ---
	const b = await connect();
	const aJoin = once(a, 'join');
	const aSetHost = once(a, 'setHost');
	b.emit('join', 'ABCDEF', 2, 202, true);
	const bSetClients = await once(b, 'setClients');
	check('second joiner sees existing peer in setClients', !!bSetClients && Object.keys(bSetClients).length === 1, JSON.stringify(bSetClients));
	check('existing peer receives join broadcast', (await aJoin) !== undefined);
	const hostSeen = await aSetHost;
	check('BUGFIX existing peer receives setHost from joining host', hostSeen === 202, `got ${hostSeen}`);

	// --- setClient relay ---
	const aSetClient = once(a, 'setClient');
	b.emit('id', 2, 202);
	check('id broadcasts setClient to peers', (await aSetClient) !== undefined);

	// --- VAD relay ---
	const bVad = once(b, 'VAD');
	a.emit('VAD', true);
	const vad = await bVad;
	check('VAD relayed to peers', !!vad && vad.activity === true && vad.socketId === a.id, JSON.stringify(vad));

	// --- signal to a peer in the same room works ---
	const bSignal = once(b, 'signal');
	a.emit('signal', { to: b.id, data: 'sdp-payload' });
	const sig = await bSignal;
	check('signal delivered to peer in same room', !!sig && sig.data === 'sdp-payload' && sig.from === a.id);
	// Desktop 3.2 answers an offer with createPeerConnection(from, false, signal.client) and
	// reads client.clientId; a missing `client` threw and killed voice in 3+ player lobbies.
	check('BUGFIX signal carries the sender client for 3.2 desktops',
		!!sig && !!sig.client && sig.client.clientId === 101 && sig.client.playerId === 1, JSON.stringify(sig && sig.client));

	// --- OBS overlay: BetterCrewlink-obs joins a room named after the 9-char obsSecret and the
	// desktop streams to it by room name, from inside its own lobby ---
	const overlay = await connect();
	overlay.emit('join', 'K3Z9Q2M7X', 7, 59001);
	await once(overlay, 'setClients');
	let bObs = 0;
	b.on('signal', () => bObs++);
	const obsFrame = once(overlay, 'signal');
	a.emit('signal', { to: 'K3Z9Q2M7X', data: { overlayState: { gameState: 1 } } });
	const obs = await obsFrame;
	await wait(200);
	check('BUGFIX desktop OBS feed reaches the overlay room', !!obs && !!obs.data.overlayState && obs.from === a.id,
		JSON.stringify(obs));
	check('OBS feed is not fanned out to the sender\'s lobby', bObs === 0, `b got ${bObs}`);
	overlay.close();

	// --- lobby browser: only the opener gets new_lobbies (the :334 fix) ---
	const br1 = await connect();
	const br2 = await connect();
	br1.emit('lobbybrowser', true);
	const br1First = await once(br1, 'new_lobbies');
	check('browser opener receives new_lobbies', br1First !== undefined);
	let br1Extra = 0;
	br1.on('new_lobbies', () => br1Extra++);
	br2.emit('lobbybrowser', true);
	const br2First = await once(br2, 'new_lobbies');
	check('second browser opener receives new_lobbies', br2First !== undefined);
	await wait(400);
	check('BUGFIX opening the browser does NOT re-broadcast to other browsers', br1Extra === 0, `br1 got ${br1Extra} extra`);

	// --- public lobby advertisement reaches browsers ---
	const brUpdate = once(br1, 'update_lobby');
	b.emit('lobby', 'ABCDEF', {
		title: 'Test Lobby', host: 'Host', current_players: 2, max_players: 10,
		language: 'EN', mods: 'none', isPublic: true, server: 'eu', gameState: 0, stateTime: Date.now(),
	});
	const upd = await brUpdate;
	check('update_lobby broadcast to browsers', !!upd && upd.title === 'Test Lobby', JSON.stringify(upd));

	// --- SECURITY: signal aimed at a room name must not fan out ---
	let brSignal = 0;
	br1.on('signal', () => brSignal++);
	a.emit('signal', { to: 'lobbybrowser', data: 'amplify' });
	await wait(400);
	check('SECURITY signal to a room name is not relayed', brSignal === 0, `browser got ${brSignal} signals`);

	// --- SECURITY: signal to a socket in another lobby must not be relayed ---
	let br2Signal = 0;
	br2.on('signal', () => br2Signal++);
	a.emit('signal', { to: br2.id, data: 'cross-lobby' });
	await wait(400);
	check('SECURITY signal to a peer outside the room is not relayed', br2Signal === 0);

	// --- leave then VAD must not broadcast (the code-reset fix) ---
	let bVadAfterLeave = 0;
	b.on('VAD', () => bVadAfterLeave++);
	a.emit('leave');
	await wait(200);
	a.emit('VAD', true);
	await wait(400);
	check('BUGFIX no broadcast into a room after leave', bVadAfterLeave === 0, `got ${bVadAfterLeave}`);

	// --- SECURITY: joining the reserved room is rejected ---
	const evil = await connect();
	const evilDisc = once(evil, 'disconnect', 1500);
	evil.emit('join', 'lobbybrowser', 9, 909, false);
	check('SECURITY join("lobbybrowser") is rejected', (await evilDisc) !== undefined);

	// --- health endpoint ---
	const health = await get('/health');
	check('health endpoint responds with metrics', !!health && health.eventLoopDelayMs !== undefined && health.events !== undefined,
		health ? `conn=${health.connectionCount} lobbies=${health.lobbiesCount} public=${health.publicLobbiesCount} p99=${health.eventLoopDelayMs.p99.toFixed(2)}ms` : 'no response');

	// --- lobbies endpoint ---
	const lobbies = await get('/lobbies');
	check('lobbies endpoint lists the public lobby', Array.isArray(lobbies) && lobbies.length === 1, JSON.stringify(lobbies));

	check('INERT /health reports TURN unconfigured', !!health && health.turn && health.turn.configured === false,
		health ? JSON.stringify(health.turn) : 'no response');

	// --- response parser: the shape most likely to drift if Cloudflare changes it ---
	const { parseIceServers } = require('./dist/turnCredentials');
	const documented = JSON.stringify({
		iceServers: [
			{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
			{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'p' },
		],
	});
	const parsed = parseIceServers(documented);
	check('parser handles the documented generate-ice-servers shape',
		parsed.length === 2 && parsed[1].username === 'u' && parsed[1].credential === 'p', JSON.stringify(parsed));
	const single = parseIceServers(JSON.stringify({ iceServers: { urls: ['turn:x:3478'], username: 'u', credential: 'p' } }));
	check('parser also accepts a single (non-array) iceServers object', single.length === 1);
	let threw = false;
	try { parseIceServers(JSON.stringify({ iceServers: [] })); } catch (e) { threw = true; }
	check('parser rejects an empty response instead of serving nothing silently', threw);

	// --- degraded path: bad credentials must not crash or block startup ---
	const PORT2 = PORT + 1;
	const server2 = fork('dist/index.js', [], {
		env: { ...process.env, PORT: String(PORT2), NODE_ENV: 'production',
			CF_TURN_KEY_ID: 'bogus-key-id', CF_TURN_API_TOKEN: 'bogus-api-token' },
		stdio: 'inherit',
	});
	const get2 = (path) => new Promise((resolve) => {
		http.get(`http://127.0.0.1:${PORT2}${path}`, (res) => {
			let d = ''; res.on('data', (c) => (d += c));
			res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
		}).on('error', () => resolve(null));
	});
	let h2 = null;
	for (let i = 0; i < 40 && !h2; i++) { h2 = await get2('/health'); if (!h2) await wait(250); }
	check('DEGRADED server still starts with unusable TURN credentials', !!h2);
	const c2 = await new Promise((resolve) => {
		const s2 = ioClient(`http://127.0.0.1:${PORT2}`, { transports: ['websocket'], forceNew: true });
		s2.once('clientPeerConfig', (cfg) => { s2.close(); resolve(cfg); });
		setTimeout(() => { s2.close(); resolve(null); }, 3000);
	});
	check('DEGRADED clients still get STUN when TURN cannot be fetched', !!c2 && !hasTurn(c2), JSON.stringify(c2));
	await wait(1500);
	const h2b = await get2('/health');
	check('DEGRADED /health reports configured-but-invalid with an error',
		!!h2b && h2b.turn.configured === true && h2b.turn.valid === false && !!h2b.turn.lastError,
		h2b ? JSON.stringify(h2b.turn) : 'no response');
	check('DEGRADED credential is never exposed on /health',
		!!h2b && !JSON.stringify(h2b).includes('bogus-api-token'));
	server2.kill('SIGKILL');

	// --- protocol compatibility: both client generations, one server ---
	// The web/mobile client is socket.io-client 4.x (EIO=4), desktop BetterCrewLink is
	// 2.4.0 (EIO=3). A server speaking only one leaves the other spinning on
	// "connecting to voice server" with nothing in its logs, so assert both.
	const v2 = await connectV2();
	check('EIO=3 client connects', v2.connected);
	await wait(400);
	check('EIO=3 client upgrades to websocket', v2.io.engine.transport.name === 'websocket',
		v2.io.engine.transport.name);
	check('EIO=3 client receives clientPeerConfig', !!(await v2.peerConfig));

	const hp = await get('/health');
	check('health splits live connections by protocol',
		!!hp && hp.protocols.eio3 === 1 && hp.protocols.eio4 > 0,
		hp ? JSON.stringify(hp.protocols) : 'no response');

	// v2 sent these by default via origins:'*:*'; v4 only sends them because of the
	// explicit cors option, and losing them breaks every browser client silently.
	const cors = await headers('/socket.io/?EIO=4&transport=polling', { Origin: 'https://example.com' });
	check('CORS reflects the browser origin',
		cors['access-control-allow-origin'] === 'https://example.com' &&
			cors['access-control-allow-credentials'] === 'true',
		JSON.stringify(cors['access-control-allow-origin']));

	const v4 = await connect();
	v2.emit('join', 'XPROTO', 1, 101);
	v2.emit('id', 1, 101);
	await wait(150);
	const joinSeen = once(v2, 'join');
	v4.emit('join', 'XPROTO', 2, 202);
	v4.emit('id', 2, 202);
	const joined = await joinSeen;
	// Peer signalling only works because an EIO3 socket's server-side id is the
	// engine.io id the v2 client knows itself by. If that ever drifts, every peer
	// connection breaks while the lobby still looks healthy.
	check('socket id agrees across the protocol boundary',
		Array.isArray(joined) && joined[0] === v4.id, JSON.stringify(joined));

	const sigToV2 = once(v2, 'signal');
	v4.emit('signal', { to: v2.id, data: { hello: 'v4' } });
	const gotV2 = await sigToV2;
	check('signal relays v4 -> v2 with the right sender', !!gotV2 && gotV2.from === v4.id);

	const sigToV4 = once(v4, 'signal');
	v2.emit('signal', { to: v4.id, data: { hello: 'v2' } });
	check('signal relays v2 -> v4', !!(await sigToV4));

	// --- mobile: the real Mobile Host protocol, host on the desktop generation ---
	// Desktop Voice.tsx never joins <CODE>_mobile and never learns a phone's socket id:
	// it stays in <CODE> and addresses the *room* <CODE>_mobile by name in signal.to,
	// both for the 5s mobileHostInfo beacon and the gameState stream. The phone joins
	// <CODE>_mobile first, then <CODE> for voice, and must keep receiving the
	// room-addressed stream after it moves. A production server that got either half
	// wrong showed as signal in=91 / emits=0 on /health and a phone stuck forever on
	// "Searching for bettercrewlink PC players".
	const host = await connectV2();
	const phone = await connect();
	const pc2 = await connect();
	host.emit('join', 'MOBILE1', 3, 303, true);
	host.emit('id', 3, 303);
	pc2.emit('join', 'MOBILE1', 6, 606);
	pc2.emit('id', 6, 606);
	phone.emit('join', 'MOBILE1_mobile', Date.now(), Date.now()); // what the client sends
	await wait(200);

	const hostHello = once(phone, 'signal');
	host.emit('signal', { to: 'MOBILE1_mobile', data: { mobileHostInfo: { isHostingMobile: true, isGameHost: true } } });
	const hello = await hostHello;
	check('BUGFIX room-addressed mobileHostInfo reaches the phone in <CODE>_mobile',
		!!hello && hello.from === host.id && !!hello.data.mobileHostInfo, JSON.stringify(hello));

	const askSeen = once(host, 'signal');
	phone.emit('signal', { to: host.id, data: { mobilePlayerInfo: { code: 'MOBILE1', askingForHost: true } } });
	const ask = await askSeen;
	check('phone in <CODE>_mobile can ask the host in <CODE> by socket id', !!ask && ask.from === phone.id);

	const hostSeesPhone = once(host, 'join');
	phone.emit('join', 'MOBILE1', 7, 707); // the phone moves to the voice room
	check('phone joins the voice room and the host sees it', (await hostSeesPhone) !== undefined);

	let pc2Leak = 0;
	pc2.on('signal', () => pc2Leak++);
	const gameState = once(phone, 'signal');
	host.emit('signal', { to: 'MOBILE1_mobile', data: { gameState: 1, lobbySettings: {} } });
	const gs = await gameState;
	check('BUGFIX phone still receives the room-addressed gameState after joining <CODE>', !!gs && !!gs.data.gameState);
	await wait(300);
	check('room-addressed gameState is not fanned out to desktop peers in <CODE>', pc2Leak === 0, `pc2 got ${pc2Leak}`);

	// --- SECURITY: room addressing works in exactly one direction ---
	let hostLeak = 0;
	host.on('signal', () => hostLeak++);
	const rogue = await connect();
	rogue.emit('join', 'MOBILE1_mobile', 8, 808);
	await wait(150);
	rogue.emit('signal', { to: 'MOBILE1', data: 'fan-out' });
	await wait(300);
	check('SECURITY a socket in <CODE>_mobile cannot fan out to the <CODE> room',
		hostLeak === 0 && pc2Leak === 0, `host got ${hostLeak}, pc2 got ${pc2Leak}`);

	// --- leaving drops the discovery room too, so lobbiesCount does not creep ---
	const before = await get('/health');
	phone.emit('leave');
	rogue.emit('leave');
	await wait(300);
	const after = await get('/health');
	check('BUGFIX leave drops the discovery room as well as the voice room',
		!!before && !!after && before.lobbiesCount - after.lobbiesCount === 1,
		`${before && before.lobbiesCount} -> ${after && after.lobbiesCount}`);
	check('mobile stream stays inside the signal rate budget',
		!!after && after.events.dropped.signal === undefined, after ? JSON.stringify(after.events.dropped) : 'no response');

	const browser3 = await connect();
	browser3.emit('lobbybrowser', true);
	const sneaky = await connect();
	sneaky.emit('join', 'lobbybrowser_mobile', 5, 505);
	await wait(150);
	const leak = once(browser3, 'signal', 700);
	sneaky.emit('signal', { to: browser3.id, data: { evil: true } });
	check('SECURITY lobbybrowser_mobile does not pair into the reserved browser room', !(await leak));

	for (const s of [v2, v4, host, phone, pc2, rogue, browser3, sneaky]) s.close();
	await wait(200);

	// --- graceful shutdown on SIGTERM ---
	for (const s of [a, b, br1, br2, evil]) s.close();
	await wait(200);
	if (process.platform === 'win32') {
		console.log('SKIP  graceful shutdown on SIGTERM -- not deliverable on Windows; verify on Linux/Docker');
		server.kill('SIGKILL');
	} else {
		const exited = await new Promise((resolve) => {
			const t = setTimeout(() => resolve(false), 5000);
			server.once('exit', (c) => { clearTimeout(t); resolve(c === 0); });
			server.kill('SIGTERM');
		});
		check('graceful shutdown on SIGTERM (exit 0)', exited);
	}

	const failed = results.filter((r) => !r.pass);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	process.exit(failed.length ? 1 : 0);
})().catch((e) => {
	console.error(e);
	server.kill('SIGKILL');
	process.exit(1);
});
