#!/usr/bin/env node
// End-to-end benchmark for Court. It drives the Codex engine bundled with the
// ChatGPT desktop app, so every turn takes the real path: engine -> Court ->
// ChatGPT or the Router -> model -> engine tools. Checks run in parallel, one
// short-lived thread each, for every model and every ordered model pair.
//
//   npm run bench                              fast suite, default models
//   npm run bench -- --slow                    adds image generation and compaction
//   npm run bench -- --models claude-sonnet-5,gpt-6.1-sol --only search,subagent
//   npm run bench -- --list                    show the plan without running
//
// Before any model call it checks the app (drift.mjs): Court is up, the
// config points at Court, the models exist, and the engine still has every
// method and item field the checks use. A broken contract stops the run with
// the exact missing piece, which is what an app update usually breaks first.
//
// The desktop phase opens ChatGPT if it is closed and confirms its own engine
// is running the same build. Browsers exist only inside the desktop window,
// so browser counts are not asserted here; see docs/benchmark.md.
//
// Terminal: one line per check. Report: ~/.local/state/court/bench/<time>.json,
// with a short item trail (types, tools, statuses, no prompts) for failures.

import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServer, CODEX_BIN, agentText, completedItems } from './client.mjs';
import { solidPng } from './fixtures.mjs';
import { drift, saveBaseline } from './drift.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const MODELS = [...new Set(option('models', 'claude-sonnet-5,gpt-6-luna').split(',').map((m) => m.trim()).filter(Boolean))];
const ONLY = option('only', '').split(',').filter(Boolean);
const CONCURRENCY = Math.max(1, Number(option('jobs', 6)) || 6);
const TIMEOUT = Math.max(10_000, Number(option('timeout', 180_000)) || 180_000);
const provider = (model) => /^claude-/.test(model) ? 'claude' : 'gpt';
const slug = (model) => model.replace(/[^a-z0-9]+/gi, '_').toUpperCase();

class CheckFailed extends Error {}
const expect = (ok, message) => { if (!ok) throw new CheckFailed(message); };
const quote = (text, n = 120) => JSON.stringify(String(text ?? '').slice(0, n));
const has = (text, word) => new RegExp(`\\b${word}\\b`, 'i').test(text);
// Per running check: every event seen (for the failure trail) and notes such
// as retries, which show up even when the check passes.
const checkEvents = new AsyncLocalStorage();

// ---- checks -------------------------------------------------------------
// Each check proves the tool really ran (from engine items), then that the
// model used the result (from its reply). A model claiming success is not
// enough on its own.

const checks = [];
const check = (name, models, body, { slow = false } = {}) => checks.push({ name, models, body, slow });

