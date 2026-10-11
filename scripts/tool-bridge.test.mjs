import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeRequest, needsToolBridge, restoreResponse, ToolBridgeStream } from '../lib/tool-bridge.mjs';

const searchTool = {
  type: 'tool_search', execution: 'client', description: 'Find deferred tools.',
  parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false }
};
const patchTool = {
  type: 'custom', name: 'apply_patch', description: 'Edit files.',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' }
};
const github = {
  type: 'namespace', name: 'mcp__codex_apps__github', description: 'GitHub',
  tools: [{ type: 'function', name: '_get_repo', defer_loading: true, parameters: { type: 'object', properties: {} } }]
};

test('only non-GPT models use the bridge', () => {
  assert.equal(needsToolBridge('claude-opus-5-5'), true);
  assert.equal(needsToolBridge('gemini-3.7-flash-high'), true);
  assert.equal(needsToolBridge('gpt-6.1-sol'), false);
  assert.equal(needsToolBridge('codex-auto-review'), false);
  const request = { model: 'gpt-6.1-sol', tools: [searchTool, patchTool] };
  assert.equal(bridgeRequest(request).request, request);
});

test('request side turns native tools and history into plain functions', () => {
  const { request, state } = bridgeRequest({
    model: 'claude-opus-5-5',
    tools: [{ type: 'function', name: 'exec_command' }, searchTool, patchTool],
    input: [
      { role: 'user', content: 'go' },
      { type: 'tool_search_call', call_id: 's1', execution: 'client', arguments: { query: 'github', limit: 1 } },
      { type: 'tool_search_output', call_id: 's1', execution: 'client', tools: [github] },
      { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
      { type: 'custom_tool_call_output', call_id: 'p1', output: 'Success' }
    ]
  });
  assert.equal(state.search, true);
  assert(state.custom.has('apply_patch'));
  const names = request.tools.map((tool) => `${tool.type}:${tool.name}`);
  assert.deepEqual(names, ['function:exec_command', 'function:tool_search', 'function:apply_patch', 'namespace:mcp__codex_apps__github']);
  assert.deepEqual(request.tools[1].parameters, searchTool.parameters);
  assert.match(request.tools[2].description, /start: begin_patch/);
  assert.equal('defer_loading' in request.tools[3].tools[0], false);
  assert.deepEqual(request.input.slice(1).map((item) => item.type), ['function_call', 'function_call_output', 'function_call', 'function_call_output']);
  assert.deepEqual(JSON.parse(request.input[1].arguments), { query: 'github', limit: 1 });
  assert.match(request.input[2].output, /mcp__codex_apps__github: _get_repo/);
  assert.deepEqual(JSON.parse(request.input[3].arguments), { input: '*** Begin Patch\n*** End Patch' });
});

test('loaded tools merge into an existing namespace without duplicates', () => {
  const { request } = bridgeRequest({
    model: 'claude-opus-5-5',
    tools: [{ ...github, tools: [{ type: 'function', name: '_get_repo' }] }],
    input: [{ type: 'tool_search_output', call_id: 's1', tools: [{ ...github, tools: [...github.tools, { type: 'function', name: '_list_prs' }] }] }]
  });
  assert.equal(request.tools.length, 1);
  assert.deepEqual(request.tools[0].tools.map((tool) => tool.name), ['_get_repo', '_list_prs']);
});

test('non-stream responses get native item shapes back', () => {
  const { state } = bridgeRequest({ model: 'claude-opus-5-5', tools: [searchTool, patchTool] });
  const response = restoreResponse({ output: [
    { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'tool_search', arguments: '{"query":"sites","limit":2}' },
    { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
    { type: 'function_call', id: 'fc_3', call_id: 'c3', name: '_get_repo', namespace: 'mcp__codex_apps__github', arguments: '{}' }
  ] }, state);
  assert.deepEqual(response.output[0], { type: 'tool_search_call', id: 'tsc_fc_1', call_id: 'c1', status: 'completed', execution: 'client', arguments: { query: 'sites', limit: 2 } });
  assert.deepEqual(response.output[1], { type: 'custom_tool_call', id: 'ctc_fc_2', call_id: 'c2', status: 'completed', name: 'apply_patch', input: '*** Begin Patch' });
  assert.equal(response.output[2].type, 'function_call');
});

test('SSE rewrite hides argument deltas and keeps the CLIProxyAPI event order', () => {
  const { state } = bridgeRequest({ model: 'claude-opus-5-5', tools: [searchTool] });
  const item = { type: 'function_call', id: 'fc_toolu_1', call_id: 'toolu_1', name: 'tool_search', arguments: '', status: 'in_progress' };
  const done = { ...item, arguments: '{"query":"github"}', status: 'completed' };
  const frames = [
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_toolu_1', delta: '{"query":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_toolu_1', delta: '"github"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_toolu_1', arguments: done.arguments },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [done] } }
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const stream = new ToolBridgeStream(state);
  const bytes = Buffer.from(frames);
  // Split mid-frame to prove buffering works.
  const text = Buffer.concat([stream.push(bytes.subarray(0, 77)), stream.push(bytes.subarray(77)), stream.push(new Uint8Array(), true)]).toString();
  const events = text.split('\n\n').filter((frame) => frame.includes('data: {')).map((frame) => JSON.parse(frame.split('data: ')[1]));
  assert.deepEqual(events.map((event) => event.type), ['response.output_item.added', 'response.output_item.done', 'response.completed']);
  assert.equal(events[0].item.type, 'tool_search_call');
  assert.match(text, /event: response\.output_item\.added\ndata:/);
  assert.deepEqual(events[1].item.arguments, { query: 'github' });
  assert.equal(events[2].response.output[0].type, 'tool_search_call');
  assert(text.endsWith('data: [DONE]\n\n'));
});

test('Router reasoning is never saved in the chat, in the stream or the final response', () => {
  const { state } = bridgeRequest({ model: 'claude-opus-5-5', input: 'hi' });
  const reasoning = { type: 'reasoning', id: 'rs_msg_01', summary: [], encrypted_content: 'anthropic-sealed' };
  const answer = { type: 'message', id: 'msg_1', role: 'assistant', content: [] };
  assert.deepEqual(restoreResponse({ output: [reasoning, answer] }, state).output, [answer]);
  const stream = new ToolBridgeStream(state);
  const text = Buffer.from(stream.push(Buffer.from([
    { type: 'response.output_item.added', output_index: 0, item: reasoning },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_msg_01', delta: 'Thinking' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, item: answer },
    { type: 'response.completed', response: { id: 'r', output: [reasoning, answer] } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')), true)).toString();
  assert(!text.includes('rs_msg_01'));
  assert.equal(text.match(/data: /g).length, 2);
  const gpt = { type: 'reasoning', id: 'rs_1', encrypted_content: 'openai-sealed' };
  assert.equal(restoreResponse({ output: [gpt] }, bridgeRequest({ model: 'gpt-6.1-sol' }).state).output[0], gpt);
});
