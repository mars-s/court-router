import test from 'node:test';
import assert from 'node:assert/strict';
import { revealSealedAgentMessages, unsealPlainAgentMessages } from '../lib/agent-messages.mjs';

const header = { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n' };
const message = (payload) => ({
  type: 'agent_message', id: 'amsg_1', author: '/root', recipient: '/root/probe',
  content: [header, { type: 'encrypted_content', encrypted_content: payload }],
  internal_chat_message_metadata_passthrough: { turn_id: 't1' }
});

test('Claude-origin plain task text becomes readable input for GPT', () => {
  const request = { model: 'gpt-6-luna', input: [{ role: 'user', content: 'hi' }, message('Reply with PONG')] };
  const out = unsealPlainAgentMessages(request);
  const item = out.input[1];
  assert.deepEqual(item.content[1], { type: 'input_text', text: 'Reply with PONG' });
  assert.equal(item.content[0], header);
  assert.deepEqual(item.internal_chat_message_metadata_passthrough, { turn_id: 't1' });
  assert.equal(item.id, 'amsg_1');
  assert.equal(request.input[1].content[1].type, 'encrypted_content');
});

test('real OpenAI ciphertext is left untouched', () => {
  const request = { model: 'gpt-6-luna', input: [message('gAAAAABqSealedBlob')] };
  assert.equal(unsealPlainAgentMessages(request), request);
});

test('GPT-sealed task text is revealed for Claude, and kept when reveal fails', async () => {
  const request = { model: 'claude-sonnet-5', input: [message('gAAAAABqSealedBlob')] };
  const seen = [];
  const out = await revealSealedAgentMessages(request, async (item) => { seen.push(item); return 'Reply with PONG'; });
  assert.deepEqual(out.input[0].content, [header, { type: 'input_text', text: 'Reply with PONG' }]);
  assert.equal(seen[0].content.length, 1);
  assert.equal(seen[0].id, 'amsg_1');
  const failed = await revealSealedAgentMessages(request, async () => null);
  assert.equal(failed, request);
});
