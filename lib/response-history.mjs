import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { handoffMessage, isCourtCompaction, summaryMessage } from './handoff.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const providerFor = (model) => /^claude-/i.test(model) ? 'claude' : /^(gpt-|codex-)/i.test(model) ? 'openai' : null;
const inputItems = (input) => typeof input === 'string' ? [{ role: 'user', content: input }] : input ?? [];
const opaque = (item) => ['reasoning', 'compaction'].includes(item.type);

export class HistoryError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Immutable response snapshots let delta requests travel between providers.
// Full-history requests remain authoritative, including edits and rollbacks.
export class ResponseHistory {
  // `handoff(item)` asks the provider that made an opaque compaction to
  // summarise it in plain text, or returns null.
  constructor(directory, { maxBytes = 128 * 1024 * 1024, maxEntries = 128, ttlMs = 7 * 24 * 60 * 60 * 1000, handoff = null } = {}) {
    this.directory = directory;
    this.handoff = handoff;
    this.handoffs = new Map();
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.records = new Map();
    this.items = new Map();
    this.carriers = new Map();
    this.writeQueue = Promise.resolve();
  }

  file(id) { return path.join(this.directory, `${digest(id)}.json`); }

  async load() {
    this.ready ??= this.initialise();
    return this.ready;
  }