function defineChecks(ctx) {
  const { thread, turn, done, swatch, work, engine, cleanup } = ctx;

  for (const model of MODELS) {
    check('reply', [model], async () => {
      const r = done(await turn(await thread(model), 'Reply with exactly: PONG'));
      expect(has(r.text, 'PONG'), `said ${quote(r.text)}`);
    });

    check('shell', [model], async () => {
      const r = done(await turn(await thread(model), 'Run the shell command `echo BENCH_$((6*7))` and reply with its exact output only.'));
      expect(r.items.some((i) => i.type === 'commandExecution' && i.exitCode === 0 && /BENCH_42/.test(i.aggregatedOutput ?? '')), 'no command printed BENCH_42');
      expect(r.text.includes('BENCH_42'), `said ${quote(r.text)}`);
    });

    check('patch', [model], async () => {
      const file = `patched-${slug(model).toLowerCase()}.txt`;
      const r = done(await turn(await thread(model), `Use the apply_patch tool to create a new file ${file} in the current folder containing the single line: COURT_PATCH_OK. Then reply DONE.`));
      const content = await fs.readFile(path.join(work, file), 'utf8').catch(() => '');
      expect(content.trim() === 'COURT_PATCH_OK', `file holds ${quote(content, 60)}`);
    });

    check('search', [model], async () => {
      const r = done(await turn(await thread(model), 'You must use your web search tool for this, even if you think you know. Search the web for "Australian Bureau of Meteorology". Reply with the domain of the official site, or SEARCH EMPTY if the search gave you nothing.'));
      expect(r.items.some((i) => i.type === 'webSearch'), 'no web search ran');
      expect(/bom\.gov\.au/i.test(r.text), `said ${quote(r.text)}`);
    });

    // Claude defers a hosted search when it calls one of our tools in the
    // same step. Court must not hand it back as an empty search.
    check('search+tool', [model], async () => {
      const r = done(await turn(await thread(model), 'In ONE step, at the same time: run the shell command `echo STEP_OK` AND search the web for "Australian Bureau of Meteorology". Then reply with the shell output and the official site domain. If the search gave you nothing, say SEARCH EMPTY.'));
      expect(r.items.some((i) => i.type === 'commandExecution' && /STEP_OK/.test(i.aggregatedOutput ?? '')), 'shell did not print STEP_OK');
      expect(r.items.some((i) => i.type === 'webSearch'), 'no web search ran');
      expect(!/SEARCH EMPTY/i.test(r.text), 'model reported an empty search');
      expect(/bom\.gov\.au/i.test(r.text), `said ${quote(r.text)}`);
    });

    // A later turn must still see what an earlier search found.
    check('search-history', [model], async () => {
      const id = await thread(model);
      // The first reply must quote a result title, so the model has to read
      // its results. (GPT 6.1 Sol searches from its code tool and, asked only
      // for OK, sometimes never prints the results, so it never sees them.)
      // The second turn asks for the domain, which the title does not give.
      const first = done(await turn(id, 'You must use your web search tool now. Search the web for "Australian Bureau of Meteorology" and reply with only the page title of the official site\'s result, without its address.'));
      expect(first.items.some((i) => i.type === 'webSearch'), 'first turn did not search');
      const r = done(await turn(id, 'Do not search. From your earlier search results in this chat, including tool outputs: what is that result\'s domain? If you have no earlier results, say NO RESULTS.'));
      expect(!r.items.some((i) => i.type === 'webSearch'), 'searched again instead of reading history');
      expect(/bom\.gov\.au/i.test(r.text), `said ${quote(r.text)}`);
    });

    check('image-view', [model], async () => {
      const r = done(await turn(await thread(model), `Use the view_image tool on ${swatch('blue')} and reply with the main colour in one lowercase word.`));
      expect(r.items.some((i) => i.type === 'imageView'), 'view_image was not called');
      expect(has(r.text, 'blue'), `said ${quote(r.text)}`);
    });

    check('computer-use', [model], async () => {
      const r = done(await turn(await thread(model), [
        'Use the computer use JavaScript tool (cua_repl js; find it with tool_search if needed).',
        'First call it with exactly: await cua.getState();',
        'Then call it again with exactly: const s = await cua.getState(); nodeRepl.write("APPS=" + s.apps.length + " BROWSERS=" + s.browsers.length);',
        'Reply with only the APPS= line from the second call.'
      ].join('\n')));
      const calls = r.items.filter((i) => i.type === 'mcpToolCall' && /cua/i.test(`${i.server} ${i.tool}`));
      expect(calls.length > 0, 'computer use tool was not called');
      expect(calls.every((i) => i.status === 'completed' && !i.error), `tool failed: ${quote(calls.find((i) => i.error)?.error?.message ?? calls.find((i) => i.status !== 'completed')?.status)}`);
      expect(Number(r.text.match(/APPS=(\d+)/)?.[1] ?? 0) > 0, `said ${quote(r.text)}`);
    });

    check('memory', [model], async () => {
      const id = await thread(model);
      done(await turn(id, 'Remember the code word KESTREL. Reply OK.'));
      const r = done(await turn(id, 'What was the code word? One word.'));
      expect(has(r.text, 'KESTREL'), `said ${quote(r.text)}`);
    });

    // The app's "edit message" is thread/revert followed by a new turn.
    check('edit', [model], async () => {
      const id = await thread(model, { ephemeral: false });
      try {
        done(await turn(id, 'Remember the code word ZEBRA. Reply OK.'));
        const second = done(await turn(id, 'Forget that. The code word is now APPLE. Reply OK.'));
        await engine.call('thread/revert', { threadId: id, beforeTurnId: second.turn.id });
        const r = done(await turn(id, 'What is the code word? One word.'));
        expect(has(r.text, 'ZEBRA') && !has(r.text, 'APPLE'), `said ${quote(r.text)}`);
      } finally { await cleanup(id); }
    });

    // Generate, then have the same model look at the saved file.
    check('image-gen', [model], async () => {
      const id = await thread(model);
      const r = done(await turn(id, 'Generate an image of a single red apple on a plain white background with your image generation tool. Then reply with the saved file path only.'));
      const generated = r.all.find((i) => i.type === 'imageGeneration');
      expect(generated, 'no image generation ran');
      expect(!generated.failure && generated.status !== 'failed', `generation failed: ${quote(generated.failure ?? generated.status)}`);
      expect(generated.savedPath, 'no saved path');
      const size = (await fs.stat(generated.savedPath).catch(() => null))?.size ?? 0;
      expect(size > 1_000, `saved file is ${size} bytes`);
      const look = done(await turn(id, `Use view_image on ${generated.savedPath} and name the fruit in one lowercase word.`));
      expect(look.items.some((i) => i.type === 'imageView'), 'did not view the generated image');
      expect(has(look.text, 'apple'), `said ${quote(look.text)}`);
    }, { slow: true });
  }

  for (const from of MODELS) {
    for (const to of MODELS) {
      // The helper must run a real tool in its own thread, on the requested
      // model, so this covers the helper's tool loop on its provider.
      const token = `CHILD_${slug(to)}_OK`;
      check('subagent', [from, to], async () => {
        const r = done(await turn(await thread(from), `Use spawn_agent (load it with tool_search if needed) to start ONE subagent with model "${to}" and fork_turns "none". Its task: "Run the shell command \`echo ${token}\` and reply with its output only." Do not run the command yourself. Wait for it with wait_agent, then reply with exactly what it returned.`));
        // Claude parents report a spawn as collabAgentToolCall, GPT parents
        // as subAgentActivity. The engine's record of the helper thread says
        // which model really ran it.
        const spawn = r.items.find((i) => (i.type === 'collabAgentToolCall' && i.tool === 'spawnAgent') || (i.type === 'subAgentActivity' && i.kind === 'started'));
        expect(spawn, 'no helper was spawned');
        expect(spawn.status === undefined || spawn.status === 'completed', `spawn ${spawn.status}`);
        const child = spawn.receiverThreadIds?.[0] ?? spawn.agentThreadId;
        expect(child, 'spawn has no helper thread');
        const record = await engine.call('thread/read', { threadId: child }).catch((error) => ({ error }));
        const childModel = record.thread?.model ?? spawn.model;
        expect(childModel, `could not read the helper's model: ${quote(record.error?.message)}`);
        expect(childModel === to, `helper ran ${quote(childModel)} instead of ${to}`);
        const childItems = completedItems(r.events, child);
        const childStates = r.all.filter((i) => i.type === 'collabAgentToolCall').flatMap((i) => Object.entries(i.agentsStates || {})).filter(([tid]) => tid === child).map(([, s]) => s);
        expect(!childStates.some((s) => s.status === 'errored'), `helper errored: ${quote(childStates.find((s) => s.status === 'errored')?.message, 200)}`);
        expect(childItems.some((i) => i.type === 'commandExecution' && (i.aggregatedOutput ?? '').includes(token)), `helper did not run the shell (helper items: ${childItems.map((i) => i.type).join(',') || 'none'})`);
        expect(r.text.includes(token), `parent said ${quote(r.text, 160)}`);
      });
      if (from === to) continue;

      // Change model mid-chat: history, including a tool call, must carry over.
      check('switch', [from, to], async () => {
        const id = await thread(from);
        done(await turn(id, 'Run `echo SWITCH_SEED` in the shell, remember the code word OSPREY, and reply OK.'));
        const r = done(await turn(id, 'What was the code word, and what did the shell print? Reply as WORD OUTPUT.', { model: to }));
        expect(has(r.text, 'OSPREY') && r.text.includes('SWITCH_SEED'), `said ${quote(r.text)}`);
      });

      check('compact-switch', [from, to], async () => {
        const id = await thread(from, { ephemeral: false });
        try {
          done(await turn(id, 'Remember the code word HERON. Reply OK.'));
          await ctx.compact(id);
          const r = done(await turn(id, 'What was the code word? One word.', { model: to }));
          expect(has(r.text, 'HERON'), `said ${quote(r.text)}`);
        } finally { await cleanup(id); }
      }, { slow: true });
    }
  }
}

