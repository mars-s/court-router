import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAnnotations } from '../lib/annotations.mjs';

const claudeCitation = {
  type: 'web_search_result_location',
  url: 'https://example.com/a',
  title: 'Example',
  cited_text: 'quoted',
  encrypted_index: 'abc'
};

test('turns Claude web search citations into url_citation so GPT accepts the history', () => {
  const request = {
    model: 'gpt-6.1-sol',
    input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world', annotations: [claudeCitation] }] }]
  };
  const [annotation] = normaliseAnnotations(request).input[0].content[0].annotations;
  assert.deepEqual(annotation, { type: 'url_citation', url: 'https://example.com/a', title: 'Example', start_index: 0, end_index: 0 });
  assert.equal(request.input[0].content[0].annotations[0].type, 'web_search_result_location', 'original not mutated');
});

test('keeps OpenAI citations and drops unknown ones that have no URL', () => {
  const keep = { type: 'url_citation', url: 'https://x', title: 'x', start_index: 0, end_index: 1 };
  const request = { input: [{ type: 'message', content: [{ type: 'output_text', text: 'x', annotations: [keep, { type: 'char_location', cited_text: 'x' }] }] }] };
  assert.deepEqual(normaliseAnnotations(request).input[0].content[0].annotations, [keep]);
});

test('returns the same request when nothing needs changing', () => {
  const request = { input: [{ type: 'message', content: [{ type: 'output_text', text: 'x', annotations: [] }] }] };
  assert.equal(normaliseAnnotations(request), request);
});
