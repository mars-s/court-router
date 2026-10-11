// Codex keeps a derived index of every chat in thread_history_1.sqlite. The
// index remembers how far into the chat file it has read, as a byte offset.
// When Court rewrites a chat file and makes it shorter, that bookmark points
// at the wrong place, and Codex refuses to edit the chat with "durable rollout
// shrank before projection". Dropping one chat's index makes Codex rebuild it
// from the file the next time the chat is opened. The chat file is untouched.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TABLES = ['thread_items', 'thread_turns', 'thread_realtime_items', 'thread_history_projection_state'];
const THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
export const REINDEXED = '.court-reindexed';

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function threadIdFromFile(file) {
  return path.basename(file).match(THREAD_ID)?.[1] ?? null;
}

async function openDatabase(file, options = {}) {
  // node:sqlite is still marked experimental in Node 22, but works.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, options);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// Drops the derived index for each thread in one transaction. The removed rows
// are saved to backupFile first so the change can be undone. Returns the IDs
// that had any index rows.
export async function forgetThreadHistory(threadIds, { home = codexHome(), backupFile = null } = {}) {
  const ids = [...new Set(threadIds)].filter(Boolean);
  const file = path.join(home, 'thread_history_1.sqlite');
  if (!ids.length || !(await fs.stat(file).catch(() => null))) return [];
  const db = await openDatabase(file);
  try {
    const marks = ids.map(() => '?').join(',');
    const rows = {};
    for (const table of TABLES) rows[table] = db.prepare(`SELECT * FROM ${table} WHERE thread_id IN (${marks})`).all(...ids);
    const found = [...new Set(TABLES.flatMap((table) => rows[table].map((row) => row.thread_id)))];
    if (!found.length) return [];
    if (backupFile) {
      await fs.mkdir(path.dirname(backupFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(backupFile, JSON.stringify({ database: file, savedAt: new Date().toISOString(), rows }), { mode: 0o600 });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of TABLES) db.prepare(`DELETE FROM ${table} WHERE thread_id IN (${marks})`).run(...ids);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return found;
  } finally {
    db.close();
  }
}

// Lists Court's rewrite backups: { threadId, backup, reindexed }.
export async function courtRewrites(home = codexHome()) {
  const rewrites = [];
  for (const dir of ['sessions', 'archived_sessions']) {
    const names = await fs.readdir(path.join(home, dir), { recursive: true }).catch(() => []);
    for (const name of names) {
      if (!name.endsWith('.jsonl.court-backup')) continue;
      const backup = path.join(home, dir, name);
      const threadId = threadIdFromFile(backup.slice(0, -'.court-backup'.length));
      if (!threadId) continue;
      const reindexed = Boolean(await fs.stat(`${backup}${REINDEXED}`).catch(() => null));
      rewrites.push({ threadId, backup, reindexed });
    }
  }
  return rewrites;
}

// Reports chats whose index cannot be trusted: the bookmark is past the end
// of the chat file, or Court rewrote the file and the index was never rebuilt.
export async function staleThreadHistory(home = codexHome()) {
  const rewrites = new Map((await courtRewrites(home)).filter((entry) => !entry.reindexed).map((entry) => [entry.threadId, entry]));
  const db = await openDatabase(path.join(home, 'thread_history_1.sqlite'), { readOnly: true });
  try {
    db.exec(`ATTACH DATABASE 'file:${path.join(home, 'state_5.sqlite').replaceAll("'", "''")}?mode=ro' AS state`);
    const rows = db.prepare(`SELECT p.thread_id AS id, t.rollout_path AS file, t.archived AS archived,
        p.next_rollout_byte_offset AS offset
      FROM thread_history_projection_state p LEFT JOIN state.threads t ON t.id = p.thread_id`).all();
    const stale = [];
    for (const row of rows) {
      const size = row.file ? await fs.stat(row.file).then((stat) => stat.size, () => null) : null;
      const reasons = [];
      if (size !== null && row.offset > size) reasons.push('index is past the end of the chat file');
      if (rewrites.has(row.id)) reasons.push('Court rewrote the chat file after it was indexed');
      if (reasons.length) stale.push({ id: row.id, file: row.file, archived: Boolean(row.archived), size, offset: row.offset, backup: rewrites.get(row.id)?.backup ?? null, reasons });
    }
    return stale;
  } finally {
    db.close();
  }
}

// Rebuilds the index of every stale chat. Marks each Court rewrite as handled,
// so later runs leave rebuilt chats alone.
export async function repairThreadHistory({ home = codexHome(), backupDir, only = null } = {}) {
  let stale = await staleThreadHistory(home);
  if (only) stale = stale.filter((entry) => only.includes(entry.id));
  const backupFile = backupDir && stale.length ? path.join(backupDir, `thread-history-${Date.now()}.json`) : null;
  const forgotten = await forgetThreadHistory(stale.map((entry) => entry.id), { home, backupFile });
  for (const entry of stale) if (entry.backup) await fs.writeFile(`${entry.backup}${REINDEXED}`, '');
  return { stale, forgotten, backupFile };
}
