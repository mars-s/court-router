# Benchmark

```sh
npm run bench                                           # fast, two models (about 40 s)
npm run bench -- --models claude-sonnet-5,gpt-6-luna,gpt-6.1-sol
npm run bench -- --slow                                 # adds image generation and compaction
npm run bench -- --only search,subagent --jobs 4
npm run bench -- --list                                 # show the plan only
```

The benchmark starts the Codex engine bundled with the ChatGPT app
(`codex app-server`), the same engine the app's window drives. Every turn
goes engine, Court, ChatGPT or the Router, the model, then back to the
engine's real tools. Nothing is mocked.

## What it checks

First, before any model call:

- **Setup.** Court answers, `~/.codex/config.toml` points at Court, and each
  requested model is in the catalogue.
- **App contract.** It exports the engine's protocol schema and checks the
  short list of methods, events and item fields that Court and the checks
  use (`scripts/bench/drift.mjs`). New fields are fine. A missing one stops
  the run with its name, for example `app no longer has TurnStartParams.model`.
- **Versions.** App and engine versions are compared with the last fully
  green run. A change is printed first, since it is the usual cause.
- **Desktop.** Opens ChatGPT if it is closed and checks its engine is the
  same build the benchmark drives.

Then, for each model:

| Check | Proves |
| --- | --- |
| reply | a plain answer comes back |
| shell | a command runs and the model reads its output |
| patch | `apply_patch` writes the exact file |
| search | web search runs and returns results |
| search+tool | a search and a shell command in one step both work (Claude defers the search, see below) |
| search-history | a later turn can still read an earlier search's results |
| image-view | the model sees a picture's colour (file names are neutral) |
| computer-use | the Computer Use tool runs and lists apps |
| memory | a second turn remembers the first |
| edit | the app's edit message (`thread/revert`) drops the later turn |
| image-gen (slow) | an image is made, saved, and the model looks at it |

For every ordered pair of models, same and cross provider:

| Check | Proves |
| --- | --- |
| subagent | the parent spawns a helper on the requested model, the helper runs a shell command in its own thread, and the parent reports it back |
| switch | changing model mid-chat keeps the earlier answer and tool output |
| compact-switch (slow) | a compacted chat still remembers after a model switch |

Each check reads the engine's own items to confirm the tool really ran,
then checks the reply. A model saying it worked is not enough.

## Reading results

The terminal prints one line per check. The report goes to
`~/.local/state/court/bench/<time>.json` (private permissions). For failed
checks it keeps a short trail: item types, tool names, models, statuses and
errors per thread. Prompts, replies and tool output are left out.

For live detail during a run, use `node scripts/debug/watch.mjs` with Court's
trace on (see the README).

## Limits

- Browser counts are not asserted. The in-app and Chrome browsers register
  with the app's window, so an engine started outside the window sees none.
  Check browsers from a chat in the app.
- Results depend on live models and web search. A one-off failure is worth
  a rerun with `--only`. A repeated one is real.
- It cannot promise a future update will not break Court. It makes such a
  break show up quickly, with the missing piece named.

## Known behaviour it guards

- When Claude calls a hosted web search and one of the app's tools in the
  same step, Claude pauses before the search runs. The Router still reports
  that search as finished with no results, which made Claude think the web
  was empty. Court now drops those unrun searches from history, so Claude
  searches again (`lib/response-history.mjs`, `searchForClaude`).
- Claude parents report helpers as `collabAgentToolCall` items. GPT parents
  report them as `subAgentActivity`. The check accepts both and reads the
  helper's model from the engine.
