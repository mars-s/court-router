import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('HTTP proxy preserves session headers, streamed history, compacted context and errors', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'court-proxy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = 'test-router-key';
  const config = path.join(directory, 'router.conf');
  await fs.writeFile(config, `api-keys:\n  - "${key}"\n`);
  const calls = [];
  const router = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    calls.push({ headers: req.headers, request });
    const id = `response-${calls.length}`;
    if (request.input.some((item) => item.content === 'fail upstream')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'rate_limit', message: 'Try later' } }));
    }
    const response = req.url.endsWith('/compact')
      ? { id, output: [{ type: 'compaction', id: 'compact-item', encrypted_content: 'opaque-native-compaction' }] }
      : { id, status: 'completed', output: [{ type: 'message', id: `item-${id}`, role: 'assistant', content: `answer-${calls.length}` }] };
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'test-request' });
      const stream = Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`);
      res.write(stream.subarray(0, 20));
      return res.end(stream.subarray(20));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  t.after(() => new Promise((resolve) => { router.closeAllConnections(); router.close(resolve); }));
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, COURT_PORT: String(port), COURT_STATE_DIR: directory, COURT_ROUTER_CONFIG: config, COURT_ROUTER_URL: `http://127.0.0.1:${router.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('Test proxy failed to start'); })
  ]);
  const url = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'session_id': 'native-session', 'conversation_id': 'native-conversation', 'x-codex-turn-metadata': 'turn-metadata' };
  const send = (body, suffix = '', extra = {}) => fetch(`${url}/v1/responses${suffix}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const first = await send({ model: 'gpt-6.1-sol', input: 'first request', stream: true });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-request-id'), 'test-request');
  assert((await first.text()).includes('response.completed'));
  assert.equal(calls[0].headers.session_id, 'native-session');
  assert.equal(calls[0].headers.conversation_id, 'native-conversation');
  assert.equal(calls[0].headers['x-codex-turn-metadata'], 'turn-metadata');
  const second = await send({ model: 'claude-sonnet-4-6', previous_response_id: 'response-1', input: 'second request' });
  assert.equal(second.status, 200);
  assert.deepEqual(calls[1].request.input.map((item) => item.content), ['first request', 'answer-1', 'second request']);
  assert.equal('previous_response_id' in calls[1].request, false);
  await second.json();
  const compact = await send({ model: 'gpt-6.1-sol', input: 'Original constraint' }, '/compact');
  const compacted = await compact.json();
  const expanded = await send({ model: 'claude-sonnet-4-6', input: [...compacted.output, { role: 'user', content: 'After compaction' }] });
  assert.equal(expanded.status, 200);
  assert.deepEqual(calls[3].request.input.map((item) => item.content), ['Original constraint', 'After compaction']);
  await expanded.json();
  const missing = await send({ model: 'claude-sonnet-4-6', previous_response_id: 'missing', input: 'continue' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'previous_response_not_found');
  assert.equal(calls.length, 4);
  const failed = await send({ model: 'gpt-6.1-sol', input: 'fail upstream' });
  assert.equal(failed.status, 429);
  assert.equal((await failed.json()).error.code, 'rate_limit');
  const compressed = await send({ model: 'gpt-6.1-sol', input: 'hello' }, '', { 'content-encoding': 'gzip' });
  assert.equal(compressed.status, 415);
  const unauthorised = await send({ model: 'gpt-6.1-sol', input: 'hello' }, '', { authorization: 'Bearer wrong-key' });
  assert.equal(unauthorised.status, 401);
});
