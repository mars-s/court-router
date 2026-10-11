import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResponseHistory, ResponseEventReader } from '../lib/response-history.mjs';

const message = (role, content) => ({ type: 'message', role, content });
const reply = (id, output, status = 'completed') => ({ id, status, output });

async function fixture(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'court-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, history: new ResponseHistory(directory, options) };
}

test('GPT to Claude to GPT keeps messages and tool results, with reasoning owned by its provider', async (t) => {
  const { directory, history } = await fixture(t);
  const first = await history.prepare({ model: 'gpt-6.1-sol', instructions: 'Keep the user constraints.', input: [message('user', 'Use Australian English.')] });
  const reasoning = { type: 'reasoning', id: 'gpt-reason', encrypted_content: 'native-openai-context' };
  const call = { type: 'function_call', id: 'tool-item', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"pwd"}' };
  await history.save(first, reply('resp-gpt', [reasoning, call]));
  const toolResult = { type: 'function_call_output', call_id: 'call-1', output: 'project-directory' };
  const second = await history.prepare({ model: 'claude-sonnet-4-6', previous_response_id: 'resp-gpt', instructions: 'Keep the user constraints.', input: [toolResult, message('user', 'Continue with Claude.')] });
  assert.equal('previous_response_id' in second.request, false);
  assert.equal(second.request.instructions, first.request.instructions);
  assert.deepEqual(second.request.input, [first.input[0], { ...call, id: undefined }, toolResult, message('user', 'Continue with Claude.')].map((item) => { const copy = { ...item }; if (copy.id === undefined) delete copy.id; return copy; }));
  const claudeReasoning = { type: 'reasoning', id: 'claude-reason', encrypted_content: 'native-claude-signature' };
  await history.save(second, reply('resp-claude', [claudeReasoning, message('assistant', 'The project uses Australian English.')]));
  // A restart must preserve the chain and provenance, not just in-memory state.
  const restarted = new ResponseHistory(directory);
  const third = await restarted.prepare({ model: 'gpt-6.1-sol', previous_response_id: 'resp-claude', input: 'Continue with ChatGPT.' });
  assert(third.request.input.some((item) => item.id === 'gpt-reason'));
  assert(!third.request.input.some((item) => item.id === 'claude-reason'));
  assert(third.request.input.some((item) => item.call_id === 'call-1' && item.output === 'project-directory'));
  assert(third.request.input.some((item) => item.content === 'The project uses Australian English.'));
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const name of await fs.readdir(directory)) assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
});

test('full-history switching removes foreign reasoning even without previous_response_id', async (t) => {
  const { history } = await fixture(t);
  const initial = await history.prepare({ model: 'claude-sonnet-4-6', input: 'Hello' });
  const output = [{ type: 'reasoning', id: 'rs-claude', encrypted_content: 'claude-signature' }, message('assistant', 'Hello from Claude.')];
  await history.save(initial, reply('claude-full', output));
  const next = await history.prepare({ model: 'gpt-6.1-sol', input: [...initial.input, ...output, message('user', 'Continue')] });
  assert.deepEqual(next.request.input, [initial.input[0], output[1], message('user', 'Continue')]);
  const sameProvider = await history.prepare({ model: 'claude-sonnet-4-6', input: [...initial.input, ...output] });
  assert.deepEqual(sameProvider.request.input, [...initial.input, ...output]);
});

test('full-history edits, independent chats and branches do not pick up other turns', async (t) => {
  const { history } = await fixture(t);
  await Promise.all(['one', 'two'].map(async (id) => {
    const prepared = await history.prepare({ model: 'gpt-6.1-sol', input: id });
    await history.save(prepared, reply(id, [message('assistant', `${id}-reply`)]));
  }));
  for (const id of ['one', 'two']) {
    const next = await history.prepare({ model: 'claude-sonnet-4-6', previous_response_id: id, input: `${id}-next` });
    assert.deepEqual(next.request.input.map((item) => item.content), [id, `${id}-reply`, `${id}-next`]);
  }
  const edited = await history.prepare({ model: 'claude-sonnet-4-6', input: 'Replacement first turn' });
  assert.deepEqual(edited.request.input, [{ role: 'user', content: 'Replacement first turn' }]);
  const branchA = await history.prepare({ model: 'claude-sonnet-4-6', previous_response_id: 'one', input: 'branch A' });
  await history.save(branchA, reply('branch-A', [message('assistant', 'only branch A')]));
  const branchB = await history.prepare({ model: 'claude-sonnet-4-6', previous_response_id: 'one', input: 'branch B' });
  assert(!JSON.stringify(branchB.request).includes('only branch A'));
});

test('missing history and failed responses never silently start a fresh delta chat', async (t) => {
  const { history } = await fixture(t);
  await assert.rejects(history.prepare({ model: 'claude-sonnet-4-6', previous_response_id: '../../missing', input: 'continue' }), { code: 'previous_response_not_found' });
  const prepared = await history.prepare({ model: 'gpt-6.1-sol', input: 'request' });
  await history.save(prepared, reply('failed', [message('assistant', 'partial')], 'failed'));
  await assert.rejects(history.prepare({ model: 'gpt-6.1-sol', previous_response_id: 'failed', input: 'continue' }), { code: 'previous_response_not_found' });
  await assert.rejects(history.prepare(null), { code: 'invalid_request' });
  await assert.rejects(history.prepare({ model: 'gpt-6.1-sol', input: {} }), { code: 'invalid_input' });
});

