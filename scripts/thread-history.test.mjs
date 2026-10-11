import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanRolloutFile } from '../lib/chat-cleanup.mjs';
import { repairThreadHistory, staleThreadHistory } from '../lib/thread-history.mjs';

const ID = '01a129ea-5a89-7e92-ac76-b6286b12fc7f';
const OTHER = '01a129ea-0000-7e92-ac76-b6286b12fc7f';
const line = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });

// A Codex home with one Claude chat that Codex has already indexed, plus an
// unrelated chat whose index must survive.
async function codexHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'court-home-'));
  const dir = path.join(home, 'sessions/2026/10/11');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-11T18-43-06-${ID}.jsonl`);
  const chat = [
    line('session_meta', { id: ID }),
    line('turn_context', { model: 'claude-haiku-5-5' }),
    line('response_item', { type: 'reasoning', id: 'rs_msg_011Cfv5PMedNJzwpZDKcRjdu_0', summary: [], encrypted_content: 'anthropic-sealed' }),
    line('response_item', { type: 'message', role: 'assistant', id: 'msg_1', content: [] })
  ].join('\n');
  await fs.writeFile(file, `${chat}\n`);
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER)');
  state.prepare('INSERT INTO threads VALUES (?, ?, 0), (?, ?, 0)').run(ID, file, OTHER, file);
  state.close();
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec(`CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT);
    CREATE TABLE thread_items (thread_id TEXT, item_id TEXT);
    CREATE TABLE thread_realtime_items (thread_id TEXT, item_id TEXT);
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);`);
  for (const id of [ID, OTHER]) {
    history.prepare("INSERT INTO thread_turns VALUES (?, 'turn')").run(id);
    history.prepare("INSERT INTO thread_items VALUES (?, 'item')").run(id);
    history.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, 4)').run(id, id === ID ? (await fs.stat(file)).size : 0);
  }
  history.close();
  return { home, file };
}

function indexed(home) {
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'), { readOnly: true });
  const rows = Object.fromEntries(['thread_turns', 'thread_items', 'thread_history_projection_state'].map((table) => [table, db.prepare(`SELECT thread_id FROM ${table} ORDER BY thread_id`).all().map((row) => row.thread_id)]));
  db.close();
  return rows;
}

test('cleaning a chat file makes Codex rebuild that chat, so its messages stay editable', async () => {
  const { home, file } = await codexHome();
  const backups = path.join(home, 'court-backups');
  assert.equal(await cleanRolloutFile(file, { backupDir: backups }), true);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /rs_msg_011Cfv5PMedNJzwpZDKcRjdu_0/);
  assert.deepEqual(indexed(home), { thread_turns: [OTHER], thread_items: [OTHER], thread_history_projection_state: [OTHER] });
  assert.equal((await fs.readdir(backups)).length, 1);
  assert.deepEqual(await staleThreadHistory(home), []);
});

test('chats an older Court shortened are found and rebuilt once', async () => {
  const { home, file } = await codexHome();
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(`${file}.court-backup`, original);
  await fs.writeFile(file, original.split('\n').filter((entry) => !entry.includes('reasoning')).join('\n'));
  const stale = await staleThreadHistory(home);
  assert.deepEqual(stale.map((entry) => entry.id), [ID]);
  assert.match(stale[0].reasons.join(), /past the end/);
  const result = await repairThreadHistory({ home, backupDir: path.join(home, 'court-backups') });
  assert.deepEqual(result.forgotten, [ID]);
  assert.deepEqual(indexed(home).thread_history_projection_state, [OTHER]);
  assert.deepEqual(await staleThreadHistory(home), []);
  const saved = JSON.parse(await fs.readFile(result.backupFile, 'utf8'));
  assert.equal(saved.rows.thread_turns[0].thread_id, ID);
});
