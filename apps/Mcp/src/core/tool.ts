import { z } from 'zod';
import type { AdkApi } from '../api/http-client.js';
import type { Session } from './session.js';

/** Groups of tools that can be enabled independently (`ADK_MCP_TOOLSETS`). */
export const TOOLSETS = [
  'account',
  'workspaces',
  'integrations',
  'brain',
  'agents',
  'issues',
  'pbi',
  'spec',
  'testplans',
  'design',
  'e2e',
  'releasenotes',
  'audit',
] as const;
export type Toolset = (typeof TOOLSETS)[number];

/**
 * `read` never changes data, `write` creates or changes it, `destructive` deletes it or has an
 * irreversible external effect. Clients use these hints to decide when to ask for confirmation.
 */
export type ToolAccess = 'read' | 'write' | 'destructive';

/**
 * `host`: the MCP client's own model does the reasoning, so no LLM API key is needed in ADK.
 * `server`: ADK calls the LLM integration configured in the workspace (requires an API key).
 */
export type ToolExecution = 'data' | 'host' | 'server';

export interface ToolContext {
  readonly api: AdkApi;
  readonly session: Session;
  readonly apiUrl: string;
}

export type ToolResult =
  | { readonly kind: 'json'; readonly data: unknown }
  | { readonly kind: 'text'; readonly text: string };

export const json = (data: unknown): ToolResult => ({ kind: 'json', data });
export const text = (value: string): ToolResult => ({ kind: 'text', text: value });

export interface ToolSpec<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly toolset: Toolset;
  readonly access: ToolAccess;
  readonly execution?: ToolExecution;
  /** The tool reaches systems outside ADK (external wiki, repository, provider test). */
  readonly openWorld?: boolean;
  /** Backend routes this tool covers, e.g. `GET /agents`. Drives the parity guard. */
  readonly routes: readonly string[];
  readonly input: Shape;
  run(input: z.output<z.ZodObject<Shape>>, context: ToolContext): Promise<ToolResult>;
}

/** Type-erased tool as stored by the registry. */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly toolset: Toolset;
  readonly access: ToolAccess;
  readonly execution: ToolExecution;
  readonly openWorld: boolean;
  readonly routes: readonly string[];
  readonly input: z.ZodRawShape;
  execute(rawInput: unknown, context: ToolContext): Promise<ToolResult>;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): McpTool {
  if (!TOOL_NAME.test(spec.name)) throw new Error(`Invalid MCP tool name: ${spec.name}`);
  const schema = z.object(spec.input);
  const execution = spec.execution ?? 'data';
  const suffix =
    execution === 'server'
      ? ' Uses the LLM integration configured in the ADK workspace (needs an API key there); prefer the matching host-mode tool when none is configured.'
      : execution === 'host'
        ? ' Host mode: no API key needed — you (the assistant) do the reasoning with the returned brief.'
        : '';
  return {
    name: spec.name,
    title: spec.title,
    description: `${spec.description}${suffix}`,
    toolset: spec.toolset,
    access: spec.access,
    execution,
    openWorld: spec.openWorld ?? execution === 'server',
    routes: spec.routes,
    input: spec.input,
    execute: (rawInput, context) =>
      Promise.resolve().then(() => spec.run(schema.parse(rawInput ?? {}), context)),
  };
}
