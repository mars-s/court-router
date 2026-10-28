// Builds the Claude desktop third-party config from what the router serves, with real model names
// and context sizes from models.dev. Writes the import file, and updates the Claude (Gateway) app's
// saved config in place when it exists, so reopening that app picks up model changes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildDesktopConfig, buildModelList, readAliases } from '../lib/claude-desktop.mjs';
import { APP_3P_DIR, APP_NAME, IMPORT_FILE, ROUTER_CONFIG, ROUTER_URL, loadSettings, readApiKey } from './settings.mjs';

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'court', ...headers }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

function writePrivate(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const settings = loadSettings();
const apiKey = readApiKey();
const live = new Set((await getJson(`${ROUTER_URL}/v1/models`, { Authorization: `Bearer ${apiKey}` })).data.map(m => m.id));
const dev = await getJson('https://models.dev/api.json');
const catalogue = { ...dev['opencode-go']?.models, ...dev.openai?.models, ...dev.anthropic?.models };
const aliases = readAliases(readFileSync(ROUTER_CONFIG, 'utf8'));
const models = buildModelList({ live, aliases, catalogue });
const config = buildDesktopConfig({ gatewayUrl: settings.gatewayUrl, apiKey, models, sshHosts: settings.sshHosts });

writePrivate(IMPORT_FILE, config);
const count = tag => models.filter(m => m.labelOverride.endsWith(`· ${tag}`)).length;
console.log(`Wrote ${IMPORT_FILE}: ${models.length} models (${models.length - count('Codex') - count('OpenCode')} Claude, ${count('Codex')} Codex, ${count('OpenCode')} OpenCode)`);

// Seed or update the Claude (Gateway) app's config library, then put it in third-party mode.
const library = path.join(APP_3P_DIR, 'configLibrary');
const metaFile = path.join(library, '_meta.json');
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : null;
const id = meta?.appliedId || randomUUID();
const savedFile = path.join(library, `${id}.json`);
const saved = existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, 'utf8')) : {};
writePrivate(savedFile, { ...saved, ...config });
if (!meta) writePrivate(metaFile, { appliedId: id, entries: [{ id, name: 'court-gateway' }] });

const modeFile = path.join(APP_3P_DIR, 'claude_desktop_config.json');
const mode = existsSync(modeFile) ? JSON.parse(readFileSync(modeFile, 'utf8')) : {};
if (mode.deploymentMode !== '3p') writePrivate(modeFile, { ...mode, deploymentMode: '3p' });
console.log(`Updated the ${APP_NAME} app config. Quit and reopen that app to load it.`);