test('foreign compaction replays readable source history and unknown compaction is rejected', async (t) => {
  const { history } = await fixture(t);
  const original = [message('user', 'Keep this important original constraint.'), message('assistant', 'Completed step one.')];
  const prepared = await history.prepare({ model: 'gpt-6.1-sol', input: original });
  const compacted = { type: 'compaction', id: 'compact-item', encrypted_content: 'opaque-compacted-context' };
  await history.save(prepared, { id: 'compact-response', output: [compacted] }, { compact: true });
  const switched = await history.prepare({ model: 'claude-sonnet-4-6', input: [compacted, message('user', 'Do step two.')] });
  assert.deepEqual(switched.request.input, [...original, message('user', 'Do step two.')]);
  const same = await history.prepare({ model: 'gpt-6.1-sol', input: [compacted] });
  assert.deepEqual(same.request.input, [compacted]);
  await assert.rejects(history.prepare({ model: 'claude-sonnet-4-6', input: [{ type: 'compaction', encrypted_content: 'unknown' }] }), { code: 'portable_context_unavailable' });
});

test('references are expanded with the correct provider provenance', async (t) => {
  const { history } = await fixture(t);
  const prepared = await history.prepare({ model: 'gpt-6.1-sol', input: 'hello' });
  const output = { id: 'message-reference', ...message('assistant', 'A remembered answer') };
  await history.save(prepared, reply('reference-response', [output]));
  const next = await history.prepare({ model: 'claude-sonnet-4-6', input: [{ type: 'item_reference', id: output.id }] });
  assert.deepEqual(next.request.input, [message('assistant', 'A remembered answer')]);
  await assert.rejects(history.prepare({ model: 'gpt-6.1-sol', input: [{ type: 'item_reference', id: 'unknown' }] }), { code: 'history_reference_not_found' });
});

test('cache eviction is bounded and unknown non-target providers retain their existing request format', async (t) => {
  const { directory, history } = await fixture(t, { maxEntries: 1 });
  for (const id of ['old', 'new']) {
    const prepared = await history.prepare({ model: 'gpt-6.1-sol', input: id });
    await history.save(prepared, reply(id, [message('assistant', id)]));
  }
  assert.equal((await fs.readdir(directory)).length, 1);
  await assert.rejects(history.prepare({ model: 'claude-sonnet-4-6', previous_response_id: 'old', input: 'continue' }), { code: 'previous_response_not_found' });
  const request = { model: 'gemini-3-flash', input: 'hello', previous_response_id: 'upstream' };
  assert.deepEqual((await history.prepare(request)).request, request);
});

