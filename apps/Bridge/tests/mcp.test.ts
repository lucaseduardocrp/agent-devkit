import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialStore } from '../src/app/credential-store.js';
import { Sandbox } from '../src/app/sandbox.js';
import { claudeAdapter } from '../src/cli/claude.js';
import { codexAdapter } from '../src/cli/codex.js';
import { geminiAdapter } from '../src/cli/gemini.js';
import { isAcceptableMcpUrl, mcpTokenEnv } from '../src/core/mcp.js';
import type { IncomingMessage } from '../src/core/types.js';
import { message, setup } from './helpers.js';

const server = { name: 'adk', url: 'https://mcp.example.com/mcp', token: 'adk_pat_SECRET' };
const ok = async () => ({
  stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 's' }),
  stderr: '',
  exitCode: 0,
});
const request = { prompt: 'hi', autonomy: 'auto' as const, cwd: '/w', home: '/h' };

describe('MCP helpers', () => {
  it('names the token variable and judges URLs', () => {
    expect(mcpTokenEnv('adk')).toBe('MCP_TOKEN_ADK');
    expect(mcpTokenEnv('my-tool.v2')).toBe('MCP_TOKEN_MY_TOOL_V2');
    expect(isAcceptableMcpUrl('https://x.example.com/mcp')).toBe(true);
    expect(isAcceptableMcpUrl('http://ai-cli-bridge.railway.internal:3333/mcp')).toBe(true);
    expect(isAcceptableMcpUrl('http://localhost:3333/mcp')).toBe(true);
    expect(isAcceptableMcpUrl('http://127.0.0.1:3333/mcp')).toBe(true);
    expect(isAcceptableMcpUrl('http://evil.example.com/mcp')).toBe(false);
    expect(isAcceptableMcpUrl('ftp://x.example.com')).toBe(false);
    expect(isAcceptableMcpUrl('not a url')).toBe(false);
  });
});

describe('MCP in each CLI adapter', () => {
  it('claude reads a config file in the HOME, and never gets the token on the command line', () => {
    const invocation = claudeAdapter.buildInvocation({ ...request, mcpServers: [server] });
    const index = invocation.args.indexOf('--mcp-config');
    expect(invocation.args[index + 1]).toBe(join('/h', '.adk/mcp-claude.json'));
    expect(JSON.stringify(invocation)).not.toContain('SECRET');

    const files = claudeAdapter.mcpFiles!([server]);
    const content = JSON.parse(files['.adk/mcp-claude.json']!(null)) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(content.mcpServers.adk).toEqual({
      type: 'http',
      url: server.url,
      headers: { Authorization: 'Bearer adk_pat_SECRET' },
    });
    // Without servers (or without a HOME) the flag is left out.
    expect(claudeAdapter.buildInvocation({ ...request, mcpServers: [] }).args).not.toContain(
      '--mcp-config',
    );
    expect(
      claudeAdapter.buildInvocation({ ...request, home: undefined, mcpServers: [server] }).args,
    ).not.toContain('--mcp-config');
  });

  it('codex gets the URL by flag and the token by environment variable only', () => {
    const invocation = codexAdapter.buildInvocation({ ...request, mcpServers: [server] });
    expect(invocation.args).toContain('mcp_servers.adk.url="https://mcp.example.com/mcp"');
    expect(invocation.args).toContain('mcp_servers.adk.bearer_token_env_var="MCP_TOKEN_ADK"');
    expect(invocation.args.at(-1)).toBe('-');
    expect(invocation.env).toEqual({ MCP_TOKEN_ADK: 'adk_pat_SECRET' });
    expect(invocation.args.join(' ')).not.toContain('SECRET');
    expect(codexAdapter.buildInvocation(request).env).toEqual({});
  });

  it('gemini keeps the other settings and replaces only its MCP servers', () => {
    const write = geminiAdapter.mcpFiles!([server])['.gemini/settings.json']!;
    const fresh = JSON.parse(write(null)) as { mcpServers: Record<string, unknown> };
    expect(fresh.mcpServers.adk).toEqual({
      httpUrl: server.url,
      headers: { Authorization: 'Bearer adk_pat_SECRET' },
    });
    const merged = JSON.parse(
      write(JSON.stringify({ theme: 'dark', mcpServers: { old: {} } })),
    ) as Record<string, unknown>;
    expect(merged.theme).toBe('dark');
    expect(Object.keys(merged.mcpServers as object)).toEqual(['adk']);
    // Broken or unexpected settings are replaced instead of kept.
    expect(JSON.parse(write('{broken')).mcpServers.adk).toBeDefined();
    expect(JSON.parse(write('"text"')).mcpServers.adk).toBeDefined();
    // No servers left: the section is emptied.
    expect(
      JSON.parse(geminiAdapter.mcpFiles!([])['.gemini/settings.json']!('{}')).mcpServers,
    ).toEqual({});
  });
});

