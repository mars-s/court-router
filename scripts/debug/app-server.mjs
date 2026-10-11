#!/usr/bin/env node
// Talks to the ChatGPT desktop's bundled Codex app-server over JSON-RPC, the
// same API the app's UI uses. Every thread operation the UI performs (list,
// read, resume, revert, rollback, turn/start) can be called and inspected.
// Use --home with a scratch directory to experiment on copied chats.
//
//   node scripts/debug/app-server.mjs [--home DIR] [--notify] [--timeout MS] METHOD 'PARAMS_JSON' [METHOD PARAMS_JSON]...
//
// Example: reproduce "Failed to edit message" on a copy of a chat.
//   node scripts/debug/app-server.mjs --home /tmp/scratch \
//     thread/resume '{"threadId":"ID","excludeTurns":true}' \
//     thread/revert '{"threadId":"ID","beforeTurnId":"TURN"}'
//
// "$thread" in params is replaced with the thread ID from the previous
// result. --until METHOD waits for that notification on the same thread,
// for example --until turn/completed after turn/start.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CODEX = process.env.COURT_CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

const args = process.argv.slice(2);
let home = null;
let notify = false;
let timeout = 60_000;
let until = null;
const calls = [];
while (args.length) {
  const arg = args.shift();
  if (arg === '--home') home = args.shift();
  else if (arg === '--notify') notify = true;
  else if (arg === '--timeout') timeout = Number(args.shift());
  else if (arg === '--until') until = args.shift();
  else calls.push({ method: arg, params: args.shift() || '{}' });
}
if (!calls.length) {
  console.error('Usage: app-server.mjs [--home DIR] [--notify] [--timeout MS] METHOD PARAMS_JSON ...');
  process.exit(2);
}

const child = spawn(CODEX, ['app-server', '--stdio', '-c', 'mcp_servers={}'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: home ? { ...process.env, CODEX_HOME: home } : process.env
});
const pending = new Map();
let sequence = 0;
let threadId = null;
let reached = null;
const untilSeen = new Promise((resolve) => { reached = resolve; });
function failAll(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}
child.on('error', failAll);
child.on('exit', (code) => failAll(new Error(`app-server exited with status ${code}`)));
createInterface({ input: child.stdout }).on('line', (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.method && event.id !== undefined) {
    // The server is asking for approval or input. Refuse so nothing runs unattended.
    child.stdin.write(`${JSON.stringify({ id: event.id, error: { code: -32601, message: 'debug client refuses interactive requests' } })}\n`);
    return;
  }
  if (event.method) {
    if (notify) console.log(JSON.stringify({ notification: event.method, params: event.params }));
    if (event.method === until && (!threadId || event.params?.threadId === threadId)) reached(event.params);
    return;
  }
  const request = pending.get(event.id);
  if (!request) return;
  pending.delete(event.id);
  request.resolve(event);
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

let failed = false;
try {
  const init = await rpc('initialize', { clientInfo: { name: 'court_debug', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  if (init.error) throw new Error(init.error.message);
  child.stdin.write('{"method":"initialized"}\n');
  for (const call of calls) {
    const params = JSON.parse(call.params.replaceAll('$thread', threadId ?? ''));
    const reply = await rpc(call.method, params);
    if (reply.error) failed = true;
    threadId = reply.result?.thread?.id ?? reply.result?.threadId ?? threadId;
    console.log(JSON.stringify({ method: call.method, ...(reply.error ? { error: reply.error } : { result: reply.result }) }, null, 2));
  }
  if (until) {
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`no ${until} within ${timeout}ms`)), timeout));
    console.log(JSON.stringify({ until, params: await Promise.race([untilSeen, timer]) }));
  }
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  child.stdin.end();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  child.kill();
  await exited;
  clearTimeout(timer);
}
process.exit(failed ? 1 : 0);
