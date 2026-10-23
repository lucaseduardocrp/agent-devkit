# ADK command line (`devkit`)

`@agent-devkit/cli` is the terminal side of ADK. It signs you in, runs the browser of E2E tests on
your computer, opens tunnels to local applications, installs the ADK skills into your assistant and
starts the [ADK MCP server](../Mcp) for assistants on this computer. The server is built from
`apps/Mcp` and embedded in this package, so `npm install -g @agent-devkit/cli` is the only install.

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

## Sign in

```bash
devkit login --api-url https://<your-adk-api>
devkit whoami
```

- `login` asks for your e-mail and password, creates a **90-day personal access token** named
  `devkit (<computer>)`, and stores it in `~/.adk/mcp-session.json` (mode 0600). The password is
  used once and never passes through the chat.
- Google or GitHub accounts: create a token in the web app (**Settings → Access tokens**) and run
  `devkit login --token <token>`.
- Tokens are listed and revoked in the web app or with the `auth_list_tokens` /
  `auth_revoke_token` tools. Run `login` again when a tool reports `401`.

Later commands, including the MCP server, reuse the API address of the last login.

## Connect your assistant (MCP)

`devkit` with no command, or `devkit mcp`, starts the MCP server over stdio with the stored
session:

```bash
claude mcp add adk --scope user -- devkit
codex mcp add adk -- devkit
devkit install-skills --client claude   # or --client codex / agents, --scope project
devkit tools                            # list the enabled tools
```

`devkit mcp http` starts the Streamable HTTP server. The configuration for each client, the remote
team mode and the tool catalog are documented in [apps/Mcp](../Mcp/README.md).

## Skills and plugins from the ADK Hub

The [ADK Hub](https://github.com/lucaseduardocrp/agent-devkit-hub) lists community and official
skills, and plugins that bundle skills, subagents and MCP servers. `devkit` installs them into the
same folders as `install-skills` (`--client claude|codex|agents`, `--scope user|project`,
`--dir PATH`):

```bash
devkit skills                                   # browse (✓ marks what is installed)
devkit skills search flaky --category e2e-automation
devkit skills info playwright-flaky-test-triage
devkit skills install playwright-flaky-test-triage api-contract-checks
devkit plugins install <name>                   # needs git
devkit skills installed                         # also: devkit plugins installed
devkit skills update                            # reinstall what changed in the hub
devkit skills remove api-contract-checks
```

- Skill files are downloaded from the commit the hub index pins them to and must match the
  sha256 listed for them; on any mismatch nothing is installed.
- Plugins are fetched with git at the exact commit listed in the hub. Only the skills and
  subagents they declare are copied (subagents go to `.claude/agents` for Claude Code). Their MCP
  servers are not registered for you: `devkit` prints the `claude mcp add-json` or
  `codex mcp add` commands and the environment variables to set.
- `~/.adk/hub-lock.json` records what was installed and where, so `update` and `remove` only touch
  those folders. An existing folder that `devkit` did not install is never replaced without
  `--force`. Items removed from the hub for security reasons cannot be installed.
- `--json` prints search, info and installed results as JSON. `--hub-url` (or `ADK_HUB_URL`)
  reads another index, from a URL or a local file.

### Agents for your ADK workspace

Hub agents are installed in the active ADK workspace, not on this computer: they appear on the
Agents page and run on Issues, in the Test Playground and in workflows. `devkit agents` calls the
ADK API with the session of `devkit login`, the same way as the Hub tab of the Agents page and the
`agents_hub_*` MCP tools; the server downloads each file and checks it before creating the agent.

```bash
devkit agents                                   # hub agents and plugin subagents (✓ installed, ↑ update)
devkit agents search qa
devkit agents install qa-test-designer
devkit agents install --plugin jira-qa          # every subagent of a plugin; add names for some
devkit agents update                            # everything with a new version; or pass names
```

Updating replaces an agent's name, description and instructions with the hub version and keeps
the model, temperature and role set in the workspace. Remove an agent on the Agents page.

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

The [MCP server](../Mcp) hosted on Railway can call `e2e_tunnel_setup { localUrl: "http://localhost:5173" }`
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

## Configuration

| Variable               | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `ADK_API_URL`          | ADK API base URL (default: the API of the last `devkit login`)      |
| `ADK_CLOUDFLARED_PATH` | Optional path to the local `cloudflared` binary for `devkit tunnel` |
| `ADK_E2E_USERNAME`     | Replaces the saved test account user name on this computer          |
| `ADK_E2E_PASSWORD`     | Replaces the saved test account password on this computer           |
| `ADK_HUB_URL`          | Another ADK Hub index (URL or local file) for `devkit skills/plugins` |

The MCP settings (`ADK_MCP_*`) are listed in [apps/Mcp](../Mcp/README.md#configuration).

## Architecture

```text
src/
  bin/devkit.ts             CLI entry point; the MCP commands come from the embedded server (#mcp)
  commands.ts               login, logout, whoami, install-skills, signed-in API client
  e2e/
    local-runner/           devkit runner and devkit e2e: claim tasks, run Playwright, upload results
    cloudflare-tunnel.ts    devkit tunnel: cloudflared plus the authenticated local gateway
    local-bridge.ts         devkit bridge: lets the ADK web app control the tunnel
  hub/
    catalog.ts              downloads and validates the ADK Hub index, search
    install.ts              verified skill downloads, pinned plugin checkouts, hub-lock.json
    command.ts, format.ts   devkit skills / devkit plugins and their output
    agents-command.ts       devkit agents: hub agents in the ADK workspace, through the API
  vendor/e2e/               copy of the backend's Playwright runner (scripts/sync-e2e-runner.mjs)
```

- The CLI talks to ADK only through the MCP server code (HTTP client, session, configuration) and
  never imports backend code. `src/vendor` is a verbatim copy that `tests/e2e-runner-parity.test.ts`
  keeps identical to `apps/Backend/src/modules/e2e`, so local runs behave like the ADK workers.
- The CLI imports the server as `#mcp` (package.json `imports`). Typecheck and tests resolve it to
  `../Mcp/src`; `npm run build` builds `apps/Mcp` and copies it into `dist/mcp` and `skills/`
  (`scripts/embed-mcp.mjs`), which is what the npm package ships. The server's runtime
  dependencies are declared here too; `tests/embedded-mcp.test.ts` fails when they drift.

## Development

```bash
cd apps/Mcp && npm ci                    # the CLI reads and builds these sources
cd ../Cli && npm ci
npm run build             # builds apps/Mcp, embeds it, then builds the CLI
npm run verify            # format, lint, typecheck, tests with coverage (includes the runner parity)
npm run sync-e2e-runner   # after changing the backend's Playwright runner
```

## Releasing

Push a tag such as `cli-v0.5.0`. The **CLI release** workflow (`.github/workflows/cli-release.yml`)
verifies both apps, builds the CLI with the embedded MCP server, publishes `@agent-devkit/cli` to the
public npm registry and attaches the tarball to a GitHub release. It authenticates with npm Trusted
Publishing configured for `@agent-devkit/cli` with this workflow file, or with the repository secret
`NPM_AGENT_DEVKIT` (an npm automation or granular publish token for the package). The MCP server has
no release of its own.
