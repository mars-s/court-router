import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { restartMacChatGPT } from './lib/macos-app-launch.mjs';
import { filterVerifiedModels, toCodexCatalog } from './lib/model-catalog.mjs';
import { ResponseHistory, ResponseEventReader } from './lib/response-history.mjs';
import { restoreNormalConfig } from './lib/normal-mode.mjs';
import { restoreNativeCourtChats } from './lib/native-chat-restore.mjs';
import { repairThreadHistory } from './lib/thread-history.mjs';
import { bridgeRequest, needsToolBridge, restoreResponse, ToolBridgeStream } from './lib/tool-bridge.mjs';
import { HANDOFF_PROMPT, wantsCompaction } from './lib/handoff.mjs';
import { claudeWindow } from './lib/claude-usage.mjs';
import { fitImageBudget } from './lib/image-budget.mjs';
import { normaliseAnnotations } from './lib/annotations.mjs';
import { StreamOutcome, Trace, traceShape } from './lib/trace.mjs';
import { revealSealedAgentMessages, unsealPlainAgentMessages } from './lib/agent-messages.mjs';
import { createHash } from 'node:crypto';

const PORT = Number.parseInt(process.env.COURT_PORT || '8477', 10);
const HOST = '127.0.0.1';
const HOME = os.homedir();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.COURT_STATE_DIR || path.join(HOME, '.local', 'state', 'court');
const AUTH_DIR = process.env.COURT_AUTH_DIR || path.join(HOME, '.cli-proxy-api');
const CONFIG = process.env.COURT_ROUTER_CONFIG || '/opt/homebrew/etc/cliproxyapi.conf';
const ROUTER_URL = process.env.COURT_ROUTER_URL || 'http://127.0.0.1:8317';
const CHATGPT_URL = process.env.COURT_CHATGPT_URL || 'https://chatgpt.com/backend-api/codex';
const CODEX_AUTH = process.env.COURT_CODEX_AUTH || path.join(HOME, '.codex', 'auth.json');
const COURT_API_URL = `http://${HOST}:${PORT}/v1`;
const COURT_CHATGPT_URL = `http://${HOST}:${PORT}/chatgpt`;
const PUBLIC = path.join(ROOT, 'public');
const COURT_LOG = path.join(STATE_DIR, 'court.log');
const AUTH_LOG = path.join(STATE_DIR, 'auth.log');
const CUSTOM_PROVIDERS = process.env.COURT_PROVIDERS_FILE || path.join(STATE_DIR, 'providers.json');
const LEGACY_CUSTOM_PROVIDERS = path.join(HOME, '.court-providers.json');
const CODEX_CONFIG = process.env.COURT_CODEX_CONFIG || path.join(HOME, '.codex', 'config.toml');
const CODEX_MODE_STATE = path.join(STATE_DIR, 'codex-mode.json');
const CODEX_MODEL_CATALOG = path.join(STATE_DIR, 'codex-model-catalog.json');
const CODEX_MODELS_CACHE = process.env.COURT_CODEX_MODELS_CACHE || path.join(HOME, '.codex', 'models_cache.json');
const GEMINI_CREDENTIALS = process.env.COURT_GEMINI_CREDENTIALS || path.join(HOME, '.gemini', 'oauth_creds.json');
const MAX_BODY_BYTES = 32 * 1024;
const CLAUDE_MAX_OUTPUT_TOKENS = 128000;
const MAX_PROXY_BODY_BYTES = 256 * 1024 * 1024;
const quotaCache = new Map();
let changingCodexMode = false;
const responseHistory = new ResponseHistory(path.join(STATE_DIR, 'response-history'), { handoff: gptHandoff });
const trace = new Trace(STATE_DIR, { redact: (text) => redactLog(text) });

// Records one finished request when tracing is on. Error bodies are kept
// because they name the item the backend rejected.
// Successful streams are written when they end, so the line also says how
// the stream finished. Returns a function that finishes the record.
async function traceUpstream(route, sent, upstream, extra = {}) {
  if (!(await trace.enabled())) return () => {};
  const event = { route, status: upstream.status, requestId: upstream.headers.get('x-request-id'), sent: traceShape(sent), ...extra };
  if (!upstream.ok) {
    event.error = await upstream.clone().text().catch(() => null);
    await trace.write(event);
    return () => {};
  }
  const outcome = new StreamOutcome();
  let done = false;
  const finish = (end = {}) => {
    if (done) return;
    done = true;
    const summary = outcome.summary();
    // The app may hang up right after a finished turn. That is not a failure.
    if (end.failure === 'client closed the connection' && summary.ended === 'response.completed') end = { closedAfterCompletion: true };
    return trace.write({ ...event, ...summary, ...end });
  };
  finish.watch = (chunk) => outcome.push(chunk);
  return finish;
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('COURT_PORT must be between 1024 and 65535');
await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
await fs.chmod(STATE_DIR, 0o700);

if (process.argv[2] === '--daemon') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(child.pid);
  process.exit(0);
}

