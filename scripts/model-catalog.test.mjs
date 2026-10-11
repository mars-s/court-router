import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVerifiedModels, toCodexCatalog } from '../lib/model-catalog.mjs';

test('image inputs follow provider capabilities without granting vision to unknown models', () => {
  const models = [
    { id: 'gpt-6.1-sol', ownedBy: 'openai' },
    { id: 'gpt-5.5', owned_by: 'openai' },
    { id: 'claude-opus-5-5', ownedBy: 'anthropic' },
    { id: 'claude-sonnet-4-6', ownedBy: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', ownedBy: 'anthropic' },
    { id: 'claude-3-5-sonnet-20241022', ownedBy: 'anthropic' },
    { id: 'gpt-3.5-turbo', ownedBy: 'openai' },
    { id: 'claude-2', ownedBy: 'anthropic' },
    { id: 'codex-auto-review', ownedBy: 'openai' },
    { id: 'openrouter/free', ownedBy: 'OpenRouter' },
    { id: 'gpt-6.1-sol', ownedBy: 'unknown' },
    { id: 'custom-vision', input_modalities: ['text', 'image'] },
    { id: 'gpt-6.1-sol', ownedBy: 'openai', input_modalities: ['text'] }
  ];
  const result = toCodexCatalog(models).models;
  for (const model of result.slice(0, 6)) assert.deepEqual(model.input_modalities, ['text', 'image']);
  for (const model of result.slice(6, 11)) assert.deepEqual(model.input_modalities, ['text']);
  assert.deepEqual(result[11].input_modalities, ['text', 'image']);
  assert.deepEqual(result[12].input_modalities, ['text']);
});

test('keeps verified text models and removes broken or media models', () => {
  const input = [
    { id: 'gpt-5.6-sol', ownedBy: 'openai' },
    { id: 'gpt-image-2.5', ownedBy: 'openai' },
    { id: 'grok-4.6', ownedBy: 'xai' },
    { id: 'grok-3-mini', ownedBy: 'xai' },
    { id: 'gemini-3.8-flash-high', ownedBy: 'antigravity' },
    { id: 'openrouter/free', ownedBy: 'OpenRouter' },
    { id: 'openrouter/auto', ownedBy: 'OpenRouter' },
    { id: 'opencode-go/grok-4.6', ownedBy: 'OpenCode Go' }
  ];

  assert.deepEqual(filterVerifiedModels(input).map((model) => model.id), [
    'gpt-5.6-sol',
    'grok-4.6',
    'openrouter/free',
    'openrouter/auto'
  ]);
});

test('builds the native Codex models response instead of an OpenAI data list', () => {
  const catalog = toCodexCatalog([
    { id: 'openrouter/free', ownedBy: 'OpenRouter' },
    { id: 'grok-4.6', ownedBy: 'xai' }
  ]);

  assert.deepEqual(Object.keys(catalog), ['models']);
  assert.equal(catalog.models[0].slug, 'openrouter/free');
  assert.equal(catalog.models[0].display_name, 'OpenRouter Free');
  assert.equal(catalog.models[0].default_reasoning_level, 'low');
  assert.equal(catalog.models[0].supports_search_tool, true);
  assert.equal(catalog.models[1].slug, 'grok-4.6');
  assert.equal('data' in catalog, false);
});

test('advertised Claude text models are included without a fixed version allowlist', () => {
  const models = [
    { id: 'claude-opus-4-6', ownedBy: 'anthropic' },
    { id: 'claude-opus-5-5', owned_by: 'anthropic' },
    { id: 'claude-sonnet-5-5', ownedBy: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', ownedBy: 'anthropic' },
    { id: 'claude-opus-6-2', ownedBy: 'anthropic' },
    { id: 'claude-video-5', ownedBy: 'anthropic' },
    { id: 'claude-opus-5-5', ownedBy: 'untrusted-provider' }
  ];
  const catalog = toCodexCatalog(filterVerifiedModels(models));
  assert.deepEqual(catalog.models.map((model) => model.display_name), [
    'Claude Opus 4.6', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 4.5', 'Claude Opus 6.2'
  ]);
});

test('keeps native ChatGPT entries as they are and adds only missing Router models', () => {
  const native = [{ slug: 'gpt-6.1-sol', tool_mode: 'code_mode_only', multi_agent_version: 'v2' }];
  const catalog = toCodexCatalog([
    { id: 'gpt-6.1-sol', ownedBy: 'openai' },
    { id: 'claude-opus-5-5', ownedBy: 'anthropic' }
  ], native);
  assert.deepEqual(catalog.models.map((model) => model.slug), ['gpt-6.1-sol', 'claude-opus-5-5']);
  assert.equal(catalog.models[0], native[0]);
  assert.equal(catalog.models[1].priority, 2);
  assert.equal(catalog.models[1].context_window, 200000);
});
