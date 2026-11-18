import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialStore } from '../src/app/credential-store.js';
import { LlmHost, LlmError, type LlmEvent, type LlmInput } from '../src/app/llm-host.js';
import { Sandbox } from '../src/app/sandbox.js';
import { createCliRegistry } from '../src/cli/index.js';
import { CliExecutor } from '../src/core/cli-registry.js';
import type {
  ProcessStreamer,
  StreamExit,
  StreamOptions,
  StreamRun,
} from '../src/core/stream-process.js';
import { SECURITY_POLICY } from '../src/core/guard.js';
import type { Invocation } from '../src/core/types.js';

const OAUTH_TOKEN = 'sk-ant-oat-workspace-token-0123456789';
const claudeLine = (value: unknown) => JSON.stringify(value);
const delta = (text: string) =>
  claudeLine({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
const result = (text: string, usage: object = { input_tokens: 3, output_tokens: 4 }) =>
  claudeLine({ type: 'result', subtype: 'success', result: text, usage });

interface Started {
  invocation: Invocation;
  options: StreamOptions;
  /** What the prompt file held when the process started (it is removed afterwards). */
  files: Record<string, string>;
}

function setup(
  script: (invocation: Invocation) => {
    lines?: string[];
    exit?: Partial<StreamExit>;
    fail?: Error;
  },
  extra: { timeoutMs?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'llm-host-'));
  const credentials = new CredentialStore(null, 'test-key');
  const sandbox = new Sandbox({
    homesDir: join(root, 'homes'),
    workspacesDir: join(root, 'work'),
    usersFile: null,
    credentials,
    switchUser: false,
  });
  const started: Started[] = [];
  const stopped: boolean[] = [];
  const stream: ProcessStreamer = (invocation, options) => {
    const files: Record<string, string> = {};
    for (const name of readdirSync(options.cwd))
      files[name] = readFileSync(join(options.cwd, name), 'utf8');
    started.push({ invocation, options, files });
    const plan = script(invocation);
    const run: StreamRun = {
      output: (async function* () {
        for (const line of plan.lines ?? []) yield line;
        if (plan.fail) throw plan.fail;
      })(),
      exit: Promise.resolve({ exitCode: 0, stderr: '', stopped: null, ...plan.exit }),
      stop: () => stopped.push(true),
    };
    return run;
  };
  const registry = createCliRegistry();
  const host = new LlmHost({
    registry,
    executor: new CliExecutor({
      timeoutMs: 1000,
      run: async (invocation) => ({
        stdout: invocation.command === 'gemini' ? '' : `${invocation.command} 9.9.9\n`,
        stderr: '',
        exitCode: invocation.command === 'gemini' ? 1 : 0,
      }),
    }),
    sandbox,
    credentials,
    stream,
    timeoutMs: extra.timeoutMs ?? 60_000,
    ownSecrets: () => ['bridge-shared-token-secret'],
  });
  return { host, credentials, sandbox, started, stopped, root };
}

const base: LlmInput = {
  workspaceId: 'ws-1',
  cli: 'claude',
  prompt: 'Qual é a capital da França?',
  credential: OAUTH_TOKEN,
};

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const all: LlmEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const text = (events: LlmEvent[]) =>
  events
    .filter((event): event is Extract<LlmEvent, { type: 'delta' }> => event.type === 'delta')
    .map((event) => event.text)
    .join('');

describe('LlmHost', () => {
  it('streams the answer with its usage', async () => {
    const { host } = setup(() => ({
      lines: [
        claudeLine({
          type: 'stream_event',
          event: { type: 'message_start', message: { model: 'claude-sonnet-5-5' } },
        }),
        delta('Paris'),
        delta(' é a capital.'),
        result('Paris é a capital.'),
      ],
    }));
    const events = await collect(host.stream(base));
    expect(text(events)).toBe('Paris é a capital.');
    expect(events.find((event) => event.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 3,
      outputTokens: 4,
      model: 'claude-sonnet-5-5',
    });
  });

  it('runs the CLI in an empty directory of its own, as the workspace, and removes it after', async () => {
    const { host, started, sandbox, root } = setup(() => ({ lines: [delta('ok'), result('ok')] }));
    await collect(host.stream({ ...base, instruction: 'Responda em uma palavra.', model: 'm-1' }));

    const [run] = started;
    const runtime = sandbox.resolve('llm:ws-1', 'claude');
    expect(run!.options.cwd.startsWith(runtime.cwd)).toBe(true);
    expect(run!.options.env['HOME']).toBe(runtime.home);
    // The prompt travels on stdin, never on the command line.
    expect(run!.invocation.stdin).toBe(base.prompt);
    expect(run!.invocation.args.join(' ')).not.toContain('capital');
    expect(run!.invocation.args).toEqual(expect.arrayContaining(['--tools', '--model', 'm-1']));
    // The system prompt carries the bridge's rules ahead of the agent's own.
    const system = run!.files['system.txt']!;
    expect(system.startsWith(SECURITY_POLICY)).toBe(true);
    expect(system.endsWith('Responda em uma palavra.')).toBe(true);
    expect(run!.invocation.env).toEqual({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
    // Nothing of the bridge's own configuration reaches the CLI.
    expect(JSON.stringify(run!.options.env)).not.toContain('bridge-shared-token-secret');
    expect(existsSync(run!.options.cwd)).toBe(false);
    expect(root).toBeTruthy();
  });

  it('gives each workspace its own identity, home and login', async () => {
    const { host, started, credentials } = setup(() => ({ lines: [delta('x'), result('x')] }));
    await collect(host.stream(base));
    await collect(
      host.stream({ ...base, workspaceId: 'ws-2', credential: 'sk-ant-oat-other-0123456789' }),
    );
    expect(started[0]!.options.env['HOME']).not.toBe(started[1]!.options.env['HOME']);
    expect(credentials.get('llm:ws-1', 'claude')!.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    });
    expect(credentials.get('llm:ws-2', 'claude')!.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-other-0123456789',
    });
    // Telegram users live in a different namespace and are not touched.
    expect(credentials.has('member:ws-1', 'claude')).toBe(false);
  });

  describe('the workspace token', () => {
    it('is stored once and reused when the same token is sent again', async () => {
      const { host, credentials } = setup(() => ({ lines: [delta('x'), result('x')] }));
      await collect(host.stream(base));
      const stored = credentials.get('llm:ws-1', 'claude');
      await collect(host.stream(base));
      expect(credentials.get('llm:ws-1', 'claude')).toBe(stored);
      // After it was given once, requests may omit it.
      await collect(host.stream({ ...base, credential: undefined }));
    });

    it('replaces the old token when a new one arrives', async () => {
      const { host, credentials } = setup(() => ({ lines: [delta('x'), result('x')] }));
      await collect(host.stream(base));
      await collect(host.stream({ ...base, credential: 'sk-ant-api-new-token-0123456789' }));
      expect(credentials.get('llm:ws-1', 'claude')!.env).toEqual({
        ANTHROPIC_API_KEY: 'sk-ant-api-new-token-0123456789',
      });
    });

    it('rewrites a login file when it changes, and leaves it alone otherwise', async () => {
      const { host, sandbox } = setup(() => ({
        lines: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
        ],
      }));
      const input = { ...base, cli: 'codex' };
      const file = (home: string) => join(home, '.codex', 'auth.json');
      await collect(host.stream({ ...input, credential: '{"tokens":{"refresh":"one"}}' }));
      const { home } = sandbox.resolve('llm:ws-1', 'codex');
      expect(readFileSync(file(home), 'utf8')).toContain('one');

      // The CLI refreshed its tokens in the file: sending the same token must not undo that.
      await collect(host.stream({ ...input, credential: '{"tokens":{"refresh":"one"}}' }));
      expect(readFileSync(file(home), 'utf8')).toContain('one');

      await collect(host.stream({ ...input, credential: '{"tokens":{"refresh":"two"}}' }));
      expect(readFileSync(file(home), 'utf8')).toContain('two');
    });

    it('refuses a token the CLI does not accept, and asks for one when there is none', async () => {
      const { host } = setup(() => ({}));
      await expect(
        collect(host.stream({ ...base, credential: 'not-a-token' })),
      ).rejects.toMatchObject({
        code: 'NOT_AUTHENTICATED',
        message: expect.stringContaining('claude setup-token'),
      });
      await expect(collect(host.stream({ ...base, credential: undefined }))).rejects.toMatchObject({
        code: 'NOT_AUTHENTICATED',
        message: expect.stringContaining('no Claude token'),
      });
      await expect(collect(host.stream({ ...base, credential: '   ' }))).rejects.toMatchObject({
        code: 'NOT_AUTHENTICATED',
      });
    });
  });

  describe('the ADK tools (MCP)', () => {
    const mcp = {
      name: 'adk-tools',
      url: 'http://mcp:3333/mcp?workspace=ws-1',
      token: 'adk_pat_mcp-token-0123456789',
    };

    it('gives Claude the server in a private file of the run, never on the command line', async () => {
      const { host, started } = setup(() => ({ lines: [delta('ok'), result('ok')] }));
      await collect(host.stream({ ...base, mcp }));
      const [run] = started;
      expect(run!.invocation.args).toEqual(
        expect.arrayContaining(['--mcp-config', 'mcp.json', '--allowedTools', 'mcp__adk-tools']),
      );
      expect(run!.invocation.args.join(' ')).not.toContain(mcp.token);
      expect(JSON.parse(run!.files['mcp.json']!).mcpServers['adk-tools']).toMatchObject({
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.token}` },
      });
      expect(run!.invocation.env).toEqual({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
    });

    it('gives Codex the token as an environment variable of that run only', async () => {
      const { host, started } = setup(() => ({
        lines: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
        ],
      }));
      await collect(
        host.stream({ ...base, cli: 'codex', credential: '{"tokens":{"a":"b"}}', mcp }),
      );
      const [run] = started;
      expect(run!.invocation.env).toEqual({ ADK_MCP_TOKEN: mcp.token });
      expect(run!.invocation.args.join(' ')).not.toContain(mcp.token);
      expect(JSON.stringify(run!.options.env)).not.toContain(mcp.token);
    });

    it('writes the settings Gemini reads into the HOME of this workspace, and clears them after', async () => {
      const { host, sandbox } = setup(() => ({ lines: ['texto'] }));
      const settings = () => {
        const { home } = sandbox.resolve('llm:ws-1', 'gemini');
        return JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
      };
      const input = { ...base, cli: 'gemini', credential: 'AIzaSyExampleGeminiKey0123456789' };
      await collect(host.stream({ ...input, mcp }));
      expect(settings().mcpServers['adk-tools']).toMatchObject({ httpUrl: mcp.url });

      // A run without tools must not find the last run's server left in the HOME.
      await collect(host.stream(input));
      expect(settings().mcpServers).toEqual({});
    });

    it('masks the token if the CLI repeats it, in the answer and in an error', async () => {
      const { host } = setup(() => ({
        lines: [delta(`the token is ${mcp.token}!`), result('x')],
      }));
      const answer = text(await collect(host.stream({ ...base, mcp })));
      expect(answer).not.toContain(mcp.token);
      expect(answer).toContain('[redacted]');

      const failing = setup(() => ({ exit: { exitCode: 1, stderr: `denied ${mcp.token}` } }));
      const error = await collect(failing.host.stream({ ...base, mcp })).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(mcp.token);
    });

    it('refuses a server that could break out of a config or a command line', async () => {
      const { host, started } = setup(() => ({}));
      for (const bad of [
        { ...mcp, name: 'x"; calc' },
        { ...mcp, url: 'file:///etc/passwd' },
        { ...mcp, token: '' },
      ]) {
        await expect(collect(host.stream({ ...base, mcp: bad }))).rejects.toMatchObject({
          code: 'UNSUPPORTED',
        });
      }
      expect(started).toHaveLength(0);
    });
  });

  describe('images and files', () => {
    const image = { mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') };
    const pdf = { name: 'a.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' };

    it('hands Claude the image on stdin as a content block, never on the command line', async () => {
      const { host, started } = setup(() => ({ lines: [delta('ok'), result('ok')] }));
      await collect(host.stream({ ...base, images: [image], files: [pdf] }));
      const [run] = started;
      expect(run!.invocation.args).toEqual(
        expect.arrayContaining(['--input-format', 'stream-json']),
      );
      expect(run!.invocation.args.join(' ')).not.toContain(image.data);
      const content = (
        JSON.parse(run!.invocation.stdin ?? '') as { message: { content: Array<{ type: string }> } }
      ).message.content;
      expect(content.map((block) => block.type)).toEqual(['image', 'document', 'text']);
    });

    it('writes the image Codex is given into the run directory, byte for byte', async () => {
      const { host, started } = setup(() => ({
        lines: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
        ],
      }));
      await collect(
        host.stream({ ...base, cli: 'codex', credential: '{"tokens":{"a":"b"}}', images: [image] }),
      );
      const [run] = started;
      expect(run!.invocation.args).toContain('--image=image-1.png');
      expect(run!.files['image-1.png']).toBe('png-bytes');
    });

    it('refuses an image the CLI cannot read before running it', async () => {
      const { host, started } = setup(() => ({}));
      await expect(
        collect(
          host.stream({
            ...base,
            cli: 'codex',
            credential: '{"tokens":{"a":"b"}}',
            images: [{ mimeType: 'image/bmp', data: 'AAEC' }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      expect(started).toHaveLength(0);
    });

    it('runs the CLI without a file it cannot read, and says so in the prompt', async () => {
      const { host, started } = setup(() => ({
        lines: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
        ],
      }));
      await collect(
        host.stream({ ...base, cli: 'codex', credential: '{"tokens":{"a":"b"}}', files: [pdf] }),
      );
      expect(started[0]!.invocation.stdin).toContain('left out: "a.pdf" (application/pdf)');
    });
  });

  describe('rejects what it should not run', () => {
    const cases: Array<[string, Partial<LlmInput>]> = [
      ['an unknown CLI', { cli: 'bash' }],
      ['a CLI with no spec', { cli: 'unknown' }],
      ['a bad workspace id', { workspaceId: '../etc' }],
      ['an empty workspace id', { workspaceId: '' }],
      ['a model that could break out', { model: 'x; rm -rf /' }],
    ];
    it.each(cases)('%s', async (_name, patch) => {
      const { host, started } = setup(() => ({}));
      await expect(collect(host.stream({ ...base, ...patch }))).rejects.toMatchObject({
        code: 'UNSUPPORTED',
      });
      expect(started).toHaveLength(0);
    });
  });

  describe('secrets', () => {
    it('masks a token even when the CLI writes it in pieces', async () => {
      const { host } = setup(() => ({
        lines: [
          delta('Your token is '),
          delta(OAUTH_TOKEN.slice(0, 15)),
          delta(OAUTH_TOKEN.slice(15)),
          delta(' ok. And the bridge key bridge-shared-token-secret.'),
          result('x'),
        ],
      }));
      const answer = text(await collect(host.stream(base)));
      expect(answer).not.toContain(OAUTH_TOKEN);
      expect(answer).not.toContain('sk-ant-oat');
      expect(answer).not.toContain('bridge-shared-token-secret');
      expect(answer).toContain('[redacted]');
      expect(answer.startsWith('Your token is ')).toBe(true);
    });

    it('streams a long answer without holding all of it back', async () => {
      const long = 'palavra '.repeat(200);
      const { host } = setup(() => ({
        lines: [delta(long.slice(0, 800)), delta(long.slice(800)), result(long)],
      }));
      const events = await collect(host.stream(base));
      expect(text(events)).toBe(long);
      expect(events.filter((event) => event.type === 'delta').length).toBeGreaterThan(1);
    });

    it('masks secrets in an error message too', async () => {
      const { host } = setup(() => ({
        exit: { exitCode: 1, stderr: `boom ${OAUTH_TOKEN} boom` },
      }));
      const error = await collect(host.stream(base)).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(OAUTH_TOKEN);
    });
  });

  describe('failures', () => {
    const fails = (plan: ReturnType<Parameters<typeof setup>[0]>) => {
      const { host } = setup(() => plan);
      return collect(host.stream(base)).catch((error: unknown) => error as LlmError);
    };

    it('says the CLI is not installed', async () => {
      const error = await fails({
        fail: new (await import('../src/core/types.js')).CliError(
          '"claude" is not installed in this container.',
        ),
      });
      expect(error).toMatchObject({ code: 'NOT_INSTALLED' });
    });

    it('lets any other start failure through as it is', async () => {
      const error = await fails({ fail: new Error('EPERM') });
      expect((error as Error).message).toBe('EPERM');
    });

    it('maps a login failure, a timeout and a plain failure', async () => {
      expect(
        await fails({ exit: { exitCode: 1, stderr: 'Invalid API key · Please run /login' } }),
      ).toMatchObject({ code: 'NOT_AUTHENTICATED' });
      expect(await fails({ exit: { exitCode: 1, stopped: 'timeout' } })).toMatchObject({
        code: 'TIMEOUT',
      });
      expect(await fails({ exit: { exitCode: 2, stderr: 'segfault' } })).toMatchObject({
        code: 'FAILED',
        message: 'segfault',
      });
      expect(await fails({ exit: { exitCode: 1 } })).toMatchObject({
        code: 'FAILED',
        message: 'Claude CLI failed.',
      });
      expect(
        await fails({
          lines: [claudeLine({ type: 'result', is_error: true, result: 'quota exceeded' })],
        }),
      ).toMatchObject({ code: 'FAILED', message: 'quota exceeded' });
    });

    it('reports a cancelled run as an abort', async () => {
      const error = await fails({ exit: { exitCode: 1, stopped: 'cancelled' } });
      expect(error).toMatchObject({ name: 'AbortError' });
    });

    it('answers from the final result when the CLI never streamed', async () => {
      const { host } = setup(() => ({ lines: [result('Pronto')] }));
      expect(text(await collect(host.stream(base)))).toBe('Pronto');
    });

    it('stops the process and frees the slot when the caller stops reading', async () => {
      const { host, stopped } = setup(() => ({
        lines: [delta('a'.repeat(600)), delta('b'.repeat(600)), result('x')],
      }));
      const events = host.stream(base);
      await events.next();
      await events.return(undefined);
      expect(stopped).toEqual([true]);
    });

    it('does not start when the request was already cancelled', async () => {
      const { host, started } = setup(() => ({}));
      const controller = new AbortController();
      controller.abort();
      await expect(collect(host.stream(base, controller.signal))).rejects.toThrow();
      expect(started).toHaveLength(0);
    });
  });

  it('keeps at most four CLI processes running and lets a queued request be cancelled', async () => {
    const releases: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const { host, started } = setup(() => ({}));
    // Replace the runner with one that waits to be released.
    (host as unknown as { options: { stream: ProcessStreamer } }).options = {
      ...(host as unknown as { options: object }).options,
      stream: () => {
        running += 1;
        peak = Math.max(peak, running);
        let release!: () => void;
        const finished = new Promise<void>((resolve) => (release = resolve));
        releases.push(() => {
          running -= 1;
          release();
        });
        return {
          output: (async function* () {
            await finished;
            yield delta('ok');
            yield result('ok');
          })(),
          exit: finished.then(() => ({ exitCode: 0, stderr: '', stopped: null })),
          stop: () => undefined,
        };
      },
    } as never;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

    const first = Array.from({ length: 4 }, () => collect(host.stream(base)));
    const queued = collect(host.stream(base, new AbortController().signal));
    const cancel = new AbortController();
    const cancelled = collect(host.stream(base, cancel.signal));
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(releases).toHaveLength(4);

    cancel.abort();
    await cancelledResult;
    releases[0]!();
    await settle();
    expect(releases).toHaveLength(5); // the queued one took the free slot; the cancelled one never ran
    for (const release of releases) release();
    await Promise.all([...first, queued]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(started).toHaveLength(0); // the default runner was swapped out
  });

  describe('clis()', () => {
    it('reports each CLI that can answer, whether it is installed and whether the workspace has a token', async () => {
      const { host } = setup(() => ({ lines: [delta('x'), result('x')] }));
      await collect(host.stream(base));
      const statuses = await host.clis('ws-1');
      expect(statuses.map((status) => status.id)).toEqual(['claude', 'codex', 'gemini']);
      expect(statuses.find((status) => status.id === 'claude')).toMatchObject({
        installed: true,
        version: 'claude 9.9.9',
        signedIn: true,
        label: 'Claude',
        command: 'claude',
      });
      expect(statuses.find((status) => status.id === 'claude')!.hint).toContain('setup-token');
      expect(statuses.find((status) => status.id === 'codex')).toMatchObject({
        installed: true,
        signedIn: false,
      });
      expect(statuses.find((status) => status.id === 'gemini')).toMatchObject({ installed: false });
      expect(statuses.find((status) => status.id === 'gemini')).not.toHaveProperty('version');
    });

    it('skips a CLI that is not registered and rejects a bad workspace id', async () => {
      const root = mkdtempSync(join(tmpdir(), 'llm-host-'));
      const credentials = new CredentialStore(null, 'k');
      const registry = createCliRegistry();
      const empty = new (registry.constructor as new () => typeof registry)();
      empty.register(registry.get('claude')!);
      const host = new LlmHost({
        registry: empty,
        executor: new CliExecutor({
          timeoutMs: 1000,
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        }),
        sandbox: new Sandbox({
          homesDir: join(root, 'h'),
          workspacesDir: join(root, 'w'),
          usersFile: null,
          credentials,
          switchUser: false,
        }),
        credentials,
        stream: () => {
          throw new Error('not used');
        },
        timeoutMs: 1000,
        ownSecrets: () => [],
      });
      const statuses = await host.clis('ws-1');
      expect(statuses.map((status) => status.id)).toEqual(['claude']);
      // A version command that prints nothing still counts as installed.
      expect(statuses[0]).toMatchObject({ installed: true, version: 'installed' });
      await expect(host.clis('../x')).rejects.toBeInstanceOf(LlmError);
    });
  });
});
