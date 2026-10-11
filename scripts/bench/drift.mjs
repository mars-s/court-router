// Notices when a ChatGPT desktop update changes something Court relies on.
//
// The full engine protocol is large and changes every release, so this does
// not diff all of it. It checks a short contract: the methods, events, item
// types and fields the benchmark and Court actually use, plus the local
// wiring (config points at Court, Court is up, models are in the catalogue).
//
//   broken  - something we need is gone. The benchmark stops here.
//   changed - versions moved since the last fully green run. Not an error,
//             but the first thing to read when a check fails.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODEX_BIN } from './client.mjs';

const run = promisify(execFile);
const STATE = process.env.COURT_STATE_DIR || path.join(os.homedir(), '.local/state/court');
const BASELINE = path.join(STATE, 'bench', 'contract.json');
const APP_PLIST = process.env.COURT_APP_PLIST || '/Applications/ChatGPT.app/Contents/Info.plist';
export const COURT = process.env.COURT_URL || 'http://127.0.0.1:8477';

export const CONTRACT = {
  methods: ['initialize', 'thread/start', 'thread/delete', 'thread/revert', 'thread/compact/start', 'turn/start', 'turn/interrupt'],
  notifications: ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/started'],
  params: {
    ThreadStartParams: ['model', 'ephemeral', 'cwd', 'approvalPolicy', 'sandbox'],
    TurnStartParams: ['threadId', 'input', 'model'],
    ThreadRevertParams: ['threadId', 'beforeTurnId'],
    TurnInterruptParams: ['threadId', 'turnId']
  },
  // Item type -> fields the checks read.
  items: {
    agentMessage: ['text'],
    commandExecution: ['command', 'exitCode', 'status', 'aggregatedOutput'],
    fileChange: ['changes', 'status'],
    webSearch: ['query', 'results'],
    imageView: ['path'],
    imageGeneration: ['status', 'savedPath'],
    mcpToolCall: ['server', 'tool', 'status', 'error'],
    collabAgentToolCall: ['tool', 'status', 'model', 'receiverThreadIds', 'agentsStates'],
    contextCompaction: []
  }
};

const methodsOf = (union) => (union?.oneOf || union?.anyOf || []).map((v) => v.properties?.method?.enum?.[0]).filter(Boolean);

// Pure: compare an exported schema with the contract. Returns what is missing.
export function checkSchema({ requests, notifications, definitions }, contract = CONTRACT) {
  const missing = [];
  const req = new Set(methodsOf(requests));
  const note = new Set(methodsOf(notifications));
  for (const m of contract.methods) if (!req.has(m)) missing.push(`method ${m}`);
  for (const m of contract.notifications) if (!note.has(m)) missing.push(`notification ${m}`);
  for (const [name, fields] of Object.entries(contract.params)) {
    const props = definitions?.[name]?.properties;
    if (!props) { missing.push(`type ${name}`); continue; }
    for (const f of fields) if (!(f in props)) missing.push(`${name}.${f}`);
  }
  const variants = new Map((definitions?.ThreadItem?.oneOf || []).map((v) => [v.properties?.type?.enum?.[0], v.properties || {}]));
  for (const [type, fields] of Object.entries(contract.items)) {
    const props = variants.get(type);
    if (!props) { missing.push(`item ${type}`); continue; }
    for (const f of fields) if (!(f in props)) missing.push(`item ${type}.${f}`);
  }
  return missing;
}

async function exportSchema() {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'court-schema-'));
  try {
    await run(CODEX_BIN, ['app-server', 'generate-json-schema', '--out', out], { timeout: 20_000 });
    const read = async (name) => JSON.parse(await fs.readFile(path.join(out, name), 'utf8'));
    const v2 = await read('codex_app_server_protocol.v2.schemas.json');
    return { requests: await read('ClientRequest.json'), notifications: await read('ServerNotification.json'), definitions: v2.definitions || v2.$defs || {} };
  } finally { await fs.rm(out, { recursive: true, force: true }); }
}

async function versions() {
  const [cli, app] = await Promise.all([
    run(CODEX_BIN, ['--version'], { timeout: 10_000 }).then((r) => r.stdout.trim(), (e) => `unavailable: ${e.code ?? e.message}`),
    run('/usr/bin/defaults', ['read', APP_PLIST, 'CFBundleShortVersionString'], { timeout: 10_000 }).then((r) => r.stdout.trim(), () => 'unknown')
  ]);
  return { app, cli };
}

// Pure: read the two config keys Court needs. Nothing else is kept.
export function readConfig(text) {
  return {
    base: text.match(/^\s*openai_base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    catalog: text.match(/^\s*model_catalog_json\s*=\s*"([^"]+)"/m)?.[1] ?? null
  };
}

async function wiring(models) {
  const problems = [];
  const text = await fs.readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8').catch(() => '');
  const config = readConfig(text);
  if (!config.base?.startsWith(COURT)) problems.push(`config openai_base_url ${config.base ? 'does not point at Court' : 'is missing'}`);
  let catalog = [];
  try {
    const parsed = JSON.parse(await fs.readFile(config.catalog, 'utf8'));
    catalog = (parsed.models || parsed).map((m) => m.slug || m.id || m.model).filter(Boolean);
  } catch { problems.push('model catalogue unreadable'); }
  for (const m of models) if (catalog.length && !catalog.includes(m)) problems.push(`model ${m} not in catalogue`);
  const up = await fetch(`${COURT}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok, () => false);
  if (!up) problems.push(`Court not answering at ${COURT}`);
  return { problems, catalog };
}

export async function drift({ models = [] } = {}) {
  const [ver, schema, wire] = await Promise.all([versions(), exportSchema().catch((e) => ({ error: e.message })), wiring(models)]);
  const broken = [...wire.problems];
  if (schema.error) broken.push(`schema export failed: ${schema.error.slice(0, 160)}`);
  else broken.push(...checkSchema(schema).map((m) => `app no longer has ${m}`));
  const before = await fs.readFile(BASELINE, 'utf8').then(JSON.parse, () => null);
  const changed = [];
  if (before) for (const key of ['app', 'cli']) if (before[key] !== ver[key]) changed.push(`${key} ${before[key]} -> ${ver[key]}`);
  return { ...ver, catalog: wire.catalog.length, broken, changed, firstRun: !before };
}

// Called only after a full, fully green run.
export async function saveBaseline(report) {
  await fs.mkdir(path.dirname(BASELINE), { recursive: true, mode: 0o700 });
  await fs.writeFile(BASELINE, JSON.stringify({ app: report.app, cli: report.cli, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
}
