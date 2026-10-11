import { spawn } from 'node:child_process';

const APP_BUNDLE_ID = 'com.openai.codex';
const APP_NAME = 'ChatGPT';
const KEY_NAME = 'CLIPROXYAPI_API_KEY';

function runQuiet(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', ...options });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

export function guiEnvironmentCommand(mode, key) {
  if (mode === 'normal') return { command: '/bin/launchctl', args: ['unsetenv', KEY_NAME] };
  if (!key) throw new Error('Court Router API key is unavailable');
  return { command: '/bin/launchctl', args: ['setenv', KEY_NAME, key] };
}

export async function restartMacChatGPT(mode, key, beforeOpen) {
  const environment = guiEnvironmentCommand(mode, key);
  await runQuiet(environment.command, environment.args);
  await runQuiet('/usr/bin/osascript', ['-e', `tell application id "${APP_BUNDLE_ID}" to quit`]);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  try {
    await beforeOpen?.();
  } finally {
    await runQuiet('/usr/bin/open', ['-a', APP_NAME]);
  }
}
