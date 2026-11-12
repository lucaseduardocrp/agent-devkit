import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialStore } from '../src/app/credential-store.js';
import { Sandbox } from '../src/app/sandbox.js';
import { runProcess, safeEnv } from '../src/core/process-runner.js';
import type { IncomingMessage } from '../src/core/types.js';
import { identityOf } from '../src/core/types.js';
import { message, setup } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'bridge-iso-'));
const claudeOk = async () => ({
  stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 's' }),
  stderr: '',
  exitCode: 0,
});

describe('CredentialStore', () => {
  it('encrypts at rest and reads back with the same key', () => {
    const file = join(tmp(), 'credentials.enc');
    const store = new CredentialStore(file, 'secret-one');
    store.set('member:a', 'claude', {
      kind: 'env',
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-PLAIN',
    });
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-PLAIN');
    expect(new CredentialStore(file, 'secret-one').get('member:a', 'claude')?.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-PLAIN',
    });
  });

  it('refuses a wrong key instead of starting an empty vault', () => {
    const file = join(tmp(), 'credentials.enc');
    new CredentialStore(file, 'secret-one').set('a', 'claude', {
      kind: 'env',
      name: 'K',
      value: 'v',
    });
    expect(() => new CredentialStore(file, 'secret-two')).toThrow('cannot be decrypted');
  });

  it('keeps users apart, replaces a key with a new one and clears', () => {
    const store = new CredentialStore(null, 'k');
    store.set('a', 'claude', { kind: 'env', name: 'ANTHROPIC_API_KEY', value: '1' });
    store.set('a', 'claude', { kind: 'env', name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '2' });
    store.set('a', 'codex', { kind: 'file', path: '.codex/auth.json', content: '{}' });
    expect(store.get('a', 'claude')?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '2' });
    expect(store.has('b', 'claude')).toBe(false);
    expect(store.has('a', 'codex')).toBe(true);
    expect(store.clear('a', 'claude')).toBe(true);
    expect(store.clear('a', 'claude')).toBe(false);
    expect(store.clear('nobody', 'claude')).toBe(false);
  });
});

