// Anthropic rejects requests over about 32 MB ("request_too_large") and more
// than 100 images, and Court cannot raise either limit. Image-heavy chats hit
// them because every turn resends every pasted image as a full-size PNG.
// When a Claude request is too big, shrink its images to the size Claude
// reads anyway, then replace the oldest ones with a short note if needed.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const REQUEST_BUDGET_BYTES = 28 * 1024 * 1024;
export const MAX_IMAGES = 100;
const LONG_EDGE = 1568;
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,/i;
export const DROPPED_NOTE = '[Court removed this older image so the request fits Claude\'s size limit. Ask the user to paste it again if you need it.]';

async function sipsShrink(dataUrl) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'court-img-'));
  const source = path.join(folder, 'in');
  const target = path.join(folder, 'out.jpg');
  try {
    await fs.writeFile(source, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(LONG_EDGE), source, '--out', target], { timeout: 30_000 });
    return `data:image/jpeg;base64,${(await fs.readFile(target)).toString('base64')}`;
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

// Swappable for tests and hosts without sips.
let shrinkImage = sipsShrink;
export function setImageShrinker(fn) { shrinkImage = fn || sipsShrink; }

const cache = new Map();
async function shrunk(dataUrl) {
  const key = createHash('sha256').update(dataUrl).digest('hex');
  if (cache.has(key)) return cache.get(key);
  let result = dataUrl;
  try {
    const smaller = await shrinkImage(dataUrl);
    if (typeof smaller === 'string' && smaller.length < dataUrl.length) result = smaller;
  } catch {}
  cache.set(key, result);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return result;
}

// Every inline image part, oldest first, with its parent array slot.
function findImages(value, found = [], parent = null, index = null) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => findImages(item, found, value, i));
  } else if (value && typeof value === 'object') {
    const url = typeof value.image_url === 'string' ? value.image_url : value.image_url?.url;
    if (value.type === 'input_image' && typeof url === 'string' && DATA_URL.test(url) && parent) {
      found.push({ part: value, parent, index, url });
      return found;
    }
    for (const child of Object.values(value)) findImages(child, found);
  }
  return found;
}

function setUrl(image, url) {
  if (typeof image.part.image_url === 'string') image.part.image_url = url;
  else image.part.image_url = { ...image.part.image_url, url };
  image.url = url;
}

const size = (request) => Buffer.byteLength(JSON.stringify(request));

export async function fitImageBudget(request, { budget = REQUEST_BUDGET_BYTES, maxImages = MAX_IMAGES } = {}) {
  const before = size(request);
  if (before <= budget && findImages(request.input).length <= maxImages) return { request, changed: false };
  request = structuredClone(request);
  const images = findImages(request.input);
  let shrunkCount = 0;
  if (before > budget) {
    for (const image of images) {
      const next = await shrunk(image.url);
      if (next !== image.url) { setUrl(image, next); shrunkCount += 1; }
    }
  }
  let bytes = size(request);
  let dropped = 0;
  for (const image of images) {
    if (bytes <= budget && images.length - dropped <= maxImages) break;
    const note = { type: 'input_text', text: DROPPED_NOTE };
    bytes -= Buffer.byteLength(JSON.stringify(image.part)) - Buffer.byteLength(JSON.stringify(note));
    image.parent[image.index] = note;
    dropped += 1;
  }
  return { request, changed: true, stats: { before, after: size(request), images: images.length, shrunk: shrunkCount, dropped } };
}
