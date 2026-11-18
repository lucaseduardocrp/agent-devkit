import { readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CliLlmError,
  CliLlmProvider,
  isValidConfigDir,
  summarizeAccount,
} from '../src/modules/agents/adapters/cli-llm/cli-llm.js';
import {
  assertSafeArgument,
  cliEnvironment,
  startCli,
  type CliExit,
  type CliRun,
  type CliRunOptions,
} from '../src/modules/agents/adapters/cli-llm/cli-process.js';
import {
  attachmentProblem,
  CLI_SPECS,
  cliForProvider,
} from '../src/modules/agents/adapters/cli-llm/cli-specs.js';

/** A fake CLI run: the lines are written one by one, the way a real process would. */
function fakeRun(
  lines: string[],
  exit: Partial<CliExit> = {},
  onStart?: (o: CliRunOptions) => void,
) {
  return (options: CliRunOptions): CliRun => {
    onStart?.(options);
    async function* output(): AsyncGenerator<string> {
      for (const line of lines) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield line;
      }
    }
    return {
      output: output(),
      exit: Promise.resolve({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        aborted: false,
        ...exit,
      }),
      stop: () => undefined,
    };
  };
}

const claudeStream = [
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'message_start', message: { model: 'claude-sonnet-5-5' } },
  }),
  ...['Olá', ', ', 'mundo'].map((text) =>
    JSON.stringify({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    }),
  ),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Olá, mundo',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 3,
      output_tokens: 7,
    },
  }),
];

