# Gemini CLI integration notes

Checked against CLIProxyAPI 7.3.0 and the upstream `main` branch on 18 September 2026.

## Short answer

CLIProxyAPI 7.3.x does not expose a Gemini CLI OAuth login flow. There is no `-gemini-login` flag in the current binary or source. The current login flags cover Codex, Claude, Antigravity, Kimi, xAI, Devin, and Meta. Adding a Gemini card that runs a guessed `-gemini-login` command would fail.

The practical choices are:

1. Launch the official Gemini CLI and let it own the Google sign-in. Run `gemini`, then choose **Sign in with Google**.
2. Connect Google models to CLIProxyAPI through Vertex AI by importing a service-account JSON file with `-vertex-import`.
3. Add a Google AI Studio key as a configured API-key provider. This is not the user's Gemini subscription and has separate API quotas and billing.

Sources: [CLIProxyAPI command-line source](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/cmd/server/main.go), [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/).

## CLIProxyAPI details

### OAuth login flag

There is no Gemini OAuth login flag in CLIProxyAPI 7.3.x. The installed 7.3.0 binary and upstream source both omit it. `-antigravity-login` is a different Google product and credential type. It should not be presented as Gemini CLI login.

CLIProxyAPI's README still says it supports Google Gemini models and multi-account routing, but in v7 the first-party Google credential path visible in the command-line source is Vertex import rather than Gemini CLI OAuth. Treat the broad README statement as provider capability, not proof of a Gemini subscription-login command.

Sources: [CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI), [CLIProxyAPI server entry point](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/cmd/server/main.go).

### Vertex import

The supported import command is:

```sh
cliproxyapi -vertex-import /absolute/path/to/service-account.json
```

An optional model namespace can be added with:

```sh
cliproxyapi -vertex-import /absolute/path/to/service-account.json \
  -vertex-import-prefix my-project
```

The imported auth record uses:

- Provider: `vertex`
- Metadata `type`: `vertex`
- File name: `vertex-<sanitized-project-id>.json`
- With a prefix: `vertex-<sanitized-prefix>-<sanitized-project-id>.json`
- Other metadata: `service_account`, `project_id`, `email`, `location`, `prefix`, and `label`
- Default location: `us-central1`

The auth file embeds the service-account object, including the private key. The dashboard must never read or return this file's contents. It may list only safe metadata such as provider, label, project ID, and masked email.

Source: [CLIProxyAPI Vertex import implementation](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/cmd/vertex_import.go).

### Multiple accounts

CLIProxyAPI states that it supports multiple accounts with round-robin load balancing for Gemini. The current Vertex importer also creates separate credential files when project IDs or prefixes differ. That supports a Vertex credential pool, but it does not turn personal Gemini CLI logins into a CLIProxyAPI pool.

Source: [CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI), [Vertex importer](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/cmd/vertex_import.go).

## Official Gemini CLI login

The documented Google sign-in flow has no standalone `gemini login` command:

1. Run `gemini`.
2. Choose **Sign in with Google**.
3. Complete the browser flow. Gemini CLI caches the credential locally.

For a school or Google Workspace account, Google requires a Cloud project with the Gemini for Cloud API enabled and the necessary IAM access. Personal accounts usually do not need a project.

Source: [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/).

## Models

The official Gemini CLI model selector currently documents these concrete IDs:

- `gemini-3-pro-preview`
- `gemini-3-flash-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`

`/model` opens the selector. `--model <id>` selects a model at startup. Available models can differ by account and auth method, so Court should discover models from the connected runtime instead of hard-coding this list as guaranteed availability.

Source: [Gemini CLI model selection](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model.md).

## Education plans and quota reporting

A school-issued Google account is an organization account. That does not mean a general Gemini Education or Workspace entitlement increases Gemini CLI quota.

The CLI quota page lists the supported fixed tiers:

| Account or auth method | Documented daily maximum |
| --- | ---: |
| Gemini Code Assist Individual | 1,000 requests |
| Google AI Pro | 1,500 requests |
| Google AI Ultra | 2,000 requests |
| Unpaid Gemini API key | 250 requests, Flash only |
| Code Assist Standard | 1,500 requests |
| Code Assist Enterprise | 2,000 requests |
| Workspace AI Ultra | 2,000 requests |

Google explicitly says unlisted Workspace tiers do not receive these supported CLI subscription quotas. Court should therefore show the detected account and live quota when an upstream API exposes it. It should not label an education account as Pro or invent a larger allowance from the email domain or Gemini web-app entitlement.

Source: [Gemini CLI quotas and pricing](https://geminicli.com/docs/resources/quota-and-pricing/).

## Recommended Court behavior

- Add a **Gemini CLI** card that launches `gemini` and explains that sign-in happens inside the official CLI.
- Do not place Gemini CLI accounts in the CLIProxyAPI account pool until the router gains a real Gemini OAuth/import flow.
- Offer **Vertex AI** as the router-backed Google provider. Import service-account JSON through a local-only file picker and never echo the secret JSON back to the browser.
- Keep **Google AI Studio API key** separate from Gemini CLI subscription login.
- Show quota as **not reported** unless live provider data supplies a remaining value and reset time.
- Do not infer education-plan benefits. Show the upstream-reported tier verbatim.
