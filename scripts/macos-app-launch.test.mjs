import assert from 'node:assert/strict';
import test from 'node:test';
import { guiEnvironmentCommand } from '../lib/macos-app-launch.mjs';

test('Court mode installs the router key in the macOS GUI session', () => {
  assert.deepEqual(guiEnvironmentCommand('court', 'test-key'), {
    command: '/bin/launchctl',
    args: ['setenv', 'CLIPROXYAPI_API_KEY', 'test-key']
  });
});

test('normal mode removes the router key from the macOS GUI session', () => {
  assert.deepEqual(guiEnvironmentCommand('normal', ''), {
    command: '/bin/launchctl',
    args: ['unsetenv', 'CLIPROXYAPI_API_KEY']
  });
});

test('Court mode refuses to launch without a router key', () => {
  assert.throws(() => guiEnvironmentCommand('court', ''), /API key is unavailable/);
});
