# ADK — Agent DevKit

ADK is a QA and product-delivery platform driven by AI assistants. It brings together a knowledge
base, specifications, test plans, agents, design prototypes and E2E automation in shared
workspaces, and exposes all of it to Claude, Codex and other assistants through an MCP server.

## Quick start

All you need is [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker
Engine with Compose v2) running, and about 5 GB of free disk space.

1. **Download ADK**: `git clone https://github.com/lucaseduardocrp/agent-devkit.git`, or use
   **Code → Download ZIP** on GitHub and extract it.
2. **Start it** from the ADK folder:

   | Windows                                             | macOS / Linux |
   | --------------------------------------------------- | ------------- |
   | Double-click `adk.cmd` (or run `.\adk` in a terminal) | `./adk.sh`    |

3. **Configure it in your browser.** The setup wizard opens by itself at `http://localhost:4000`.
   Secure keys are generated for you, so the defaults are enough: click **Use recommended
   settings**, then **Save and start ADK**. The page follows the startup and shows the link to
   ADK when it is ready (the first start builds the images and takes 5 to 15 minutes).

![The ADK setup wizard](docs/images/setup-wizard.png)

Then open `http://localhost:8080`, create your account and your first workspace.

### Everyday commands

| What                                   | Windows        | macOS / Linux      |
| -------------------------------------- | -------------- | ------------------ |
| Start ADK                              | `adk.cmd`      | `./adk.sh`         |
| Change the configuration (wizard)      | `adk setup`    | `./adk.sh setup`   |
| Stop ADK (your data is kept)           | `adk stop`     | `./adk.sh stop`    |
| Follow the logs                        | `adk logs`     | `./adk.sh logs`    |
| See the services and their health      | `adk status`   | `./adk.sh status`  |
| Update to the latest version           | `adk update`   | `./adk.sh update`  |

The launchers are thin wrappers around Docker Compose. Without them: run
`docker compose -f setup/compose.yaml up`, finish the wizard at `http://localhost:4000`, then
`docker compose up -d --build`.

### What runs

| Service    | Address                      | Notes                                                   |
| ---------- | ---------------------------- | ------------------------------------------------------- |
| Web app    | `http://localhost:8080`      | Always on                                               |
| API        | `http://localhost:3000`      | Always on; applies database migrations when it starts   |
| PostgreSQL | internal only                | Always on; data lives in the `agent-devkit_database-data` volume |
| E2E worker | internal only                | Optional: Playwright and Chromium, about 2 GB           |
| MCP server | `http://localhost:3333/mcp`  | Optional: remote MCP for claude.ai and other assistants |
| Mailpit    | `http://localhost:8025`      | Optional: local inbox that catches password-recovery emails |

Every port, the services to run, email (SMTP), Google and GitHub sign-in, video storage and
access from other devices are set in the wizard and saved to `.env` in the ADK folder. Keep a
copy of that file: its `INTEGRATION_ENCRYPTION_KEY` is needed to read saved integrations.
The [self-hosting guide](docs/self-hosting.md) covers HTTPS, backups, upgrades and
troubleshooting.

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/agent-devkit)

The button creates a complete ADK in your Railway account: PostgreSQL, the API, the web app, the
remote MCP server and the E2E worker, with every secret generated and the services connected over
Railway's private network. When the deploy finishes:

1. Open the `Web` service's URL and create your account and first workspace.
2. Connect your assistant: `npm install -g @agent-devkit/cli`, then
   `devkit login --api-url https://<API service URL>`. Remote connectors such as claude.ai use
   `https://<MCP service URL>/mcp` directly.
3. Optional: set `SMTP_URL` on the `API` service for password-recovery emails, and the Google or
   GitHub OAuth variables for social sign-in.

The services, variables and how the template is maintained are documented in
[docs/deploy/railway.md](docs/deploy/railway.md).

## Using ADK from an AI assistant

Install the CLI and log in to your ADK API:

```bash
npm install -g @agent-devkit/cli
devkit login --api-url http://localhost:3000   # or the address of your ADK API
```

