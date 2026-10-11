// A small JSON-RPC client for the Codex engine bundled with the ChatGPT
// desktop app (`codex app-server`). The desktop UI talks to this same
// engine, so a turn started here takes the same path as one typed into the
// app: the engine reads ~/.codex/config.toml, sends the request to Court,
// and runs the model's tools.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export const CODEX_BIN = process.env.COURT_CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export class AppServer extends EventEmitter {
  constructor({ home = null, args = [] } = {}) {
    super();
    this.setMaxListeners(0);
    this.child = spawn(CODEX_BIN, ['app-server', '--stdio', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: home ? { ...process.env, CODEX_HOME: home } : process.env
    });
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-8_000); });
    this.exitCode = undefined;
    this.child.on('error', (error) => { this.stderr += `\nspawn error: ${error.message}`; });
    this.child.on('exit', (code, signal) => {
      this.exitCode = code ?? signal;
      for (const { reject } of this.pending.values()) reject(new Error(`app-server exited (${code})`));
      this.pending.clear();
      this.emit('exit', this.exitCode);
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
  }

  receive(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.method && event.id !== undefined) {
      // Approval and input requests. Nothing here should need a person, so
      // refuse; a test that hits one fails visibly.
      this.emit('request', event);
      this.send({ id: event.id, error: { code: -32601, message: 'benchmark refuses interactive requests' } });
      return;
    }
    if (event.method) { this.emit('notification', event); return; }
    const request = this.pending.get(event.id);
    if (!request) return;
    this.pending.delete(event.id);
    if (event.error) request.reject(Object.assign(new Error(event.error.message), { rpc: event.error }));
    else request.resolve(event.result);
  }

  get alive() { return this.exitCode === undefined; }

  send(message) { if (this.alive && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`); }

  call(method, params = {}, timeout = 60_000) {
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error(`app-server exited (${this.exitCode})`)); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.send({ id, method, params });
    });
  }

  async start() {
    const init = await this.call('initialize', { clientInfo: { name: 'court_bench', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    return init;
  }

  // Runs one turn and resolves on its `turn/completed`. Events from other
  // threads are kept only if they belong to helpers this turn started, so
  // parallel checks never see each other's items. On timeout the turn is
  // interrupted, so a stuck check does not keep a model busy.
  runTurn(params, { timeout = 180_000 } = {}) {
    const { threadId } = params;
    const seen = [];
    let turnId = null;
    return new Promise((resolve, reject) => {
      const listener = (event) => {
        const p = event.params || {};
        seen.push(event);
        if (p.threadId !== threadId) return;
        if (event.method === 'turn/started') turnId = p.turn?.id ?? turnId;
        if (event.method === 'turn/completed' && (!turnId || p.turn?.id === turnId)) finish(null, p.turn);
      };
      const timer = setTimeout(() => {
        if (turnId) this.call('turn/interrupt', { threadId, turnId }, 10_000).catch(() => {});
        finish(new Error(`turn timed out after ${timeout}ms`));
      }, timeout);
      let settled = false;
      const finish = (error, turn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('notification', listener);
        const events = scopeEvents(seen, threadId);
        if (error) { error.events = events; reject(error); } else resolve({ turn, events });
      };
      this.on('notification', listener);
      this.call('turn/start', params).then((r) => { turnId ??= r?.turn?.id ?? null; }, (error) => finish(error));
    });
  }

  async close() {
    if (!this.alive) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3_000);
    this.child.kill();
    await exited;
    clearTimeout(timer);
  }
}

// Keeps events from the main thread and from any helper threads it started,
// following helpers of helpers.
export function scopeEvents(events, threadId) {
  const family = new Set([threadId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const event of events) {
      const p = event.params || {};
      if (!family.has(p.threadId)) continue;
      // Claude parents report spawns as collabAgentToolCall, GPT parents as
      // subAgentActivity. Follow both.
      const children = [...(p.item?.receiverThreadIds || []), p.item?.agentThreadId].filter(Boolean);
      for (const child of children) if (!family.has(child)) { family.add(child); grew = true; }
    }
  }
  return events.filter((event) => !event.params?.threadId || family.has(event.params.threadId));
}

// Items finished during a turn, by type. Only the main thread's items.
export function completedItems(events, threadId) {
  return events.filter((event) => event.method === 'item/completed' && (!threadId || event.params?.threadId === threadId)).map((event) => event.params.item);
}

export function agentText(events, threadId) {
  return completedItems(events, threadId).filter((item) => item.type === 'agentMessage').map((item) => item.text).join('\n');
}