  async initialise() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const files = await fs.readdir(this.directory);
    const entries = await Promise.all(files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
      const filename = path.join(this.directory, name);
      return { filename, stat: await fs.stat(filename) };
    }));
    let bytes = 0;
    let count = 0;
    for (const { filename, stat } of entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
      if (Date.now() - stat.mtimeMs > this.ttlMs || count >= this.maxEntries || bytes + stat.size > this.maxBytes) {
        await fs.unlink(filename);
        continue;
      }
      try {
        const record = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (record.version !== 1 || typeof record.id !== 'string' || !Array.isArray(record.input) || !Array.isArray(record.output)) continue;
        this.records.set(record.id, { ...record, bytes: stat.size });
        bytes += stat.size;
        count++;
      } catch { /* An incomplete cache file must not break full-history chats. */ }
    }
    this.index();
  }

  index() {
    this.items.clear();
    this.carriers.clear();
    for (const record of this.records.values()) {
      if (Date.now() - record.createdAt > this.ttlMs) continue;
      for (const [carrier, provider] of Object.entries(record.origins || {})) {
        if (!this.carriers.has(carrier)) this.carriers.set(carrier, { provider });
      }
      for (const item of record.output) {
        const source = { provider: record.provider, item, input: record.input };
        if (item.id) this.items.set(item.id, source);
        if (item.encrypted_content) this.carriers.set(digest(item.encrypted_content), source);
      }
    }
  }

  async prepare(request, expanding = new Set()) {
    await this.load();
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.model !== 'string') {
      throw new HistoryError('A model and a JSON request object are required.', 'invalid_request');
    }
    const provider = providerFor(request.model);
    if (!provider) return { request, provider, input: inputItems(request.input) };
    let input = inputItems(request.input);
    if (!Array.isArray(input)) throw new HistoryError('Responses input must be text or an array.', 'invalid_input');
    let previous = null;
    if (request.previous_response_id) {
      previous = this.records.get(request.previous_response_id);
      if (!previous || Date.now() - previous.createdAt > this.ttlMs) {
        throw new HistoryError('Court cannot find the earlier response. Resume with the full conversation history.', 'previous_response_not_found');
      }
      input = [...previous.input, ...previous.output, ...input];
    }
    const crossProvider = previous && previous.provider !== provider;
    const portable = [];
    for (let item of input) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HistoryError('Invalid conversation item.', 'invalid_input');
      if (item.type === 'item_reference') {
        const source = this.items.get(item.id);
        if (!source) throw new HistoryError('Court cannot resolve this history reference. Send the full conversation items.', 'history_reference_not_found');
        item = source.item;
      }
      // Court's own compaction is readable by every model.
      if (isCourtCompaction(item)) { portable.push(summaryMessage(item)); continue; }
      // Unsealed reasoning makes ChatGPT look for stored data that is not there.
      if (item.type === 'reasoning' && !item.encrypted_content && provider === 'openai') continue;
      // Codex keeps a web search step but drops the results Claude found, so
      // on the next turn Claude would see an empty search. Put them back.
      if (item.type === 'web_search_call' && !item.results && provider === 'claude') {
        const results = this.items.get(item.id)?.item?.results;
        if (Array.isArray(results)) item = { ...item, results };
      }
      const source = (item.encrypted_content && this.carriers.get(digest(item.encrypted_content))) || this.items.get(item.id);
      const foreign = source ? source.provider !== provider : provider === 'claude' || crossProvider;
      if (opaque(item) && foreign) {
        if (item.type === 'compaction') {
          // Like T3 Code, the provider being left writes a handoff summary of
          // its own opaque context. Replaying the saved source is the fallback.
          const summary = await this.summarise(item);
          if (summary) { portable.push(handoffMessage(summary)); continue; }
          if (!source?.input) throw new HistoryError('This compacted history belongs to another provider and Court has no readable copy. Resume from a saved transcript.', 'portable_context_unavailable');
          const carrier = digest(item.encrypted_content || item.id || '');
          if (expanding.has(carrier) || expanding.size >= 16) throw new HistoryError('Cannot safely expand this compacted history. Resume from a saved transcript.', 'portable_context_unavailable');
          const expanded = await this.prepare({ model: request.model, input: source.input }, new Set([...expanding, carrier]));
          portable.push(...expanded.request.input);
        }
        continue;
      }
      const copy = { ...item };
      if (foreign) delete copy.id;
      portable.push(copy);
    }
    const next = { ...request, input: portable };
    delete next.previous_response_id;
    return { request: next, provider, input };
  }

  async summarise(item) {
    if (!this.handoff || !item.encrypted_content) return null;
    // Summaries are slow to make, so they are kept on disk beside the history.
    const key = digest(item.encrypted_content);
    const file = path.join(this.directory, 'handoffs', `${key}.txt`);
    if (!this.handoffs.has(key)) {
      const pending = fs.readFile(file, 'utf8').catch(async () => {
        const summary = await Promise.resolve(this.handoff(item)).catch(() => null);
        if (summary) {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(file, summary, { mode: 0o600 }).catch(() => {});
        }
        return summary;
      });
      this.handoffs.set(key, pending);
      if (!(await pending)) this.handoffs.delete(key);
    }
    return this.handoffs.get(key) ?? null;
  }

  async save(prepared, response, { compact = false } = {}) {
    if (!prepared.provider || !response?.id || !Array.isArray(response.output)) return;
    if (!compact && response.status !== 'completed') return;
    const origins = {};
    for (const item of prepared.input) {
      if (!item.encrypted_content) continue;
      const carrier = digest(item.encrypted_content);
      const source = this.carriers.get(carrier);
      if (source) origins[carrier] = source.provider;
    }
    for (const item of response.output) {
      if (item.encrypted_content) origins[digest(item.encrypted_content)] = prepared.provider;
    }
    const record = {
      version: 1, id: response.id, provider: prepared.provider,
      createdAt: Date.now(), input: prepared.input, output: response.output, origins
    };
    const raw = JSON.stringify(record);
    const bytes = Buffer.byteLength(raw);
    if (bytes > this.maxBytes) throw new HistoryError('Conversation is too large for the Court history cache. Compact the chat before continuing.', 'history_cache_full', 413);
    const write = this.writeQueue.then(async () => {
      const filename = this.file(record.id);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filename);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      this.records.set(record.id, { ...record, bytes });
      let total = [...this.records.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)) {
        if (this.records.size <= this.maxEntries && total <= this.maxBytes && Date.now() - entry.createdAt <= this.ttlMs) break;
        this.records.delete(entry.id);
        total -= entry.bytes;
        await fs.unlink(this.file(entry.id)).catch(() => {});
      }
      this.index();
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }
}

export class ResponseEventReader {
  constructor(onComplete, { maxEventBytes = 32 * 1024 * 1024 } = {}) {
    this.onComplete = onComplete;
    this.maxEventBytes = maxEventBytes;
    this.decoder = new TextDecoder();
    this.pending = '';
    this.items = [];
  }

  async push(chunk, final = false) {
    this.pending += this.decoder.decode(chunk, { stream: !final });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      if (Buffer.byteLength(frame) > this.maxEventBytes) throw new HistoryError('Response event is too large.', 'response_too_large', 413);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.type === 'response.output_item.done' && event.item) this.items[event.output_index ?? this.items.length] = event.item;
      if (event.type === 'response.completed') {
        // ChatGPT sends the finished items as separate events and an empty list here.
        const response = event.response?.output?.length ? event.response : { ...event.response, output: this.items.filter(Boolean) };
        await this.onComplete(response);
      }
    }
    if (Buffer.byteLength(this.pending) > this.maxEventBytes) throw new HistoryError('Response event is too large.', 'response_too_large', 413);
    if (final && this.pending.trim()) throw new HistoryError('Response stream ended before its final event was complete.', 'incomplete_stream', 502);
  }
}
