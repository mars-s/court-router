// Court now saves Router model output in a shape native ChatGPT accepts. Chats
// written by older Court versions can still hold sealed Router reasoning,
// Router item IDs ChatGPT rejects, and Court's old compaction summaries. This
// one-time migration rewrites those chats with the same rules, so GPT can
// carry on without Court. It runs when Court is switched off.

import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeId, needsToolBridge } from './tool-bridge.mjs';
import { isCourtCompaction, summaryMessage } from './handoff.mjs';
import { REINDEXED, forgetThreadHistory, threadIdFromFile } from './thread-history.mjs';

// IDs that CLIProxyAPI builds from Anthropic message and tool IDs.
const ROUTER_ID = /(?:^|_)(?:msg_01|toolu_01)/;

const PREFIXES = { custom_tool_call: 'ctc', tool_search_call: 'tsc' };

// Returns the same object when nothing needs changing, or null to remove it.
// Reasoning without OpenAI's seal is never valid for ChatGPT.
function cleanItem(item, fromRouter) {
  if (isCourtCompaction(item)) return summaryMessage(item);
  if (item?.type === 'reasoning' && !item.encrypted_content) return null;
  if (!fromRouter && !ROUTER_ID.test(item?.id || '')) return item;
  if (item.type === 'reasoning') return null;
  const prefix = PREFIXES[item.type];
  return prefix && item.id && nativeId(prefix, item.id) !== item.id ? { ...item, id: nativeId(prefix, item.id) } : item;
}

// Returns the cleaned rollout text, or null when nothing needed changing.
export function cleanRollout(text) {
  let model = null;
  let changed = false;
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) return line;
    let entry;
    try { entry = JSON.parse(line); } catch { return line; }
    if (entry.type === 'turn_context') model = entry.payload?.model ?? model;
    if (entry.type === 'response_item' && entry.payload) {
      const item = cleanItem(entry.payload, needsToolBridge(model));
      if (item === entry.payload) return line;
      changed = true;
      return item ? JSON.stringify({ ...entry, payload: item }) : null;
    }
    if (entry.type === 'compacted' && Array.isArray(entry.payload?.replacement_history)) {
      const history = entry.payload.replacement_history.map((item) => cleanItem(item, false));
      if (history.every((item, index) => item === entry.payload.replacement_history[index])) return line;
      changed = true;
      return JSON.stringify({ ...entry, payload: { ...entry.payload, replacement_history: history.filter(Boolean) } });
    }
    return line;
  });
  return changed ? lines.filter((line) => line !== null).join('\n') : null;
}

// The Codex home a chat file lives in: the folder above sessions/.
function homeOf(file) {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    if (['sessions', 'archived_sessions'].includes(path.basename(dir))) return path.dirname(dir);
    dir = path.dirname(dir);
  }
  return null;
}

// Cleans one chat file in place, keeping the original beside it. Codex's
// index of the chat still points into the old, longer file, which breaks
// editing messages, so the index is dropped and Codex rebuilds it.
export async function cleanRolloutFile(file, { backupDir = null } = {}) {
  const text = await fs.readFile(file, 'utf8');
  const cleaned = cleanRollout(text);
  if (cleaned === null) return false;
  const backup = `${file}.court-backup`;
  await fs.copyFile(file, backup);
  await fs.writeFile(file, cleaned);
  const home = homeOf(file);
  const threadId = threadIdFromFile(file);
  if (home && threadId) {
    await forgetThreadHistory([threadId], { home, backupFile: backupDir && path.join(backupDir, `thread-history-${threadId}-${Date.now()}.json`) });
    await fs.writeFile(`${backup}${REINDEXED}`, '');
  }
  return true;
}
