#!/usr/bin/env node
// One compact live feed of every layer Court can see:
//   court  - each proxied model request (~/.local/state/court/trace.jsonl,
//            written while ~/.local/state/court/trace.on exists)
//   engine - WARN/ERROR from the app's Codex engine (~/.codex/logs_2.sqlite)
// One line per event, no prompts or payloads, noisy repeats collapsed.
//
//   node scripts/debug/watch.mjs              follow live (Ctrl-C to stop)
//   node scripts/debug/watch.mjs --since 15m  replay the last 15 minutes, then follow
//   node scripts/debug/watch.mjs --once       print and exit
//   --all includes noisy engine targets (MCP reconnects, feature flags)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// node:sqlite prints an experimental warning on load. Keep the feed clean.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => (String(warning).includes('SQLite') ? undefined : emitWarning.call(process, warning, ...rest));
const { DatabaseSync } = await import('node:sqlite');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const units = { s: 1, m: 60, h: 3600 };
const since = (() => { const m = /^(\d+)([smh])$/.exec(value('--since', '0s')); return m ? Number(m[1]) * units[m[2]] : 0; })();
const TRACE = path.join(os.homedir(), '.local', 'state', 'court', 'trace.jsonl');
const LOGS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'logs_2.sqlite');
const NOISY = /rmcp|codex_mcp::|http_client|codex_features|live_writer|exec_server/;
const startAt = Date.now() / 1000 - since;

const clock = (seconds) => new Date(seconds * 1000).toTimeString().slice(0, 8);
const clip = (text, max = 220) => { const s = String(text).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max)}…` : s; };

let last = '';
let repeats = 0;
function emit(line) {
  const key = line.slice(9);
  if (key === last) { repeats++; return; }
  if (repeats) console.log(`         (repeated ${repeats}x)`);
  last = key;
  repeats = 0;
  console.log(line);
}

function courtLine(r) {
  const at = clock(Date.parse(r.at) / 1000);
  if (r.route === 'reveal') return `${at} court reveal ${r.agentMessage || ''} ${r.ok ? `ok ${r.chars} chars` : 'FAILED'}`;
  const sent = r.sent || {};
  const sealed = sent.sealed?.length ? ` sealed=${sent.sealed.join(',')}` : '';
  const agents = sent.types?.agent_message ? ` agent_msgs=${sent.types.agent_message}` : '';
  const problem = r.streamError || r.error || r.failure;
  const ok = r.status === 200 && r.ended === 'response.completed' && !problem;
  return `${at} court ${ok ? 'ok  ' : 'FAIL'} ${r.route} ${sent.model || '?'} ${r.status ?? ''} ${r.ended || ''} items=${sent.items ?? '?'}${agents}${sealed}${problem ? ` :: ${clip(problem)}` : ''}`;
}

let traceOffset = 0;
function readTrace() {
  let size;
  try { size = fs.statSync(TRACE).size; } catch { return; }
  if (size < traceOffset) traceOffset = 0;
  if (size === traceOffset) return;
  const fd = fs.openSync(TRACE, 'r');
  const buffer = Buffer.alloc(size - traceOffset);
  fs.readSync(fd, buffer, 0, buffer.length, traceOffset);
  fs.closeSync(fd);
  const text = buffer.toString('utf8');
  const end = text.lastIndexOf('\n') + 1;
  traceOffset += Buffer.byteLength(text.slice(0, end));
  for (const line of text.slice(0, end).split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (Date.parse(record.at) / 1000 >= startAt) emit(courtLine(record));
    } catch {}
  }
}

let db = null;
let lastId = 0;
function readEngine() {
  try {
    db ??= new DatabaseSync(LOGS, { readOnly: true });
    if (!lastId) lastId = db.prepare('select coalesce(max(id),0) id from logs where ts < ?').get(Math.floor(startAt)).id;
    const rows = db.prepare("select id, ts, level, target, thread_id, feedback_log_body body from logs where id > ? and level in ('WARN','ERROR') order by id limit 500").all(lastId);
    for (const row of rows) {
      lastId = row.id;
      if (!flag('--all') && NOISY.test(row.target)) continue;
      // Bodies start with long tracing span prefixes; keep the message after them.
      const body = String(row.body || '').replace(/^[^\n]*\}:\s?/, '');
      emit(`${clock(row.ts)} engine ${row.level === 'ERROR' ? 'ERR ' : 'warn'} ${row.target.replace(/^codex_/, '')} ${row.thread_id ? row.thread_id.slice(0, 13) : ''} :: ${clip(body)}`);
    }
  } catch (error) {
    if (!db) { console.log(`engine log unavailable: ${error.message}`); db = false; }
  }
}

if (!fs.existsSync(path.join(path.dirname(TRACE), 'trace.on'))) console.log('note: Court tracing is off. Turn on with: touch ~/.local/state/court/trace.on');
const tick = () => { readTrace(); if (db !== false) readEngine(); };
tick();
if (!flag('--once')) setInterval(tick, 1000);