// A short, private trail of what happened in a failed check: item types,
// tool names, statuses and errors. No prompts, replies or tool output.
function trail(events) {
  return (events || []).filter((e) => e.method === 'item/completed' || e.method === 'error' || e.method === 'turn/completed').slice(-40).map((e) => {
    const p = e.params || {};
    const thread = String(p.threadId ?? '').slice(-6);
    if (e.method === 'turn/completed') return `${thread} turn ${p.turn?.status}${p.turn?.error ? `: ${String(p.turn.error.message).slice(0, 120)}` : ''}`;
    if (e.method === 'error') return `${thread} error ${String(p.error?.message ?? '').slice(0, 120)}`;
    const i = p.item || {};
    const bits = [i.type, i.tool, i.server, i.model, i.status, i.exitCode !== undefined && i.exitCode !== null ? `exit ${i.exitCode}` : null, i.error ? `error ${String(i.error.message ?? i.error).slice(0, 80)}` : null, i.failure ? `failure ${String(i.failure).slice(0, 80)}` : null];
    return `${thread} ${bits.filter(Boolean).join(' ')}`;
  });
}

// Opens ChatGPT if it is closed and confirms its engine is this build.
async function desktop() {
  const engines = async () => (await run('/bin/ps', ['-axo', 'pid=,args=']).then((r) => r.stdout, () => '')).split('\n').filter((l) => /CodexCLI\.app\/Contents\/MacOS\/codex .*code_mode_host=true app-server/.test(l));
  let found = await engines();
  let opened = false;
  if (!found.length) {
    opened = true;
    await run('/usr/bin/open', ['-g', '-a', 'ChatGPT']);
    for (let i = 0; i < 40 && !found.length; i++) { await new Promise((r) => setTimeout(r, 500)); found = await engines(); }
  }
  expect(found.length > 0, 'desktop app engine did not start');
  const bin = found[0].trim().split(/\s+/)[1];
  const [desk, ours] = await Promise.all([bin, CODEX_BIN].map((b) => run(b, ['--version']).then((r) => r.stdout.trim(), () => 'unknown')));
  expect(desk === ours, `desktop engine ${desk} differs from benchmark engine ${ours}`);
  return opened ? 'opened app' : 'app running';
}

