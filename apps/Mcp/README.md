# ADK command line (`devkit`)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **every ADK
capability** (Brain, Specs, Test Plans, Agents, Design, Workspaces, Integrations, Audit) to Claude
Code, Claude Desktop, Codex, Cursor, Gemini CLI, VS Code and any other MCP client.

**No LLM API key is needed.** In _host mode_ the assistant you already pay for (Claude Team, ChatGPT
or Codex, and so on) does the reasoning. ADK supplies the grounded instructions and context and then
stores the result. Tools marked _server model_ still use the LLM integration configured in the
workspace for teams that prefer it.

## Install

Requires [Node.js](https://nodejs.org) 20 or newer. On Windows, macOS or Linux:

```bash
npm install -g @agent-devkit/cli
devkit login --api-url https://<your-adk-api>
```

Update with the same `npm install -g @agent-devkit/cli`. On Windows PowerShell, if the command fails with
"running scripts is disabled on this system", run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (or call `devkit.cmd` instead).
The first local E2E run downloads Chromium automatically (or run `devkit e2e setup` ahead of time).

## Run E2E tests on your computer (local runner)

Set a run's **Where the tests run** to **My computer** (`executionTarget: "local"` in MCP, or
`e2e_set_execution`). ADK keeps planning, writing and healing the specs, analysing failures,
storing results and publishing them; only the browser runs on your computer, so `localhost`
apps work without a tunnel. The frontend, its backend APIs, other local APIs and a local SSO are
all reached the same way your own browser reaches them.

```bash
devkit login --api-url https://<your-adk-api>   # once
devkit runner                                   # keep open while tests run
```

