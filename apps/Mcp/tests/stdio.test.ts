import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/bootstrap/config.js';
import { createRegistry, runServerCommand } from '../src/bootstrap/serve.js';
import { startStdio } from '../src/bootstrap/transports.js';
import { ToolRegistry } from '../src/core/registry.js';
import { modules } from '../src/modules/index.js';

/** The stdio transport of the SDK reads process.stdin: tests talk to the server in memory instead. */
const pipe = vi.hoisted(() => ({ client: undefined as unknown as { close(): Promise<void> } }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport: Memory } = await import('@modelcontextprotocol/sdk/inMemory.js');
  return {
    StdioServerTransport: class {
      public constructor() {
        const [client, server] = Memory.createLinkedPair();
        pipe.client = client;
        return server;
      }
    },
  };
});

async function config() {
  const dir = await mkdtemp(join(tmpdir(), 'adk-stdio-'));
  return loadConfig({
    ADK_API_URL: 'http://adk.test',
    ADK_MCP_SESSION_FILE: join(dir, 'session.json'),
    ADK_MCP_TOOLSETS: 'audit',
  });
}

describe('stdio transport', () => {
  it('serves the registry over the stdio transport', async () => {
    const settings = await config();
    await startStdio(settings, new ToolRegistry(modules, { toolsets: ['audit'] }), []);
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(pipe.client as never);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['audit_history']);
    await client.close();
  });

  it('starts it from the stdio command and reports it on the given channel', async () => {
    const settings = await config();
    const lines: string[] = [];
    expect(await runServerCommand('stdio', settings, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([
      `[devkit] stdio server ready (${createRegistry(settings).tools.length} tools, API http://adk.test).`,
    ]);
    await pipe.client.close();
  });
});