// ---- main ---------------------------------------------------------------

let engine = null;
let work = null;
const cleanupAll = async () => {
  await engine?.close().catch(() => {});
  if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await cleanupAll(); process.exit(130); });

let exitCode = 1;
try {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'court-bench-'));
  // Neutral names, so a model cannot read the colour from the file name.
  const swatches = {};
  for (const [name, rgb] of Object.entries({ red: [220, 30, 30], blue: [30, 60, 220], green: [30, 170, 60] })) {
    swatches[name] = path.join(work, `fixture-${Math.random().toString(36).slice(2, 8)}.png`);
    await fs.writeFile(swatches[name], solidPng(rgb));
  }

  engine = new AppServer();
  const ctx = {
    engine,
    work,
    swatch: (name) => swatches[name],
    async thread(model, { ephemeral = true } = {}) {
      const { thread } = await engine.call('thread/start', { model, ephemeral, cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access' });
      return thread.id;
    },
    async turn(threadId, text, extra = {}) {
      const log = checkEvents.getStore()?.events;
      let outcome;
      try { outcome = await engine.runTurn({ threadId, input: [{ type: 'text', text }], ...extra }, { timeout: TIMEOUT }); } catch (error) { log?.push(...(error.events || [])); throw error; }
      const { turn, events } = outcome;
      log?.push(...events);
      return { turn, events, items: completedItems(events, threadId), all: completedItems(events), text: agentText(events, threadId) };
    },
    done(result) {
      if (result.turn?.status !== 'completed') throw new CheckFailed(`turn ${result.turn?.status}: ${String(result.turn?.error?.message ?? 'no error text').slice(0, 200)}`);
      return result;
    },
    note(text) { checkEvents.getStore()?.notes.push(text); },
    async cleanup(threadId) {
      await engine.call('thread/delete', { threadId }).catch((error) => { throw new CheckFailed(`could not delete test chat: ${error.message}`); });
    },
    // Compaction runs as its own turn. It must produce a contextCompaction
    // item (or the older thread/compacted notification) and then finish,
    // because the thread refuses new input until that turn completes.
    compact(threadId) {
      return new Promise((resolve, reject) => {
        let compacted = false;
        const finish = (error) => { clearTimeout(timer); engine.off('notification', listener); error ? reject(error) : resolve(); };
        const listener = (e) => {
          if (e.params?.threadId !== threadId) return;
          if (e.method === 'thread/compacted' || (e.method === 'item/completed' && e.params.item?.type === 'contextCompaction')) compacted = true;
          if (e.method !== 'turn/completed') return;
          if (e.params.turn?.status !== 'completed') finish(new CheckFailed(`compaction turn ${e.params.turn?.status}: ${e.params.turn?.error?.message ?? ''}`));
          else finish(compacted ? null : new CheckFailed('compaction turn ended without compacting'));
        };
        const timer = setTimeout(() => finish(new CheckFailed('compaction did not finish')), TIMEOUT);
        engine.on('notification', listener);
        engine.call('thread/compact/start', { threadId }).catch(finish);
      });
    }
  };
  defineChecks(ctx);

  const selected = checks.filter((c) => (!c.slow || flag('slow')) && (!ONLY.length || ONLY.includes(c.name)));
  const unknown = ONLY.filter((name) => !checks.some((c) => c.name === name));
  if (unknown.length) throw new Error(`unknown check ${unknown.join(', ')}. Known: ${[...new Set(checks.map((c) => c.name))].join(', ')}`);
  if (flag('list')) {
    for (const c of selected) console.log(`${c.name.padEnd(15)} ${c.models.join(' -> ')}`);
    exitCode = 0;
  } else {
    const started = Date.now();
    const pre = await drift({ models: MODELS });
    console.log(`app ${pre.app}, engine ${pre.cli}, ${pre.catalog} models in catalogue${pre.firstRun ? ', first run' : ''}`);
    for (const change of pre.changed) console.log(`! changed since the last green run: ${change}`);
    if (pre.broken.length) {
      for (const problem of pre.broken) console.log(`BROKEN ${problem}`);
      throw new Error('setup is broken; fix the lines above before running model checks');
    }
    const report = { at: new Date().toISOString(), codex: CODEX_BIN, models: MODELS, slow: flag('slow'), only: ONLY, drift: pre, results: [] };

    const line = (result) => console.log(`${result.status === 'pass' ? (result.notes ? 'ok~ ' : 'ok  ') : 'FAIL'} ${result.check.padEnd(15)} ${result.models.join(' -> ').padEnd(36)} ${(result.ms / 1000).toFixed(1).padStart(6)}s${result.detail ? `  ${result.detail.slice(0, 200)}` : ''}${result.notes ? `  (${result.notes.join('; ')})` : ''}`);
    const t0 = Date.now();
    try {
      const note = await desktop();
      report.results.push({ check: 'desktop', models: [], status: 'pass', ms: Date.now() - t0, detail: note });
    } catch (error) {
      report.results.push({ check: 'desktop', models: [], status: 'fail', ms: Date.now() - t0, detail: error.message });
    }
    line(report.results[0]);

    await engine.start();
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const c = selected[next++];
        const began = Date.now();
        const result = { check: c.name, models: c.models, status: 'pass' };
        const store = { events: [], notes: [] };
        try { await checkEvents.run(store, c.body); } catch (error) {
          result.status = error instanceof CheckFailed ? 'fail' : 'error';
          result.detail = error.message;
          result.trail = trail(store.events);
        }
        if (store.notes.length) result.notes = store.notes;
        result.ms = Date.now() - began;
        report.results.push(result);
        line(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

    const failed = report.results.filter((r) => r.status !== 'pass');
    report.ms = Date.now() - started;
    if (failed.length && engine.stderr) report.engineStderr = engine.stderr.split('\n').filter((l) => /ERROR|WARN|panic/i.test(l)).slice(-20);
    const dir = path.join(process.env.COURT_STATE_DIR || path.join(os.homedir(), '.local/state/court'), 'bench');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${report.at.replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
    // Only a complete, green default-depth run becomes the new baseline.
    if (!failed.length && !ONLY.length) await saveBaseline(pre);
    console.log(`\n${report.results.length - failed.length}/${report.results.length} passed in ${Math.round(report.ms / 1000)}s. Report: ${file}`);
    exitCode = failed.length ? 1 : 0;
  }
} catch (error) {
  console.error(`bench stopped: ${error.message}`);
  if (engine?.stderr) console.error(engine.stderr.split('\n').slice(-5).join('\n'));
  exitCode = 2;
} finally {
  await cleanupAll();
}
process.exit(exitCode);
