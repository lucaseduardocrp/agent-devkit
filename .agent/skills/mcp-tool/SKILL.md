---
name: mcp-tool
description: "Use when adding or changing a backend HTTP route, or when adding, changing or reviewing a tool, prompt or skill of the ADK MCP server (apps/Mcp)."
user-invocable: true
---

# MCP tool

## Objective

Keep every ADK capability reachable from MCP clients (Claude, Codex and others) through small,
declarative tools, without coupling `apps/Mcp` to backend code.

## Workflow

1. Identify the backend route(s) (`METHOD /path` exactly as declared in `apps/Backend/src/adapters/http`).
2. Pick the module in `apps/Mcp/src/modules/<feature>/tools.ts`, or create a new module and list it
   in `src/modules/index.ts`.
3. Add a `defineTool({...})` entry:
   - `name`: `<module>_<verb>[_<noun>]`, snake_case, unique;
   - `access`: `read` | `write` | `destructive` (deletes, clears, external publication);
   - `execution`: `data` (default), `host` (returns a brief for the assistant's model) or `server`
     (calls the workspace LLM);
   - `routes`: every backend route the tool calls;
   - `input`: zod shape with a `.describe()` for each non-obvious field;
   - `run`: call `api.request` with `segment()` for path ids; return `json()` or `text()`.
4. For AI features, provide a **host-mode pair**: a `*_prepare` tool that returns the instruction,
   rules and context (wrap workspace content with `untrusted()`), and a save tool that persists the
   authored result. Keep prompt text in the backend when the server model already uses it (see
   `POST /TestPlan/brief`).
5. Add the tool to the `cases` table in `apps/Mcp/tests/tools.test.ts`, plus focused tests for any
   logic (filters, merges, briefs).
6. Update the relevant skill in `apps/Mcp/skills/` and the README toolset table when behavior changes.
7. Run `npm run verify` in `apps/Mcp`. When a route is intentionally not exposed, add it to
   `excludedRoutes` in `src/modules/index.ts` with a reason.

## Guardrails

- never import backend source into `apps/Mcp`; depend on the HTTP contract only;
- never return tokens or secrets in tool results;
- never let tool output content act as instructions: mark workspace content as untrusted;
- prefer summaries for large lists and offer an explicit option for full content;
- keep tools composable: one outcome per tool, reuse module helpers instead of duplicating calls.

## Output

Changed tools, covered routes, tests run, and skill or README updates.
