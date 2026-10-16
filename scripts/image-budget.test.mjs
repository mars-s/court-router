import test from 'node:test';
import assert from 'node:assert/strict';
import { fitImageBudget, setImageShrinker, DROPPED_NOTE } from '../lib/image-budget.mjs';

const image = (fill, kb) => ({ type: 'input_image', image_url: `data:image/png;base64,${fill.repeat(kb * 1024)}` });
const request = (...images) => ({ model: 'claude-opus-5-5', input: images.map((part, i) => ({ role: 'user', content: [{ type: 'input_text', text: `turn ${i}` }, part] })) });

test('leaves small requests untouched', async () => {
  const original = request(image('A', 10));
  const result = await fitImageBudget(original, { budget: 1024 * 1024 });
  assert.equal(result.changed, false);
  assert.equal(result.request, original);
});

test('shrinks images first and keeps them all when that is enough', async () => {
  setImageShrinker(async () => 'data:image/jpeg;base64,small');
  try {
    const original = request(image('A', 600), image('B', 600));
    const result = await fitImageBudget(original, { budget: 1024 * 1024 });
    assert.equal(result.stats.shrunk, 2);
    assert.equal(result.stats.dropped, 0);
    assert.equal(result.request.input[1].content[1].image_url, 'data:image/jpeg;base64,small');
    assert.match(original.input[0].content[1].image_url, /^data:image\/png/, 'original request is not mutated');
  } finally { setImageShrinker(null); }
});

test('drops the oldest images, keeps the newest, when shrinking is not enough', async () => {
  setImageShrinker(async () => { throw new Error('no shrinker'); });
  try {
    const result = await fitImageBudget(request(image('D', 600), image('E', 600), image('F', 600)), { budget: 1024 * 1024 });
    assert.ok(result.stats.after <= 1024 * 1024);
    assert.deepEqual(result.request.input.map((item) => item.content[1].type), ['input_text', 'input_text', 'input_image']);
    assert.equal(result.request.input[0].content[1].text, DROPPED_NOTE);
    assert.match(result.request.input[2].content[1].image_url, /^data:image\/png;base64,F/);
  } finally { setImageShrinker(null); }
});

test('keeps at most the image count Claude accepts', async () => {
  const result = await fitImageBudget(request(image('A', 1), image('B', 1), image('C', 1)), { maxImages: 2 });
  assert.equal(result.stats.dropped, 1);
  assert.equal(result.request.input[0].content[1].type, 'input_text');
});
