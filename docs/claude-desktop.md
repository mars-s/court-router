# Claude workflow: the Claude desktop app on the Router

Court has two workflows on the same CLIProxyAPI Router:

- **Codex workflow.** The ChatGPT/Codex app, switching between GPT and Claude in one chat. See the README.
- **Claude workflow.** A second copy of the Claude desktop app, *Claude (Gateway)*, in third-party
  (gateway) mode. Its model menu holds your Claude, Codex and OpenCode Go models, and it can run
  Claude Code sessions on another machine over SSH. Your normal Claude app stays signed in to Claude
  as before.

## What runs where

```
Claude (Gateway) app ─┐
Claude Code over SSH ─┼─> tailnet address ─> web search relay (127.0.0.1:8318) ─> CLIProxyAPI (127.0.0.1:8317)
                      ┘                                                            ├─ Claude login
Court, Codex app ──────────────────────────────────────────────────────────────────┤  Codex login
                                                                                   └─ OpenCode Go key
```

- **CLIProxyAPI** serves every model in Anthropic's format.
- **The web search relay** (`claude/websearch-relay.mjs`) passes everything through unchanged, except
  web searches from OpenCode models. OpenCode Go drops Anthropic's server-side `web_search` tool, and
  Claude Code's WebSearch asks the chat's own model to run the search. So those requests go to
  `searchModel` (a Codex model by default) instead.
- **`claude/config.mjs`** builds the app's config from what the Router serves now, with real names
  and context sizes from models.dev.

## Rules the desktop app imposes

- **Model names.** It accepts only `claude-*` names and rejects any that mention another vendor
  (`qwen`, `gpt`, `minimax`...). So CLIProxyAPI serves the others under neutral codes:
  `claude-oc-<6 hex>` for OpenCode Go and `claude-cx-<6 hex>` for Codex. The hex is the first six
  characters of the SHA-1 of the real id. The menu still shows the real name.
- **Where it reads its config.** With `--user-data-dir=X`, the app keeps third-party state in a
  sibling folder `X-3p`. `deploymentMode` in `X-3p/claude_desktop_config.json` picks `3p` (gateway) or
  `1p` (Claude sign-in). The saved config is in `X-3p/configLibrary`. Seeding `X` instead just shows
  the Claude sign-in screen.
- **Sandbox.** With no `coworkEgressAllowedHosts`, the app treats the network as locked: it starts
  every session with the sandbox on, in strict mode, with no hosts allowed, and shows that as
  "Your organization turns on strict sandbox mode". The config sets it to `["*"]`.
- **Remote Control and cloud sessions** are off in gateway mode.

## Set up

1. Connect Claude and Codex (`court connect claude`, `court connect codex`).
2. In the CLIProxyAPI config:
   - Add a key for the app to `api-keys:`, below the Router key Court uses (Court reads the first
     one). Save the same key to `~/.cli-proxy-api/desktop-gateway.key`, mode 600.
   - For OpenCode Go, add a `claude-api-key` entry with base URL
     `https://opencode.ai/inference/go/anthropic` and the header
     `X-Claude-Code-Session-Id: "$X-Claude-Code-Session-Id"` (OpenCode rejects requests with no
     session header). Give each model a `claude-oc-` alias.
   - For Codex, add a top-level `oauth-model-alias: codex:` entry per model with a `claude-cx-` alias
     and `fork: true`, so the plain GPT names keep working for Court.
3. To reach the gateway from other machines, serve the relay on your tailnet only:
   `tailscale serve --bg --https=8317 http://127.0.0.1:8318`.
4. Write your settings to `~/.local/state/court/claude.json`:

   ```json
   {
     "gatewayUrl": "https://your-mac.your-tailnet.ts.net:8317",
     "sshHosts": ["100.x.y.z"],
     "searchModel": "gpt-6.1-sol"
   }
   ```

   `gatewayUrl` defaults to the local Router. `sshHosts` are the machines the app may open Claude Code
   sessions on. `searchModel` is the real model id that runs searches for OpenCode models.
5. Run:

   ```sh
   court claude relay install   # web search relay, starts at login
   court claude app             # creates /Applications/Claude (Gateway).app
   court claude config          # builds the config and seeds the app
   ```

6. Open Claude (Gateway). It skips the sign-in and opens on the gateway. Add your SSH machine under
   New environment.

On another machine running Claude Code, point it at `gatewayUrl` with the same key
(`ANTHROPIC_BASE_URL` and an `apiKeyHelper` that prints the key). A machine on a userspace tailnet
has no MagicDNS, so map the Mac's tailnet name in `/etc/hosts`.

## Keep it current

Run `court claude config` after the Router's model list changes, then quit and reopen
Claude (Gateway). `court claude status` shows what is installed.

`beam-free` is left out of the menu: it answers a bare message but rejects Claude Code's real
requests with `400 invalid messages[0].content`.

## Not covered

- Adding the `claude-oc-` and `claude-cx-` aliases to the CLIProxyAPI config is still by hand.
- When the Mac sleeps, remote sessions lose the gateway.
- Routing your Claude and Codex subscriptions through CLIProxyAPI may break those providers' terms.