const json = (res, value, code = 200) => {
  res.writeHead(code, securityHeaders({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
  res.end(JSON.stringify(value));
};

function securityHeaders(extra = {}) {
  return {
    'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra
  };
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body is too large');
  }
  return JSON.parse(body || '{}');
}

async function readRawBody(req, limit = MAX_PROXY_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Proxy request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Codex compresses large request bodies. Court reads them to keep history and
// translate tools, then forwards plain JSON.
const DECODERS = { zstd: zlib.zstdDecompressSync, gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync };
function decodeBody(body, encoding = 'identity') {
  const name = String(encoding).toLowerCase();
  if (name === 'identity') return body;
  if (!DECODERS[name]) throw Object.assign(new Error(`Court cannot read ${encoding} request bodies.`), { code: 'unsupported_content_encoding', status: 415 });
  try { return DECODERS[name](body, { maxOutputLength: MAX_PROXY_BODY_BYTES }); }
  catch { throw Object.assign(new Error('Request body could not be decompressed or is too large.'), { code: 'invalid_content_encoding', status: 400 }); }
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  if (!allowedHosts.has(host)) return false;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

function redactLog(value) {
  return String(value)
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/([?&](?:code|token|access_token|refresh_token|id_token|key)=)[^\s&]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~');
}

function providerFor(filename, data) {
  const type = String(data?.type || '').toLowerCase();
  const name = filename.toLowerCase();
  if (name.startsWith('codex-') || type.includes('codex') || type.includes('openai')) return 'Codex';
  if (name.startsWith('claude-') || type.includes('claude')) return 'Claude';
  if (name.startsWith('antigravity-') || type.includes('antigravity')) return 'Antigravity';
  if (name.startsWith('gemini-') || type === 'gemini' || type === 'gemini-cli') return 'Gemini';
  if (name.startsWith('xai-') || type.includes('grok')) return 'Grok';
  if (name.startsWith('kimi-') || type.includes('kimi')) return 'Kimi';
  return 'Other';
}

async function executablePath(name) {
  const candidates = [
    path.join(HOME, '.local', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
    ...String(process.env.PATH || '').split(path.delimiter).map((directory) => path.join(directory, name))
  ];
  for (const candidate of [...new Set(candidates)]) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  return null;
}

async function geminiCliStatus() {
  const binary = await executablePath('gemini');
  let credential = null;
  try { credential = JSON.parse(await fs.readFile(GEMINI_CREDENTIALS, 'utf8')); } catch {}
  const claims = jwtPayload(credential?.id_token || '');
  return {
    installed: Boolean(binary),
    signedIn: Boolean(credential?.access_token || credential?.refresh_token || credential?.id_token),
    accountLabel: claims.email || null,
    routerSupported: false
  };
}

function planFor(filename) {
  const m = filename.match(/-(prolite|pro|max|plus|free)(?:\.json)?$/i);
  return m ? m[1].replace(/^./, (x) => x.toUpperCase()) : 'OAuth';
}

function titleCasePlan(value) {
  return String(value || '').replace(/prolite/i, 'Pro Lite').replace(/\b\w/g, (x) => x.toUpperCase());
}

function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

async function codexQuota(filename, data) {
  const cached = quotaCache.get(filename);
  if (cached && Date.now() - cached.time < 60_000) return cached.value;
  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { authorization: `Bearer ${data.access_token}`, 'ChatGPT-Account-Id': data.account_id },
      signal: AbortSignal.timeout(6_000)
    });
    if (!response.ok) throw new Error(`Usage returned ${response.status}`);
    const usage = await response.json();
    const window = usage.rate_limit?.primary_window;
    const value = {
      plan: titleCasePlan(usage.plan_type),
      quotaUsed: Number.isFinite(window?.used_percent) ? window.used_percent : null,
      quotaRemaining: Number.isFinite(window?.used_percent) ? Math.max(0, 100 - window.used_percent) : null,
      windowSeconds: window?.limit_window_seconds || null,
      resetAt: window?.reset_at ? new Date(window.reset_at * 1000).toISOString() : null,
      bankedResets: usage.rate_limit_reset_credits?.available_count ?? null
    };
    quotaCache.set(filename, { time: Date.now(), value });
    return value;
  } catch {
    return { plan: null, quotaUsed: null, quotaRemaining: null, windowSeconds: null, resetAt: null, bankedResets: null };
  }
}

async function claudeQuota(filename, data) {
  const cached = quotaCache.get(filename);
  if (cached && Date.now() - cached.time < 60_000) return cached.value;
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${data.access_token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(6_000)
    });
    if (!response.ok) throw new Error(`Usage returned ${response.status}`);
    const window = claudeWindow(await response.json());
    if (!window) throw new Error('Usage had no windows');
    const value = { plan: null, ...window, bankedResets: null };
    quotaCache.set(filename, { time: Date.now(), value });
    return value;
  } catch {
    return { plan: null, quotaUsed: null, quotaRemaining: null, windowSeconds: null, resetAt: null, bankedResets: null };
  }
}

async function apiKey() {
  const config = await fs.readFile(CONFIG, 'utf8').catch(() => '');
  const match = config.match(/^\s*-\s*"([^"]+)"\s*$/m);
  return match?.[1] || '';
}

