# Deploy and Host ADK with Railway

ADK (Agent DevKit) is an open-source QA and product-delivery platform for teams that work with AI
assistants. It keeps a knowledge base, specifications, test plans, agents and Playwright E2E
automation in shared workspaces, and exposes all of it to Claude, Codex, Cursor and other
assistants through an MCP server.

## About Hosting ADK

Hosting ADK means running four services next to a PostgreSQL database: the REST API, the web
app, a remote MCP server that assistants connect to, and a Playwright worker that executes E2E
tests. This template wires them together on Railway's private network, generates every secret
for you, applies database migrations on each deploy and puts the worker to sleep when no tests
are running. After the deploy finishes, open the web app, create your account and workspace,
and connect your assistant to the MCP URL. Email (SMTP), Google and GitHub sign-in, and
Cloudflare R2 video storage are optional.

## Common Use Cases

- Give Claude, Codex or Cursor grounded access to your team's specs, test plans and knowledge base
- Generate test plans from backlog items and publish them to Azure DevOps or other test-management tools
- Write and run Playwright E2E tests from an assistant, with videos and screenshots of every run
- Track agent runs, issues, budgets and costs in one workspace

## Dependencies for ADK Hosting

- PostgreSQL 17
- Node.js 24
- Playwright (Chromium)
- nginx (serves the web app)

### Deployment Dependencies

- Source code: https://github.com/lucaseduardocrp/Agent-Development-Kit
- CLI for assistants: https://www.npmjs.com/package/@agent-devkit/cli
- MCP specification: https://modelcontextprotocol.io

### Implementation Details

Connect an assistant after the deploy:

```bash
npm install -g @agent-devkit/cli
devkit login --api-url https://<your-api-domain>
```

Remote connectors such as claude.ai use `https://<your-mcp-domain>/mcp` directly and sign in
through OAuth.

### Why Deploy ADK on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your
infrastructure so you don't have to deal with configuration, while allowing you to vertically
and horizontally scale it.

By deploying ADK on Railway, you are one step closer to supporting a complete full-stack
application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
