#!/usr/bin/env node
// Finds chats whose Codex index no longer matches the chat file. Those chats
// fail to edit with "durable rollout shrank before projection". With --apply,
// drops their index (after saving the rows) so Codex rebuilds it the next time
// each chat opens. Quit ChatGPT before --apply.
//
//   node scripts/debug/chat-index.mjs [--home DIR] [--apply] [THREAD_ID...]

import path from 'node:path';
import os from 'node:os';
import { codexHome, repairThreadHistory, staleThreadHistory } from '../../lib/thread-history.mjs';

const args = process.argv.slice(2);
let home = codexHome();
let apply = false;
const only = [];
while (args.length) {
  const arg = args.shift();
  if (arg === '--home') home = args.shift();
  else if (arg === '--apply') apply = true;
  else only.push(arg);
}
const backupDir = path.join(process.env.COURT_STATE_DIR || path.join(os.homedir(), '.local/state/court'), 'chat-index-backups');

if (!apply) {
  const stale = (await staleThreadHistory(home)).filter((entry) => !only.length || only.includes(entry.id));
  for (const entry of stale) console.log(`${entry.id}  ${entry.archived ? 'archived' : 'active  '}  file=${entry.size} index=${entry.offset}  ${entry.reasons.join('; ')}`);
  console.log(`${stale.length} chat(s) need their index rebuilt.${stale.length ? ' Quit ChatGPT, then rerun with --apply.' : ''}`);
} else {
  const result = await repairThreadHistory({ home, backupDir, only: only.length ? only : null });
  console.log(`Rebuilt the index for ${result.forgotten.length} chat(s).${result.backupFile ? ` Removed rows saved to ${result.backupFile}` : ''}`);
}
