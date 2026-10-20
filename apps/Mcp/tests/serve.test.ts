import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { storedApiUrl } from '../src/bootstrap/config.js';
import {
  createRegistry,
  isServerCommand,
  resolveConfig,
  runServerCommand,
} from '../src/bootstrap/serve.js';

async function sessionFile(content: string) {
  const file = join(await mkdtemp(join(tmpdir(), 'adk-serve-')), 'session.json');
  await writeFile(file, content);
  return file;
}

describe('server commands', () => {
  it('reads the API of the last login from the session file', async () => {
    const missing = join(tmpdir(), 'adk-missing', 'session.json');
    expect(await storedApiUrl({ ADK_MCP_SESSION_FILE: missing })).toBeUndefined();
    const stored = await sessionFile(JSON.stringify({ apiUrl: 'https://adk.test' }));
    expect(await storedApiUrl({ ADK_MCP_SESSION_FILE: stored })).toBe('https://adk.test');
    const empty = await sessionFile(JSON.stringify({ apiUrl: '' }));
    expect(await storedApiUrl({ ADK_MCP_SESSION_FILE: empty })).toBeUndefined();
  });

  it('lets flags win over the environment and falls back to the stored API', async () => {
    const stored = await sessionFile(JSON.stringify({ apiUrl: 'https://stored.test' }));
    const env = { ADK_MCP_SESSION_FILE: stored };
    expect((await resolveConfig({}, env)).apiUrl).toBe('https://stored.test');
    expect((await resolveConfig({}, { ...env, ADK_API_URL: 'https://env.test' })).apiUrl).toBe(
      'https://env.test',
    );
    const config = await resolveConfig(
      {
        'api-url': 'https://flag.test',
        toolsets: 'brain,spec',
        'read-only': true,
        port: '4444',
        host: '0.0.0.0',
      },
      { ...env, ADK_API_URL: 'https://env.test' },
    );
    expect(config).toMatchObject({
      apiUrl: 'https://flag.test',
      toolsets: ['brain', 'spec'],
      readOnly: true,
      http: { port: 4444, host: '0.0.0.0' },
    });
    const registry = createRegistry(config);
    expect(new Set(registry.tools.map((tool) => tool.toolset))).toEqual(new Set(['brain', 'spec']));
    expect(registry.tools.every((tool) => tool.access === 'read')).toBe(true);
  });

  it('recognizes the server commands', () => {
    expect(['stdio', 'http', 'tools', 'login'].map(isServerCommand)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('lists the enabled tools', async () => {
    const lines: string[] = [];
    const config = await resolveConfig({ toolsets: 'audit' }, { ADK_API_URL: 'http://adk.test' });
    expect(await runServerCommand('tools', config, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toHaveLength(createRegistry(config).tools.length);
    expect(lines[0]).toMatch(/^audit_history\s+audit\s+read/);
  });

  it('starts the HTTP server and reports where it listens', async () => {
    const lines: string[] = [];
    const config = await resolveConfig(
      { port: '1', host: '127.0.0.1' },
      { ADK_API_URL: 'http://adk.test' },
    );
    const server = await runServerCommand(
      'http',
      { ...config, http: { ...config.http, port: 0 } },
      (line) => lines.push(line),
    );
    try {
      expect((server!.address() as AddressInfo).port).toBeGreaterThan(0);
      expect(lines[0]).toContain('HTTP server on http://127.0.0.1:0/mcp');
      expect(lines[0]).toContain('auth optional');
    } finally {
      await new Promise((resolve) => server!.close(resolve));
    }
  });
});