describe('MCP storage', () => {
  it('keeps servers per user, encrypted, next to the CLI credentials', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bridge-mcp-')), 'credentials.enc');
    const store = new CredentialStore(file, 'k');
    store.set('member:a', 'claude', { kind: 'env', name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok' });
    store.setMcp('member:a', server);
    store.setMcp('member:b', { ...server, token: 'B-token' });
    expect(readFileSync(file, 'utf8')).not.toContain('SECRET');

    const reloaded = new CredentialStore(file, 'k');
    expect(reloaded.getMcp('member:a')).toEqual([server]);
    expect(reloaded.getMcp('member:b')[0]?.token).toBe('B-token');
    expect(reloaded.getMcp('nobody')).toEqual([]);
    // A server is not a CLI account, and the account survives next to it.
    expect(reloaded.has('member:a', 'claude')).toBe(true);
    expect(reloaded.has('member:a', 'mcp:adk')).toBe(true);

    expect(reloaded.clearMcp('member:a', 'adk')).toBe(true);
    expect(reloaded.clearMcp('member:a', 'adk')).toBe(false);
    expect(reloaded.clearMcp('nobody', 'adk')).toBe(false);
    expect(reloaded.getMcp('member:a')).toEqual([]);
  });
});

describe('Sandbox managed files', () => {
  it('rewrites them on every run, privately, and never outside the HOME', () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-managed-'));
    const box = new Sandbox({
      homesDir: join(root, 'homes'),
      workspacesDir: join(root, 'work'),
      usersFile: null,
      credentials: new CredentialStore(null, 'k'),
      switchUser: false,
    });
    const first = box.resolve('a', 'claude', { '.adk/mcp.json': () => 'one' });
    const file = join(first.home, '.adk', 'mcp.json');
    expect(readFileSync(file, 'utf8')).toBe('one');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    box.resolve('a', 'claude', { '.adk/mcp.json': (current) => `${current}+two` });
    expect(readFileSync(file, 'utf8')).toBe('one+two');

    box.resolve('a', 'claude', { '../escape.json': () => 'x' });
    expect(existsSync(join(root, 'homes', 'escape.json'))).toBe(false);
    writeFileSync(file, 'tampered');
    box.resolve('a', 'claude', { '.adk/mcp.json': () => 'fresh' });
    expect(readFileSync(file, 'utf8')).toBe('fresh');
  });
});