async function routerModels() {
  const key = await apiKey();
  if (!key) return { online: false, models: [], error: 'No local Router key found' };
  try {
    const response = await fetch(`${ROUTER_URL}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { online: false, models: [], error: `Router returned ${response.status}` };
    const body = await response.json();
    const modelDetails = (body.data || []).map((model) => ({ id: model.id, ownedBy: model.owned_by || null, input_modalities: model.input_modalities || model.inputModalities })).sort((a, b) => a.id.localeCompare(b.id));
    return { online: true, models: modelDetails.map((model) => model.id), modelDetails };
  } catch {
    return { online: false, models: [], error: 'Router is not running' };
  }
}

async function verifiedRouterModels() {
  const router = await routerModels();
  if (!router.online) return router;
  const modelDetails = filterVerifiedModels(router.modelDetails || []);
  return { ...router, models: modelDetails.map((model) => model.id), modelDetails };
}

// `routed` is set when the ChatGPT route already checked the caller and read
// the body. Otherwise the caller must present the Router key.
async function proxyRouterRequest(req, res, url, routed = null) {
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableFinished) abort.abort(); });
  let finishTrace = () => {};
  try {
    const key = await apiKey();
    if (!key) return json(res, { error: 'No local Router key found' }, 503);
    if (!routed && req.headers.authorization !== `Bearer ${key}`) return json(res, { error: 'Unauthorized' }, 401);
    const headers = { authorization: `Bearer ${key}` };
    for (const name of ['accept', 'content-encoding', 'content-type', 'openai-beta', 'user-agent', 'x-opencode-session', 'session_id', 'session-id', 'conversation_id', 'x-codex-turn-metadata', 'x-codex-turn-state']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const pathname = routed?.pathname ?? url.pathname;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    let body = routed ? routed.body : hasBody ? await readRawBody(req) : undefined;
    const isResponses = req.method === 'POST' && ['/v1/responses', '/v1/responses/compact'].includes(pathname);
    let prepared;
    let bridge = null;
    let traced = null;
    if (isResponses) {
      if (!routed) body = decodeBody(body, req.headers['content-encoding']);
      delete headers['content-encoding'];
      const received = JSON.parse(body.toString('utf8'));
      prepared = await responseHistory.prepare(received);
      prepared.request = await revealSealedAgentMessages(prepared.request, gptRevealAgentMessage);
      const bridged = bridgeRequest(prepared.request);
      bridge = bridged.state;
      // Claude rejects requests over ~32 MB, so shrink or drop old images.
      // Without an explicit limit the Router applies a smaller default output cap, which
      // cuts long tool calls off mid-argument ("max_output_tokens"). Ask for more.
      if (/^claude-/i.test(String(bridged.request.model)) && !bridged.request.max_output_tokens) {
        bridged.request.max_output_tokens = CLAUDE_MAX_OUTPUT_TOKENS;
      }
      const fitted = await fitImageBudget(bridged.request);
      body = JSON.stringify(fitted.request);
      traced = { sent: fitted.request, extra: { path: pathname, received: traceShape(received), ...(fitted.stats ? { images: fitted.stats } : {}) } };
    }
    const upstream = await fetch(`${ROUTER_URL}${pathname}${url.search}`, {
      method: req.method,
      headers,
      body,
      signal: abort.signal
    });
    if (traced) finishTrace = await traceUpstream('router', traced.sent, upstream, traced.extra);
    const responseHeaders = {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    };
    const requestId = upstream.headers.get('x-request-id');
    if (requestId) responseHeaders['x-request-id'] = requestId;
    if (isResponses && upstream.ok && !(upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      const response = restoreResponse(await upstream.json(), bridge);
      await responseHistory.save(prepared, response, { compact: pathname.endsWith('/compact') });
      res.writeHead(upstream.status, securityHeaders(responseHeaders));
      return res.end(JSON.stringify(response));
    }
    res.writeHead(upstream.status, securityHeaders(responseHeaders));
    if (!upstream.body) return res.end();
    if (isResponses && upstream.ok) {
      const events = new ResponseEventReader((response) => responseHistory.save(prepared, response));
      const rewrite = bridge ? new ToolBridgeStream(bridge) : null;
      const forward = async (chunk, final = false) => {
        const out = rewrite ? rewrite.push(chunk, final) : chunk;
        finishTrace.watch?.(out);
        await events.push(out, final);
        if (out.length && !res.write(out)) await once(res, 'drain', { signal: abort.signal });
      };
      for await (const chunk of upstream.body) await forward(chunk);
      await forward(new Uint8Array(), true);
      await finishTrace();
      return res.end();
    }
    await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
  } catch (error) {
    const failure = abort.signal.aborted ? 'client closed the connection' : error.message;
    if (finishTrace.watch) await finishTrace({ failure });
    else await trace.write({ route: 'router', path: routed?.pathname ?? url.pathname, failure });
    if (!res.headersSent) return json(res, { error: { code: error.code || 'proxy_error', message: error.message } }, error.status || (error.message.includes('too large') ? 413 : error instanceof SyntaxError ? 400 : 502));
    res.destroy(error);
  }
}

// GPT summarises its own compacted context for the next model, using the
// signed-in ChatGPT account. Returns null when that is not possible.
async function gptHandoff(item) {
  const started = Date.now();
  const carrier = createHash('sha256').update(item.encrypted_content).digest('hex').slice(0, 12);
  try {
    // A long chat takes GPT one to two minutes to summarise.
    const summary = await gptText('You write handoff summaries so another model can continue a conversation.',
      [{ type: 'compaction', encrypted_content: item.encrypted_content }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: HANDOFF_PROMPT }] }], { timeoutMs: 300_000 });
    await trace.write({ route: 'handoff', carrier, ok: Boolean(summary), chars: summary?.length ?? 0, ms: Date.now() - started });
    return summary;
  } catch (error) {
    await trace.write({ route: 'handoff', carrier, ok: false, failure: error.message, ms: Date.now() - started });
    throw error;
  }
}

// A GPT parent seals subagent task text so only GPT can read it. Claude
// children get it back as plain text, read out by GPT once and cached.
const revealed = new Map();
async function gptRevealAgentMessage(item) {
  const key = createHash('sha256').update(item.content[0].encrypted_content).digest('hex');
  if (revealed.has(key)) return revealed.get(key);
  let failure;
  const text = await gptText(`You are ${item.recipient || 'a subagent'}. Your teammate on another model will do the task you were just assigned, so you are handing it over. Output the task payload you received, word for word, with nothing added.`, [
    item,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hand over the task now: write the payload you were sent, verbatim.' }] }
  ]).catch((error) => { failure = error.message; return null; });
  if (text != null) {
    if (revealed.size > 256) revealed.delete(revealed.keys().next().value);
    revealed.set(key, text);
  }
  await trace.write({ route: 'reveal', agentMessage: item.id, ok: text != null, chars: text?.length ?? 0, ...(failure ? { failure } : {}) });
  return text;
}

async function gptText(instructions, input, { timeoutMs = 120_000 } = {}) {
  const auth = await fs.readFile(CODEX_AUTH, 'utf8').then(JSON.parse).catch(() => ({}));
  if (!auth.tokens?.access_token) throw new Error('ChatGPT is not signed in');
  const model = await defaultGptModel();
  const upstream = await fetch(`${CHATGPT_URL}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.tokens.access_token}`, ...(auth.tokens.account_id ? { 'chatgpt-account-id': auth.tokens.account_id } : {}), 'content-type': 'application/json', originator: 'codex_cli_rs' },
    body: JSON.stringify({ model, instructions, store: false, stream: true, input }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!upstream.ok || !upstream.body) throw new Error(`ChatGPT returned ${upstream.status}: ${(await upstream.text().catch(() => '')).slice(0, 200)}`);
  let summary = null;
  const events = new ResponseEventReader(async (response) => {
    summary = response.output.filter((entry) => entry.type === 'message').flatMap((entry) => entry.content || []).map((part) => part.text || '').join('\n').trim() || null;
  });
  for await (const chunk of upstream.body) await events.push(chunk);
  await events.push(new Uint8Array(), true);
  return summary;
}

let codexAccessToken = null;
async function isCodexCaller(header) {
  const token = String(header || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  if (token === codexAccessToken) return true;
  // ChatGPT refreshes its token, so re-read auth.json on a mismatch.
  const auth = await fs.readFile(CODEX_AUTH, 'utf8').then(JSON.parse).catch(() => ({}));
  codexAccessToken = auth.tokens?.access_token || null;
  return token === codexAccessToken;
}

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

// Court mode points ChatGPT's own OpenAI provider here, so every chat keeps
// one provider and the model picker can switch freely. GPT turns go to
// ChatGPT untouched. Other models go to the Router with the tool bridge.
async function proxyChatGPTRequest(req, res, url) {
  // Codex tries a WebSocket first. 426 tells it to use plain HTTP.
  if (req.headers.upgrade) return json(res, { error: { code: 'websocket_unsupported', message: 'Court uses HTTP for Responses.' } }, 426);
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableFinished) abort.abort(); });
  let finishTrace = () => {};
  try {
    const rest = url.pathname.slice('/chatgpt'.length) || '/';
    const raw = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRawBody(req);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(name)) headers[name] = value;
    let body = raw;
    let prepared = null;
    let traced = null;
    if (req.method === 'POST' && ['/responses', '/responses/compact'].includes(rest)) {
      const decoded = decodeBody(raw, req.headers['content-encoding']);
      let request = JSON.parse(decoded.toString('utf8'));
      const received = traceShape(request);
      // GPT always compacts, so the chat only ever holds ChatGPT's own
      // compacted context. Router models read it through a handoff summary.
      const compacting = needsToolBridge(request.model) && wantsCompaction(request);
      if (compacting) request = { ...request, model: await defaultGptModel() };
      if (needsToolBridge(request.model)) {
        if (!(await isCodexCaller(req.headers.authorization))) return json(res, { error: 'Unauthorized' }, 401);
        return proxyRouterRequest(req, res, url, { pathname: `/v1${rest}`, body: decoded });
      }
      // Router turns leave their own item IDs and private reasoning in the
      // chat. Clean them up before GPT sees them. History problems never
      // block GPT: the original request is sent instead.
      prepared = await responseHistory.prepare(request).catch(() => null);
      if (prepared) prepared.request = normaliseAnnotations(unsealPlainAgentMessages(prepared.request));
      const outgoing = prepared?.request ?? normaliseAnnotations(unsealPlainAgentMessages(request));
      if (Array.isArray(request.input) && (compacting || JSON.stringify(outgoing.input) !== JSON.stringify(request.input))) {
        body = JSON.stringify(outgoing);
        delete headers['content-encoding'];
      }
      traced = { sent: outgoing, extra: { path: rest, received, historyPrepared: Boolean(prepared) } };
    }
    const upstream = await fetch(`${CHATGPT_URL}${rest}${url.search}`, { method: req.method, headers, body, redirect: 'manual', signal: abort.signal });
    if (traced) finishTrace = await traceUpstream('chatgpt', traced.sent, upstream, traced.extra);
    const responseHeaders = {};
    // fetch has already decoded the body, so drop its encoding headers.
    upstream.headers.forEach((value, name) => {
      if (!HOP_HEADERS.has(name) && !['content-encoding', 'set-cookie'].includes(name)) responseHeaders[name] = value;
    });
    if (rest === '/responses/compact' && upstream.ok) {
      // Keep a readable copy so a later Claude turn can expand GPT compaction.
      const text = await upstream.text();
      if (prepared) await responseHistory.save(prepared, JSON.parse(text), { compact: true }).catch(() => {});
      res.writeHead(upstream.status, responseHeaders);
      return res.end(text);
    }
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) return res.end();
    if (!prepared || !upstream.ok) {
      await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
      return finishTrace();
    }
    // GPT can compact the chat inside a normal turn. Keep a readable copy so a
    // later Router turn can replay it. History problems never break GPT.
    let events = new ResponseEventReader((response) => responseHistory.save(prepared, response));
    const remember = (chunk, final) => events?.push(chunk, final).catch(() => { events = null; });
    for await (const chunk of upstream.body) {
      finishTrace.watch?.(chunk);
      await remember(chunk);
      if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
    }
    await remember(new Uint8Array(), true);
    await finishTrace();
    res.end();
  } catch (error) {
    const failure = abort.signal.aborted ? 'client closed the connection' : error.message;
    if (finishTrace.watch) await finishTrace({ failure });
    else await trace.write({ route: 'chatgpt', path: url.pathname, failure });
    if (!res.headersSent) return json(res, { error: { code: error.code || 'proxy_error', message: error.message } }, error.status || (error.message.includes('too large') ? 413 : error instanceof SyntaxError ? 400 : 502));
    res.destroy(error);
  }
}

async function accounts() {
  const names = await fs.readdir(AUTH_DIR).catch(() => []);
  const rows = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (filename) => {
    try {
      const absolute = path.join(AUTH_DIR, filename);
      const [raw, stat] = await Promise.all([fs.readFile(absolute, 'utf8'), fs.stat(absolute)]);
      const data = JSON.parse(raw);
      const provider = providerFor(filename, data);
      const tokenClaims = jwtPayload(data.id_token || '');
      const authClaims = tokenClaims['https://api.openai.com/auth'] || {};
      const quota = provider === 'Codex' ? await codexQuota(filename, data) : provider === 'Claude' ? await claudeQuota(filename, data) : {};
      return {
        id: filename.replace(/\.json$/, ''),
        provider,
        label: data.email || filename.replace(/\.json$/, ''),
        plan: quota.plan || titleCasePlan(authClaims.chatgpt_plan_type) || planFor(filename),
        disabled: Boolean(data.disabled),
        expired: Boolean(data.expired),
        updatedAt: stat.mtime.toISOString(),
        quotaUsed: quota.quotaUsed ?? null,
        quotaRemaining: quota.quotaRemaining ?? null,
        windowSeconds: quota.windowSeconds ?? null,
        resetAt: quota.resetAt ?? null,
        bankedResets: quota.bankedResets ?? null,
        activeRequests: 0
      };
    } catch { return null; }
  }));
  const filtered = rows.filter(Boolean);
  const gemini = await geminiCliStatus();
  if (gemini.signedIn) {
    filtered.push({
      id: 'gemini-cli', provider: 'Gemini', label: gemini.accountLabel || 'Gemini CLI Google account',
      plan: 'Google sign-in', disabled: false, expired: false, updatedAt: new Date().toISOString(),
      quotaUsed: null, quotaRemaining: null, windowSeconds: null, resetAt: null, bankedResets: null, activeRequests: 0
    });
  }
  return filtered.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

async function overview() {
  const [router, accountRows, geminiCli] = await Promise.all([verifiedRouterModels(), accounts(), geminiCliStatus()]);
  const providers = Object.values(accountRows.reduce((all, account) => {
    const group = all[account.provider] ||= { name: account.provider, accounts: [], models: [] };
    group.accounts.push(account);
    return all;
  }, {}));
  for (const provider of providers) {
    provider.models = router.models.filter((model) => {
      if (provider.name === 'Codex') return /^gpt|^codex/i.test(model);
      if (provider.name === 'Claude') return /^claude/i.test(model);
      const owner = router.modelDetails?.find((detail) => detail.id === model)?.ownedBy;
      if (provider.name === 'Antigravity') return owner === 'antigravity' || (!owner && /antigravity/i.test(model));
      if (provider.name === 'Gemini') return owner === 'gemini';
      if (provider.name === 'Grok') return /grok/i.test(model);
      if (provider.name === 'Kimi') return /kimi/i.test(model);
      return false;
    });
  }
  return { generatedAt: new Date().toISOString(), router, providers, accounts: accountRows, integrations: { geminiCli } };
}

async function readCustomProviders() {
  try {
    const value = JSON.parse(await fs.readFile(CUSTOM_PROVIDERS, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    try {
      const legacy = await fs.readFile(LEGACY_CUSTOM_PROVIDERS, 'utf8');
      const value = JSON.parse(legacy);
      if (!Array.isArray(value)) return [];
      await fs.writeFile(CUSTOM_PROVIDERS, legacy, { mode: 0o600, flag: 'wx' }).catch(() => {});
      await fs.chmod(CUSTOM_PROVIDERS, 0o600).catch(() => {});
      return value;
    } catch { return []; }
  }
}

function cleanBaseUrl(value) {
  const parsed = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL must use HTTP or HTTPS');
  return parsed.toString().replace(/\/$/, '');
}

async function discoverModels(baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(12_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Model endpoint returned ${response.status}`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('Model endpoint did not return JSON'); }
  const models = (Array.isArray(body) ? body : body.data || body.models || []).map((item) => typeof item === 'string' ? item : item.id || item.name).filter(Boolean);
  if (!models.length) throw new Error('Connected, but no models were returned');
  return [...new Set(models)].slice(0, 2000).sort();
}

