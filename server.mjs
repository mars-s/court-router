import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.COURT_PORT || '8477', 10);
const HOST = '127.0.0.1';
const HOME = os.homedir();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.COURT_STATE_DIR || path.join(HOME, '.local', 'state', 'court');
const AUTH_DIR = process.env.COURT_AUTH_DIR || path.join(HOME, '.cli-proxy-api');
const CONFIG = process.env.COURT_ROUTER_CONFIG || '/opt/homebrew/etc/cliproxyapi.conf';
const ROUTER_URL = process.env.COURT_ROUTER_URL || 'http://127.0.0.1:8317';
const PUBLIC = path.join(ROOT, 'public');
const COURT_LOG = path.join(STATE_DIR, 'court.log');
const AUTH_LOG = path.join(STATE_DIR, 'auth.log');
const CUSTOM_PROVIDERS = process.env.COURT_PROVIDERS_FILE || path.join(STATE_DIR, 'providers.json');
const LEGACY_CUSTOM_PROVIDERS = path.join(HOME, '.court-providers.json');
const CODEX_CONFIG = process.env.COURT_CODEX_CONFIG || path.join(HOME, '.codex', 'config.toml');
const CODEX_MODE_STATE = path.join(STATE_DIR, 'codex-mode.json');
const GEMINI_CREDENTIALS = process.env.COURT_GEMINI_CREDENTIALS || path.join(HOME, '.gemini', 'oauth_creds.json');
const MAX_BODY_BYTES = 32 * 1024;
const quotaCache = new Map();

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
    const modelDetails = (body.data || []).map((model) => ({ id: model.id, ownedBy: model.owned_by || null })).sort((a, b) => a.id.localeCompare(b.id));
    return { online: true, models: modelDetails.map((model) => model.id), modelDetails };
  } catch {
    return { online: false, models: [], error: 'Router is not running' };
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
      const quota = provider === 'Codex' ? await codexQuota(filename, data) : {};
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
  const [router, accountRows, geminiCli] = await Promise.all([routerModels(), accounts(), geminiCliStatus()]);
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

async function codexMode() {
  const config = await fs.readFile(CODEX_CONFIG, 'utf8').catch(() => '');
  if (!/model_provider\s*=\s*["']cliproxyapi["']/.test(config)) return 'normal';
  return /^model\s*=\s*["']gemini-3\.8-flash-high["']/m.test(config) ? 'gemini' : 'court';
}

async function setCodexMode(mode) {
  let config = await fs.readFile(CODEX_CONFIG, 'utf8');
  const previousMode = await codexMode();
  await fs.copyFile(CODEX_CONFIG, `${CODEX_CONFIG}.${Math.floor(Date.now() / 1000)}.bak`);
  if (mode !== 'normal' && previousMode === 'normal') {
    const model = config.match(/^model\s*=\s*(["'][^"']*["'])/m)?.[1] || null;
    await fs.writeFile(CODEX_MODE_STATE, JSON.stringify({ model }), { mode: 0o600 });
  }
  const providerBlock = /\n?\[model_providers\.cliproxyapi\]\n[\s\S]*?(?=\n\[|$)/;
  config = config.replace(/^model_provider\s*=.*\n/m, '').replace(providerBlock, '\n');
  if (mode === 'normal') {
    try {
      const saved = JSON.parse(await fs.readFile(CODEX_MODE_STATE, 'utf8'));
      if (saved.model) config = config.replace(/^model\s*=.*$/m, `model = ${saved.model}`);
      await fs.unlink(CODEX_MODE_STATE);
    } catch {}
  } else {
    if (mode === 'gemini') {
      if (/^model\s*=/m.test(config)) config = config.replace(/^model\s*=.*$/m, 'model = "gemini-3.8-flash-high"');
      else config = `model = "gemini-3.8-flash-high"\n${config}`;
    }
    const firstLineEnd = config.indexOf('\n') + 1;
    config = `${config.slice(0, firstLineEnd)}model_provider = "cliproxyapi"\n${config.slice(firstLineEnd).replace(/^\n+/, '')}`;
    config = `${config.trimEnd()}\n\n[model_providers.cliproxyapi]\nname = "Court Router"\nbase_url = "${ROUTER_URL}/v1"\nenv_key = "CLIPROXYAPI_API_KEY"\nwire_api = "responses"\n`;
  }
  await fs.writeFile(CODEX_CONFIG, config, { mode: 0o600 });
}

function restartChatGPT(mode) {
  const quit = spawn('osascript', ['-e', 'tell application "ChatGPT" to quit'], { stdio: 'ignore' });
  quit.once('exit', () => setTimeout(async () => {
    const env = { ...process.env };
    if (mode !== 'normal') env.CLIPROXYAPI_API_KEY = await apiKey();
    else delete env.CLIPROXYAPI_API_KEY;
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE']) delete env[key];
    const launcher = spawn('/Applications/ChatGPT.app/Contents/Resources/codex', ['app'], {
      cwd: HOME, env, detached: true, stdio: 'ignore'
    });
    launcher.unref();
  }, 1_500));
}

const server = http.createServer(async (req, res) => {
  if (!isLocalRequest(req)) return json(res, { error: 'Local requests only' }, 403);
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/api/overview') return json(res, await overview());
  if (url.pathname === '/api/codex-mode' && req.method === 'GET') return json(res, { mode: await codexMode() });
  if (url.pathname === '/api/codex-mode' && req.method === 'POST') {
    try {
      const mode = (await readJsonBody(req)).mode;
      if (!['court', 'gemini', 'normal'].includes(mode)) throw new Error('Unknown Codex mode');
      if (mode !== 'normal') {
        const router = await routerModels();
        if (!router.online) throw new Error('Router is offline. Start it before launching Codex.');
        if (mode === 'gemini' && !router.models.includes('gemini-3.8-flash-high')) throw new Error('Gemini 3.8 Flash is not available in the current router pool.');
      }
      await setCodexMode(mode);
      const message = mode === 'gemini' ? 'Restarting Codex with Gemini 3.8 Flash.' : mode === 'court' ? 'Restarting Codex with Court models.' : 'Restoring your normal ChatGPT account.';
      json(res, { ok: true, mode, message });
      setTimeout(() => restartChatGPT(mode), 700);
      return;
    } catch (error) { return json(res, { error: error.message }, 400); }
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
      await fs.writeFile(CUSTOM_PROVIDERS, JSON.stringify(providers, null, 2), { mode: 0o600 });
      await fs.chmod(CUSTOM_PROVIDERS, 0o600);
      await writeRouterProviders(providers);
      return json(res, { ok: true, models, message: `Connected ${name} with ${models.length} models.` }, 201);
    } catch (error) { return json(res, { error: error.message }, 400); }
  }
  if (url.pathname === '/api/custom-providers' && req.method === 'DELETE') {
    try {
      const prefix = String((await readJsonBody(req)).prefix || '');
      const providers = await readCustomProviders();
      const next = providers.filter((provider) => provider.prefix !== prefix);
      if (next.length === providers.length) return json(res, { error: 'Provider not found' }, 404);
      await fs.writeFile(CUSTOM_PROVIDERS, JSON.stringify(next, null, 2), { mode: 0o600 });
      await writeRouterProviders(next);
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

server.listen(PORT, HOST, () => console.log(`Court is running at http://${HOST}:${PORT}`));
