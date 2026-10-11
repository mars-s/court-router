// Opt-in request trace for debugging. Turn it on with COURT_TRACE=1 or by
// creating trace.on in Court's state folder. Each Responses request becomes
// one JSON line: which backend it went to, which model, the shape of its
// history (item types and reasoning IDs, never message text), and the status
// and error text the backend returned.

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ERROR = 4_000;

export function traceShape(request) {
  const input = Array.isArray(request?.input) ? request.input : [];
  const types = {};
  for (const item of input) types[item?.type || 'message'] = (types[item?.type || 'message'] || 0) + 1;
  // Sealed parts anywhere in the history. OpenAI-sealed blobs start with
  // gAAAA; anything else in a sealed slot is plain text another model wrote.
  const sealed = [];
  input.forEach((item, index) => {
    const parts = [item, ...(Array.isArray(item?.content) ? item.content : [])];
    for (const part of parts) {
      if (typeof part?.encrypted_content === 'string') sealed.push(`${index}:${item.type}${part === item ? '' : `.${part.type}`}:${part.encrypted_content.startsWith('gAAAA') ? 'openai' : 'plain'}`);
    }
  });
  return {
    model: request?.model ?? null,
    items: input.length,
    types,
    sealed,
    previousResponseId: request?.previous_response_id ?? null
  };
}

export class Trace {
  constructor(dir, { env = process.env, redact = (text) => text } = {}) {
    this.file = path.join(dir, 'trace.jsonl');
    this.flag = path.join(dir, 'trace.on');
    this.env = env;
    this.redact = redact;
  }

  async enabled() {
    if (this.env.COURT_TRACE === '1') return true;
    return Boolean(await fs.stat(this.flag).catch(() => null));
  }

  async write(event) {
    if (!(await this.enabled())) return;
    const entry = { at: new Date().toISOString(), ...event };
    if (typeof entry.error === 'string') entry.error = this.redact(entry.error.slice(0, MAX_ERROR));
    await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch(() => {});
  }
}

// Watches a server-sent event stream without changing it and reports how it
// ended: the last event type, the item types it produced, and any error the
// backend put inside the stream (these arrive with HTTP 200).
export class StreamOutcome {
  constructor() {
    this.decoder = new TextDecoder();
    this.pending = '';
    this.last = null;
    this.items = [];
    this.error = null;
  }

  push(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.pending))) {
      const data = this.pending.slice(0, boundary.index).split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      this.last = event.type;
      if (event.type === 'response.output_item.done') this.items.push(event.item?.type);
      const error = event.response?.error || event.error || (event.type === 'error' ? event : null);
      if (error && (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete')) this.error = error.message || error.code || JSON.stringify(error).slice(0, 300);
    }
  }

  summary() {
    return { ended: this.last, output: this.items, ...(this.error ? { streamError: this.error } : {}) };
  }
}
