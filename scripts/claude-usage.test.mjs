import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeWindow } from '../lib/claude-usage.mjs';

test('picks the Claude window closest to its limit', () => {
  const usage = {
    five_hour: { utilization: 3, resets_at: '2026-10-11T11:10:00.361021+00:00' },
    seven_day: { utilization: 24, resets_at: '2026-10-16T16:00:00+00:00' }
  };
  assert.deepEqual(claudeWindow(usage), {
    quotaUsed: 24, quotaRemaining: 76, windowSeconds: 604_800, resetAt: '2026-10-16T16:00:00.000Z'
  });
  usage.five_hour.utilization = 90;
  assert.equal(claudeWindow(usage).windowSeconds, 18_000);
  assert.equal(claudeWindow(usage).quotaRemaining, 10);
});

test('returns null when no window is reported', () => {
  assert.equal(claudeWindow({ five_hour: null, seven_day: { utilization: null } }), null);
  assert.equal(claudeWindow(null), null);
});
