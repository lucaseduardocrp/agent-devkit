import type { Server } from 'node:http';
import { ToolRegistry } from '../core/registry.js';
import { modules } from '../modules/index.js';
import { loadConfig, storedApiUrl, type McpConfig } from './config.js';
import { loadSkills } from './skills.js';
import { createHttpServer, startStdio } from './transports.js';

/** `parseArgs` options of the server commands, shared by `devkit-mcp` and the `devkit` CLI. */
export const SERVER_OPTIONS = {
  'api-url': { type: 'string' },
  toolsets: { type: 'string' },
  'read-only': { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
} as const;

export interface ServerFlags {
  readonly 'api-url'?: string;
  readonly toolsets?: string;
  readonly 'read-only'?: boolean;
  readonly port?: string;
  readonly host?: string;
}

export const SERVER_COMMANDS = ['stdio', 'http', 'tools'] as const;
export type ServerCommand = (typeof SERVER_COMMANDS)[number];

export function isServerCommand(command: string): command is ServerCommand {
  return (SERVER_COMMANDS as readonly string[]).includes(command);
}

/**
 * Flags win over the environment. Without --api-url or ADK_API_URL, the API of the last
 * `devkit login` is used instead of the localhost default.
 */
export async function resolveConfig(
  flags: ServerFlags,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<McpConfig> {
  const apiUrl =
    flags['api-url'] ?? (environment['ADK_API_URL'] ? undefined : await storedApiUrl(environment));
  return loadConfig({
    ...environment,
    ...(apiUrl ? { ADK_API_URL: apiUrl } : {}),
    ...(flags.toolsets ? { ADK_MCP_TOOLSETS: flags.toolsets } : {}),
    ...(flags['read-only'] ? { ADK_MCP_READ_ONLY: 'true' } : {}),
    ...(flags.port ? { ADK_MCP_HTTP_PORT: flags.port } : {}),
    ...(flags.host ? { ADK_MCP_HTTP_HOST: flags.host } : {}),
  });
}

export function createRegistry(config: McpConfig): ToolRegistry {
  return new ToolRegistry(modules, { toolsets: config.toolsets, readOnly: config.readOnly });
}

/**
 * Runs `stdio`, `http` or `tools`. Human output goes through `say` (stderr in the binaries,
 * because stdout carries the MCP protocol in stdio mode). `http` returns the listening server.
 */
export async function runServerCommand(
  command: ServerCommand,
  config: McpConfig,
  say: (message: string) => void,
): Promise<Server | undefined> {
  const registry = createRegistry(config);
  switch (command) {
    case 'stdio':
      await startStdio(config, registry, await loadSkills());
      say(`[devkit] stdio server ready (${registry.tools.length} tools, API ${config.apiUrl}).`);
      return undefined;
    case 'http': {
      const server = createHttpServer(config, registry, await loadSkills());
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.http.port, config.http.host, resolve);
      });
      say(
        `[devkit] HTTP server on http://${config.http.host}:${config.http.port}/mcp (${registry.tools.length} tools, API ${config.apiUrl}, auth ${config.http.requireAuth ? 'required' : 'optional'}).`,
      );
      return server;
    }
    case 'tools':
      for (const tool of registry.tools) {
        say(
          `${tool.name.padEnd(34)} ${tool.toolset.padEnd(13)} ${tool.access.padEnd(12)} ${tool.execution}`,
        );
      }
      return undefined;
  }
}