describe('CLI specs', () => {
  it('maps API providers to the CLI that replaces them', () => {
    expect(cliForProvider('claude')).toBe('claude');
    expect(cliForProvider('Anthropic')).toBe('claude');
    expect(cliForProvider('openai')).toBe('codex');
    expect(cliForProvider('gemini')).toBe('gemini');
    expect(cliForProvider('groq')).toBeNull();
  });

  it('runs Claude without tools, MCP servers or user settings, and keeps the prompt off argv', () => {
    const invocation = CLI_SPECS.claude.build(
      { prompt: 'secret prompt "; rm -rf /', instruction: 'Be brief.\nAlways.' },
      'claude-haiku-5-5',
    );
    expect(invocation.args).toEqual(
      expect.arrayContaining(['--tools', '', '--strict-mcp-config', '--setting-sources', '']),
    );
    expect(invocation.args).toContain('--include-partial-messages');
    expect(invocation.args.join(' ')).not.toContain('secret prompt');
    expect(invocation.stdin).toBe('secret prompt "; rm -rf /');
    expect(invocation.files['system.txt']).toBe('Be brief.\nAlways.');
    for (const argument of invocation.args)
      expect(() => assertSafeArgument(argument)).not.toThrow();
  });

  it('puts the instruction before the prompt for CLIs without a system prompt option', () => {
    const invocation = CLI_SPECS.codex.build(
      { prompt: 'Question', instruction: 'Rules' },
      undefined,
    );
    expect(invocation.stdin).toBe('Rules\n\n---\n\nQuestion');
    expect(invocation.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
  });

  describe('images and files', () => {
    const png = { mimeType: 'image/png', data: 'AAEC' };
    const pdf = { name: 'spec.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' };
    const notes = {
      name: 'notes "a".md',
      mimeType: 'text/markdown',
      data: Buffer.from('# Title\n```js\nx\n```').toString('base64'),
    };

    it('gives Claude one stream-json message with the image, the PDF and the text file', () => {
      const invocation = CLI_SPECS.claude.build(
        { prompt: 'Describe', images: [png], files: [pdf, notes] },
        undefined,
      );
      expect(invocation.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
      expect(invocation.stdin.endsWith('\n')).toBe(true);
      const message = JSON.parse(invocation.stdin) as {
        type: string;
        message: { role: string; content: Array<Record<string, unknown>> };
      };
      expect(message.type).toBe('user');
      const [image, document, prompt] = message.message.content;
      expect(image).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAEC' },
      });
      expect(document).toMatchObject({
        type: 'document',
        title: 'spec.pdf',
        source: { media_type: 'application/pdf', data: 'JVBERi0=' },
      });
      const text = String(prompt?.['text']);
      expect(text).toContain('Describe');
      // The fence is longer than the one inside the file, and the name has no quote in it.
      expect(text).toContain('Attached file "notes  a .md":\n````\n# Title\n```js');
      for (const argument of invocation.args)
        expect(() => assertSafeArgument(argument)).not.toThrow();
    });

    it('keeps the plain text input for Claude when nothing needs a content block', () => {
      const invocation = CLI_SPECS.claude.build({ prompt: 'Read', files: [notes] }, undefined);
      expect(invocation.args).not.toContain('--input-format');
      expect(invocation.stdin).toContain('Attached file');
      expect(invocation.stdin.startsWith('Read')).toBe(true);
    });

    it('passes Codex its images as files, ahead of another flag', () => {
      const invocation = CLI_SPECS.codex.build(
        { prompt: 'Look', images: [png, { mimeType: 'image/jpeg', data: 'AAEC' }] },
        'gpt-x',
      );
      const flag = invocation.args.indexOf('--image=image-1.png,image-2.jpg');
      expect(flag).toBeGreaterThan(0);
      expect(invocation.args[flag + 1]).toMatch(/^--/);
      expect(invocation.args.at(-1)).toBe('-');
      expect(invocation.files['image-1.png']).toEqual({ base64: 'AAEC' });
      expect(invocation.files['image-2.jpg']).toEqual({ base64: 'AAEC' });
      for (const argument of invocation.args)
        expect(() => assertSafeArgument(argument)).not.toThrow();
    });

    it('points Gemini at its images and PDFs with @file', () => {
      const invocation = CLI_SPECS.gemini.build(
        { prompt: 'Look', images: [png], files: [pdf] },
        undefined,
      );
      expect(invocation.stdin.startsWith('@image-1.png @file-1.pdf\n\nLook')).toBe(true);
      expect(Object.keys(invocation.files).sort()).toEqual(['file-1.pdf', 'image-1.png']);
    });

    it('names a file the CLI cannot read in the prompt, instead of failing or ignoring it', () => {
      const docx = { name: 'plan "Q3".docx', mimeType: 'application/zip', data: 'AA==' };
      const codex = CLI_SPECS.codex.build({ prompt: 'Read', files: [pdf, docx] }, undefined);
      expect(codex.stdin).toContain(
        'Attached files that could not be read and are left out: "spec.pdf" (application/pdf), "plan  Q3 .docx" (application/zip).',
      );
      // Claude takes the PDF, so only the Word file is named.
      const claude = CLI_SPECS.claude.build({ prompt: 'Read', files: [pdf, docx] }, undefined);
      const content = (
        JSON.parse(claude.stdin) as { message: { content: Array<{ text?: string }> } }
      ).message.content;
      expect(content.at(-1)?.text).toContain('left out: "plan  Q3 .docx"');
      expect(content.at(-1)?.text).not.toContain('spec.pdf');
    });

    it('says which CLI cannot read which file', () => {
      expect(CLI_SPECS.codex.fileSupport('application/pdf')).toBeNull();
      expect(CLI_SPECS.claude.fileSupport('application/pdf')).toBe('native');
      expect(CLI_SPECS.claude.fileSupport('text/csv')).toBe('text');
      // A file is never a reason to refuse: the ones a CLI cannot read are left out, and said so.
      expect(attachmentProblem(CLI_SPECS.codex, { prompt: 'x', files: [pdf] })).toBeUndefined();
      expect(
        attachmentProblem(CLI_SPECS.claude, {
          prompt: 'x',
          files: [{ name: 'a.docx', mimeType: 'application/zip', data: 'AA==' }],
        }),
      ).toBeUndefined();
      expect(
        attachmentProblem(CLI_SPECS.claude, {
          prompt: 'x',
          images: [{ mimeType: 'image/bmp', data: '' }],
        }),
      ).toContain('image/bmp');
      expect(
        attachmentProblem(CLI_SPECS.claude, { prompt: 'x', images: [png], files: [pdf] }),
      ).toBe(undefined);
    });
  });

  it('parses Codex messages and errors', () => {
    const parse = CLI_SPECS.codex.createParser();
    expect(
      parse(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'A' } })),
    ).toEqual([{ type: 'delta', text: 'A' }]);
    expect(
      parse(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'B' } })),
    ).toEqual([{ type: 'delta', text: '\n\nB' }]);
    expect(parse(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }))).toEqual([
      { type: 'error', message: 'boom' },
    ]);
    expect(parse('not json')).toEqual([]);
  });
});