async function validateRequestedModel(baseUrl, apiKey, modelId, discovered) {
  if (discovered.includes(modelId)) return;
  const url = new URL(baseUrl);
  if (url.hostname !== 'openrouter.ai') throw new Error(`The provider did not return model ${modelId}`);
  const response = await fetch(`${baseUrl}/models/${modelId}/endpoints`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.data?.id !== modelId) throw new Error(`OpenRouter did not confirm model ${modelId}`);
}

function openRouterConnection(providers) {
  return providers.find((provider) => {
    try { return new URL(provider.baseUrl).hostname === 'openrouter.ai' && provider.apiKey; }
    catch { return false; }
  });
}

async function saveCustomProviders(providers) {
  await fs.writeFile(CUSTOM_PROVIDERS, JSON.stringify(providers, null, 2), { mode: 0o600 });
  await fs.chmod(CUSTOM_PROVIDERS, 0o600);
  await writeRouterProviders(providers);
}

async function writeRouterProviders(providers) {
  const current = await fs.readFile(CONFIG, 'utf8');
  const start = '# >>> COURT CUSTOM PROVIDERS';
  const end = '# <<< COURT CUSTOM PROVIDERS';
  const block = providers.length ? [start, 'openai-compatibility:', ...providers.flatMap((provider) => [
    `  - name: ${JSON.stringify(provider.name)}`,
    `    prefix: ${JSON.stringify(provider.prefix)}`,
    `    base-url: ${JSON.stringify(provider.baseUrl)}`,
    ...(/opencode\.ai\/zen\/go\/v1\/?$/i.test(provider.baseUrl) ? [
      '    headers:',
      '      X-Opencode-Session: "$Session-Id"'
    ] : []),
    '    api-key-entries:',
    `      - api-key: ${JSON.stringify(provider.apiKey)}`,
    '    models:',
    ...provider.models.flatMap((model) => [
      `      - name: ${JSON.stringify(model)}`,
      `        alias: ${JSON.stringify(model === 'unbiased/pareto' ? 'union-alpha' : model)}`
    ])
  ]), end].join('\n') : '';
  const managed = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!managed.test(current) && /^openai-compatibility:\s*$/m.test(current)) throw new Error('Router already has a manually managed openai-compatibility section');
  const next = managed.test(current) ? current.replace(managed, block).trimEnd() + '\n' : `${current.trimEnd()}\n\n${block}\n`;
  await fs.writeFile(CONFIG, next, { mode: 0o600 });
}

