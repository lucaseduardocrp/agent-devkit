#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { packageVersion } from '../bootstrap/create-server.js';
import {
  isServerCommand,
  resolveConfig,
  runServerCommand,
  SERVER_OPTIONS,
} from '../bootstrap/serve.js';

const HELP = `devkit-mcp — ADK MCP server

Usage:
  devkit-mcp [stdio]               Start the local stdio server (default)
  devkit-mcp http [--port N] [--host H]
                                   Start the Streamable HTTP server (endpoint /mcp)
  devkit-mcp tools                 List the enabled tools

Options:
  --api-url URL        ADK API base URL (env ADK_API_URL, default: API of the last
                       \`devkit login\`, then http://localhost:3000)
  --toolsets a,b       Enabled toolsets (env ADK_MCP_TOOLSETS)
  --read-only          Expose only read tools (env ADK_MCP_READ_ONLY)

The stdio server uses the session stored by \`devkit login\` (npm install -g @agent-devkit/cli)
or the ADK_TOKEN environment variable.
`;

// stdout is reserved for the MCP protocol in stdio mode, so all human output goes to stderr.
const say = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      ...SERVER_OPTIONS,
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const command = positionals[0] ?? 'stdio';
  if (values.help || command === 'help') return say(HELP);
  if (values.version || command === 'version') return say(packageVersion());
  if (!isServerCommand(command)) {
    say(HELP);
    process.exitCode = 1;
    return;
  }
  const server = await runServerCommand(command, await resolveConfig(values), say);
  if (server) {
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
}

main().catch((error: unknown) => {
  say(`[devkit] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
