/* Temporary smoke test: verifies the wire protocol still works and the fixes fire. */
const { fork } = require('child_process');
const http = require('http');
const ioClient = require('socket.io-client');

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
function once(sock, ev, ms = 1500) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(undefined), ms);
		sock.once(ev, (...args) => {
			clearTimeout(t);
			resolve(args.length > 1 ? args : args[0]);
		});
	});
}

const server = fork('dist/index.js', [], { env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' }, stdio: 'inherit' });

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
