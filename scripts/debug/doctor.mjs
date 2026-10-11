#!/usr/bin/env node
// One snapshot of every layer between the ChatGPT app and the models:
// Court, the Router, the Codex config, the chat index, Court's trace, and
// recent errors from the desktop app's own log.
//
//   node scripts/debug/doctor.mjs

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexHome, staleThreadHistory } from '../../lib/thread-history.mjs';

const state = process.env.COURT_STATE_DIR || path.join(os.homedir(), '.local/state/court');
const court = `http://127.0.0.1:${process.env.COURT_PORT || 8477}`;
const router = process.env.COURT_ROUTER_URL || 'http://127.0.0.1:8317';
const home = codexHome();

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return `${response.status}`;
  } catch (error) { return `down (${error.cause?.code || error.message})`; }
}

console.log(`Court   ${court}/health -> ${await probe(`${court}/health`)}`);
console.log(`Router  ${router}/v1/models -> ${await probe(`${router}/v1/models`)}`);
const mode = await fs.readFile(path.join(home, 'config.toml'), 'utf8').catch(() => '');
console.log(`Config  model=${mode.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? '?'} base_url=${mode.match(/^openai_base_url\s*=\s*"([^"]+)"/m)?.[1] ?? 'ChatGPT default'}`);

const stale = await staleThreadHistory(home).catch((error) => { console.log(`Index   unreadable: ${error.message}`); return []; });
console.log(`Index   ${stale.length} chat(s) cannot be edited until their index is rebuilt (scripts/debug/chat-index.mjs)`);

const traceOn = process.env.COURT_TRACE === '1' || Boolean(await fs.stat(path.join(state, 'trace.on')).catch(() => null));
console.log(`Trace   ${traceOn ? 'on' : `off (touch ${path.join(state, 'trace.on')} to record requests)`}`);
const traces = (await fs.readFile(path.join(state, 'trace.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
for (const line of traces.slice(-5)) {
  const entry = JSON.parse(line);
  console.log(`        ${entry.at} ${entry.route} ${entry.sent?.model ?? ''} ${entry.status ?? entry.failure}${entry.error ? ` ${entry.error.slice(0, 160)}` : ''}`);
}

const logs = path.join(os.homedir(), 'Library/Logs/com.openai.codex');
const files = (await fs.readdir(logs, { recursive: true }).catch(() => [])).filter((name) => name.endsWith('.log')).map((name) => path.join(logs, name));
const stats = await Promise.all(files.map(async (file) => ({ file, time: (await fs.stat(file)).mtimeMs })));
const newest = stats.sort((a, b) => b.time - a.time)[0];
if (newest) {
  const errors = (await fs.readFile(newest.file, 'utf8')).split('\n').filter((line) => /error|failed/i.test(line) && !/level=debug/.test(line)).slice(-8);
  console.log(`App log ${newest.file}`);
  for (const line of errors) console.log(`        ${line.slice(0, 220)}`);
}
