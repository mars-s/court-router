import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesktopConfig, buildModelList, readAliases, rerouteWebSearch } from '../lib/claude-desktop.mjs';

const routerConfig = `
claude-api-key:
  - api-key: "secret"
    models:
      - name: "kimi-k3"
        alias: "claude-oc-1b2f2d"
        display-name: "Kimi K3"
      - name: "beam-free"
        alias: "claude-oc-aaaaaa"
oauth-model-alias:
  codex:
    - name: "gpt-6.1-sol"
      alias: "claude-cx-36604a"
      fork: true
`;

test('reads the neutral model codes from the router config', () => {
  assert.deepEqual([...readAliases(routerConfig)], [
    ['kimi-k3', 'claude-oc-1b2f2d'], ['beam-free', 'claude-oc-aaaaaa'], ['gpt-6.1-sol', 'claude-cx-36604a']
  ]);
});

test('lists only served models, under codes the desktop app accepts, with real names', () => {
  const live = new Set(['claude-opus-5-5', 'claude-oc-1b2f2d', 'claude-oc-aaaaaa', 'claude-cx-36604a']);
  const catalogue = {
    'claude-opus-5-5': { name: 'Claude Opus 5.5', limit: { context: 1_000_000 } },
    'kimi-k3': { name: 'Kimi K3', limit: { context: 262_144 } },
    'gpt-6.1-sol': { name: 'GPT-6.1 Sol' }
  };
  assert.deepEqual(buildModelList({ live, aliases: readAliases(routerConfig), catalogue }), [
    { name: 'claude-opus-5-5', labelOverride: 'Claude Opus 5.5', supports1m: true },
    { name: 'claude-cx-36604a', labelOverride: 'GPT-6.1 Sol · Codex' },
    { name: 'claude-oc-1b2f2d', labelOverride: 'Kimi K3 · OpenCode' }
  ]);
});

test('allows all network hosts so the app does not force a strict sandbox', () => {
  const config = buildDesktopConfig({ gatewayUrl: 'https://gw', apiKey: 'k', models: [] });
  assert.deepEqual(config.coworkEgressAllowedHosts, ['*']);
  assert.equal(config.inferenceProvider, 'gateway');
});

test('sends OpenCode web searches to the search model and leaves everything else alone', () => {
  const search = Buffer.from(JSON.stringify({ model: 'claude-oc-1b2f2d', tools: [{ type: 'web_search_20250305', name: 'web_search' }] }));
  assert.equal(JSON.parse(rerouteWebSearch(search, 'claude-cx-36604a')).model, 'claude-cx-36604a');

  const chat = Buffer.from(JSON.stringify({ model: 'claude-oc-1b2f2d', tools: [{ name: 'Bash', input_schema: {} }] }));
  assert.equal(rerouteWebSearch(chat, 'claude-cx-36604a'), chat);

  const claudeSearch = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', tools: [{ type: 'web_search_20250305' }] }));
  assert.equal(rerouteWebSearch(claudeSearch, 'claude-cx-36604a'), claudeSearch);

  const notJson = Buffer.from('not json');
  assert.equal(rerouteWebSearch(notJson, 'claude-cx-36604a'), notJson);
});
