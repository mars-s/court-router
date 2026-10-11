import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRollout } from '../lib/chat-cleanup.mjs';

const line = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });
const legacySummary = { type: 'compaction', id: 'cmp_1', encrypted_content: `court-compaction:v1:${Buffer.from(JSON.stringify({ summary: 'Keep PELICAN.' })).toString('base64')}` };

test('chats from older Court versions become valid for native ChatGPT, once', () => {
  const gptReasoning = { type: 'reasoning', id: 'rs_gpt', summary: [], encrypted_content: 'openai-sealed' };
  const text = [
    line('session_meta', { id: 'chat' }),
    line('turn_context', { model: 'gpt-6.1-sol' }),
    line('response_item', gptReasoning),
    line('turn_context', { model: 'claude-opus-5-5' }),
    line('response_item', { type: 'message', role: 'user', id: 'msg_user', content: [] }),
    line('response_item', { type: 'reasoning', id: 'rs_msg_01x', summary: [], content: [{ type: 'reasoning_text', text: 'Thinking.' }], encrypted_content: 'anthropic-sealed' }),
    line('response_item', { type: 'custom_tool_call', id: 'fc_toolu_01x', call_id: 'toolu_01x', name: 'apply_patch', input: 'p' }),
    line('compacted', { replacement_history: [legacySummary] })
  ].join('\n');
  const cleaned = cleanRollout(text);
  const entries = cleaned.split('\n').map((entry) => JSON.parse(entry));
  assert.deepEqual(entries[2].payload, gptReasoning);
  assert.equal(entries[4].payload.id, 'msg_user');
  // Claude's sealed reasoning is removed.
  assert.equal(entries[5].payload.id, 'ctc_fc_toolu_01x');
  assert.match(entries[6].payload.replacement_history[0].content[0].text, /Keep PELICAN/);
  assert.equal(entries.length, 7);
  assert.equal(cleanRollout(cleaned), null);
  assert.equal(cleanRollout(entries.slice(0, 3).map((entry) => JSON.stringify(entry)).join('\n')), null);
});
