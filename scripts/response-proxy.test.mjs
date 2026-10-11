import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import zlib from 'node:zlib';

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
    if (request.stream && request.input.some((item) => item.content === 'bridge me')) {
      const call = { type: 'function_call', id: 'fc_toolu_1', call_id: 'toolu_1', name: 'tool_search', arguments: '{"query":"github"}', status: 'completed' };
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', item_id: call.id, delta: call.arguments },
        { type: 'response.output_item.done', output_index: 0, item: call },
        { type: 'response.completed', response: { id, status: 'completed', output: [call] } }
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    }
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
  const chatgptCalls = [];
  const handoffs = [];
  const chatgpt = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    // Court asks GPT to summarise its own compacted context for the next model.
    if (!req.headers['content-encoding'] && JSON.parse(raw.toString() || '{}').input?.[0]?.type === 'compaction') {
      handoffs.push(JSON.parse(raw.toString()));
      const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'GPT handoff summary' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'h', status: 'completed', output: [] } })}\n\n`);
    }
    chatgptCalls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '12' });
    res.end('data: {"type":"response.completed","response":{"id":"gpt-native","status":"completed","output":[]}}\n\n');
  });
  chatgpt.listen(0, '127.0.0.1');
  await once(chatgpt, 'listening');
  t.after(() => new Promise((resolve) => { chatgpt.closeAllConnections(); chatgpt.close(resolve); }));
  const codexAuth = path.join(directory, 'auth.json');
  const chatgptToken = 'test-chatgpt-token';
  await fs.writeFile(codexAuth, JSON.stringify({ tokens: { access_token: chatgptToken } }));
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, COURT_PORT: String(port), COURT_STATE_DIR: directory, COURT_ROUTER_CONFIG: config, COURT_ROUTER_URL: `http://127.0.0.1:${router.address().port}`, COURT_CHATGPT_URL: `http://127.0.0.1:${chatgpt.address().port}/backend-api/codex`, COURT_CODEX_AUTH: codexAuth, COURT_CODEX_MODELS_CACHE: path.join(directory, 'missing-models.json') },
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
  // GPT's opaque compaction becomes a GPT-written handoff summary for Claude.
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].input[0].encrypted_content, 'opaque-native-compaction');
  assert.equal(calls[3].request.input[0].content[0].text, 'Summary of the earlier conversation:\n\nGPT handoff summary');
  assert.equal(calls[3].request.input[1].content, 'After compaction');
  await expanded.json();
  const missing = await send({ model: 'claude-sonnet-4-6', previous_response_id: 'missing', input: 'continue' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'previous_response_not_found');
  assert.equal(calls.length, 4);
  const failed = await send({ model: 'gpt-6.1-sol', input: 'fail upstream' });
  assert.equal(failed.status, 429);
  assert.equal((await failed.json()).error.code, 'rate_limit');
  const sendRaw = (body, encoding) => fetch(`${url}/v1/responses`, { method: 'POST', headers: { ...headers, 'content-encoding': encoding }, body });
  const zstd = await sendRaw(zlib.zstdCompressSync(JSON.stringify({ model: 'gpt-6.1-sol', input: 'zstd body' })), 'zstd');
  assert.equal(zstd.status, 200);
  await zstd.json();
  assert.equal(calls.at(-1).request.input[0].content, 'zstd body');
  assert.equal(calls.at(-1).headers['content-encoding'], undefined);
  const gzip = await sendRaw(zlib.gzipSync(JSON.stringify({ model: 'gpt-6.1-sol', input: 'gzip body' })), 'gzip');
  assert.equal(gzip.status, 200);
  await gzip.json();
  assert.equal((await sendRaw('{}', 'compress')).status, 415);
  assert.equal((await sendRaw('not zstd', 'zstd')).status, 400);
  const tools = [
    { type: 'tool_search', execution: 'client', description: 'Find tools.' },
    { type: 'custom', name: 'apply_patch', description: 'Edit files.' }
  ];
  const bridged = await send({ model: 'claude-opus-5-5', input: 'bridge me', tools, stream: true });
  assert.equal(bridged.status, 200);
  const stream = await bridged.text();
  assert.deepEqual(calls.at(-1).request.tools.map((tool) => `${tool.type}:${tool.name}`), ['function:tool_search', 'function:apply_patch']);
  assert(!stream.includes('function_call_arguments'));
  assert(stream.includes('"type":"tool_search_call"'));
  const followUp = await send({ model: 'claude-opus-5-5', previous_response_id: `response-${calls.length}`, input: [
    { type: 'tool_search_output', call_id: 'toolu_1', execution: 'client', tools: [{ type: 'namespace', name: 'mcp__codex_apps__github', tools: [{ type: 'function', name: '_get_repo', defer_loading: true }] }] }
  ], tools });
  assert.equal(followUp.status, 200);
  await followUp.json();
  assert.deepEqual(calls.at(-1).request.input.map((item) => item.type ?? item.role), ['user', 'function_call', 'function_call_output']);
  assert.equal(calls.at(-1).request.tools.at(-1).name, 'mcp__codex_apps__github');
  const unauthorised = await send({ model: 'gpt-6.1-sol', input: 'hello' }, '', { authorization: 'Bearer wrong-key' });
  assert.equal(unauthorised.status, 401);
  // ChatGPT route: GPT passes through untouched, Router models need the ChatGPT token.
  const native = { authorization: `Bearer ${chatgptToken}`, 'chatgpt-account-id': 'account', 'content-type': 'application/json' };
  const upgrade = await new Promise((resolve) => http.get(`${url}/chatgpt/responses`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, resolve));
  assert.equal(upgrade.statusCode, 426);
  upgrade.resume();
  const gptBody = zlib.zstdCompressSync(JSON.stringify({ model: 'gpt-6.1-sol', input: 'native turn', stream: true }));
  const gpt = await fetch(`${url}/chatgpt/responses`, { method: 'POST', headers: { ...native, 'content-encoding': 'zstd' }, body: gptBody });
  assert.equal(gpt.status, 200);
  assert.equal(gpt.headers.get('x-codex-primary-used-percent'), '12');
  assert((await gpt.text()).includes('gpt-native'));
  assert.equal(chatgptCalls[0].url, '/backend-api/codex/responses');
  assert.equal(chatgptCalls[0].headers.authorization, `Bearer ${chatgptToken}`);
  assert.equal(chatgptCalls[0].headers['content-encoding'], 'zstd');
  assert(chatgptCalls[0].body.equals(gptBody));
  const routerCount = calls.length;
  const claude = await fetch(`${url}/chatgpt/responses`, { method: 'POST', headers: native, body: JSON.stringify({ model: 'claude-opus-5-5', previous_response_id: 'gpt-native', input: 'routed turn' }) });
  assert.equal(claude.status, 200);
  await claude.json();
  assert.equal(calls.length, routerCount + 1);
  // The GPT turn was remembered on the way past, so Claude sees it.
  assert.deepEqual(calls.at(-1).request.input.map((item) => item.content), ['native turn', 'routed turn']);
  assert.equal(calls.at(-1).headers.authorization, `Bearer ${key}`);
  assert.equal(calls.at(-1).headers['chatgpt-account-id'], undefined);
  const claudeItem = { type: 'message', id: `item-response-${calls.length}`, role: 'assistant', content: `answer-${calls.length}` };
  const back = await fetch(`${url}/chatgpt/responses`, { method: 'POST', headers: native, body: JSON.stringify({ model: 'gpt-6.1-sol', input: [claudeItem, { role: 'user', content: 'back to GPT' }] }) });
  assert.equal(back.status, 200);
  await back.text();
  // Claude's item ID would be rejected by ChatGPT, so Court removes it.
  assert.deepEqual(JSON.parse(chatgptCalls.at(-1).body).input[0], { type: 'message', role: 'assistant', content: claudeItem.content });
  // GPT always does compaction, even in a Claude stretch, so the chat only
  // ever holds ChatGPT's own compacted context.
  const routerBefore = calls.length;
  const compacting = await fetch(`${url}/chatgpt/responses`, { method: 'POST', headers: native, body: JSON.stringify({ model: 'claude-opus-5-5', input: [claudeItem, { type: 'compaction_trigger' }], stream: true }) });
  assert.equal(compacting.status, 200);
  await compacting.text();
  assert.equal(calls.length, routerBefore);
  const compactRequest = JSON.parse(chatgptCalls.at(-1).body);
  assert.equal(compactRequest.model, 'gpt-6.1-sol');
  assert.equal(compactRequest.input[0].id, undefined);
  assert.equal(compactRequest.input.at(-1).type, 'compaction_trigger');
  const beforeStranger = calls.length;
  const stranger = await fetch(`${url}/chatgpt/responses`, { method: 'POST', headers: { ...native, authorization: `Bearer ${'someone-else'}` }, body: JSON.stringify({ model: 'claude-opus-5-5', input: 'x' }) });
  assert.equal(stranger.status, 401);
  assert.equal(calls.length, beforeStranger);
});
