import YAML from 'yaml';
import path from 'path';
import fs from 'fs';
import { ICEServer } from './ICEServer';

const PEER_CONFIG_PATH = path.join(__dirname, '..', 'config', 'peerConfig.yml');

interface IntegratedRelaySettings {
	enabled: boolean;
	listeningIps: string[];
	relayIps: string[];
	externalIps: string[];
	minPort: number;
	maxPort: number;
	listeningPort: number;
	debugLevel: 'OFF' | 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE' | 'ALL';
	defaultUsername: string;
	defaultPassword: string;
}

interface PeerConfig {
	forceRelayOnly: boolean;
	integratedRelay: IntegratedRelaySettings;
	iceServers?: ICEServer[];
}

const DEFAULT_PEER_CONFIG: PeerConfig = {
	forceRelayOnly: false,
	integratedRelay: {
		enabled: false,
		listeningIps: ['0.0.0.0'],
		relayIps: [],
		externalIps : null,
		minPort: 49152,
		maxPort: 65535,
		listeningPort: 3478,
		debugLevel: 'INFO',
		defaultUsername: 'M9DRVaByiujoXeuYAAAG',
		defaultPassword: 'TpHR9HQNZ8taxjb3',
	},
	iceServers: [
		{
			urls: 'stun:stun.l.google.com:19302',
		},
	],
};

let peerConfig = DEFAULT_PEER_CONFIG;
if (fs.existsSync(PEER_CONFIG_PATH)) {
	try {
		peerConfig = YAML.parse(fs.readFileSync(PEER_CONFIG_PATH).toString('utf8'));
	} catch (err) {
		console.error(`Unable to load peer config file. Make sure it is valid YAML.\n${err}`);
	}
}

/**
 * Returns undefined for unset, blank, or unrecognised values so that a variable
 * left empty in a hosting panel is treated as "not configured" rather than false.
 */
function parseBoolEnv(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	if (value === '') return undefined;
	if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
	if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
	console.warn(`Ignoring ${name}: expected a boolean, got "${raw}".`);
	return undefined;
}

// Environment overrides. Container deployments (Docker, Coolify, Heroku) have no
// practical way to mount config/peerConfig.yml, so the settings an operator is
// most likely to need at runtime are also reachable from the environment.
const forceRelayOnly = parseBoolEnv('FORCE_RELAY_ONLY');
if (forceRelayOnly !== undefined) {
	peerConfig.forceRelayOnly = forceRelayOnly;
}

export default peerConfig;
