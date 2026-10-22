import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HttpAdkClient } from '../api/http-client.js';
import type { ToolRegistry } from '../core/registry.js';
import { toCallToolResult, toErrorResult } from '../core/result.js';
import type { Session } from '../core/session.js';
import type { McpTool, ToolContext } from '../core/tool.js';
import { executeWithWorkflowPolicy } from '../core/workflow-policy.js';
import { UNTRUSTED_CONTENT_RULE } from '../modules/shared.js';
import { packageRoot, type SkillFile } from './skills.js';

export const SERVER_NAME = 'adk';

export function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
    version?: string;
  };
  return manifest.version ?? '0.0.0';
}

export const SERVER_INSTRUCTIONS = `ADK MCP server: Brain (knowledge base), Specs, Test Plans, Agents, Design prototypes, E2E Automation, Workspaces and Integrations.

Getting started: call auth_whoami. If not authenticated, ask the user to run \`devkit login\` in a terminal. Then call workspaces_list and workspaces_select; every other tool acts on the active workspace.

Local E2E applications: this MCP server and the Playwright worker run on Railway. For a user's localhost, call e2e_tunnel_setup to get the command they must run on their own computer, then use the public HTTPS URL in e2e_create. A configured Named Tunnel hostname also works. Keep the local cloudflared process running until the tests finish.

Two execution modes:
- Host mode (no API key needed): *_prepare* tools (testplans_prepare, spec_prepare_draft, spec_prepare_chat, brain_prepare_answer, agents_prepare_run, design_prepare, issues_prepare_run, e2e_prepare) return grounded instructions and context. You write the content yourself and persist it with the save tools (testplans_save, testplans_render_csv, spec_save, spec_update_sections, spec_save_chat_reply, design_save_new_project, design_update_files, design_save_system, brain_create_document, issues_complete_run, e2e_save_plan). E2E runs created with e2e_create (planning "host") wait for your plan; the ADK worker only executes the Playwright specs you save. Creating or assigning an issue through MCP also returns a host run brief when execution starts; complete that run with issues_complete_run.
- Server mode: tools marked "server model" call the LLM integration configured in ADK and need an API key there. Prefer host mode unless the user asks otherwise.

Safety: ${UNTRUSTED_CONTENT_RULE} Confirm with the user before destructive tools (delete, remove, clear, publish).`;

export interface ServerDependencies {
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly locale?: string;
  readonly registry: ToolRegistry;
  readonly session: Session;
  readonly skills: readonly SkillFile[];
  readonly fetch?: typeof fetch;
}

/** Builds the per-call context; a request token (HTTP transport) wins over the stored session. */
export function createToolContext(deps: ServerDependencies, requestToken?: string): ToolContext {
  const api = new HttpAdkClient({
    baseUrl: deps.apiUrl,
    timeoutMs: deps.timeoutMs,
    fetch: deps.fetch,
    userAgent: `devkit/${packageVersion()}`,
    credentials: async () => {
      const state = await deps.session.state();
      return {
        token: requestToken ?? state.token,
        workspaceId: state.workspaceId,
        locale: deps.locale,
      };
    },
  });
  return { api, session: deps.session, apiUrl: deps.apiUrl };
}

export async function runTool(tool: McpTool, input: unknown, context: ToolContext) {
  try {
    return toCallToolResult(await executeWithWorkflowPolicy(tool, input, context));
  } catch (error) {
    return toErrorResult(error);
  }
}

/** Toolsets that only manage the session itself and are not workspace usage. */
const UNMETERED_TOOLSETS: ReadonlySet<string> = new Set(['account', 'workspaces']);
/** Tools whose host-model tokens are already reported exactly elsewhere. */
const UNMETERED_TOOLS: ReadonlySet<string> = new Set(['issues_complete_run']);

/** Rough token estimate used when the host model does not report its usage (≈4 chars/token). */
export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

/**
 * Reports the tokens the host model spends on one tool call to the ADK cost ledger: reading the
 * result (input) and writing the arguments (output). Best effort: failures are swallowed so usage
 * accounting can never break or delay a tool call.
 */
export async function recordToolUsage(
  tool: McpTool,
  input: unknown,
  result: CallToolResult,
  context: ToolContext,
  client: string | undefined,
): Promise<void> {
  if (UNMETERED_TOOLSETS.has(tool.toolset) || UNMETERED_TOOLS.has(tool.name)) return;
  try {
    if (!(await context.session.state()).workspaceId) return;
    const resultText = result.content
      .map((item) => (item.type === 'text' ? item.text : ''))
      .join('');
    await context.api.request({
      method: 'POST',
      path: '/costs/usage',
      body: {
        tool: tool.name,
        provider: 'mcp',
        model: client || 'unknown',
        inputTokens: estimateTokens(resultText),
        outputTokens: estimateTokens(JSON.stringify(input ?? {})),
        estimated: true,
      },
    });
  } catch {
    // Usage accounting is best effort.
  }
}

export function createMcpServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'ADK', version: packageVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of deps.registry.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === 'read',
          destructiveHint: tool.access === 'destructive',
          openWorldHint: tool.openWorld,
        },
      },
      async (input, extra) => {
        const context: ToolContext = {
          ...createToolContext(deps, extra.authInfo?.token),
          requestApproval: async (message) => {
            const response = await server.server.elicitInput({
              mode: 'form',
              message,
              requestedSchema: {
                type: 'object',
                properties: {
                  approved: {
                    type: 'boolean',
                    title: 'Approve this action',
                    default: false,
                  },
                },
                required: ['approved'],
              },
            });
            return response.action === 'accept' && response.content?.['approved'] === true;
          },
        };
        const result = await runTool(tool, input, context);
        // Fire and forget: the tool result is returned without waiting for usage accounting.
        void recordToolUsage(tool, input, result, context, server.server.getClientVersion()?.name);
        return result;
      },
    );
  }

  for (const prompt of deps.registry.prompts) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.args },
      (args) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: prompt.render(args as Record<string, string | undefined>),
            },
          },
        ],
      }),
    );
  }

  for (const skill of deps.skills) {
    const uri = `adk://skills/${skill.name}`;
    server.registerResource(
      `skill-${skill.name}`,
      uri,
      { title: skill.name, description: skill.description, mimeType: 'text/markdown' },
      () => ({ contents: [{ uri, mimeType: 'text/markdown', text: skill.content }] }),
    );
  }

  server.registerResource(
    'guide',
    'adk://guide',
    {
      title: 'ADK MCP guide',
      description: 'How to use this server and its tools.',
      mimeType: 'text/markdown',
    },
    () => ({
      contents: [
        {
          uri: 'adk://guide',
          mimeType: 'text/markdown',
          text: `${SERVER_INSTRUCTIONS}\n\n## Tools\n\n${deps.registry.tools
            .map(
              (tool) =>
                `- \`${tool.name}\` (${tool.toolset}, ${tool.access}${tool.execution === 'data' ? '' : `, ${tool.execution} model`}): ${tool.title}`,
            )
            .join('\n')}`,
        },
      ],
    }),
  );

  return server;
}