test('SSE captures completed responses across Unicode and CRLF chunk boundaries before forwarding', async () => {
  const completed = [];
  const reader = new ResponseEventReader(async (response) => { completed.push(response); });
  const response = reply('streamed', [message('assistant', 'Australian café')]);
  const bytes = Buffer.from(`: keepalive\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response })}\r\n\r\ndata: [DONE]\r\n\r\n`);
  for (let offset = 0; offset < bytes.length; offset += 3) await reader.push(bytes.subarray(offset, offset + 3));
  await reader.push(new Uint8Array(), true);
  assert.deepEqual(completed, [response]);
  const truncated = new ResponseEventReader(async () => assert.fail('must not commit'));
  await truncated.push(Buffer.from('data: {"type":"response.completed"'));
  await assert.rejects(truncated.push(new Uint8Array(), true), { code: 'incomplete_stream' });
  // ChatGPT leaves `output` empty on completion and streams each item instead.
  const native = [];
  const nativeReader = new ResponseEventReader(async (value) => { native.push(value); });
  const compaction = { type: 'compaction', id: 'cmp', encrypted_content: 'opaque' };
  await nativeReader.push(Buffer.from([
    { type: 'response.output_item.done', output_index: 1, item: compaction },
    { type: 'response.output_item.done', output_index: 0, item: message('assistant', 'first') },
    { type: 'response.completed', response: { id: 'native', status: 'completed', output: [] } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
  assert.deepEqual(native[0].output, [message('assistant', 'first'), compaction]);
  const oversized = new ResponseEventReader(async () => {}, { maxEventBytes: 5 });
  await assert.rejects(oversized.push(Buffer.from('data: 123456\n\n')), { code: 'response_too_large' });
});

test('reasoning provenance survives snapshot eviction for an ongoing full-history chat', async (t) => {
  const { directory, history } = await fixture(t, { maxEntries: 1 });
  const first = await history.prepare({ model: 'claude-sonnet-4-6', input: 'first' });
  const thought = { type: 'reasoning', encrypted_content: 'earlier-claude-signature' };
  await history.save(first, reply('first', [thought, message('assistant', 'Claude answer')]));
  const second = await history.prepare({ model: 'gpt-6.1-sol', previous_response_id: 'first', input: 'continue' });
  await history.save(second, reply('second', [message('assistant', 'GPT answer')]));
  const restarted = new ResponseHistory(directory, { maxEntries: 1 });
  const third = await restarted.prepare({ model: 'gpt-6.1-sol', previous_response_id: 'second', input: 'continue again' });
  assert(!third.request.input.some((item) => item.type === 'reasoning'));
  assert(third.request.input.some((item) => item.content === 'Claude answer'));
});

test('opaque compaction gets a handoff summary from its provider, cached, with replay as the fallback', async (t) => {
  let asked = 0;
  const { history } = await fixture(t, { handoff: async (item) => { asked++; return item.encrypted_content === 'known' ? 'GPT says: ship it.' : null; } });
  const unknownToCourt = { type: 'compaction', encrypted_content: 'known' };
  for (let turn = 0; turn < 2; turn++) {
    const next = await history.prepare({ model: 'claude-sonnet-4-6', input: [unknownToCourt, message('user', 'go')] });
    assert.equal(next.request.input[0].content[0].text, 'Summary of the earlier conversation:\n\nGPT says: ship it.');
  }
  assert.equal(asked, 1);
  const restarted = new ResponseHistory(history.directory, { handoff: async () => assert.fail('summary should come from disk') });
  const again = await restarted.prepare({ model: 'claude-sonnet-4-6', input: [unknownToCourt] });
  assert.match(again.request.input[0].content[0].text, /ship it/);
  const prepared = await history.prepare({ model: 'gpt-6.1-sol', input: [message('user', 'Original')] });
  const saved = { type: 'compaction', encrypted_content: 'saved-only' };
  await history.save(prepared, { id: 'c', output: [saved] }, { compact: true });
  const replayed = await history.prepare({ model: 'claude-sonnet-4-6', input: [saved] });
  assert.deepEqual(replayed.request.input, [message('user', 'Original')]);
});

test('Claude gets back the web search results Codex drops from its history', async (t) => {
  const { history } = await fixture(t);
  const ask = message('user', 'Search the weather.');
  const first = await history.prepare({ model: 'claude-sonnet-5', input: [ask] });
  const results = [{ type: 'web_search_result', title: 'Forecast', url: 'https://example.com', encrypted_content: 'sealed-page' }];
  await history.save(first, reply('resp-search', [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'weather' }, results }]));
  // Codex replays the call with its action only.
  const replayed = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'weather' } };
  const next = await history.prepare({ model: 'claude-sonnet-5', input: [ask, replayed, message('user', 'What did you find?')] });
  assert.deepEqual(next.request.input[1].results, results);
  const gpt = await history.prepare({ model: 'gpt-6.1-sol', input: [ask, replayed] });
  assert.equal('results' in gpt.request.input[1], false);
});

test('Claude retries a search that never ran because it paused for another tool', async (t) => {
  const { history } = await fixture(t);
  const ask = message('user', 'Get the time and search the weather.');
  const first = await history.prepare({ model: 'claude-sonnet-5', input: [ask] });
  const call = { type: 'function_call', id: 'fc_1', call_id: 'toolu_1', name: 'get_time', arguments: '{}' };
  const search = { type: 'web_search_call', id: 'ws_srvtoolu_1', status: 'completed', action: { type: 'search', query: 'weather' } };
  await history.save(first, reply('resp-paused', [call, search]));
  const output = { type: 'function_call_output', call_id: 'toolu_1', output: '20:15' };
  const next = await history.prepare({ model: 'claude-sonnet-5', input: [ask, call, search, output] });
  assert.deepEqual(next.request.input.map((item) => item.type), ['message', 'function_call', 'function_call_output']);
  // GPT history is left alone.
  const gpt = await history.prepare({ model: 'gpt-6.1-sol', input: [ask, { ...search, id: 'ws_gpt' }] });
  assert.equal(gpt.request.input.length, 2);
});

test('Claude search history keeps real results, even empty ones, across a restart', async (t) => {
  const { directory, history } = await fixture(t);
  const ask = message('user', 'Search.');
  const first = await history.prepare({ model: 'claude-sonnet-5', input: [ask] });
  const empty = { type: 'web_search_call', id: 'ws_empty', status: 'completed', action: { type: 'search', query: 'nothing' }, results: [] };
  const deferred = { type: 'web_search_call', id: 'ws_future_format', status: 'completed', action: { type: 'search', query: 'later' } };
  await history.save(first, reply('resp-1', [empty, deferred]));
  const restarted = new ResponseHistory(directory);
  const stranger = { type: 'web_search_call', id: 'ws_unknown', status: 'completed', action: { type: 'search', query: 'x' } };
  const next = await restarted.prepare({ model: 'claude-sonnet-5', input: [ask, empty, deferred, stranger] });
  // A real empty result stays. A no-results search Court saw Claude make is
  // dropped whatever its ID looks like. One Court never saw is left alone.
  assert.deepEqual(next.request.input.filter((i) => i.type === 'web_search_call').map((i) => i.action.query), ['nothing', 'x']);
  assert.deepEqual(next.request.input[1].results, []);
});
