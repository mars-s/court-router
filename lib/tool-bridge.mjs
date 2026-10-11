// Router models (Claude, Gemini and others) are guests in a ChatGPT chat.
// Codex sends some tools in shapes only OpenAI models understand, so Court
// translates them on the way in. On the way out, everything a Router model
// produces is turned into a shape native ChatGPT accepts, because Codex saves
// it in the chat and GPT may read that chat later without Court in between.
//
// - `tool_search` (client execution) unlocks deferred MCP servers, apps such
//   as Sites and Gmail, and the multi-agent tools.
// - `custom` (freeform) tools such as `apply_patch` take raw text input.

const TOOL_SEARCH = 'tool_search';
const searchParameters = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Words describing the capability, app or tool you need.' },
    limit: { type: 'integer', description: 'Maximum number of tool groups to load.' }
  },
  required: ['query'],
  additionalProperties: false
};

export const needsToolBridge = (model) => typeof model === 'string' && !/^(gpt-|codex-|o\d)/i.test(model);

function parseJson(text, fallback) {
  if (text && typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return fallback; }
}

function customFunction(tool) {
  const format = tool.format?.definition
    ? `\n\nPut the complete raw text in the \`input\` argument. It must follow this ${tool.format.syntax || ''} grammar:\n${tool.format.definition}`
    : '\n\nPut the complete raw text in the `input` argument.';
  return {
    type: 'function',
    name: tool.name,
    description: `${tool.description || ''}${format}`,
    strict: false,
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'The raw freeform input for this tool.' } },
      required: ['input'],
      additionalProperties: false
    }
  };
}

function searchFunction(tool) {
  return {
    type: 'function',
    name: TOOL_SEARCH,
    description: `${tool.description || 'Search for more tools.'}\n\nCall this before saying a tool, app, plugin, MCP server or subagent feature is unavailable. Matching tools become callable on your next step.`,
    strict: false,
    parameters: tool.parameters || searchParameters
  };
}

function loadedTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const { defer_loading: _deferred, ...copy } = tool;
  if (copy.type === 'namespace' && Array.isArray(copy.tools)) {
    copy.tools = copy.tools.map((child) => loadedTool(child)).filter(Boolean);
  }
  return copy;
}

function mergeTools(tools, extra) {
  const result = tools.map((tool) => tool.type === 'namespace' ? { ...tool, tools: [...(tool.tools || [])] } : tool);
  for (const tool of extra) {
    if (tool.type === 'namespace') {
      const existing = result.find((entry) => entry.type === 'namespace' && entry.name === tool.name);
      if (!existing) { result.push(tool); continue; }
      for (const child of tool.tools || []) {
        if (!existing.tools.some((entry) => entry.name === child.name)) existing.tools.push(child);
      }
    } else if (!result.some((entry) => entry.type !== 'namespace' && entry.name === tool.name)) {
      result.push(tool);
    }
  }
  return result;
}

function describeLoaded(tools) {
  if (!tools.length) return 'No matching tools were found. Try different search words.';
  const lines = tools.map((tool) => tool.type === 'namespace'
    ? `- ${tool.name}: ${(tool.tools || []).map((child) => child.name).join(', ')}`
    : `- ${tool.name}`);
  return `Loaded these tools. They are now callable:\n${lines.join('\n')}`;
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output;
  return JSON.stringify(output ?? '');
}

