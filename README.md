# Court Router

Court is a localhost dashboard and verified-model gateway for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It shows connected OAuth accounts, model availability, quota windows, reset times, and custom OpenAI-compatible endpoints. It can also restart the Codex desktop app against the local router, launch it directly with Gemini 3.7 Flash from a connected Antigravity pool, or restore the normal ChatGPT connection.

Court is local administration software. It is not affiliated with OpenAI, Anthropic, Google, xAI, Moonshot AI, or the OpenCode project.

## Requirements

- macOS
- Node.js 20 or newer
- CLIProxyAPI installed and configured
- The Codex desktop app, only if you want the Codex routing toggle
- Gemini CLI, only if you want Google sign-in and Gemini CLI status in Court

## Install

```sh
git clone https://github.com/mars-s/court-router.git court
cd court
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/court" "$HOME/.local/bin/court"
```

Make sure `$HOME/.local/bin` is on `PATH`, then run:

```sh
court up
court open
```

Stop it with `court down`. Use `court status` to check it.

Court uses Node's built-in modules, so there are no npm dependencies to install.
Each person needs their own configured CLIProxyAPI installation and connected
provider accounts. Account credentials, API keys and saved chats stay in local
state directories and are not included in this repository.

With CLIProxyAPI running, connect the providers you want:

```sh
court connect codex
court connect claude
court connect antigravity
```

These commands open the provider's sign-in flow. Connect only the accounts you
want to use, then open Court to check which models are available. A connected
account does not guarantee access to every model.

If your CLIProxyAPI configuration is outside the default Homebrew path, set
`COURT_ROUTER_CONFIG` before starting Court:

```sh
export COURT_ROUTER_CONFIG=/path/to/cliproxyapi.conf
court up
```

To update an existing installation, stop Court, pull the latest changes inside
the cloned folder, then start it again:

```sh
court down
git pull --ff-only
court up
```

## Switch between ChatGPT and Claude in one Codex chat

Connect your ChatGPT and Claude accounts, then choose **Enable ChatGPT + Claude**
in Court. This one-time setup restarts Codex and selects an available GPT model
as the default. In Codex, start a chat with GPT. Once its reply finishes, choose
**Claude Sonnet 4.6** in that chat's model picker and send your next message.
Choose GPT again to continue with ChatGPT. Switching models between turns does
not require another restart or a new chat.

Court keeps your existing ChatGPT sign-in active with `requires_openai_auth = true`.
Your dot and other account features retain that identity. Model requests use the
separate local router key through `env_key`; Court does not receive your desktop
ChatGPT login token. Your dot continues to run in ChatGPT's cloud and does not
switch to Claude when you select Claude for a local chat.

Current GPT chat models and Claude 3 or later accept image attachments through
Court. The native model catalogue advertises both text and image inputs for
these models, while preserving explicit provider capability metadata. Unknown
models and text-only models are not automatically marked as image-capable.

Codex owns the chat and tool execution. Court forwards the selected model on
each request and preserves session headers, messages, instructions, tool calls,
and tool results. When a client sends only new input and a `previous_response_id`,
Court rebuilds the transcript from saved responses. Full-history requests remain
authoritative, so an edited or rolled-back chat does not regain discarded turns.
Provider-specific reasoning stays with its originating provider. Saved compacted
context is expanded to readable history when another provider needs it.

Court stores response history in a private `response-history` directory under
its state directory, with directory mode `700` and file mode `600`. It retains
at most 128 snapshots and 128 MiB for seven days. This includes conversation text
and tool output. Missing delta history or opaque compacted context without a
saved transcript returns an explicit error rather than starting an empty chat.
These limits do not guarantee that a transcript fits the selected model's
context window. Existing chats that contain only opaque provider context may
need a readable transcript before their first switch.

The design follows T3 Code's [provider switching and context transfer](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/provider-switching-and-context.md):
one visible conversation and portable history when providers change. Court uses
Codex's existing conversation and CLIProxyAPI's Responses translation rather
than launching a separate Claude Code session. It does not move hidden reasoning,
provider-native approval state, or a native Claude Code session into Codex.

Connect Gemini CLI with `court connect gemini`, then choose **Sign in with
Google**. Gemini CLI OAuth is separate from CLIProxyAPI in current 7.3.x
releases, so Court reports the account but does not claim its models are routed
into Codex. Google AI Studio keys and Vertex service accounts use separate API
quotas.

If `gemini-3.7-flash-high` is available through a connected Antigravity account,
the Overview page offers a dedicated **Use Gemini 3.7 Flash** button. This is an
Antigravity-backed router mode; it does not reuse Gemini CLI credentials.

After connecting any OpenRouter endpoint, Manage can reuse that stored key to add
`openrouter/free` and `openrouter/auto`. The free router selects a compatible free
model for each request. The Auto router is task-aware and charges the rate of the
model it selects.

## Configuration

Court uses these defaults:

- dashboard: `http://127.0.0.1:8477`
- verified model API: `http://127.0.0.1:8477/v1`
- router: `http://127.0.0.1:8317`
- CLIProxyAPI config: `/opt/homebrew/etc/cliproxyapi.conf`
- private state: `$HOME/.local/state/court`
- OAuth accounts: `$HOME/.cli-proxy-api`
- Codex config: `$HOME/.codex/config.toml`

Override paths with the environment variables in `.env.example`. The launcher does not parse `.env` files automatically.

## Security model

Court binds only to `127.0.0.1`. It validates the Host and Origin headers, applies a restrictive Content Security Policy, caps request bodies, and redacts common tokens from the log viewer. API keys are written outside the repository with mode `600`; the browser receives only the last four characters. The dashboard has no remote fonts, scripts, analytics, or CDN requests.

The Codex toggle edits your Codex config and creates a timestamped backup beside it before restarting the app. OAuth login and custom-provider changes alter local CLIProxyAPI state. Review `server.mjs` before using Court on a shared machine.

Run the included checks before publishing changes:

```sh
npm run check
npm test
npm run security
```

The automated tests cover catalogue generation, macOS launch commands and
conversation forwarding through a simulated upstream service. They do not
verify a live provider sign-in or a complete desktop app conversation on your
machine.

## License

Court is available under the MIT License. Provider logos remain subject to their owners' trademark rules. See `THIRD_PARTY_NOTICES.md` and `docs/logo-sources.md`.