async function defaultGptModel() {
  const models = (await nativeModels()).filter((model) => model.visibility === 'list');
  return (models.find((model) => model.slug === 'gpt-6.1-sol') || models[0])?.slug || 'gpt-6.1-sol';
}

async function nativeModels() {
  const cache = await fs.readFile(CODEX_MODELS_CACHE, 'utf8').then(JSON.parse).catch(() => ({}));
  return Array.isArray(cache.models) ? cache.models : [];
}

async function codexMode() {
  const config = await fs.readFile(CODEX_CONFIG, 'utf8').catch(() => '');
  const court = config.includes(`openai_base_url = ${JSON.stringify(COURT_CHATGPT_URL)}`) || /model_provider\s*=\s*["']cliproxyapi["']/.test(config);
  if (!court) return 'normal';
  return /^model\s*=\s*["']gemini-3\.7-flash-high["']/m.test(config) ? 'gemini' : 'court';
}

async function setCodexMode(mode) {
  let config = await fs.readFile(CODEX_CONFIG, 'utf8');
  const previousMode = await codexMode();
  await fs.copyFile(CODEX_CONFIG, `${CODEX_CONFIG}.${Math.floor(Date.now() / 1000)}.bak`);
  if (mode !== 'normal' && previousMode === 'normal') {
    const model = config.match(/^model\s*=\s*["']([^"']*)["']/m)?.[1] || null;
    const modelCatalogJson = config.match(/^model_catalog_json\s*=\s*(["'][^"']*["'])/m)?.[1] || null;
    await fs.writeFile(CODEX_MODE_STATE, JSON.stringify({ model, modelCatalogJson }), { mode: 0o600 });
  }
  const providerBlock = /\n?\[model_providers\.cliproxyapi\]\n[\s\S]*?(?=\n\[|$)/;
  config = config
    .replace(/^model_provider\s*=.*\n/m, '')
    .replace(/^model_catalog_json\s*=.*\n/m, '')
    .replace(/^openai_base_url\s*=.*\n/m, '')
    .replace(providerBlock, '\n');
  let normalModel;
  if (mode === 'normal') {
    const saved = await fs.readFile(CODEX_MODE_STATE, 'utf8').then(JSON.parse).catch(() => ({}));
    const restored = restoreNormalConfig(config, saved);
    config = restored.config;
    normalModel = restored.model;
  } else {
    const router = await verifiedRouterModels();
    if (!router.online) throw new Error(router.error);
    const catalog = toCodexCatalog(router.modelDetails, await nativeModels());
    await fs.writeFile(CODEX_MODEL_CATALOG, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
    if (mode === 'court') {
      const gpt = catalog.models.filter((model) => !needsToolBridge(model.slug) && model.visibility === 'list');
      const defaultModel = gpt.find((model) => model.slug === 'gpt-6.1-sol') || gpt[0];
      if (!defaultModel) throw new Error('Sign in to ChatGPT before enabling Court models.');
      if (/^model\s*=/m.test(config)) config = config.replace(/^model\s*=.*$/m, `model = ${JSON.stringify(defaultModel.slug)}`);
      else config = `model = ${JSON.stringify(defaultModel.slug)}\n${config}`;
    }
    if (mode === 'gemini') {
      if (/^model\s*=/m.test(config)) config = config.replace(/^model\s*=.*$/m, 'model = "gemini-3.7-flash-high"');
      else config = `model = "gemini-3.7-flash-high"\n${config}`;
    }
    const firstLineEnd = config.indexOf('\n') + 1;
    // Every chat stays on ChatGPT's own provider. Court picks the backend per
    // turn, so switching between GPT and Router models never strands a chat.
    config = `${config.slice(0, firstLineEnd)}model_provider = "openai"\nopenai_base_url = ${JSON.stringify(COURT_CHATGPT_URL)}\nmodel_catalog_json = ${JSON.stringify(CODEX_MODEL_CATALOG)}\n${config.slice(firstLineEnd).replace(/^\n+/, '')}`;
    // Chats from older Court versions remember this provider ID.
    config = `${config.trimEnd()}\n\n[model_providers.cliproxyapi]\nname = "Court Router"\nbase_url = "${COURT_API_URL}"\nenv_key = "CLIPROXYAPI_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = true\n`;
  }
  await fs.writeFile(CODEX_CONFIG, config, { mode: 0o600 });
  return normalModel;
}

async function restartChatGPT(mode, normalModel) {
  const key = mode === 'normal' ? '' : await apiKey();
  const backupDir = path.join(STATE_DIR, 'chat-index-backups');
  await restartMacChatGPT(mode, key, async () => {
    if (mode === 'normal') {
      await restoreNativeCourtChats(normalModel, { backupDir });
      await fs.unlink(CODEX_MODE_STATE).catch(() => {});
    } else {
      // Chats an older Court rewrote cannot be edited until Codex rebuilds
      // their index. ChatGPT is closed here, so it is safe to reset them.
      await repairThreadHistory({ backupDir }).catch(() => {});
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (!isLocalRequest(req)) return json(res, { error: 'Local requests only' }, 403);
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const key = await apiKey();
    if (!key || req.headers.authorization !== `Bearer ${key}`) return json(res, { error: 'Unauthorized' }, 401);
    const router = await verifiedRouterModels();
    if (!router.online) return json(res, { error: router.error }, 503);
    return json(res, toCodexCatalog(router.modelDetails, await nativeModels()));
  }
  if (url.pathname.startsWith('/v1/')) return proxyRouterRequest(req, res, url);
  if (url.pathname === '/chatgpt' || url.pathname.startsWith('/chatgpt/')) return proxyChatGPTRequest(req, res, url);
  if (url.pathname === '/api/overview') return json(res, await overview());
  if (url.pathname === '/api/codex-mode' && req.method === 'GET') return json(res, { mode: await codexMode(), switching: changingCodexMode });
  if (url.pathname === '/api/codex-mode' && req.method === 'POST') {
    if (changingCodexMode) return json(res, { error: 'ChatGPT is already switching models. Wait for it to reopen.' }, 409);
    changingCodexMode = true;
    try {
      const mode = (await readJsonBody(req)).mode;
      if (!['court', 'gemini', 'normal'].includes(mode)) throw new Error('Unknown Codex mode');
      if (mode !== 'normal') {
        const router = await routerModels();
        if (!router.online) throw new Error('Router is offline. Start it before launching Codex.');
        if (mode === 'gemini' && !router.models.includes('gemini-3.7-flash-high')) throw new Error('Gemini 3.7 Flash is not available in the current router pool.');
      }
      const normalModel = await setCodexMode(mode);
      await restartChatGPT(mode, normalModel);
      const message = mode === 'gemini' ? 'Restarting Codex with Gemini 3.7 Flash.' : mode === 'court' ? 'Restarting Codex with Court models.' : 'Restoring your normal ChatGPT account.';
      json(res, { ok: true, mode, message });
      return;
    } catch (error) { return json(res, { error: error.message }, 400); }
    finally { changingCodexMode = false; }
  }
  if (url.pathname === '/api/custom-providers' && req.method === 'GET') {
    const providers = await readCustomProviders();
    return json(res, providers.map(({ apiKey, ...provider }) => ({ ...provider, keyHint: `••••${apiKey.slice(-4)}` })));
  }
  if (url.pathname === '/api/custom-providers' && req.method === 'POST') {
    try {
      const input = await readJsonBody(req);
      const name = String(input.name || '').trim();
      const prefix = String(input.prefix || name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const apiKey = String(input.apiKey || '').trim();
      const modelId = String(input.modelId || '').trim();
      const baseUrl = cleanBaseUrl(input.baseUrl);
      if (!name || !prefix || !apiKey) throw new Error('Name, base URL, and API key are required');
      if (name.length > 60 || prefix.length > 60 || modelId.length > 200 || apiKey.length > 8192) throw new Error('Provider details are too long');
      const discovered = await discoverModels(baseUrl, apiKey);
      if (modelId) await validateRequestedModel(baseUrl, apiKey, modelId, discovered);
      const models = modelId ? [modelId] : discovered;
      const providers = await readCustomProviders();
      const entry = { name, prefix, baseUrl, apiKey, models, updatedAt: new Date().toISOString() };
      const index = providers.findIndex((provider) => provider.prefix === prefix);
      if (index >= 0) providers[index] = entry; else providers.push(entry);
      await saveCustomProviders(providers);
      return json(res, { ok: true, models, message: `Connected ${name} with ${models.length} models.` }, 201);
    } catch (error) { return json(res, { error: error.message }, 400); }
  }
  if (url.pathname === '/api/openrouter-routers' && req.method === 'POST') {
    try {
      const providers = await readCustomProviders();
      const source = openRouterConnection(providers);
      if (!source) throw new Error('Connect an OpenRouter API key first.');
      const models = ['openrouter/free', 'openrouter/auto'];
      const discovered = await discoverModels(source.baseUrl, source.apiKey);
      for (const model of models) await validateRequestedModel(source.baseUrl, source.apiKey, model, discovered);
      const entry = {
        ...source,
        name: 'OpenRouter',
        models: [...new Set([...source.models, ...models])],
        updatedAt: new Date().toISOString()
      };
      const next = providers
        .filter((provider) => provider.prefix !== 'openrouter-router')
        .map((provider) => provider === source ? entry : provider);
      await saveCustomProviders(next);
      return json(res, { ok: true, models, message: 'Added OpenRouter Free and Auto routers.' }, 201);
    } catch (error) { return json(res, { error: error.message }, 400); }
  }
  if (url.pathname === '/api/custom-providers' && req.method === 'DELETE') {
    try {
      const prefix = String((await readJsonBody(req)).prefix || '');
      const providers = await readCustomProviders();
      const next = providers.filter((provider) => provider.prefix !== prefix);
      if (next.length === providers.length) return json(res, { error: 'Provider not found' }, 404);
      await saveCustomProviders(next);
      return json(res, { ok: true, message: 'Custom provider removed.' });
    } catch (error) { return json(res, { error: error.message }, 400); }
  }
  if (url.pathname === '/api/logs') {
    const [court, auth] = await Promise.all([
      fs.readFile(COURT_LOG, 'utf8').catch(() => ''),
      fs.readFile(AUTH_LOG, 'utf8').catch(() => '')
    ]);
    return json(res, { court: redactLog(court.slice(-30_000)), auth: redactLog(auth.slice(-30_000)) });
  }
  if (url.pathname === '/api/connect' && req.method === 'POST') {
    let provider;
    try { provider = (await readJsonBody(req)).provider; } catch { return json(res, { error: 'Invalid request' }, 400); }
    if (provider === 'gemini') {
      const binary = await executablePath('gemini');
      if (!binary) return json(res, { error: 'Gemini CLI is not installed. Install @google/gemini-cli first.' }, 409);
      const command = binary.replace(/["\\]/g, '\\$&');
      const terminal = spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`], { detached: true, stdio: 'ignore' });
      terminal.unref();
      return json(res, { ok: true, message: 'Gemini CLI opened in Terminal. Choose Sign in with Google.' }, 202);
    }
    const flags = { codex: '--codex-login', claude: '--claude-login', antigravity: '--antigravity-login', grok: '--xai-login', kimi: '--kimi-login' };
    if (!flags[provider]) return json(res, { error: 'Unsupported provider' }, 400);
    if (provider === 'antigravity') {
      const child = spawn('CLIProxyAPI', [flags[provider], '--no-browser'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let opened = false;
      const handleOutput = (chunk) => {
        const text = chunk.toString();
        fs.appendFile(AUTH_LOG, text).catch(() => {});
        if (opened) return;
        const match = text.match(/https:\/\/accounts\.google\.com\/[^\s]+/);
        if (!match) return;
        opened = true;
        const loginUrl = new URL(match[0]);
        loginUrl.searchParams.set('prompt', 'select_account consent');
        const browser = spawn('open', ['-a', 'Helium', loginUrl.toString()], { detached: true, stdio: 'ignore' });
        browser.unref();
      };
      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);
      child.unref();
      return json(res, { ok: true, message: 'Choose your second Google account in Helium.' }, 202);
    }
    if (provider === 'claude') {
      const cleanup = spawn('pkill', ['-f', '^CLIProxyAPI --claude-login$'], { stdio: 'ignore' });
      await new Promise((resolve) => cleanup.once('exit', resolve));
    }
    const log = await fs.open(AUTH_LOG, 'a');
    const child = spawn('CLIProxyAPI', [flags[provider]], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref();
    setTimeout(() => log.close(), 1_000);
    return json(res, { ok: true, message: `Started ${provider} sign-in in your browser.` }, 202);
  }
  if (url.pathname === '/health') return json(res, { ok: true });
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
  ]);
  const assetMatch = url.pathname.match(/^\/assets\/([a-z0-9-]+\.svg)$/);
  if (assetMatch) staticFiles.set(url.pathname, [path.join('assets', assetMatch[1]), 'image/svg+xml']);
  if (staticFiles.has(url.pathname)) {
    const [file, contentType] = staticFiles.get(url.pathname);
    const content = await fs.readFile(path.join(PUBLIC, file)).catch(() => null);
    if (!content) return json(res, { error: 'Not found' }, 404);
    res.writeHead(200, securityHeaders({ 'content-type': contentType, 'cache-control': 'no-store' }));
    return res.end(content);
  }
  return json(res, { error: 'Not found' }, 404);
});

// ChatGPT reads the saved catalogue file, so refresh it on start. Otherwise a
// catalogue change (such as a larger context window) waits for a mode switch.
async function refreshSavedCatalog() {
  if (await codexMode() === 'normal') return;
  const router = await verifiedRouterModels();
  if (!router.online) return;
  const catalog = toCodexCatalog(router.modelDetails, await nativeModels());
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  if (await fs.readFile(CODEX_MODEL_CATALOG, 'utf8').catch(() => '') === next) return;
  const temp = `${CODEX_MODEL_CATALOG}.${process.pid}.tmp`;
  await fs.writeFile(temp, next, { mode: 0o600 });
  await fs.rename(temp, CODEX_MODEL_CATALOG);
  console.log('Refreshed the saved ChatGPT model catalogue');
}

server.listen(PORT, HOST, () => {
  console.log(`Court is running at http://${HOST}:${PORT}`);
  refreshSavedCatalog().catch((error) => console.error(`Could not refresh the model catalogue: ${error.message}`));
});
