# Court Router

Court is a localhost dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It shows connected OAuth accounts, model availability, quota windows, reset times, and custom OpenAI-compatible endpoints. It can also restart the Codex desktop app against the local router or restore the normal ChatGPT connection.

Court is local administration software. It is not affiliated with OpenAI, Anthropic, Google, xAI, Moonshot AI, or the OpenCode project.

## Requirements

- macOS
- Node.js 20 or newer
- CLIProxyAPI installed and configured
- The Codex desktop app, only if you want the Codex routing toggle

## Install

```sh
git clone <your-repository-url> court
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

## Configuration

Court uses these defaults:

- dashboard: `http://127.0.0.1:8477`
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
npm run security
```

## License

Court is available under the MIT License. Provider logos remain subject to their owners' trademark rules. See `THIRD_PARTY_NOTICES.md` and `docs/logo-sources.md`.
