import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'coverage', 'dist']);
const allowedExtensions = new Set(['', '.css', '.example', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.toml', '.txt', '.zsh']);
const checks = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['authorization bearer value', /authorization\s*[:=]\s*["']?bearer\s+(?!\$|\$\{|\[redacted\]|<)[A-Za-z0-9._~-]{12,}/i],
  ['macOS personal path', /\/Users\/(?!example(?:\/|$))[^/\s"']+/],
  ['credential URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/]
];

async function filesIn(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.filter((entry) => !ignored.has(entry.name)).map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(absolute) : [absolute];
  }));
  return nested.flat();
}

const findings = [];
for (const file of await filesIn(root)) {
  if (!allowedExtensions.has(path.extname(file)) && path.basename(file) !== 'court') continue;
  const content = await fs.readFile(file, 'utf8').catch(() => '');
  for (const [name, pattern] of checks) {
    const match = content.match(pattern);
    if (!match) continue;
    const line = content.slice(0, match.index).split('\n').length;
    findings.push(`${path.relative(root, file)}:${line}: ${name}`);
  }
}

if (findings.length) {
  console.error('Security check failed:');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log('Security check passed: no known secret patterns or personal absolute paths found.');
