const VERIFIED_NON_OPENAI_MODELS = new Set([
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6',
  'gemini-3-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash-high',
  'gemini-3.7-flash-high',
  'grok-4.5',
  'grok-4.6',
  'grok-composer-2.5-fast',
  'openrouter/auto',
  'openrouter/free',
  'union-alpha'
]);

function isOpenAiTextModel(model) {
  const owner = String(model.ownedBy || model.owned_by || '').toLowerCase();
  if (owner !== 'openai') return false;
  return !/image|video|audio|realtime|transcrib|tts/i.test(model.id);
}

function isClaudeTextModel(model) {
  const owner = String(model.ownedBy || model.owned_by || '').toLowerCase();
  return ['anthropic', 'claude'].includes(owner) && /^claude-/i.test(model.id)
    && !/image|video|audio|realtime|transcrib|tts/i.test(model.id);
}

export function isVerifiedModel(model) {
  return isOpenAiTextModel(model) || isClaudeTextModel(model) || VERIFIED_NON_OPENAI_MODELS.has(model.id);
}

export function filterVerifiedModels(models) {
  return models.filter(isVerifiedModel);
}

const DISPLAY_NAMES = Object.freeze({
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 Thinking',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'codex-auto-review': 'Codex Auto Review',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3.6-flash-high': 'Gemini 3.6 Flash High',
  'gemini-3.7-flash-high': 'Gemini 3.7 Flash High',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-6-astra': 'GPT-6 Astra',
  'grok-4.5': 'Grok 4.5',
  'grok-4.6': 'Grok 4.6',
  'grok-composer-2.5-fast': 'Grok Composer 2.5 Fast',
  'openrouter/auto': 'OpenRouter Auto',
  'openrouter/free': 'OpenRouter Free',
  'union-alpha': 'Union Alpha'
});

const REASONING_LEVELS = Object.freeze([
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth' },
  { effort: 'high', description: 'More reasoning for difficult tasks' }
]);

function displayName(id) {
  if (DISPLAY_NAMES[id]) return DISPLAY_NAMES[id];
  const current = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:-(thinking))?$/i);
  if (current) {
    const [, family, major, minor, thinking] = current;
    return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}${thinking ? ' Thinking' : ''}`;
  }
  const legacy = id.match(/^claude-(\d+)-(\d+)-(sonnet|haiku)(?:-\d{8})?$/i);
  if (legacy) return `Claude ${legacy[3][0].toUpperCase()}${legacy[3].slice(1)} ${legacy[1]}.${legacy[2]}`;
  return id;
}

// The Router does not report context sizes, so Claude models default to the
// common 200k window. Models listed here have a larger published window that
// was also confirmed against the live Router.
const CLAUDE_CONTEXT_WINDOWS = Object.freeze({
  'claude-opus-5-5': 1000000
});

function contextWindow(model) {
  const advertised = Number(model.context_window ?? model.contextWindow ?? model.context_length);
  if (Number.isInteger(advertised) && advertised > 0) return advertised;
  if (!isClaudeTextModel(model)) return 128000;
  const base = String(model.id).toLowerCase().replace(/-\d{8}$/, '').replace(/-thinking$/, '');
  return CLAUDE_CONTEXT_WINDOWS[base] ?? 200000;
}

export function toCodexModel(model, priority = 0) {
  const owner = model.ownedBy || model.owned_by || 'provider';
  const window = contextWindow(model);
  return {
    slug: model.id,
    display_name: displayName(model.id),
    description: `${owner} model routed through Court.`,
    default_reasoning_level: 'low',
    supported_reasoning_levels: REASONING_LEVELS,
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_image_detail_original: false,
    supports_search_tool: true,
    context_window: window,
    max_context_window: window,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: inputModalities(model),
    use_responses_lite: false,
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    base_instructions: 'You are Codex, a coding agent. Follow the user instructions and use the available tools to complete the task.'
  };
}

function inputModalities(model) {
  const advertised = model.input_modalities || model.inputModalities;
  if (Array.isArray(advertised)) {
    return ['text', ...(advertised.includes('image') ? ['image'] : [])];
  }
  // Current GPT chat models and Claude 3 onwards accept image inputs.
  const gptVision = isOpenAiTextModel(model) && /^gpt-(?:[5-9](?:[.-]|$)|4o(?:[.-]|$)|4\.1(?:[.-]|$)|4-turbo(?:[.-]|$))/i.test(model.id);
  const claudeVision = isClaudeTextModel(model) && /^claude-(?:(?:opus|sonnet|haiku|fable)-)?[3-9](?:[.-]|$)/i.test(model.id);
  return ['text', ...(gptVision || claudeVision ? ['image'] : [])];
}

// `native` is ChatGPT's own catalogue (~/.codex/models_cache.json). Its GPT
// entries carry settings Court cannot rebuild, so they are kept as they are
// and Router models only fill in what ChatGPT does not offer.
export function toCodexCatalog(models, native = []) {
  const slugs = new Set(native.map((model) => model.slug));
  const extra = models.filter((model) => !slugs.has(model.id));
  return { models: [...native, ...extra.map((model, index) => toCodexModel(model, native.length + index + 1))] };
}

export const verifiedNonOpenAiModels = Object.freeze([...VERIFIED_NON_OPENAI_MODELS]);