// Returns a request the Router understands plus the state needed to restore
// native item shapes in the response.
export function bridgeRequest(request) {
  const state = { custom: new Set(), search: false };
  if (!needsToolBridge(request?.model)) return { request, state: null };
  const tools = [];
  for (const tool of request.tools || []) {
    if (tool?.type === 'custom' && tool.name) {
      state.custom.add(tool.name);
      tools.push(customFunction(tool));
    } else if (tool?.type === TOOL_SEARCH) {
      state.search = true;
      tools.push(searchFunction(tool));
    } else {
      tools.push(tool);
    }
  }
  const loaded = [];
  const input = Array.isArray(request.input) ? request.input.map((item) => {
    if (!item || typeof item !== 'object') return item;
    switch (item.type) {
      case 'custom_tool_call':
        return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: JSON.stringify({ input: item.input ?? '' }) };
      case 'custom_tool_call_output':
        return { type: 'function_call_output', call_id: item.call_id, output: outputText(item.output) };
      case 'tool_search_call':
        return { type: 'function_call', call_id: item.call_id, name: TOOL_SEARCH, arguments: JSON.stringify(parseJson(item.arguments, {})) };
      case 'tool_search_output': {
        const found = (item.tools || []).map(loadedTool).filter(Boolean);
        loaded.push(...found);
        return { type: 'function_call_output', call_id: item.call_id, output: describeLoaded(found) };
      }
      default:
        return item;
    }
  }) : request.input;
  if (!state.custom.size && !state.search && !loaded.length && input === request.input) return { request, state };
  // Tools found by earlier searches stay callable for the rest of the chat.
  return { request: { ...request, input, tools: mergeTools(tools, loaded) }, state };
}

// ChatGPT checks that each item ID starts with its type's prefix. This keeps
// a chat valid for GPT even after Court's history copy has expired.
export const nativeId = (prefix, id) => id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;

// Returns the native item, or null for a Router model's reasoning. That
// reasoning is sealed for its provider and ChatGPT rejects it. An unsealed
// copy fails too: Codex gives it an ID, and ChatGPT then looks for stored
// data that does not exist. The model does not need it back, so it is never
// saved in the chat.
export function restoreItem(item, state) {
  if (!state) return item;
  if (item?.type === 'reasoning') return null;
  if (item?.type !== 'function_call' || item.namespace) return item;
  if (state.search && item.name === TOOL_SEARCH) {
    const args = parseJson(item.arguments, {});
    return {
      type: 'tool_search_call', ...(item.id ? { id: nativeId('tsc', item.id) } : {}), call_id: item.call_id,
      status: item.status || 'completed', execution: 'client',
      arguments: { query: String(args.query ?? ''), ...(Number.isFinite(args.limit) ? { limit: Math.trunc(args.limit) } : {}) }
    };
  }
  if (state.custom.has(item.name)) {
    const args = parseJson(item.arguments, null);
    const input = typeof args?.input === 'string' ? args.input : String(item.arguments ?? '');
    return {
      type: 'custom_tool_call', ...(item.id ? { id: nativeId('ctc', item.id) } : {}), call_id: item.call_id,
      status: item.status || 'completed', name: item.name, input
    };
  }
  return item;
}

export function restoreResponse(response, state) {
  if (!state || !Array.isArray(response?.output)) return response;
  return { ...response, output: response.output.map((item) => restoreItem(item, state)).filter(Boolean) };
}

// Rewrites a Router SSE stream. Arguments for translated calls arrive as JSON
// deltas, so Court hides those partial events. The added and done events
// carry the native item shape instead.
export class ToolBridgeStream {
  constructor(state) {
    this.state = state;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.pending = '';
    this.hidden = new Set();
    this.dropped = new Set();
  }

  translate(frame) {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return frame;
    let event;
    try { event = JSON.parse(data); } catch { return frame; }
    if (event.item) {
      const restored = restoreItem(event.item, this.state);
      if (restored === null) {
        if (event.item.id) this.dropped.add(event.item.id);
        return null;
      }
      if (restored !== event.item) {
        if (event.item.id) this.hidden.add(event.item.id);
        event = { ...event, item: restored };
      }
    } else if (event.item_id && this.dropped.has(event.item_id)) {
      return null;
    } else if (event.item_id && this.hidden.has(event.item_id) && /^response\.function_call_arguments\./.test(event.type)) {
      return null;
    } else if (event.response) {
      event = { ...event, response: restoreResponse(event.response, this.state) };
    } else {
      return frame;
    }
    const kept = lines.filter((line) => !line.startsWith('data:'));
    return [...kept, `data: ${JSON.stringify(event)}`].join('\n');
  }

  push(chunk, final = false) {
    this.pending += this.decoder.decode(chunk, { stream: !final });
    const out = [];
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const translated = this.translate(frame);
      if (translated !== null) out.push(`${translated}\n\n`);
    }
    if (final && this.pending) { out.push(this.pending); this.pending = ''; }
    return this.encoder.encode(out.join(''));
  }
}
