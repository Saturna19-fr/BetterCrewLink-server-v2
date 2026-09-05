import https from 'https';
import { ICEServer } from './ICEServer';

/**
 * Cloudflare Realtime TURN issues short-lived credentials rather than a static
 * username/password, so they have to be minted from the API and refreshed before
 * they expire. This module fetches, caches and refreshes them.
 *
 * If CF_TURN_KEY_ID / CF_TURN_API_TOKEN are not set it is completely inert and
 * the server behaves exactly as it does without it.
 *
 * Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/
 */

const API_HOST = 'rtc.live.cloudflare.com';
const REQUEST_TIMEOUT_MS = 10000;
/** Refresh at half-life, so any credential handed to a client is valid for at least TTL/2. */
const REFRESH_FRACTION = 0.5;
const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 600000;
/** Guard against a misconfigured tiny TTL turning into an API hammer. */
const MIN_TTL_SECONDS = 600;
/** Cloudflare rejects any TTL above 48h; exceeding it would silently drop us to STUN. */
const MAX_TTL_SECONDS = 172800;

interface Logger {
	info: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	error: (...args: any[]) => void;
}

export interface TurnCredentialStatus {
	configured: boolean;
	valid: boolean;
	expiresAt: number | null;
	lastRefreshAt: number | null;
	lastError: string | null;
	consecutiveFailures: number;
}

export interface TurnCredentialProvider {
	/** Begins fetching and refreshing. Never blocks; onUpdate fires when credentials change. */
	start(onUpdate: () => void): void;
	/** Current ICE servers, or an empty array when unconfigured, failed, or expired. */
	getIceServers(): ICEServer[];
	getStatus(): TurnCredentialStatus;
	stop(): void;
}

/**
 * Chrome and Firefox block port 53 and those candidates fail silently, so Cloudflare
 * recommends filtering them server-side. Match the port exactly: their own sample uses
 * `url.includes(':53')`, which also strips `:5349` -- TURN over TLS, the URL that gets
 * players through restrictive corporate firewalls.
 */
function stripPort53(urls: string | string[]): string | string[] {
	if (!Array.isArray(urls)) return urls;
	const kept = urls.filter((url) => !/:53(\?|$)/.test(url));
	// Never hand back an empty list if the shape was unexpected.
	return kept.length > 0 ? kept : urls;
}

/**
 * Parses the API response. Kept as a single function so that a change to
 * Cloudflare's response shape is a one-place fix.
 *
 * generate-ice-servers returns:
 *   { "iceServers": [ { "urls": [...] }, { "urls": [...], "username": "..", "credential": ".." } ] }
 * The older generate endpoint returns a single object rather than an array, so
 * both are accepted.
 */
export function parseIceServers(raw: string): ICEServer[] {
	const parsed = JSON.parse(raw);
	const field = parsed && parsed.iceServers;
	const list: any[] = Array.isArray(field) ? field : field ? [field] : [];

	const servers: ICEServer[] = [];
	for (const entry of list) {
		if (!entry || !entry.urls) continue;
		const server: ICEServer = { urls: stripPort53(entry.urls) };
		if (typeof entry.username === 'string') server.username = entry.username;
		if (typeof entry.credential === 'string') server.credential = entry.credential;
		servers.push(server);
	}

	if (servers.length === 0) {
		throw new Error('response contained no usable iceServers');
	}
	return servers;
}

function requestCredentials(keyId: string, apiToken: string, ttlSeconds: number): Promise<ICEServer[]> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ ttl: ttlSeconds });
		const req = https.request(
			{
				hostname: API_HOST,
				path: `/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiToken}`,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
				},
				timeout: REQUEST_TIMEOUT_MS,
			},
			(res) => {
				let data = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					const status = res.statusCode || 0;
					if (status < 200 || status >= 300) {
						// Error bodies never contain credentials, but truncate anyway.
						reject(new Error(`HTTP ${status}: ${data.substring(0, 200)}`));
						return;
					}
					try {
						resolve(parseIceServers(data));
					} catch (err) {
						reject(new Error(`could not parse response: ${err instanceof Error ? err.message : err}`));
					}
				});
			}
		);
		req.on('error', reject);
		req.on('timeout', () => req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`)));
		req.write(body);
		req.end();
	});
}

export function createTurnCredentialProvider(logger: Logger): TurnCredentialProvider {
	const keyId = process.env.CF_TURN_KEY_ID;
	const apiToken = process.env.CF_TURN_API_TOKEN;
	const configured = !!keyId && !!apiToken;
	const ttlSeconds = Math.min(
		MAX_TTL_SECONDS,
		Math.max(MIN_TTL_SECONDS, Number(process.env.CF_TURN_TTL_SECONDS) || 86400)
	);

	let iceServers: ICEServer[] = [];
	let expiresAt = 0;
	let lastRefreshAt: number | null = null;
	let lastError: string | null = null;
	let consecutiveFailures = 0;
	let timer: NodeJS.Timeout | null = null;
	let stopped = false;

	function schedule(delayMs: number, onUpdate: () => void) {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => refresh(onUpdate), delayMs);
		timer.unref();
	}

	async function refresh(onUpdate: () => void) {
		if (stopped) return;
		try {
			const servers = await requestCredentials(keyId as string, apiToken as string, ttlSeconds);
			iceServers = servers;
			expiresAt = Date.now() + ttlSeconds * 1000;
			lastRefreshAt = Date.now();
			lastError = null;
			consecutiveFailures = 0;
			const relayCount = servers.filter((s) => JSON.stringify(s.urls).indexOf('turn') !== -1).length;
			logger.info(
				'TURN credentials refreshed: %d ICE server entries (%d relay), valid for %dh',
				servers.length,
				relayCount,
				Math.round(ttlSeconds / 3600)
			);
			onUpdate();
			schedule(ttlSeconds * 1000 * REFRESH_FRACTION, onUpdate);
		} catch (err) {
			consecutiveFailures++;
			lastError = err instanceof Error ? err.message : String(err);

			// Never hand out credentials we know are expired: drop back to STUN-only.
			if (Date.now() >= expiresAt && iceServers.length > 0) {
				iceServers = [];
				onUpdate();
			}

			const backoff = Math.min(RETRY_BASE_MS * Math.pow(2, consecutiveFailures - 1), RETRY_MAX_MS);
			logger.error(
				'Failed to fetch TURN credentials (attempt %d): %s. Retrying in %ds. %s',
				consecutiveFailures,
				lastError,
				Math.round(backoff / 1000),
				iceServers.length > 0 ? 'Serving last known-good credentials.' : 'Serving STUN only.'
			);
			schedule(backoff, onUpdate);
		}
	}

	return {
		start(onUpdate: () => void) {
			if (!configured) {
				logger.info('Cloudflare TURN not configured (CF_TURN_KEY_ID / CF_TURN_API_TOKEN unset); using STUN only.');
				return;
			}
			// Deliberately not awaited: the server must start listening regardless.
			refresh(onUpdate);
		},
		getIceServers() {
			if (!configured || Date.now() >= expiresAt) return [];
			return iceServers;
		},
		getStatus() {
			return {
				configured,
				valid: configured && iceServers.length > 0 && Date.now() < expiresAt,
				expiresAt: expiresAt || null,
				lastRefreshAt,
				lastError,
				consecutiveFailures,
			};
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
