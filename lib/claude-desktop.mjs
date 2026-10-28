// Pure helpers for the Claude workflow: the Claude desktop app in third-party (gateway) mode,
// pointed at CLIProxyAPI so one model menu holds Claude, Codex and OpenCode Go models.

// The desktop app only accepts claude-* model names, and rejects any that mention another
// vendor (qwen, gpt, minimax...). So CLIProxyAPI serves the others under neutral codes:
// claude-oc-<hash> for OpenCode Go, claude-cx-<hash> for Codex. This reads them back.
export function readAliases(routerConfig) {
  const aliases = new Map();
  for (const [, name, alias] of routerConfig.matchAll(/- name: "([^"]+)"\n\s+alias: "(claude-(?:oc|cx)-[0-9a-f]+)"/g)) {
    aliases.set(name, alias);
  }
  return aliases;
}

export const CLAUDE_MODELS = Object.freeze([
  'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5',
  'claude-opus-5', 'claude-fable-5', 'claude-sonnet-5'
]);

export const CODEX_MODELS = Object.freeze([
  'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'
]);

// Answers a bare message but rejects Claude Code's real requests (400 invalid messages[0].content).
export const BROKEN_MODELS = Object.freeze(new Set(['beam-free']));

// live: model ids the router serves. catalogue: models.dev entries by id (name, limit.context).
export function buildModelList({ live, aliases, catalogue }) {
  const entry = (id, tag) => {
    const info = catalogue[id] || {};
    const label = info.name || id;
    const model = {
      name: tag === 'Claude' ? id : aliases.get(id),
      labelOverride: tag === 'Claude' ? label : `${label} · ${tag}`
    };
    if ((info.limit?.context || 0) >= 1_000_000) model.supports1m = true;
    return model;
  };
  const opencode = [...aliases]
    .filter(([id, alias]) => alias.startsWith('claude-oc-') && live.has(alias) && !BROKEN_MODELS.has(id))
    .map(([id]) => id)
    .sort();
  return [
    ...CLAUDE_MODELS.filter(id => live.has(id)).map(id => entry(id, 'Claude')),
    ...CODEX_MODELS.filter(id => live.has(aliases.get(id))).map(id => entry(id, 'Codex')),
    ...opencode.map(id => entry(id, 'OpenCode'))
  ];
}

export function buildDesktopConfig({ gatewayUrl, apiKey, models, sshHosts = [] }) {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: gatewayUrl,
    inferenceGatewayApiKey: apiKey,
    inferenceGatewayAuthScheme: 'bearer',
    inferenceModels: models,
    sshHostAllowlist: sshHosts,
    // Without this the app treats the network as locked: it forces the sandbox on, in strict
    // mode, with no hosts allowed.
    coworkEgressAllowedHosts: ['*']
  };
}

// OpenCode Go drops Anthropic's server-side web_search tool, and Claude Code's WebSearch asks the
// chat's own model to run the search. So a search request for an OpenCode model goes to a model
// that can search instead. Returns the new body, or the same body when nothing changes.
export function rerouteWebSearch(body, searchModel) {
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    return body;
  }
  const isOpenCode = String(request?.model || '').startsWith('claude-oc-');
  const searches = (request?.tools || []).some(tool => String(tool?.type || '').startsWith('web_search'));
  if (!isOpenCode || !searches) return body;
  return Buffer.from(JSON.stringify({ ...request, model: searchModel }));
}
