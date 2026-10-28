// Paths and personal settings for the Claude workflow. Personal values (the tailnet address,
// SSH hosts) live in Court's private state folder, never in the repository.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
export const STATE_DIR = process.env.COURT_STATE_DIR || path.join(HOME, '.local', 'state', 'court');
export const AUTH_DIR = process.env.COURT_AUTH_DIR || path.join(HOME, '.cli-proxy-api');
export const ROUTER_CONFIG = process.env.COURT_ROUTER_CONFIG || '/opt/homebrew/etc/cliproxyapi.conf';
export const ROUTER_URL = process.env.COURT_ROUTER_URL || 'http://127.0.0.1:8317';
export const SETTINGS_FILE = path.join(STATE_DIR, 'claude.json');
export const KEY_FILE = path.join(AUTH_DIR, 'desktop-gateway.key');
export const IMPORT_FILE = path.join(AUTH_DIR, 'claude-desktop-3p.json');
export const APP_NAME = 'Claude (Gateway)';
// The desktop app keeps third-party state in a sibling of its --user-data-dir with -3p on the end.
export const APP_DATA_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude-Gateway');
export const APP_3P_DIR = `${APP_DATA_DIR}-3p`;

const DEFAULTS = {
  // The address the desktop app and remote machines use to reach the gateway.
  gatewayUrl: ROUTER_URL,
  sshHosts: [],
  // Runs web searches for OpenCode models, which cannot search themselves.
  searchModel: 'gpt-6.1-sol',
  relayPort: 8318
};

export function loadSettings() {
  const saved = existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) : {};
  return { ...DEFAULTS, ...saved };
}

export function readApiKey() {
  if (!existsSync(KEY_FILE)) {
    throw new Error(`No gateway key at ${KEY_FILE}. Add a key to the api-keys list in ${ROUTER_CONFIG} and save it there (mode 600).`);
  }
  return readFileSync(KEY_FILE, 'utf8').trim();
}
