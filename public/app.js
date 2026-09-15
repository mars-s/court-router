const providerOrder = ['Codex', 'Claude', 'Grok', 'Antigravity', 'Kimi'];
const providerStyles = { Codex: '#58aef3', Claude: '#e99a5c', Grok: '#65c990', Antigravity: '#ad91f7', Kimi: '#63c7c7' };
const providerAssets = { Codex: 'openai.svg', Claude: 'claude.svg', Grok: 'xai.svg', Antigravity: 'antigravity.svg', Kimi: 'kimi.svg' };
const connectProviders = [['codex', 'Codex'], ['claude', 'Claude'], ['antigravity', 'Antigravity'], ['grok', 'Grok'], ['kimi', 'Kimi']];

let data = null;
let filter = 'All pools';
let customProviders = [];
let refreshTimer;

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];
const safe = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const providerClass = (name) => `provider-${providerOrder.includes(name) ? name : 'Codex'}`;
const mark = (name) => `<span class="provider-mark ${providerClass(name)}"><img src="/assets/${providerAssets[name] || 'openai.svg'}" alt=""></span>`;

function timeUntil(iso) {
  if (!iso) return 'Awaiting provider';
  const seconds = Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} d ${hours} hr` : hours ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

function windowName(seconds) {
  if (!seconds) return 'Allowance window';
  return seconds >= 604800 ? 'Weekly window' : seconds >= 18000 ? '5-hour window' : 'Allowance window';
}

function summaryPool(name) {
  const provider = data.providers.find((item) => item.name === name) || { name, accounts: [], models: [] };
  const known = provider.accounts.filter((account) => account.quotaRemaining !== null);
  const remaining = known.reduce((sum, account) => sum + account.quotaRemaining, 0);
  const capacity = provider.accounts.length * 100;
  const active = provider.accounts.reduce((sum, account) => sum + account.activeRequests, 0);
  const label = known.length
    ? `${Math.round(remaining)}<span class="percent">%</span><span class="capacity">of ${capacity}%</span>`
    : provider.accounts.length
      ? `—<span class="capacity">not reported</span>`
      : `—<span class="capacity">not connected</span>`;
  const segments = provider.accounts.length
    ? provider.accounts.map((account) => `<div class="segment" title="${safe(account.label)}"><span class="segment-fill" style="--fill:${account.quotaRemaining ?? 0}%"></span></div>`).join('')
    : '<div class="segment"><span class="segment-fill" style="--fill:0%"></span></div>';
  return `<article class="pool ${providerClass(name)}"><div class="pool-head"><div class="pool-name">${mark(name)}${safe(name)}</div><span class="pool-count">${plural(provider.accounts.length, 'account')}</span></div><div class="pool-total">${label}</div><div class="pool-window">${known.length ? windowName(known[0].windowSeconds) : 'Provider allowance window'}</div><div class="segmented">${segments}</div><div class="pool-meta"><span><span class="active-number">${active}</span> active requests</span><span class="model-count">${provider.models.length ? plural(provider.models.length, 'model') : 'No models'}</span></div></article>`;
}

function accountCard(account) {
  const reported = account.quotaRemaining !== null;
  const remaining = reported ? Math.max(0, Math.min(100, account.quotaRemaining)) : 0;
  return `<article class="account-card ${providerClass(account.provider)}" data-provider="${safe(account.provider)}"><div class="account-top"><div class="account-title" title="${safe(account.label)}">${safe(account.label)}<div class="account-plan">${safe(account.plan)}</div></div><span class="account-logo">${mark(account.provider)}</span></div><div class="usage-labels"><span>${reported ? windowName(account.windowSeconds) : 'Allowance window'}</span><b>${reported ? `${Math.round(remaining)}% left` : 'Not reported'}</b></div><div class="progress"><div class="progress-fill" style="--fill:${remaining}%"></div></div><div class="resets-copy">${account.bankedResets === null ? 'Reset credits unavailable' : `${account.bankedResets} banked reset${account.bankedResets === 1 ? '' : 's'}`}</div><div class="account-footer"><span>Next reset<b>${timeUntil(account.resetAt)}</b></span><span class="right">Active requests<b>${account.activeRequests}</b></span></div></article>`;
}

function renderOverview() {
  const connected = data.providers.map((provider) => provider.name);
  const pools = [...providerOrder.filter((name) => connected.includes(name)), ...providerOrder.filter((name) => !connected.includes(name))].slice(0, 3);
  qs('#pools').innerHTML = pools.map(summaryPool).join('');
  const available = ['All pools', ...providerOrder.filter((name) => connected.includes(name))];
  qs('#filters').innerHTML = available.map((name) => `<button class="filter ${filter === name ? 'active' : ''}" data-filter="${name}" aria-pressed="${filter === name}">${name === 'All pools' ? '' : `<i class="filter-dot" style="--dot:${providerStyles[name]}"></i>`}${name}</button>`).join('');
  const accounts = filter === 'All pools' ? data.accounts : data.accounts.filter((account) => account.provider === filter);
  qs('#accounts').innerHTML = accounts.length ? accounts.map(accountCard).join('') : '<div class="empty-card">No accounts in this pool. Add one from Manage, then refresh Court.</div>';
  qsa('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; renderOverview(); }));
}

async function refresh() {
  const button = qs('#refresh');
  button.disabled = true;
  button.classList.add('spinning');
  try {
    const response = await fetch('/api/overview');
    if (!response.ok) throw new Error('Court did not return account data');
    data = await response.json();
    qs('#updated').textContent = `Quotas updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`;
    qs('#gateway').innerHTML = data.router.online
      ? `<strong>Gateway ready</strong><span class="separator">·</span> ${plural(data.accounts.length, 'live account')} and ${plural(data.router.models.length, 'available model')}`
      : `<strong>Gateway offline</strong><span class="separator">·</span> ${safe(data.router.error)}`;
    renderOverview();
    renderManage();
  } catch (error) {
    qs('#gateway').innerHTML = '<strong>Court unavailable</strong><span class="separator">·</span> Restart with <code>court up</code>';
  } finally {
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

function renderManage() {
  if (!data) return;
  const oauth = connectProviders.map(([id, name]) => {
    const count = data.accounts.filter((account) => account.provider === name).length;
    return `<article class="provider-connect ${providerClass(name)}"><h2>${mark(name)}${safe(name)}</h2><div class="connect-state">${count ? `${plural(count, 'account')} connected` : 'No accounts connected yet'}</div><button class="connect-button" data-connect="${id}">${count ? 'Add another account' : 'Connect account'}</button></article>`;
  }).join('');
  const custom = customProviders.map((provider) => `<article class="provider-connect custom-provider provider-Codex"><h2><span class="provider-mark">API</span>${safe(provider.name)}</h2><div class="connect-state">${plural(provider.models.length, 'model')} · ${safe(provider.keyHint)}<br><code>${safe(provider.prefix)}/...</code></div><button class="remove-provider" data-remove="${safe(provider.prefix)}">Remove</button></article>`).join('');
  qs('#provider-list').innerHTML = `${oauth}${custom}<button class="add-provider" id="add-provider"><div><span aria-hidden="true">+</span>Add custom OpenAI API</div></button>`;
  qs('#provider-count').textContent = plural(connectProviders.length + customProviders.length, 'provider');
  qsa('[data-connect]').forEach((button) => button.addEventListener('click', () => connect(button)));
  qsa('[data-remove]').forEach((button) => button.addEventListener('click', () => removeProvider(button.dataset.remove)));
  qs('#add-provider').addEventListener('click', () => qs('#endpoint-dialog').showModal());
}

function showToast(message) {
  const toast = qs('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

async function connect(button) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Starting sign-in...';
  try {
    const response = await fetch('/api/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: button.dataset.connect }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    showToast(result.message);
    setTimeout(refresh, 5000);
  } catch (error) { showToast(error.message || 'Could not start sign-in'); }
  finally { button.disabled = false; button.textContent = old; }
}

async function loadLogs() {
  const output = qs('#log-output');
  output.textContent = 'Loading logs...';
  try {
    const response = await fetch('/api/logs');
    const result = await response.json();
    output.textContent = [result.court && `COURT\n${result.court}`, result.auth && `SIGN-IN\n${result.auth}`].filter(Boolean).join('\n\n') || 'No activity has been logged yet.';
    output.scrollTop = output.scrollHeight;
  } catch { output.textContent = 'Could not load logs.'; }
}

async function loadCustomProviders() {
  try { const response = await fetch('/api/custom-providers'); customProviders = await response.json(); renderManage(); } catch {}
}

async function saveEndpoint(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const result = qs('#form-result');
  button.disabled = true;
  button.textContent = 'Testing models...';
  result.className = 'form-result';
  result.textContent = "Calling the provider's /models endpoint...";
  try {
    const payload = Object.fromEntries(new FormData(form));
    const response = await fetch('/api/custom-providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    form.reset();
    qs('#endpoint-dialog').close();
    showToast(body.message);
    await loadCustomProviders();
    setTimeout(refresh, 1200);
  } catch (error) { result.className = 'form-result error'; result.textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Test and add'; }
}

async function removeProvider(prefix) {
  if (!confirm(`Remove ${prefix} and its API key from Router?`)) return;
  try {
    const response = await fetch('/api/custom-providers', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    showToast(body.message);
    await loadCustomProviders();
  } catch (error) { showToast(error.message); }
}

async function loadCodexMode() {
  try {
    const response = await fetch('/api/codex-mode');
    const { mode } = await response.json();
    qs('#codex-mode-copy').textContent = mode === 'court' ? 'Using Court Router and its model pool' : 'Using your normal ChatGPT account';
    qsa('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  } catch { qs('#codex-mode-copy').textContent = 'Could not read Codex configuration'; }
}

async function changeCodexMode(mode) {
  const label = mode === 'court' ? 'Court models' : 'your normal ChatGPT account';
  if (!confirm(`Restart the Codex App using ${label}? Any running tasks will be interrupted.`)) return;
  qsa('[data-mode]').forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch('/api/codex-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    showToast(body.message);
  } catch (error) { showToast(error.message); qsa('[data-mode]').forEach((button) => { button.disabled = false; }); }
}

function showView(name, { updateHash = true } = {}) {
  qsa('.view').forEach((view) => { view.hidden = view.id !== `view-${name}`; });
  qsa('.shell-header [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  if (updateHash) history.replaceState(null, '', `#${name}`);
  if (name === 'logs') loadLogs();
}

qsa('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
qs('.brand').addEventListener('click', () => showView('overview'));
qs('#refresh').addEventListener('click', refresh);
qs('#refresh-logs').addEventListener('click', loadLogs);
qs('#endpoint-form').addEventListener('submit', saveEndpoint);
qsa('.close-modal,.cancel-modal').forEach((button) => button.addEventListener('click', () => qs('#endpoint-dialog').close()));
qsa('[data-mode]').forEach((button) => button.addEventListener('click', () => changeCodexMode(button.dataset.mode)));
qs('#local-address').textContent = location.host;

const rate = qs('#refresh-rate');
rate.value = localStorage.getItem('court-refresh-rate') || '30';
function scheduleRefresh() { clearInterval(refreshTimer); refreshTimer = setInterval(refresh, Number(rate.value) * 1000); }
rate.addEventListener('change', () => { localStorage.setItem('court-refresh-rate', rate.value); scheduleRefresh(); showToast('Refresh setting saved'); });

const initialView = ['overview', 'manage', 'logs', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
showView(initialView, { updateHash: false });
loadCustomProviders();
loadCodexMode();
refresh();
scheduleRefresh();
