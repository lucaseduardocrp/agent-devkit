# ADK MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **every ADK
capability** (Brain, Specs, Test Plans, Agents, Design, Workspaces, Integrations, Audit) to Claude
Code, Claude Desktop, Codex, Cursor, Gemini CLI, VS Code and any other MCP client.

**No LLM API key is needed.** In _host mode_ the assistant you already pay for (Claude Team, ChatGPT
or Codex, and so on) does the reasoning. ADK supplies the grounded instructions and context and then
stores the result. Tools marked _server model_ still use the LLM integration configured in the
workspace for teams that prefer it.

This package is only the server: the tools, the stdio and Streamable HTTP transports, OAuth for
remote connectors and the Docker image deployed to Railway. The `devkit` command line that signs
in, runs E2E tests on your computer and opens tunnels is [`@agent-devkit/cli`](../Cli).

## Quick start

Install the command line and sign in once (see [apps/Cli](../Cli/README.md#sign-in)):

```bash
npm install -g @agent-devkit/cli
devkit login --api-url https://<your-adk-api>
devkit install-skills --client claude   # or --client codex
```

`devkit` (or `devkit mcp`) starts this server over stdio with the stored session, so assistants can
use `devkit` as the command. To run the server without the CLI, build it from a checkout and use
`devkit-mcp` (with `devkit login` done once, or `ADK_TOKEN`):

```bash
cd apps/Mcp && npm ci && npm run build
node dist/src/bin/devkit-mcp.js tools
```

Then register the server in your client. In the examples below, `ADK_MCP` is the absolute path to
`apps/Mcp/dist/src/bin/devkit-mcp.js`; with the CLI installed globally, replace `node ADK_MCP` with
`devkit`.

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

| Client            | File                      | Entry                                                                               |
| ----------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| Cursor            | `.cursor/mcp.json`        | `"mcpServers": { "adk": { "command": "node", "args": ["ADK_MCP"], "env": {…} } }`   |
| Gemini CLI        | `~/.gemini/settings.json` | same`mcpServers` shape                                                              |
| VS Code (Copilot) | `.vscode/mcp.json`        | `"servers": { "adk": { "type": "stdio", "command": "node", "args": ["ADK_MCP"] } }` |

If a client that does not load skills also supports MCP _resources_, it can read the same guides at
`adk://skills/<name>`. The full tool catalog is at `adk://guide`.

## Team / remote mode (Streamable HTTP + OAuth)

Run one server for the whole team (runbook: `docs/operations/mcp-server.md`). Every request
carries the user's **own** ADK token, so permissions and audit stay per person.

```bash
ADK_API_URL=https://<your-adk-api> ADK_MCP_HTTP_HOST=0.0.0.0 ADK_MCP_PUBLIC_URL=https://mcp.example.com ADK_MCP_OAUTH_SECRET=$(openssl rand -hex 32) devkit-mcp http            # or deploy apps/Mcp (Dockerfile + railway.json)
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

| Variable                                     | Purpose                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ADK_API_URL`                                | ADK API base URL                                                                                   |
| `ADK_MCP_TOOLSETS`                           | Enable only some toolsets, for example`brain,spec,testplans` (useful for clients with tool limits) |
| `ADK_MCP_READ_ONLY`                          | Expose read tools only                                                                             |
| `ADK_WORKSPACE_ID`                           | Default workspace (otherwise use`workspaces_select`)                                               |
| `ADK_MCP_TIMEOUT_MS`                         | API timeout; server-model generations can be slow                                                  |
| `ADK_MCP_PUBLIC_URL`, `ADK_MCP_OAUTH_SECRET` | Enable the OAuth authorization server (remote mode)                                                |
| `ADK_MCP_TRUST_PROXY`, `ADK_MCP_RATE_LIMIT`  | Proxy headers and per-IP limit (remote mode)                                                       |

## Tools

Run `devkit-mcp tools` (or `devkit tools` with the CLI) for the live list. Every backend route is covered: the parity test
fails when a route has no tool.

| Toolset        | Highlights                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`      | `auth_whoami`, `auth_login`, `auth_register`, password reset, access tokens (list, revoke), `system_health`                                                                                        |
| `workspaces`   | list, select, create, delete, members and permissions                                                                                                                                              |
| `integrations` | list, save, test, delete, Azure DevOps members                                                                                                                                                     |
| `brain`        | documents CRUD, search, relations, sync, publish to Azure Wiki,`brain_prepare_answer` (host) / `brain_ask` (server)                                                                                |
| `agents`       | CRUD,`agents_prepare_run` (host) / `agents_execute` (server)                                                                                                                                       |
| `issues`       | issue CRUD, inbox, dashboard, agent run lifecycle (server or host), token usage, monthly spend, budget and model rates                                                                             |
| `pbi`          | workspace backlog and card CRUD, provider list, pull, push, context and issue creation                                                                                                             |
| `spec`         | templates, specs CRUD,`spec_update_sections`, export, publish, `spec_prepare_draft` (host) / `spec_chat` and `spec_generate_from_brain` (server)                                                   |
| `testplans`    | `testplans_prepare` + `testplans_save` (host), `testplans_generate` (server), plans and suites CRUD                                                                                                |
| `design`       | prototypes and Design Systems,`design_prepare` + `design_save_new_project` (host), `design_create_project` and `design_chat` (server)                                                              |
| `e2e`          | E2E runs:`e2e_tunnel_setup` and `e2e_check_tunnel` for applications on a user's computer, create, run, rerun one test, read and commit Playwright scripts, failure analysis and signed video links |
| `releasenotes` | release notes CRUD and Markdown export,`release_notes_prepare` + `release_notes_create` (host), `release_notes_generate` (server)                                                                  |
| `audit`        | `audit_history` (documents, specs, templates, test plans, PBIs, issues, release notes)                                                                                                             |

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
  bootstrap/                composition root: config, MCP server, stdio/HTTP transports
    serve.ts                stdio, http and tools commands, shared with the devkit CLI
  bin/devkit-mcp.ts         devkit-mcp entry point
  index.ts                  public API used by the devkit CLI (apps/Cli)
skills/<name>/SKILL.md      portable skills (Claude Code, Codex and other Agent Skills clients)
```

- The package depends on the ADK **HTTP contract only**; it never imports backend code.
- It has no terminal-only code: sign-in, the local E2E runner, tunnels and skill installation live
  in the CLI ([apps/Cli](../Cli)), which depends on this package. `tests/public-api.test.ts` lists
  what the CLI may import.
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

## Deployment and releases

The server has no npm package and no releases of its own. The Railway service deploys `apps/Mcp`
from its Dockerfile, and the CLI release embeds the code built from this folder (see
[Releasing](../Cli/README.md#releasing) in apps/Cli). A change here reaches local assistants with
the next CLI release.
