import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A fake engine: answers initialize, thread/start and turn/start, and on
// turn/start emits a turn that never completes unless the text says DONE.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'court-bench-test-'));
const fake = path.join(dir, 'codex');
await fs.writeFile(fake, `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({ id: m.id, result: {} });
  if (m.method === 'turn/interrupt') { out({ id: m.id, result: {} }); out({ method: 'interrupted', params: { threadId: m.params.threadId } }); }
  if (m.method === 'die') process.exit(3);
  if (m.method === 'turn/start') {
    const t = m.params.threadId;
    const text = m.params.input[0].text;
    out({ id: m.id, result: { turn: { id: 'turn-' + t } } });
    out({ method: 'turn/started', params: { threadId: t, turn: { id: 'turn-' + t } } });
    out({ method: 'item/completed', params: { threadId: 'other', item: { type: 'agentMessage', text: 'noise' } } });
    out({ method: 'item/completed', params: { threadId: t, item: { type: 'collabAgentToolCall', receiverThreadIds: ['kid-' + t] } } });
    out({ method: 'item/completed', params: { threadId: 'kid-' + t, item: { type: 'agentMessage', text: 'from kid' } } });
    out({ method: 'item/completed', params: { threadId: t, item: { type: 'agentMessage', text: 'hello ' + t } } });
    if (text === 'DONE') out({ method: 'turn/completed', params: { threadId: t, turn: { id: 'turn-' + t, status: 'completed' } } });
  }
});
`, { mode: 0o755 });
process.env.COURT_CODEX_BIN = fake;
const { AppServer, agentText, completedItems, scopeEvents } = await import('./bench/client.mjs');
const { checkSchema, readConfig, CONTRACT } = await import('./bench/drift.mjs');

test.after(() => fs.rm(dir, { recursive: true, force: true }));

test('a turn keeps its own and its helpers\' events, and drops other chats', async () => {
  const engine = new AppServer();
  await engine.start();
  const { turn, events } = await engine.runTurn({ threadId: 'a', input: [{ type: 'text', text: 'DONE' }] });
  assert.equal(turn.status, 'completed');
  assert.equal(agentText(events, 'a'), 'hello a');
  assert.equal(agentText(events, 'kid-a'), 'from kid');
  assert.ok(!events.some((e) => e.params?.threadId === 'other'));
  assert.equal(completedItems(events).length, 3);
  await engine.close();
});

test('a stuck turn times out, gets interrupted, and keeps its trail', async () => {
  const engine = new AppServer();
  await engine.start();
  const sent = [];
  const send = engine.send.bind(engine);
  engine.send = (m) => { sent.push(m.method); send(m); };
  const error = await engine.runTurn({ threadId: 'b', input: [{ type: 'text', text: 'wait' }] }, { timeout: 300 }).catch((e) => e);
  assert.match(error.message, /timed out/);
  assert.ok(error.events.some((e) => e.method === 'turn/started'));
  assert.ok(sent.includes('turn/interrupt'));
  await engine.close();
});

test('calls fail fast after the engine exits, and close is safe twice', async () => {
  const engine = new AppServer();
  await engine.start();
  await assert.rejects(engine.call('die'), /exited/);
  await assert.rejects(engine.call('initialize'), /exited/);
  await engine.close();
  await engine.close();
});

test('scopeEvents follows helpers of helpers', () => {
  const events = [
    { params: { threadId: 'p', item: { receiverThreadIds: ['c'] } } },
    { params: { threadId: 'c', item: { receiverThreadIds: ['g'] } } },
    { params: { threadId: 'g', item: { type: 'x' } } },
    { params: { threadId: 'z', item: { type: 'y' } } }
  ];
  assert.deepEqual(scopeEvents(events, 'p').map((e) => e.params.threadId), ['p', 'c', 'g']);
});

function schemaFrom(contract) {
  const union = (methods) => ({ oneOf: methods.map((m) => ({ properties: { method: { enum: [m] } } })) });
  const definitions = { ThreadItem: { oneOf: Object.entries(contract.items).map(([type, fields]) => ({ properties: { type: { enum: [type] }, ...Object.fromEntries(fields.map((f) => [f, {}])) } })) } };
  for (const [name, fields] of Object.entries(contract.params)) definitions[name] = { properties: Object.fromEntries(fields.map((f) => [f, {}])) };
  return { requests: union(contract.methods), notifications: union(contract.notifications), definitions };
}

test('the contract passes on a matching schema and names each missing piece', () => {
  const schema = schemaFrom(CONTRACT);
  assert.deepEqual(checkSchema(schema), []);
  schema.requests.oneOf = schema.requests.oneOf.filter((v) => v.properties.method.enum[0] !== 'thread/revert');
  delete schema.definitions.TurnStartParams.properties.model;
  schema.definitions.ThreadItem.oneOf = schema.definitions.ThreadItem.oneOf.filter((v) => v.properties.type.enum[0] !== 'webSearch');
  assert.deepEqual(checkSchema(schema), ['method thread/revert', 'TurnStartParams.model', 'item webSearch']);
});

test('extra fields from a newer app do not count as breakage', () => {
  const schema = schemaFrom(CONTRACT);
  schema.requests.oneOf.push({ properties: { method: { enum: ['thread/teleport'] } } });
  schema.definitions.ThreadItem.oneOf.push({ properties: { type: { enum: ['hologram'] } } });
  assert.deepEqual(checkSchema(schema), []);
});

test('the real exported schema satisfies the contract', async (t) => {
  const real = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  if (!(await fs.stat(real).catch(() => null))) return t.skip('ChatGPT app not installed');
  const { execFile } = await import('node:child_process');
  const out = path.join(dir, 'schema');
  await new Promise((resolve, reject) => execFile(real, ['app-server', 'generate-json-schema', '--out', out], (e) => (e ? reject(e) : resolve())));
  const read = async (name) => JSON.parse(await fs.readFile(path.join(out, name), 'utf8'));
  const v2 = await read('codex_app_server_protocol.v2.schemas.json');
  assert.deepEqual(checkSchema({ requests: await read('ClientRequest.json'), notifications: await read('ServerNotification.json'), definitions: v2.definitions }), []);
});

test('readConfig reads only the two keys Court needs', () => {
  const text = 'model = "x"\nopenai_base_url = "http://127.0.0.1:8477/chatgpt"\n[profile]\nmodel_catalog_json = "/tmp/cat.json"\napi_key = "secret"\n';
  assert.deepEqual(readConfig(text), { base: 'http://127.0.0.1:8477/chatgpt', catalog: '/tmp/cat.json' });
  assert.deepEqual(readConfig(''), { base: null, catalog: null });
});