`devkit` registers the MCP server with Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI,
VS Code and other MCP clients. In host mode no LLM API key is needed: your assistant does the
reasoning and ADK supplies context and stores the results. The CLI also runs E2E tests in your
local browser (`devkit runner`) and opens tunnels to local apps (`devkit bridge`). Full details
are in [apps/Mcp/README.md](apps/Mcp/README.md).

## Features

- **Brain**: workspace knowledge base with document relations, search and grounded answers.
- **Specs**: specification drafting, templates and section-by-section editing.
- **Test Plans**: test plan and suite generation, CSV export and publishing to test-management tools.
- **PBI board**: pull and push backlog items from Azure DevOps and other providers.
- **Agents and Issues**: agent hierarchy, issue inbox, runs, budgets and cost tracking.
- **Design**: design systems and prototype projects.
- **E2E Automation**: Playwright runs on ADK workers or on your own computer, with videos,
  screenshots and test-management reporting.
- **Release notes**, **audit history**, **workspaces**, **permission groups** and **integrations**.

## Repository layout

| Path                                   | Contents                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------- |
| [adk.cmd](adk.cmd), [adk.sh](adk.sh)   | Launchers: start, stop and configure the self-hosted stack                  |
| [compose.yaml](compose.yaml)           | The self-hosted stack (Docker Compose)                                     |
| [setup](setup)                         | The setup wizard that writes `.env` (dependency-free Node server and page) |
| [apps/Backend](apps/Backend)           | REST API and E2E worker (Node, Express 5, Prisma, PostgreSQL, Playwright)  |
| [apps/Frontend](apps/Frontend)         | Web app (React 19, Vite, Tailwind), served by nginx in production          |
| [apps/Mcp](apps/Mcp)                   | `@agent-devkit/cli`: the `devkit` command, MCP server and local E2E runner |
| [infrastructure](infrastructure)       | Development Compose stack and runtime/environment documentation           |
| [docs](docs)                           | Self-hosting and deployment guides, ADRs and templates                     |
| [.agent](.agent)                       | Agent roles, skills and the task workflow                                  |

## Development

Requirements: Node.js 24 (the CLI alone supports Node.js 20 or newer) and PostgreSQL 17, or Docker
to run it.

```bash
# API on http://localhost:3000
cd apps/Backend
cp .env.example .env        # set DATABASE_URL and INTEGRATION_ENCRYPTION_KEY (openssl rand -hex 32)
npm install
npm start                   # builds, applies Prisma migrations and starts the API

# Web app on http://localhost:5173 (proxies API calls to :3000)
cd apps/Frontend
npm install
npm run dev
```

The `.env.example` files document every setting. Install the Playwright browser once with
`npm run e2e:install-browsers` in `apps/Backend`. To run the API and E2E worker in containers
against your own database, see [infrastructure/README.md](infrastructure/README.md).

Each app has the same verification script, which runs formatting, lint, type checks, the i18n
check (Backend and Frontend) and tests with coverage:

```bash
npm run verify
```

| Command                      | Where          | Purpose                              |
| ---------------------------- | -------------- | ------------------------------------ |
| `npm test`                   | every app      | Unit tests (Vitest)                  |
| `npm test`                   | `setup`        | Setup wizard tests (`node --test`)   |
| `npm run test:integration`   | `apps/Backend` | Integration tests against PostgreSQL |
| `npm run prisma:migrate:dev` | `apps/Backend` | Create and apply a new migration     |
| `npm run parity`             | `apps/Mcp`     | Check MCP tools against API routes   |

CI runs `verify` and `build` for the CLI on every pull request that touches it, checks the setup
wizard and the Compose stack, and [cli-release.yml](.github/workflows/cli-release.yml) publishes
`@agent-devkit/cli` to npm.

## Contributing

ADK is developed by its author only and does not accept pull requests. Bug reports are welcome
as issues; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (c) 2026 Lucas Eduardo Continentino de Carvalho.

ADK is free and open-source software licensed under the
[GNU Affero General Public License v3.0](LICENSE). You may use, modify and redistribute it, also
commercially. If you modify ADK and let others use it over a network, for example as a hosted
service, you must make the source code of your modified version available to those users under
the same license.

The ADK and Agent DevKit names and logos are not covered by the license; see
[TRADEMARKS.md](TRADEMARKS.md). For commercial licensing outside the AGPL terms, open an issue.