describe('Sandbox', () => {
  function sandbox(credentials = new CredentialStore(null, 'k')) {
    const root = tmp();
    const usersFile = join(root, 'users.json');
    const options = {
      homesDir: join(root, 'homes'),
      workspacesDir: join(root, 'work'),
      usersFile,
      credentials,
      switchUser: false,
    };
    return { sandbox: new Sandbox(options), options, root, credentials };
  }

  it('gives every user their own HOME and project directory, and remembers them', () => {
    const { sandbox: box, options } = sandbox();
    const a = box.resolve('member:a', 'claude');
    const b = box.resolve('member:b', 'claude');
    expect(a.home).not.toBe(b.home);
    expect(a.cwd).not.toBe(b.cwd);
    expect(existsSync(a.home) && existsSync(b.cwd)).toBe(true);
    expect(a.env.HOME).toBe(a.home);
    expect(box.resolve('member:a', 'claude').home).toBe(a.home);
    expect(new Sandbox(options).resolve('member:b', 'claude').home).toBe(b.home);
  });

  it('injects only that user and CLI credentials, and nothing from the container', () => {
    process.env.BRIDGE_SHARED_TOKEN = 'container-secret';
    process.env.ANTHROPIC_API_KEY = 'container-api-key';
    try {
      const credentials = new CredentialStore(null, 'k');
      credentials.set('member:a', 'claude', {
        kind: 'env',
        name: 'CLAUDE_CODE_OAUTH_TOKEN',
        value: 'A',
      });
      credentials.set('member:b', 'claude', {
        kind: 'env',
        name: 'CLAUDE_CODE_OAUTH_TOKEN',
        value: 'B',
      });
      credentials.set('member:a', 'codex', {
        kind: 'env',
        name: 'OPENAI_API_KEY',
        value: 'A-openai',
      });
      const { sandbox: box } = sandbox(credentials);
      const a = box.resolve('member:a', 'claude');
      expect(a.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('A');
      expect(box.resolve('member:b', 'claude').env.CLAUDE_CODE_OAUTH_TOKEN).toBe('B');
      expect(a.env.OPENAI_API_KEY).toBeUndefined();
      expect(a.env.BRIDGE_SHARED_TOKEN).toBeUndefined();
      expect(a.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(safeEnv().BRIDGE_SHARED_TOKEN).toBeUndefined();
    } finally {
      delete process.env.BRIDGE_SHARED_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('writes credential files into the HOME once, and never outside it', () => {
    const credentials = new CredentialStore(null, 'k');
    credentials.set('a', 'codex', { kind: 'file', path: '.codex/auth.json', content: '{"v":1}' });
    credentials.set('a', 'codex', { kind: 'file', path: '../escape.json', content: 'x' });
    const { sandbox: box, root } = sandbox(credentials);
    const runtime = box.resolve('a', 'codex');
    const file = join(runtime.home, '.codex', 'auth.json');
    expect(readFileSync(file, 'utf8')).toBe('{"v":1}');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, 'homes', 'escape.json'))).toBe(false);
    // The CLI refreshes its tokens: a later run must not overwrite them.
    writeFileSync(file, '{"v":2}');
    box.resolve('a', 'codex');
    expect(readFileSync(file, 'utf8')).toBe('{"v":2}');
  });

  it('assigns an OS user to each person when it can switch users', () => {
    const root = tmp();
    const passwd = join(root, 'passwd');
    const group = join(root, 'group');
    writeFileSync(passwd, 'root:x:0:0::/root:/bin/sh\n');
    writeFileSync(group, 'root:x:0:\n');
    const box = new Sandbox({
      homesDir: join(root, 'homes'),
      workspacesDir: join(root, 'work'),
      usersFile: null,
      credentials: new CredentialStore(null, 'k'),
      switchUser: process.getuid?.() === 0,
      passwdFile: passwd,
      groupFile: group,
    });
    const a = box.resolve('a', 'claude');
    if (process.getuid?.() === 0) {
      expect(a.uid).toBe(20001);
      expect(box.resolve('b', 'claude').uid).toBe(20002);
      expect(readFileSync(passwd, 'utf8')).toContain(':x:20001:');
    } else {
      expect(a.uid).toBeUndefined();
    }
  });
});

describe('runProcess environment', () => {
  it('does not hand the container secrets to the CLI', async () => {
    process.env.BRIDGE_SHARED_TOKEN = 'container-secret';
    try {
      const result = await runProcess(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write(String(process.env.BRIDGE_SHARED_TOKEN))'],
        },
        { cwd: process.cwd(), timeoutMs: 10_000 },
      );
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env.BRIDGE_SHARED_TOKEN;
    }
  });
});

describe('per-user accounts in the Bridge', () => {
  const adk = (text: string, memberId: string): IncomingMessage => ({
    ...message(text, '9'),
    channel: 'telegram',
    memberId,
  });

  it('derives the identity from the ADK member, else from the chat user', () => {
    expect(identityOf({ channel: 'adk', userId: '7', memberId: 'u-1' })).toBe('member:u-1');
    expect(identityOf({ channel: 'telegram', userId: '7' })).toBe('telegram:7');
  });

  it('runs each member as themselves, with their own credentials, HOME and directory', async () => {
    const { bridge, channel, envs, credentials, calls } = setup(claudeOk, {
      BRIDGE_ALLOWED_USER_IDS: '9',
    });
    credentials.set('member:a', 'claude', {
      kind: 'env',
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: 'A',
    });
    credentials.set('member:b', 'codex', { kind: 'env', name: 'OPENAI_API_KEY', value: 'B' });

    await bridge.handle({ ...adk('/cli claude', 'a'), chatId: 'chat-a' });
    await bridge.handle({ ...adk('hello', 'a'), chatId: 'chat-a' });
    await bridge.handle({ ...adk('/cli codex', 'b'), chatId: 'chat-b' });
    await bridge.handle({ ...adk('hello', 'b'), chatId: 'chat-b' });

    expect(calls.map((c) => c.command)).toEqual(['claude', 'codex']);
    const [envA, envB] = envs;
    expect(envA?.CLAUDE_CODE_OAUTH_TOKEN).toBe('A');
    expect(envA?.OPENAI_API_KEY).toBeUndefined();
    expect(envB?.OPENAI_API_KEY).toBe('B');
    expect(envB?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(envA?.HOME).not.toBe(envB?.HOME);
    expect(channel.sent).not.toContain('Connect');
  });

  it('asks a member who has no account to connect one, without running anything', async () => {
    const { bridge, channel, calls } = setup(claudeOk, { BRIDGE_ALLOWED_USER_IDS: '9' });
    await bridge.handle(adk('hello', 'newcomer'));
    expect(calls).toHaveLength(0);
    expect(channel.sent.join(' ')).toContain('/auth claude');
  });

  it('/auth saves the key for that member only, and /logout removes it', async () => {
    const { bridge, channel, credentials } = setup(claudeOk, { BRIDGE_ALLOWED_USER_IDS: '9' });
    await bridge.handle(adk('/auth', 'a'));
    expect(channel.sent.at(-1)).toContain('claude — not connected');
    await bridge.handle(adk('/auth claude not-a-key', 'a'));
    expect(channel.sent.at(-1)).toContain('did not recognize');
    await bridge.handle(adk('/auth claude sk-ant-oat01-secret', 'a'));
    expect(channel.sent.at(-1)).toContain('saved for you only');
    expect(credentials.get('member:a', 'claude')?.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret',
    });
    expect(credentials.has('member:b', 'claude')).toBe(false);
    await bridge.handle(adk('/auth', 'a'));
    expect(channel.sent.at(-1)).toContain('claude — connected');

    await bridge.handle(adk('/logout claude', 'a'));
    await bridge.handle(adk('/logout claude', 'a'));
    expect(channel.sent.at(-2)).toContain('removed');
    expect(channel.sent.at(-1)).toContain('no credential');
    await bridge.handle(adk('/logout nope', 'a'));
    expect(channel.sent.at(-1)).toContain('does not exist');
  });

  it('accepts a Codex auth.json and rejects broken JSON', async () => {
    const { bridge, channel, credentials } = setup(claudeOk, { BRIDGE_ALLOWED_USER_IDS: '9' });
    await bridge.handle(adk('/auth codex {broken', 'a'));
    expect(channel.sent.at(-1)).toContain('did not recognize');
    await bridge.handle(adk('/auth codex {"tokens":{}}', 'a'));
    expect(credentials.get('member:a', 'codex')?.files).toEqual({
      '.codex/auth.json': '{"tokens":{}}',
    });
    await bridge.handle(adk('/auth codex sk-proj-abc', 'a'));
    expect(credentials.get('member:a', 'codex')?.env).toEqual({ OPENAI_API_KEY: 'sk-proj-abc' });
    await bridge.handle(adk('/auth gemini AIzaSyA-abcdefghijklmnopqrstu', 'a'));
    expect(credentials.has('member:a', 'gemini')).toBe(true);
    await bridge.handle(adk('/auth claude', 'a'));
    expect(channel.sent.at(-1)).toContain('claude setup-token');
  });

  it('runs scheduled tasks with the credentials of whoever created them', async () => {
    const { bridge, channel, envs, credentials } = setup(claudeOk, {
      BRIDGE_ALLOWED_USER_IDS: '9',
    });
    credentials.set('member:a', 'claude', {
      kind: 'env',
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: 'A',
    });
    await bridge.handle({ ...adk('/cli claude', 'a'), chatId: 'chat-a' });
    await bridge.handle({ ...adk('/schedule every 1h check', 'a'), chatId: 'chat-a' });
    expect(bridge.store.tasks()[0]?.identity).toBe('member:a');
    bridge.store.tasks()[0]!.nextRunAt = 0;
    await bridge.scheduler.tick();
    expect(envs.at(-1)?.CLAUDE_CODE_OAUTH_TOKEN).toBe('A');
    expect(channel.sent.at(-1)).toContain('Task #1');

    // The owner signs out: the next run reports it instead of using anyone else's account.
    await bridge.handle({ ...adk('/logout claude', 'a'), chatId: 'chat-a' });
    bridge.store.tasks()[0]!.nextRunAt = 0;
    await bridge.scheduler.tick();
    expect(channel.sent.at(-1)).toContain('/auth claude');
  });
});