The runner only opens outbound HTTPS connections to ADK: it long-polls for the browser work of
runs **you** start (a teammate's runner never picks up your tests), runs Playwright with the same
rules and limits as the ADK workers, and uploads the result, step screenshots and video. Cancelling
the run in ADK stops the local browser. A run waits five minutes for a runner before failing with a
message that says how to start one; `e2e_list_runners` and the web form show whether yours is online.

To start a run and see its results in the terminal instead:

```bash
devkit e2e run <run-id> [--test TC001] [--base-url http://localhost:8014] [--scripts ./e2e] [--set-local]
```

- `--base-url` tests another local address than the saved one (only the origin is replaced).
- `--scripts` commits the specs you edited locally (matched by file name) before running, so ADK
  keeps the exact scripts that ran.
- `--set-local` switches a run that executes on the ADK servers to your computer.
- `ADK_E2E_USERNAME` / `ADK_E2E_PASSWORD` replace the saved test account on this computer.
- An `adk-e2e.json` file (`{ "run": "<id>", "baseUrl": "...", "scripts": "./e2e" }`) in the
  current folder provides the defaults, so a team can share its local setup.

The exit code is `1` when a test fails, which suits pre-push hooks and local CI scripts.

## Test an application running on your computer through a tunnel

The E2E browser runs outside your computer. Its `localhost` is not your computer. For a fullstack
application, install [cloudflared](https://developers.cloudflare.com/tunnel/downloads/) and the
latest `devkit` CLI on the computer running the application. Start the application and its local
services, then run:

```bash
devkit bridge --origin https://<your-adk-frontend>
```

In the E2E form, enter the frontend's local address and click **Start tunnel on my computer**. The
helper opens one authenticated tunnel to a local gateway. The test browser keeps the frontend's
`localhost` origin while the gateway forwards requests for other local HTTP and HTTPS ports to
your computer. API calls made by those local services also remain on your computer. The helper
creates a session key; ADK stores it encrypted and sends it only to this tunnel. Keep the helper,
application, and tunnel running during the test. Open the application directly at `localhost` in
your own browser; the public tunnel URL requires the session key and the SSO may reject its origin.

If the browser cannot reach the helper (local network access blocked, helper started with another
`--origin`), open the same multi-service tunnel from a terminal:

```bash
devkit tunnel --url http://localhost:8014
```

It prints **Base URL**, **Original local address**, **Access Client ID** and **Access Client
Secret**; enter them in the E2E form (the last two under **Tunnel authentication**). The session
key tells the worker to route browser requests for any `localhost` port (for example a backend on
`localhost:55542` or a local SSO) through the same tunnel. Calls between your local services, such
as the backend calling `localhost:3000`, never leave your computer.

If the application uses only one local port, you can run a manual tunnel instead. Requests to
other `localhost` ports fail with this command:

```bash
cloudflared tunnel --url http://localhost:5173 --http-host-header localhost:5173
```

Install the CLI with `npm install -g @agent-devkit/cli` (see [Install](#install)).
Its control endpoint listens only on `127.0.0.1:8765` and accepts requests from the configured
frontend origin. Browser local-network permission may be requested.

For a manual tunnel, paste the printed `https://...trycloudflare.com` URL into **E2E Automation → Application → Base URL**.
The form can copy the command and check the public URL before you start the run. Keep the terminal
and application running until the run completes. Ctrl+C closes the tunnel. A manual Quick Tunnel
URL is temporary and anyone who knows it can reach the application; use test data.

The MCP server hosted on Railway can call `e2e_tunnel_setup { localUrl: "http://localhost:5173" }`
to give the user the `devkit tunnel` command (and a cloudflared-only `singlePortCommand`), check
the public URL and session key with `e2e_check_tunnel`, then use them in `e2e_create` or
`e2e_update`. It rejects `localhost` as a run target because that address would refer to Railway.
The command tells cloudflared to forward the local `Host` header. This prevents development
servers from displaying `Invalid Host header` when the public tunnel hostname reaches them.
If a development server still rejects the tunnel hostname, add that **exact hostname** to
[`server.allowedHosts`](https://vite.dev/config/server-options#server-allowedhosts) and restart
Vite. Avoid `allowedHosts: true` or a wildcard `trycloudflare.com` entry.

For a stable URL, provision a [Named Tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)
for each local machine and enter its public hostname in ADK. For a hostname protected by
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
create a Service Token, authorize it in a **Service Auth** policy, and enter its Client ID and
Client Secret in the E2E form or `e2e_create`/`e2e_update`. The API encrypts the token at rest.
The probe and worker send its headers only to the target origin. Keep the token out of chat when
possible; use the web form to enter it. Interactive email/PIN access cannot be used by the worker.
Railway must have the same `INTEGRATION_ENCRYPTION_KEY` on the API and E2E worker services to
decrypt saved service tokens.
Each user's computer runs its own connector. Playwright still runs in the Railway E2E worker;
worker capacity and the local application's capacity determine how many tests can run at once.

## Quick start

Install the released package from npm or build it from this repository:

```bash
npm install -g @agent-devkit/cli                 # released package, provides the devkit command
# or, from a checkout:
cd apps/Mcp && npm ci && npm run build
node dist/src/bin/devkit.js login --api-url https://<your-adk-api>
node dist/src/bin/devkit.js install-skills --client claude   # or --client codex
```

- `login` asks for your e-mail and password, creates a **90-day personal access token** named
  `devkit (<computer>)`, and stores it in `~/.adk/mcp-session.json` (mode 0600). The password is
  used once and never passes through the chat.
- Google or GitHub accounts: create a token in the web app (**Settings → Access tokens**) and run
  `devkit login --token <token>`.
- Tokens are listed and revoked in the web app or with the `auth_list_tokens` /
  `auth_revoke_token` tools. Run `login` again when a tool reports `401`.

Then register the server in your client. In the examples below, `ADK_MCP` is the absolute path to
`apps/Mcp/dist/src/bin/devkit.js`.

## Client configuration

### Claude Code

```bash
claude mcp add adk --scope user -e ADK_API_URL=https://<your-adk-api> -- node ADK_MCP
```

Alternatively, commit a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "adk": {
      "command": "node",
      "args": ["ADK_MCP"],
      "env": { "ADK_API_URL": "https://<your-adk-api>" }
    }
  }
}
```

Install the skills with `devkit install-skills --client claude` (use `--scope project` to write
them into `.claude/skills` of the current repository). The workflow prompts appear as slash commands
(`/mcp__adk__generate_test_plan`, `/mcp__adk__draft_spec`, and so on).

### Claude Desktop

Add the same `mcpServers` entry to `claude_desktop_config.json` (Settings → Developer → Edit Config).

### Codex (CLI and IDE extension)

```bash
codex mcp add adk --env ADK_API_URL=https://<your-adk-api> -- node ADK_MCP
```

The equivalent entry in `~/.codex/config.toml`:

```toml
[mcp_servers.adk]
command = "node"
args = ["ADK_MCP"]
env = { ADK_API_URL = "https://<your-adk-api>" }
tool_timeout_sec = 180
```

Install the skills with `devkit install-skills --client codex` (or `--client agents` to write
`.agents/skills`). Check your Codex version's documentation for the skills folder it reads.

### Cursor, Gemini CLI, VS Code and others

| Client            | File                        | Entry                                                                                 |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| Cursor            | `.cursor/mcp.json`        | `"mcpServers": { "adk": { "command": "node", "args": ["ADK_MCP"], "env": {…} } }`  |
| Gemini CLI        | `~/.gemini/settings.json` | same`mcpServers` shape                                                              |
| VS Code (Copilot) | `.vscode/mcp.json`        | `"servers": { "adk": { "type": "stdio", "command": "node", "args": ["ADK_MCP"] } }` |

If a client that does not load skills also supports MCP _resources_, it can read the same guides at
`adk://skills/<name>`. The full tool catalog is at `adk://guide`.

## Team / remote mode (Streamable HTTP + OAuth)

Run one server for the whole team (runbook: `docs/operations/mcp-server.md`). Every request
carries the user's **own** ADK token, so permissions and audit stay per person.

```bash
ADK_API_URL=https://<your-adk-api> ADK_MCP_HTTP_HOST=0.0.0.0 ADK_MCP_PUBLIC_URL=https://mcp.example.com ADK_MCP_OAUTH_SECRET=$(openssl rand -hex 32) node ADK_MCP http            # or deploy apps/Mcp (Dockerfile + railway.json)
```

- **claude.ai (Team plan, web and desktop):** an owner adds a custom connector pointing to
  `https://mcp.example.com/mcp`. Members click _Connect_ and sign in on the ADK authorization page
  (e-mail and password, or a pasted access token for Google/GitHub accounts). The connector receives
  a revocable 90-day ADK access token.
- **Claude Code:** `claude mcp add --transport http adk https://mcp.example.com/mcp`, then `/mcp`
  to authenticate through OAuth, or add `--header "Authorization: Bearer <access token>"`.
- **Codex:** `url = "https://mcp.example.com/mcp"` and `bearer_token_env_var = "ADK_TOKEN"` under
  `[mcp_servers.adk]`, with an access token in `ADK_TOKEN`.

Protections: allowed Host/Origin (DNS rebinding), per-IP rate limit, token verification with a
`401` that points clients to the OAuth metadata, MCP sessions bound to the credential that created
them, body and session limits. A shared server never lends `ADK_TOKEN` to anonymous callers.

## Configuration

See [.env.example](.env.example). The most useful settings:

| Variable                                         | Purpose                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ADK_API_URL`                                  | ADK API base URL                                                                                     |
| `ADK_MCP_TOOLSETS`                             | Enable only some toolsets, for example`brain,spec,testplans` (useful for clients with tool limits) |
| `ADK_MCP_READ_ONLY`                            | Expose read tools only                                                                               |
| `ADK_WORKSPACE_ID`                             | Default workspace (otherwise use`workspaces_select`)                                               |
| `ADK_MCP_TIMEOUT_MS`                           | API timeout; server-model generations can be slow                                                    |
| `ADK_CLOUDFLARED_PATH`                         | Optional path to the local`cloudflared` binary for `devkit tunnel`                              |
| `ADK_MCP_PUBLIC_URL`, `ADK_MCP_OAUTH_SECRET` | Enable the OAuth authorization server (remote mode)                                                  |
| `ADK_MCP_TRUST_PROXY`, `ADK_MCP_RATE_LIMIT`  | Proxy headers and per-IP limit (remote mode)                                                         |

## Tools

Run `devkit tools` for the live list. Every backend route is covered: the parity test
fails when a route has no tool.

| Toolset          | Highlights                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account`      | `auth_whoami`, `auth_login`, `auth_register`, password reset, access tokens (list, revoke), `system_health`                                                                                    |
| `workspaces`   | list, select, create, delete, members and permissions                                                                                                                                                  |
| `integrations` | list, save, test, delete, Azure DevOps members                                                                                                                                                         |
| `brain`        | documents CRUD, search, relations, sync, publish to Azure Wiki,`brain_prepare_answer` (host) / `brain_ask` (server)                                                                                |
| `agents`       | CRUD,`agents_prepare_run` (host) / `agents_execute` (server)                                                                                                                                       |
| `issues`       | issue CRUD, inbox, dashboard, agent run lifecycle (server or host), token usage, monthly spend, budget and model rates                                                                                 |
| `pbi`          | workspace backlog and card CRUD, provider list, pull, push, context and issue creation                                                                                                                 |
| `spec`         | templates, specs CRUD,`spec_update_sections`, export, publish, `spec_prepare_draft` (host) / `spec_chat` and `spec_generate_from_brain` (server)                                               |
| `testplans`    | `testplans_prepare` + `testplans_save` (host), `testplans_generate` (server), plans and suites CRUD                                                                                              |
| `design`       | prototypes and Design Systems,`design_prepare` + `design_save_new_project` (host), `design_create_project` and `design_chat` (server)                                                          |
| `e2e`          | E2E runs:`e2e_tunnel_setup` and `e2e_check_tunnel` for applications on a user's computer, create, run, rerun one test, read and commit Playwright scripts, failure analysis and signed video links |
| `releasenotes` | release notes CRUD and Markdown export,`release_notes_prepare` + `release_notes_create` (host), `release_notes_generate` (server)                                                                |
| `audit`        | `audit_history` (documents, specs, templates, test plans, PBIs, issues, release notes)                                                                                                               |

Assigned issues created or updated through MCP run with the MCP client's model. The tool returns
the task and agent instructions; complete the work and call `issues_complete_run` to save the
result. `issues_run_server` is available when a workspace LLM integration is configured.

### Token usage accounting

After every tool call the server reports, in the background, the tokens the client's model spent
on it to `POST /costs/usage`: the tool result it reads counts as input and the arguments it wrote
count as output, estimated at about 4 characters per token. The client name sent at initialization
(for example `claude-code`) is recorded as the model under provider `mcp`, so a workspace admin can
price MCP usage with `issues_set_rate { provider: "mcp", model: "<client name>" }`. The dashboard
and `issues_costs` include these tokens in the totals and the monthly spend (`mcpUsage` holds the
monthly breakdown by tool and client). Calls without an active workspace, `account` and
`workspaces` tools, and `issues_complete_run` (which reports exact run tokens) are not metered.
Reporting failures are ignored and never affect the tool result.

Spec discovery chat also works with the client's model through `spec_prepare_chat` and
`spec_save_chat_reply`. To export authored test cases without saving a plan, use
`testplans_prepare` followed by `testplans_render_csv`.

Prompts: `generate_test_plan`, `draft_spec`, `ask_brain`, `create_prototype`.
Skills: `adk-getting-started`, `adk-test-plans`, `adk-specs`, `adk-brain`, `adk-design`, `adk-e2e`,
`adk-release-notes`, `adk-agents`, `adk-workspace-admin`.

## Architecture

```text
src/
  api/http-client.ts        AdkApi port + fetch adapter (timeouts, error mapping, no redirects)
  core/                     framework-agnostic contracts
    tool.ts                 defineTool(): name, toolset, access, execution mode, routes, zod input
    registry.ts             collects modules, filters toolsets/read-only, rejects duplicates
    session.ts              token/workspace resolution (file store for stdio, memory for HTTP)
    result.ts               tool results and actionable error messages
  modules/<feature>/tools.ts  one module per ADK feature; modules/index.ts lists them
  bootstrap/                composition root: config, MCP server, stdio/HTTP transports, CLI helpers
  bin/devkit.ts            CLI entry point
skills/<name>/SKILL.md      portable skills (Claude Code, Codex and other Agent Skills clients)
```

- The package depends on the ADK **HTTP contract only**; it never imports backend code.
- Tools are declarative. Adding a feature means adding a `defineTool` entry to its module and a case
  to `tests/tools.test.ts`. The catalog test fails when a tool has no case.
- Host-mode briefs mark workspace content as `<untrusted-content>` so documents cannot steer the
  assistant into calling tools.
- The session token is never returned to the model.

## Development

```bash
npm run verify   # format, lint, typecheck, tests with coverage (includes the parity guard)
npm run smoke    # builds and drives the stdio server end to end against ADK_API_URL
```

See `.agent/skills/mcp-tool/SKILL.md` for the maintenance workflow.

## Releasing the CLI

Push a tag such as `cli-v0.4.0`. The **CLI release** workflow (`.github/workflows/cli-release.yml`) verifies, builds and publishes
`@agent-devkit/cli` to the public npm registry (repository secret `NPM_AGENT_DEVKIT`, an npm automation or granular
publish token for the `@agent-devkit/cli` package) and attaches the tarball to a GitHub release.
