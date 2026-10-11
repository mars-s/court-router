# Claude feature parity in the ChatGPT app

Goal: a Claude (or other Router) model picked in the ChatGPT desktop app gets the
same tools and switching as native GPT.

Evidence levels: **source** (read the code), **tests** (`npm test`), **live**
(ran through the real Codex engine with `codex exec` and a real Claude model).

## The rule

Router models are guests in a ChatGPT chat. Everything Codex saves in a chat
must stay valid for native ChatGPT, so the chat keeps working with Court
switched off or not running. Court translates for Router models on the way in
and never leaves Router-only data behind.

## How it works

- Court mode keeps every chat on ChatGPT's own `openai` provider and sets
  `openai_base_url = "http://127.0.0.1:8477/chatgpt"`.
- Court reads the model on each turn. GPT turns go to
  `https://chatgpt.com/backend-api/codex` with the request bytes and headers
  unchanged. Router turns go to CLIProxyAPI with the router key, but only when
  the caller's bearer token matches `~/.codex/auth.json`.
- Codex tries a WebSocket first. Court answers 426, and Codex falls back to
  HTTP in about 60 ms.
- Court decompresses zstd, gzip, deflate and brotli request bodies.
- The tool bridge (`lib/tool-bridge.mjs`) rewrites GPT-only tool shapes for
  Router models and rewrites the replies back:
  - `tool_search` becomes a plain `tool_search` function. Its results come back
    as text, and the found tools are added to the tool list so they can be called.
  - `custom` tools such as `apply_patch` become functions with one `input` string.
- Router output is saved in a ChatGPT-valid shape. Claude's reasoning is never
  saved in the chat: its sealed form is rejected by ChatGPT, and an unsealed
  copy fails too, because Codex gives it an ID and ChatGPT then looks for
  stored data that is not there. Claude does not need it back to continue
  (tested). The cost is that the app shows no "Thinking" section for Claude
  replies. Patch and search calls get ChatGPT ID prefixes (`ctc_`, `tsc_`).
- Before a GPT turn, Court also removes any Router IDs and sealed reasoning it
  still finds, as a second line of defence.
- Switching follows T3 Code's context handoff: one model's hidden context is
  never replayed to another. When Claude meets GPT's sealed compacted context,
  Court asks GPT, with your ChatGPT sign-in, to write a plain handoff summary of
  it, and Claude gets that summary. The first switch in a long chat can take
  about a minute. Summaries are saved in `response-history/handoffs`, so later
  turns take about 2 seconds, even after a restart. If GPT cannot be reached,
  Court falls back to its readable copy of GPT turns, which it keeps as they
  stream past.
- The model list is ChatGPT's own list (`~/.codex/models_cache.json`) plus the
  Router models ChatGPT does not have. GPT entries are kept exactly as ChatGPT
  ships them. Claude entries get a 200k context window.
- With ChatGPT's own provider, Codex compacts by sending a turn ending in
  `{ "type": "compaction_trigger" }`. GPT always does this, even in a Claude
  stretch, so a chat only ever holds ChatGPT's own compacted context. Claude
  reads it through the handoff summary above.
- Court off moves old `cliproxyapi` chats, and `openai` chats left on a Router
  model, back to a GPT model. It also runs a one-time cleanup
  (`lib/chat-cleanup.mjs`) over every chat file, for chats saved by older Court
  versions. Changed files keep a `.court-backup` copy.
- `court down` warns if Court mode is still on, because then every chat,
  GPT included, needs Court running.

## Results

| Feature | Status | Evidence |
| --- | --- | --- |
| No "model is not supported" error when picking Claude in a GPT chat | Fixed | live |
| `apply_patch` | Works | live: Claude created a file |
| `tool_search` (deferred tools) | Works | live: loaded the GitHub app tools |
| Apps and connectors (GitHub) | Works | live: Claude called `get_repo` |
| Subagents | Works | live: spawned, waited, got the reply. The child used the same Claude model. |
| Shell (`exec_command`) | Works | live |
| GPT turns through Court | Works | live, plus test that bytes and headers are unchanged |
| zstd request bodies | Works | live and tests |
| GPT then Claude then GPT in one chat | Works | live: shell and `apply_patch` on each side, each model read the other's file |
| GPT compacts, then Claude continues | Works | live, plus tests. Replayed a real long chat: Claude Opus 5.5 described the earlier work correctly. |
| Long Claude-only chat compacts | Works | live: compacted several times, Claude kept a fact from the start. Court asks Claude for a handoff summary and stores it in the compaction item Codex expects. |
| Goals (`create_goal`, `update_goal`, `get_goal`) | Works | live |
| Sites | Loads through `tool_search` like other apps | not run live |
| Image generation (`image_gen` namespace) | Tool is sent to Claude | source, not run live |
| Web search | Claude uses Anthropic's own live search | source |

## Open items

- Web search: Codex asks for cached-only search (`external_web_access: false`).
  Claude's search ignores that and searches live.
- Court off and on again in the real app has not been run live. The restore
  logic is covered by tests.
- If Court is not running while Court mode is on, GPT chats fail too, because
  every turn goes through Court.