describe('/mcp in the Bridge', () => {
  const adk = (text: string, memberId: string): IncomingMessage => ({
    ...message(text, '9'),
    memberId,
  });
  const setupAdk = () => setup(ok, { BRIDGE_ALLOWED_USER_IDS: '9' });

  it('lists, adds, updates and removes a user servers without showing the token', async () => {
    const { bridge, channel, credentials } = setupAdk();
    await bridge.handle(adk('/mcp', 'a'));
    expect(channel.sent.at(-1)).toContain('not connected any MCP server');

    await bridge.handle(adk('/mcp add adk https://mcp.example.com/mcp adk_pat_SECRET', 'a'));
    expect(channel.sent.at(-1)).toContain('connected to your CLIs');
    expect(credentials.getMcp('member:a')).toEqual([
      { name: 'adk', url: 'https://mcp.example.com/mcp', token: 'adk_pat_SECRET' },
    ]);
    expect(credentials.getMcp('member:b')).toEqual([]);

    await bridge.handle(adk('/mcp list', 'a'));
    expect(channel.sent.at(-1)).toContain('• adk — https://mcp.example.com/mcp');
    expect(channel.sent.join('\n')).not.toContain('SECRET');

    await bridge.handle(adk('/mcp add adk https://mcp.example.com/other new-token', 'a'));
    expect(credentials.getMcp('member:a')[0]?.token).toBe('new-token');

    await bridge.handle(adk('/mcp remove adk', 'a'));
    await bridge.handle(adk('/mcp remove adk', 'a'));
    expect(channel.sent.at(-2)).toContain('removed');
    expect(channel.sent.at(-1)).toContain('no MCP server called adk');
  });

  it('validates the name, the URL, the arguments and the limit', async () => {
    const { bridge, channel, credentials } = setupAdk();
    await bridge.handle(adk('/mcp add Bad_Name https://x.example.com t', 'a'));
    expect(channel.sent.at(-1)).toContain('lowercase letters');
    await bridge.handle(adk('/mcp add ok http://evil.example.com t', 'a'));
    expect(channel.sent.at(-1)).toContain('must start with https://');
    await bridge.handle(adk('/mcp add ok https://x.example.com', 'a'));
    expect(channel.sent.at(-1)).toContain('/mcp add <name> <url> <token>');
    await bridge.handle(adk('/mcp frobnicate', 'a'));
    expect(channel.sent.at(-1)).toContain('/mcp add <name> <url> <token>');
    expect(credentials.getMcp('member:a')).toEqual([]);

    for (let i = 0; i < 10; i += 1)
      await bridge.handle(adk(`/mcp add s${i} https://x.example.com/${i} t${i}`, 'a'));
    await bridge.handle(adk('/mcp add extra https://x.example.com/x t', 'a'));
    expect(channel.sent.at(-1)).toContain('already have 10');
    expect(credentials.getMcp('member:a')).toHaveLength(10);
    await bridge.handle(adk('/mcp add s3 https://x.example.com/new t', 'a'));
    expect(channel.sent.at(-1)).toContain('connected to your CLIs');
  });

  it('runs each CLI with only the servers of the person who writes', async () => {
    const { bridge, calls, envs, credentials } = setupAdk();
    credentials.set('member:a', 'claude', {
      kind: 'env',
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: 'A',
    });
    credentials.set('member:b', 'codex', { kind: 'env', name: 'OPENAI_API_KEY', value: 'B' });
    credentials.setMcp('member:a', { ...server, token: 'TOKEN-OF-A' });
    credentials.setMcp('member:b', { ...server, token: 'TOKEN-OF-B' });

    await bridge.handle({ ...adk('/cli claude', 'a'), chatId: 'chat-a' });
    await bridge.handle({ ...adk('hello', 'a'), chatId: 'chat-a' });
    await bridge.handle({ ...adk('/cli codex', 'b'), chatId: 'chat-b' });
    await bridge.handle({ ...adk('hello', 'b'), chatId: 'chat-b' });

    const [claudeCall, codexCall] = calls;
    expect(claudeCall?.args).toContain('--mcp-config');
    expect(JSON.stringify(calls.map((call) => [call.args, call.stdin]))).not.toContain('TOKEN-OF');
    expect(codexCall?.env).toEqual({ MCP_TOKEN_ADK: 'TOKEN-OF-B' });
    expect(envs[0]?.HOME).not.toBe(envs[1]?.HOME);
    const claudeConfig = readFileSync(
      join(String(envs[0]?.HOME), '.adk', 'mcp-claude.json'),
      'utf8',
    );
    expect(claudeConfig).toContain('TOKEN-OF-A');
    expect(claudeConfig).not.toContain('TOKEN-OF-B');
  });
});
