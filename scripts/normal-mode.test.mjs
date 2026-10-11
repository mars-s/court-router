import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreNormalConfig } from '../lib/normal-mode.mjs';
import { restoreCourtChats } from '../lib/native-chat-restore.mjs';

test('Court off selects native GPT models and keeps old provider IDs resumable without Court credentials', () => {
  const previous = 'model = "claude-opus-5-5"\nmodel_provider = "cliproxyapi"\nmodel_catalog_json = "/tmp/court-catalog.json"\n\n[projects."/tmp/project"]\ntrust_level = "trusted"\n\n[model_providers.cliproxyapi]\nname = "Court Router"\nbase_url = "http://127.0.0.1:8477/v1"\nenv_key = "CLIPROXYAPI_API_KEY"\n';
  const { config, model } = restoreNormalConfig(previous, { model: '"gpt-5.5"', modelCatalogJson: '"/tmp/court-catalog.json"' });
  assert.equal(model, 'gpt-5.5');
  assert.match(config, /^model_provider = "openai"$/m);
  assert.match(config, /\[model_providers.cliproxyapi\]\nname = "OpenAI"/);
  assert.match(config, /requires_openai_auth = true/);
  assert.match(config, /\[projects\."\/tmp\/project"\]\ntrust_level = "trusted"/);
  assert.doesNotMatch(config, /model_catalog_json|base_url|env_key|Court Router/);
});

test('missing or stale backup restores a valid GPT model and is repeatable', () => {
  for (const saved of [{}, { model: '"claude-sonnet-4-6"' }]) {
    const first = restoreNormalConfig('model = "claude-sonnet-4-6"\n', saved);
    const second = restoreNormalConfig(first.config, saved);
    assert.equal(first.model, 'gpt-6.1-sol');
    assert.equal(first.config, second.config);
  }
});

test('existing active and archived Court chats resume with explicit GPT settings before completion', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') {
      return { data: [{ id: params.archived ? 'archived-chat' : 'active-chat' }], nextCursor: null };
    }
    return { model: params.model, modelProvider: params.modelProvider };
  };
  assert.equal(await restoreCourtChats(rpc, 'gpt-6.1-sol'), 2);
  const resumes = calls.filter((call) => call.method === 'thread/resume');
  assert.equal(resumes.length, 2);
  for (const { params } of resumes) {
    assert.equal(params.modelProvider, 'openai');
    assert.equal(params.model, 'gpt-6.1-sol');
    assert.equal(params.excludeTurns, true);
  }
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
  const archiveCalls = calls.filter((call) => call.method.includes('archive'));
  assert.deepEqual(archiveCalls.map((call) => call.method), ['thread/unarchive', 'thread/archive']);
  assert.ok(archiveCalls.every((call) => call.params.threadId === 'archived-chat'));
});

test('an archived chat stays archived when its model restore fails', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'thread/list') return { data: params.archived ? [{ id: 'archived' }] : [], nextCursor: null };
    if (method === 'thread/resume') throw new Error('Resume failed');
    return {};
  };
  await assert.rejects(restoreCourtChats(rpc, 'gpt-6.1-sol'), /1 could not be restored/);
  assert.deepEqual(calls.slice(-3), ['thread/unarchive', 'thread/resume', 'thread/archive']);
});

test('restore failures are reported rather than silently declaring the switch complete', async () => {
  const rpc = async (method) => {
    if (method === 'thread/list') return { data: [{ id: 'chat' }], nextCursor: null };
    throw new Error('Thread still running');
  };
  await assert.rejects(restoreCourtChats(rpc, 'gpt-6.1-sol'), /1 could not be restored/);
});

test('Court off also moves ChatGPT-provider chats left on a Router model, and leaves GPT chats alone', async () => {
  const resumed = [];
  const rpc = async (method, params) => {
    if (method === 'thread/list') {
      assert.deepEqual(params.modelProviders, ['cliproxyapi', 'openai']);
      return { data: params.archived ? [] : [
        { id: 'gpt-chat', modelProvider: 'openai', model: 'gpt-6.1-sol' },
        { id: 'claude-chat', modelProvider: 'openai', model: 'claude-opus-5-5' },
        { id: 'old-court-chat', modelProvider: 'cliproxyapi', model: 'gpt-6.1-sol' }
      ], nextCursor: null };
    }
    resumed.push(params.threadId);
    return { model: params.model, modelProvider: params.modelProvider };
  };
  assert.equal(await restoreCourtChats(rpc, 'gpt-6.1-sol'), 2);
  assert.deepEqual(resumed, ['claude-chat', 'old-court-chat']);
});

test('Court off removes the Court ChatGPT address', () => {
  const { config } = restoreNormalConfig('model = "claude-opus-5-5"\nopenai_base_url = "http://127.0.0.1:8477/chatgpt"\n', {});
  assert.doesNotMatch(config, /openai_base_url/);
});

test('Court off cleans every chat file before reopening, and reports files it could not clean', async () => {
  const cleaned = [];
  const rpc = async (method, params) => {
    if (method === 'thread/list') return { data: params.archived ? [{ id: 'old', modelProvider: 'openai', model: 'gpt-6.1-sol', path: '/chats/old.jsonl' }] : [{ id: 'gpt', modelProvider: 'openai', model: 'gpt-6.1-sol', path: '/chats/gpt.jsonl' }], nextCursor: null };
    return { model: params.model, modelProvider: params.modelProvider };
  };
  assert.equal(await restoreCourtChats(rpc, 'gpt-6.1-sol', async (file) => { cleaned.push(file); }), 0);
  assert.deepEqual(cleaned, ['/chats/gpt.jsonl', '/chats/old.jsonl']);
  await assert.rejects(restoreCourtChats(rpc, 'gpt-6.1-sol', async () => { throw new Error('locked'); }), /2 could not be restored/);
});
