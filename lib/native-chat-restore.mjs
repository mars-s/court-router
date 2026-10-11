import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { needsToolBridge } from './tool-bridge.mjs';
import { cleanRolloutFile } from './chat-cleanup.mjs';
import { repairThreadHistory } from './thread-history.mjs';

// Court chats are old `cliproxyapi` threads, or `openai` threads left on a
// Router model. Both must be moved to a GPT model before ChatGPT talks to
// OpenAI directly again. Every chat file also gets the one-time cleanup for
// output saved by older Court versions.
export async function restoreCourtChats(rpc, model, clean = cleanRolloutFile, repair = async () => {}) {
  const threads = new Map();
  const files = new Set();
  for (const archived of [false, true]) {
    let cursor = null;
    do {
      const page = await rpc('thread/list', {
        modelProviders: ['cliproxyapi', 'openai'], archived, cursor, limit: 100,
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
        useStateDbOnly: true
      });
      for (const thread of page.data) {
        if (thread.path) files.add(thread.path);
        if (thread.modelProvider !== 'openai' || needsToolBridge(thread.model)) threads.set(thread.id, { ...thread, archived });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  const failed = [];
  for (const file of files) await clean(file).catch(() => failed.push(file));
  // Older Court versions rewrote chats without resetting Codex's index, so
  // those chats cannot be edited. Rebuild them while ChatGPT is closed.
  await repair().catch(() => failed.push('chat index'));
  let restored = 0;
  for (const thread of threads.values()) {
    try {
      if (thread.archived) await rpc('thread/unarchive', { threadId: thread.id });
      try {
        const result = await rpc('thread/resume', {
          threadId: thread.id, model, modelProvider: 'openai', excludeTurns: true
        });
        if (result.modelProvider !== 'openai' || result.model !== model) {
          throw new Error('ChatGPT settings were not applied');
        }
      } finally {
        if (thread.archived) await rpc('thread/archive', { threadId: thread.id });
      }
      restored++;
    } catch {
      failed.push(thread.id);
    }
  }
  if (failed.length) throw new Error(`Restored ${restored} Court chats, but ${failed.length} could not be restored. Retry switching Court off.`);
  return restored;
}

export async function restoreNativeCourtChats(model, { backupDir, executable = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' } = {}) {
  const child = spawn(executable, ['app-server', '--stdio', '-c', 'mcp_servers={}'], {
    stdio: ['pipe', 'pipe', 'ignore']
  });
  const pending = new Map();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  function failAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }
  child.on('error', failAll);
  child.stdin.on('error', failAll);
  child.on('exit', () => failAll(new Error('Native ChatGPT restore process exited')));
  lines.on('line', (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.method && event.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: event.id, error: { code: -32601, message: 'No interactive actions during account restore' } })}\n`);
      return;
    }
    const request = pending.get(event.id);
    if (!request) return;
    pending.delete(event.id);
    clearTimeout(request.timer);
    if (event.error) request.reject(new Error(event.error.message));
    else request.resolve(event.result);
  });
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native ChatGPT restore timed out during ${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  try {
    await rpc('initialize', {
      clientInfo: { name: 'court_chatgpt_restore', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    child.stdin.write('{"method":"initialized"}\n');
    return await restoreCourtChats(rpc, model,
      (file) => cleanRolloutFile(file, { backupDir }),
      () => repairThreadHistory({ backupDir }));
  } finally {
    failAll(new Error('Restore finished'));
    lines.close();
    if (child.exitCode === null && child.pid) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
  }
}