describe('CliLlmProvider', () => {
  it('streams text deltas as they arrive and reports usage on complete()', async () => {
    const provider = new CliLlmProvider({ cli: 'claude', start: fakeRun(claudeStream) });
    const chunks: string[] = [];
    for await (const chunk of provider.stream({ prompt: 'oi' })) chunks.push(chunk);
    expect(chunks).toEqual(['Olá', ', ', 'mundo']);

    const response = await provider.complete({ prompt: 'oi' });
    expect(response).toEqual({
      provider: 'Claude CLI',
      text: 'Olá, mundo',
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 15, outputTokens: 7 },
    });
  });

  it('falls back to the final result when the CLI sent no deltas', async () => {
    const result = JSON.stringify({ type: 'result', subtype: 'success', result: 'Pronto' });
    const provider = new CliLlmProvider({ cli: 'claude', start: fakeRun([result]) });
    expect((await provider.complete({ prompt: 'x' })).text).toBe('Pronto');
  });

  it('starts the process in an empty directory with a scrubbed environment', async () => {
    let seen: CliRunOptions | undefined;
    const provider = new CliLlmProvider({
      cli: 'claude',
      start: fakeRun(claudeStream, {}, (options) => (seen = options)),
    });
    process.env['ADK_TEST_SECRET'] = 'must-not-leak';
    try {
      await provider.complete({ prompt: 'oi', instruction: 'sys' });
    } finally {
      delete process.env['ADK_TEST_SECRET'];
    }
    expect(seen?.env).not.toHaveProperty('ADK_TEST_SECRET');
    expect(seen?.cwd).toContain('adk-cli-');
    expect(seen?.lines).toBe(true);
  });

  it.each([
    ['Invalid API key · Please run /login', 'NOT_AUTHENTICATED'],
    ['segmentation fault', 'FAILED'],
    ['Credit balance is too low', 'QUOTA_EXCEEDED'],
    ['You have hit your usage limit', 'QUOTA_EXCEEDED'],
  ])('maps a failing exit ("%s") to %s', async (stderr, code) => {
    const provider = new CliLlmProvider({
      cli: 'claude',
      start: fakeRun([], { exitCode: 1, stderr }),
    });
    await expect(provider.complete({ prompt: 'x' })).rejects.toMatchObject({ code });
  });

  it('runs Claude and Codex with the login folder of the integration, and nothing else', async () => {
    const dir = 'C:\\Users\\me\\.claude-account2';
    for (const [cli, variable] of [
      ['claude', 'CLAUDE_CONFIG_DIR'],
      ['codex', 'CODEX_HOME'],
    ] as const) {
      let seen: CliRunOptions | undefined;
      const provider = new CliLlmProvider({
        cli,
        configDir: dir,
        start: fakeRun(claudeStream, {}, (options) => (seen = options)),
      });
      // Codex's output is not Claude's, so the run may fail to parse; the environment is what counts.
      await provider.complete({ prompt: 'oi' }).catch(() => undefined);
      expect(seen?.env[variable]).toBe(dir);
    }

    let gemini: CliRunOptions | undefined;
    await new CliLlmProvider({
      cli: 'gemini',
      configDir: dir,
      start: fakeRun([], {}, (options) => (gemini = options)),
    })
      .complete({ prompt: 'oi' })
      .catch(() => undefined);
    expect(gemini?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(gemini?.env).not.toHaveProperty('CODEX_HOME');
  });

  it.each(['relative/dir', '~/x', 'C:\\a"; calc', '/ok/../etc', 'C:\\a\nb'])(
    'rejects a login folder that is not a plain absolute path (%j)',
    (configDir) => {
      expect(() => new CliLlmProvider({ cli: 'claude', configDir })).toThrow(CliLlmError);
    },
  );

  it('accepts absolute Windows and POSIX folders, and summarizes the account', () => {
    expect(isValidConfigDir('C:\\Users\\me\\.claude-2')).toBe(true);
    expect(isValidConfigDir('/home/me/.codex-2')).toBe(true);
    expect(summarizeAccount('{"email":"a@b.com","subscriptionType":"max"}')).toBe('a@b.com · max');
    expect(summarizeAccount('Logged in using ChatGPT\nmore')).toBe('Logged in using ChatGPT');
    expect(summarizeAccount('  ')).toBeNull();
  });

  it('reports a missing CLI, a timeout and unsupported input', async () => {
    const missing = new CliLlmProvider({
      cli: 'codex',
      start: fakeRun([], {
        exitCode: 1,
        stderr: "'codex' is not recognized as an internal command",
      }),
    });
    await expect(missing.complete({ prompt: 'x' })).rejects.toMatchObject({
      code: 'NOT_INSTALLED',
    });

    const slow = new CliLlmProvider({
      cli: 'claude',
      start: fakeRun([], { exitCode: 1, timedOut: true }),
    });
    await expect(slow.complete({ prompt: 'x' })).rejects.toMatchObject({ code: 'TIMEOUT' });

    const bmp = new CliLlmProvider({ cli: 'claude', start: fakeRun(claudeStream) });
    await expect(
      bmp.complete({ prompt: 'x', images: [{ mimeType: 'image/bmp' as never, data: 'AA==' }] }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('image/bmp') });
  });

  it('hands images and files to the CLI, and writes the binary ones to its directory', async () => {
    let seen: CliRunOptions | undefined;
    let written: string[] = [];
    const provider = new CliLlmProvider({
      cli: 'codex',
      start: fakeRun([], {}, (options) => {
        seen = options;
        written = readdirSync(options.cwd);
      }),
    });
    // The fake CLI answers nothing, so the run fails; what it was started with is what counts.
    await provider
      .complete({ prompt: 'x', images: [{ mimeType: 'image/png', data: 'AA==' }] })
      .catch(() => undefined);
    expect(seen?.args).toContain('--image=image-1.png');
    expect(written).toContain('image-1.png');
  });

  it('refuses a model id that could break out of the command line', () => {
    expect(() => new CliLlmProvider({ cli: 'claude', model: 'x" & calc & "' })).toThrow(
      CliLlmError,
    );
    expect(() => new CliLlmProvider({ cli: 'claude', model: 'claude-sonnet-5-5' })).not.toThrow();
  });

  it('raises AbortError when the request is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new CliLlmProvider({ cli: 'claude', start: fakeRun(claudeStream) });
    await expect(provider.complete({ prompt: 'x' }, controller.signal)).rejects.toThrow();
  });
});

