import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolRegistry } from '../core/registry.js';
import { FileSessionStore, Session } from '../core/session.js';
import type { McpConfig } from './config.js';
import { createMcpServer } from './create-server.js';
import type { SkillFile } from './skills.js';

/** Local mode: one user, credentials persisted in the session file (Claude Code, Codex, Cursor…). */
export async function startStdio(
  config: McpConfig,
  registry: ToolRegistry,
  skills: readonly SkillFile[],
): Promise<void> {
  const session = new Session(new FileSessionStore(config.sessionFile), {
    apiUrl: config.apiUrl,
    token: config.token,
    workspaceId: config.workspaceId,
  });
  const server = createMcpServer({ ...config, registry, session, skills });
  await server.connect(new StdioServerTransport());
}

export { bearerToken, createHttpServer, type HttpServerOptions } from './http/http-server.js';