describe('cliEnvironment', () => {
  it('keeps what a CLI needs to find its login and drops ADK secrets and API keys', () => {
    const env = cliEnvironment(
      { EXTRA: '1' },
      {
        PATH: '/bin',
        HOME: '/home/u',
        DATABASE_URL: 'postgres://secret',
        INTEGRATION_ENCRYPTION_KEY: 'k',
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENAI_API_KEY: 'sk',
      },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', EXTRA: '1' });
  });

  it('rejects arguments with shell metacharacters', () => {
    for (const bad of [
      'a b',
      'a;b',
      'a"b',
      '$(x)',
      'a\nb',
      'a|b',
      'a%PATH%',
      "a'b",
      'a`b',
      'a<b',
      'a>b',
    ])
      expect(() => assertSafeArgument(bad)).toThrow();
    expect(() => assertSafeArgument('')).not.toThrow();
    // "&" separates the parameters of a URL. It is harmless where it is used: every argument is
    // put between double quotes for the Windows shell (so it is literal there), a double quote
    // cannot be part of an argument (so nothing gets out of them), and elsewhere there is no shell.
    expect(() => assertSafeArgument('http://mcp/mcp?workspace=a&profile=standard')).not.toThrow();
  });
});

describe('startCli (real process)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function script(source: string): Promise<{ file: string; dir: string }> {
    dir = await mkdtemp(join(tmpdir(), 'adk-cli-test-'));
    const file = join(dir, 'fake.mjs');
    await writeFile(file, source, 'utf8');
    return { file, dir };
  }

  it('hands over stdout while the process is still running', async () => {
    const { file, dir: cwd } = await script(`
      let input = '';
      process.stdin.on('data', (c) => (input += c)).on('end', async () => {
        process.stdout.write('first:' + input.trim() + '\\n');
        await new Promise((r) => setTimeout(r, 400));
        process.stdout.write('second\\n');
        process.stdout.write('leak:' + (process.env.DATABASE_URL ?? 'none') + '\\n');
      });
    `);
    process.env['DATABASE_URL'] = 'postgres://secret';
    const startedAt = Date.now();
    let firstAt = 0;
    const lines: string[] = [];
    try {
      const run = startCli({
        command: process.execPath.replace(/\\/g, '/'),
        args: [file.replace(/\\/g, '/')],
        stdin: 'hello',
        cwd,
        env: cliEnvironment(),
        timeoutMs: 10_000,
        lines: true,
      });
      for await (const line of run.output) {
        if (!firstAt) firstAt = Date.now() - startedAt;
        lines.push(line);
      }
      const exit = await run.exit;
      expect(exit.exitCode).toBe(0);
    } finally {
      delete process.env['DATABASE_URL'];
    }
    expect(lines).toEqual(['first:hello', 'second', 'leak:none']);
    // The first line arrived well before the process ended (~400 ms later).
    expect(firstAt).toBeLessThan(350);
  });

  it('kills the process when the signal aborts', async () => {
    const { file, dir: cwd } = await script(
      `setInterval(() => {}, 1000); process.stdout.write('up\\n');`,
    );
    const controller = new AbortController();
    const run = startCli({
      command: process.execPath.replace(/\\/g, '/'),
      args: [file.replace(/\\/g, '/')],
      stdin: '',
      cwd,
      env: cliEnvironment(),
      signal: controller.signal,
      timeoutMs: 30_000,
      lines: true,
    });
    for await (const line of run.output) {
      expect(line).toBe('up');
      controller.abort();
    }
    expect(await run.exit).toMatchObject({ aborted: true });
  });

  it('reports a command that does not exist', async () => {
    const run = startCli({
      command: 'adk-definitely-not-a-cli',
      args: [],
      stdin: '',
      cwd: tmpdir(),
      env: cliEnvironment(),
      timeoutMs: 5_000,
      lines: true,
    });
    const read = async () => {
      for await (const chunk of run.output) void chunk;
    };
    // POSIX: spawn fails and the output throws. Windows: cmd reports it and exits non-zero.
    await read().catch(() => undefined);
    expect((await run.exit).exitCode).not.toBe(0);
  });
});
