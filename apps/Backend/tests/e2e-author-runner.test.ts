import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  AgentE2eAuthor,
  MAX_E2E_TESTS,
  parseJsonObject,
} from '../src/modules/e2e/application/e2e-author.js';
import { EMPTY_AGENT_WORKFLOW } from '../src/modules/agents/domain/agent-workflow.js';
import request from 'supertest';
import express from 'express';
import { createE2eRouter } from '../src/adapters/http/e2e-routes.js';
import { errorMiddleware } from '../src/adapters/http/app.js';
import type { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import {
  PlaywrightE2eRunner,
  childEnvironment,
  defaultBrowsersPath,
  runProcess,
  runnerConfig,
  summarizeReport,
  type PlaywrightModule,
  type ProcessExecutor,
} from '../src/modules/e2e/adapters/playwright-runner.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import type { E2eCreation, E2eTestCase } from '../src/modules/e2e/domain/e2e.js';

const creation: E2eCreation = {
  id: 'c',
  workspaceId: 'ws',
  ownerId: 'owner',
  actorId: 'u',
  agentId: 'agent',
  name: 'ama',
  mode: 'frontend',
  scope: 'codebase',
  baseUrl: 'http://localhost:3000',
  executionTarget: 'remote',
  path: '/e/123',
  username: 'qa@example.com',
  passwordSecret: 'cipher',
  prd: 'Users ask questions.',
  prdFileNames: [],
  diff: null,
  instructions: null,
  locale: 'pt-BR',
  repository: null,
  reporting: null,
  lastReport: null,
  prdSummary: null,
  status: 'planning',
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  finishedAt: null,
};
const testCase = {
  id: 't',
  code: 'TC001',
  title: 'Submit',
  description: 'd',
  steps: ['open'],
} as E2eTestCase;

function author(text: string | Error, options: { provider?: boolean; fallback?: boolean } = {}) {
  const complete = vi.fn((_request: { prompt: string; instruction?: string }) =>
    text instanceof Error ? Promise.reject(text) : Promise.resolve({ text, provider: 'fake' }),
  );
  const llm = { provider: 'fake', complete, stream: vi.fn() } as unknown as LlmPort;
  const agents = {
    getAgent: vi.fn().mockResolvedValue({ instructions: 'You are QA.', model: 'm1' }),
    getWorkflow: vi.fn().mockResolvedValue(EMPTY_AGENT_WORKFLOW),
  } as unknown as AgentService;
  const providers = {
    resolveLlmProvider: vi.fn().mockResolvedValue(options.provider === false ? null : llm),
  } as unknown as DynamicProviderFactory;
  return {
    complete,
    providers,
    author: new AgentE2eAuthor({
      agents,
      providers,
      defaultLlm: options.fallback ? llm : undefined,
    }),
  };
}

describe('AgentE2eAuthor', () => {
  it('plans tests from JSON wrapped in prose and caps the count', async () => {
    const tests = Array.from({ length: 12 }, (_, index) => ({
      title: `Test ${index}`,
      priority: 'urgent',
      steps: ['x'],
    }));
    const {
      author: subject,
      complete,
      providers,
    } = author(`Here you go:\n\`\`\`json\n${JSON.stringify({ summary: '# PRD', tests })}\n\`\`\``);
    const plan = await subject.plan({ creation, snapshot: { startUrl: 'x', pages: [] } });
    expect(plan.summary).toBe('# PRD');
    expect(plan.tests).toHaveLength(MAX_E2E_TESTS);
    expect(plan.tests[0]).toEqual({
      title: 'Test 0',
      description: '',
      priority: 'medium',
      steps: ['x'],
    });
    expect(providers.resolveLlmProvider).toHaveBeenCalledWith('owner', undefined, undefined, 'm1');
    const request = complete.mock.calls[0]![0] as { prompt: string; instruction: string };
    expect(request.instruction).toContain('You are QA.');
    expect(request.instruction).toContain('Brazilian Portuguese');
    expect(request.instruction).toContain('Mode: FRONTEND');
    expect(request.instruction).toContain('Scope: CODEBASE');
    expect(request.prompt).toContain('<untrusted_input');
    expect(request.prompt).toContain('"testAccountAvailable": true');
  });

  it('rejects invalid plans', async () => {
    await expect(
      author('no json here').author.plan({ creation, snapshot: null }),
    ).rejects.toMatchObject({
      code: 'E2E_PLAN_INVALID',
    });
    await expect(
      author('{"summary":"x","tests":[]}').author.plan({ creation, snapshot: null }),
    ).rejects.toMatchObject({ code: 'E2E_PLAN_INVALID' });
  });

  it('describes backend and diff runs in English', async () => {
    const { author: subject, complete } = author('{"summary":"s","tests":[{"title":"API"}]}');
    await subject.plan({
      creation: {
        ...creation,
        mode: 'backend',
        scope: 'diff',
        diff: '+x',
        locale: 'en-US',
        username: null,
      },
      snapshot: null,
    });
    const request = complete.mock.calls[0]![0] as { prompt: string; instruction: string };
    expect(request.instruction).toContain('Mode: BACKEND');
    expect(request.instruction).toContain('Scope: CODE DIFF');
    expect(request.instruction).toContain('in English');
    expect(request.prompt).toContain('"codeDiff": "+x"');
  });

  it('writes scripts with repair context and strips fences', async () => {
    const { author: subject, complete } = author(
      "```ts\nimport { test } from '@playwright/test';\n```",
    );
    const script = await subject.writeScript({
      creation,
      test: testCase,
      snapshot: null,
      previous: { script: 'old', problem: 'locator' },
    });
    expect(script).toBe("import { test } from '@playwright/test';");
    const request = complete.mock.calls[0]![0] as { prompt: string; instruction: string };
    expect(request.instruction).toContain('process.env.E2E_USERNAME');
    expect(request.instruction).toContain('Never assume a generic greeting');
    expect(request.prompt).toContain('"problemToFix": "locator"');

    await subject.writeScript({
      creation: { ...creation, mode: 'backend', passwordSecret: null },
      test: testCase,
      snapshot: null,
    });
    const second = complete.mock.calls[1]![0] as { prompt: string; instruction: string };
    expect(second.instruction).toContain('`request` fixture');
    expect(second.instruction).toContain('No test account was provided');
    expect(second.prompt).not.toContain('problemToFix');
  });

  it('analyzes failures and falls back to raw text', async () => {
    const parsed = await author('{"verdict":"test_issue","summary":"Goal: x"}').author.analyze({
      creation,
      test: testCase,
      script: 's',
      error: 'e',
      logs: 'l',
    });
    expect(parsed).toEqual({ verdict: 'test_issue', summary: 'Goal: x' });
    const raw = await author('The app crashed.').author.analyze({
      creation,
      test: testCase,
      script: 's',
      error: 'e',
      logs: 'l',
    });
    expect(raw).toEqual({ verdict: 'app_bug', summary: 'The app crashed.' });
  });

  it('uses the default LLM or reports missing providers and LLM errors', async () => {
    const fallback = author('{"summary":"s","tests":[{"title":"t"}]}', {
      provider: false,
      fallback: true,
    });
    await expect(fallback.author.plan({ creation, snapshot: null })).resolves.toBeTruthy();
    await expect(
      author('x', { provider: false }).author.plan({ creation, snapshot: null }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' });
    await expect(
      author(new Error('HTTP 429 Too Many Requests')).author.plan({ creation, snapshot: null }),
    ).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' });
    const noProviders = new AgentE2eAuthor({
      agents: {
        getAgent: vi.fn().mockResolvedValue({ instructions: 'x', model: null }),
        getWorkflow: vi.fn().mockResolvedValue(EMPTY_AGENT_WORKFLOW),
      } as never,
    });
    await expect(noProviders.plan({ creation, snapshot: null })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_AVAILABLE',
    });
  });

  it('resolves the provider without a model override when the agent has none', async () => {
    const { author: subject, providers } = author('{"summary":"s","tests":[{"title":"t"}]}');
    const agents = (subject as unknown as { options: { agents: AgentService } }).options.agents;
    vi.mocked(agents.getAgent).mockResolvedValueOnce({ instructions: 'x', model: null } as never);
    await subject.plan({ creation, snapshot: null });
    expect(providers.resolveLlmProvider).toHaveBeenCalledWith(
      'owner',
      undefined,
      undefined,
      undefined,
    );
  });

  it('parses JSON objects defensively', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('{broken}')).toBeNull();
    expect(parseJsonObject('}{')).toBeNull();
  });
});

describe('PlaywrightE2eRunner (simulated)', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.e2e-workspaces-unit-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const runInput = {
    script: 'x',
    mode: 'frontend' as const,
    baseUrl: 'http://localhost:3000',
    locale: 'pt-BR',
    credentials: { username: 'qa-user', password: 'pw-secret' },
  };

  function withExecutor(
    executor: ProcessExecutor,
    write?: (cwd: string) => void,
  ): PlaywrightE2eRunner {
    return new PlaywrightE2eRunner({
      workspaceRoot: root,
      timeoutMs: 1000,
      executor: async (input) => {
        write?.(input.cwd);
        return executor(input);
      },
    });
  }

  it('turns a JSON report into a passing result with a video', async () => {
    const runner = withExecutor(
      () => Promise.resolve({ exitCode: 0, stdout: 'ok pw-secret', stderr: '', timedOut: false }),
      (cwd) => {
        fs.writeFileSync(
          path.join(cwd, 'report.json'),
          JSON.stringify({
            suites: [
              {
                suites: [
                  { specs: [{ tests: [{ results: [{ status: 'passed', duration: 42 }] }] }] },
                ],
              },
            ],
          }),
        );
        fs.mkdirSync(path.join(cwd, 'test-results', 'case'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'test-results', 'case', 'trace.zip'), 'zip');
        fs.writeFileSync(path.join(cwd, 'test-results', 'case', 'empty.webm'), '');
        fs.writeFileSync(path.join(cwd, 'test-results', 'case', 'video.webm'), 'webm');
        fs.mkdirSync(path.join(cwd, 'test-results', 'popup'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'test-results', 'popup', 'video.webm'), 'w');
      },
    );
    const result = await runner.run(runInput);
    expect(result).toMatchObject({ status: 'passed', durationMs: 42, error: null });
    expect(result.logs).toBe('ok [redacted]');
    expect(Buffer.from(result.video!).toString()).toBe('webm');
  });

  it('reports timeouts, missing reports and missing browsers', async () => {
    const timedOut = await withExecutor(() =>
      Promise.resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: true }),
    ).run(runInput);
    expect(timedOut).toMatchObject({
      status: 'failed',
      error: 'Test run exceeded 1s and was stopped.',
    });

    const noReport = await withExecutor(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: 'line1\nfatal pw-secret',
        stderr: '',
        timedOut: false,
      }),
    ).run(runInput);
    expect(noReport).toMatchObject({ status: 'failed', video: null });
    expect(noReport.error).toBe('line1\nfatal [redacted]');

    const empty = await withExecutor(() =>
      Promise.resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: false }),
    ).run(runInput);
    expect(empty.error).toBe('Test run failed without output.');

    await expect(
      withExecutor(() =>
        Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: "browserType.launch: Executable doesn't exist",
          timedOut: false,
        }),
      ).run(runInput),
    ).rejects.toMatchObject({ code: 'E2E_BROWSER_NOT_INSTALLED' });
  });

  it('summarizes reports', () => {
    expect(summarizeReport(null)).toEqual({ passed: false, error: null, durationMs: null });
    expect(summarizeReport({})).toEqual({
      passed: false,
      error: 'No test was executed.',
      durationMs: null,
    });
    expect(
      summarizeReport({
        suites: [{ specs: [{ tests: [{ results: [{ status: 'timedOut' }] }] }] }],
      }),
    ).toEqual({ passed: false, error: 'Test finished with status "timedOut".', durationMs: 0 });
    expect(summarizeReport({ suites: [{ specs: [{ tests: [{ results: [{}] }] }] }] }).error).toBe(
      'Test finished with status "unknown".',
    );
    expect(
      summarizeReport({
        errors: [{ message: '\u001b[31mSyntaxError\u001b[39m' }],
        suites: [
          {
            specs: [
              {
                tests: [
                  {
                    results: [
                      { status: 'failed', error: { message: 'retry' } },
                      { status: 'failed', errors: [{ message: 'A' }, { message: 'A' }] },
                    ],
                  },
                  { results: [{ status: 'failed', error: { message: 'B' } }] },
                  {},
                ],
              },
              {},
            ],
          },
        ],
      }),
    ).toEqual({ passed: false, error: 'SyntaxError\n\nA\n\nB', durationMs: 0 });
  });

  it('explores a UI with a stubbed browser and tolerates broken secondary pages', async () => {
    const snapshots = [
      {
        url: 'http://app/',
        title: 'Home',
        headings: [],
        buttons: [],
        fields: [],
        testIds: [],
        links: [
          { text: 'a', href: 'http://app/a' },
          { text: 'self', href: 'http://app/#top' },
          { text: 'ext', href: 'http://other/' },
          { text: 'b', href: 'http://app/b' },
          { text: 'c', href: 'http://app/c' },
        ],
      },
      {
        url: 'http://app/a',
        title: 'A',
        headings: [],
        buttons: [],
        fields: [],
        testIds: [],
        links: [],
      },
    ];
    const page = {
      goto: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('404')),
      waitForLoadState: vi.fn().mockRejectedValue(new Error('busy')),
      evaluate: vi.fn().mockImplementation(() => Promise.resolve(snapshots.shift())),
    };
    const close = vi.fn().mockRejectedValue(new Error('already closed'));
    const loadPlaywright = () =>
      Promise.resolve({
        chromium: {
          launch: () => Promise.resolve({ newPage: () => Promise.resolve(page), close }),
        },
      } as unknown as PlaywrightModule);
    const runner = new PlaywrightE2eRunner({ loadPlaywright, maxPages: 3 });
    const snapshot = await runner.explore({ mode: 'frontend', url: 'http://app/' });
    expect(snapshot.pages.map((item) => item.title)).toEqual(['Home', 'A']);
    expect(page.goto).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalled();
  });

  it('maps browser launch and navigation failures', async () => {
    const failingLaunch = (message: unknown) =>
      new PlaywrightE2eRunner({
        loadPlaywright: () =>
          Promise.resolve({
            chromium: { launch: () => Promise.reject(message) },
          } as unknown as PlaywrightModule),
      });
    await expect(
      failingLaunch(new Error("Executable doesn't exist at /ms-playwright")).explore({
        mode: 'frontend',
        url: 'http://app/',
      }),
    ).rejects.toMatchObject({ code: 'E2E_BROWSER_NOT_INSTALLED' });
    await expect(
      failingLaunch('sandbox crash').explore({ mode: 'frontend', url: 'http://app/' }),
    ).rejects.toMatchObject({ code: 'E2E_RUNNER_FAILED', message: 'sandbox crash' });

    const page = {
      goto: vi.fn().mockRejectedValue('net::ERR'),
      waitForLoadState: vi.fn(),
      evaluate: vi.fn(),
    };
    const unreachable = new PlaywrightE2eRunner({
      loadPlaywright: () =>
        Promise.resolve({
          chromium: {
            launch: () =>
              Promise.resolve({
                newPage: () => Promise.resolve(page),
                close: () => Promise.resolve(),
              }),
          },
        } as unknown as PlaywrightModule),
    });
    await expect(
      unreachable.explore({ mode: 'frontend', url: 'http://app/' }),
    ).rejects.toMatchObject({
      code: 'E2E_TARGET_UNREACHABLE',
      message: expect.stringContaining('Could not reach http://app/'),
    });
  });

  it('explores APIs and handles unreachable hosts', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      )
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValue(new Response('{"openapi":"3"}', { status: 200 }));
    const runner = new PlaywrightE2eRunner({ fetcher: fetcher as unknown as typeof fetch });
    const snapshot = await runner.explore({ mode: 'backend', url: 'http://api/v1' });
    expect(snapshot.api).toMatchObject({
      status: 200,
      contentType: 'application/json',
      specUrl: '/api-docs',
      spec: '{"openapi":"3"}',
    });
    const headless = new PlaywrightE2eRunner({
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(new Response('x', { status: 500 }))
        .mockRejectedValue(new Error('no')) as unknown as typeof fetch,
    });
    expect((await headless.explore({ mode: 'backend', url: 'http://api/' })).api).toEqual({
      status: 500,
      contentType: 'text/plain;charset=UTF-8',
      excerpt: 'x',
    });
    const bare = new PlaywrightE2eRunner({
      fetcher: vi
        .fn()
        .mockResolvedValueOnce({
          status: 204,
          headers: new Headers(),
          text: () => Promise.resolve(''),
        })
        .mockRejectedValue(new Error('no')) as unknown as typeof fetch,
    });
    expect((await bare.explore({ mode: 'backend', url: 'http://api/' })).api?.contentType).toBe('');
    const down = new PlaywrightE2eRunner({
      fetcher: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch,
    });
    await expect(down.explore({ mode: 'backend', url: 'http://api/' })).rejects.toMatchObject({
      code: 'E2E_TARGET_UNREACHABLE',
    });
  });

  it('builds the child config and environment without backend secrets', () => {
    expect(runnerConfig('http://a', 'en-US')).toContain('baseURL: "http://a"');
    const savedPath = process.env['PATH'];
    delete process.env['PATH'];
    expect(childEnvironment('/w', runInput).PATH).toBe('');
    process.env['PATH'] = savedPath;
    process.env['DATABASE_URL'] = 'postgres://secret';
    const env = childEnvironment('/tmp/ws', {
      ...runInput,
      credentials: { username: null, password: null },
    });
    expect(env).toMatchObject({ HOME: '/tmp/ws', E2E_USERNAME: '', E2E_PASSWORD: '', CI: '1' });
    expect(env).not.toHaveProperty('DATABASE_URL');
    delete process.env['DATABASE_URL'];
  });

  it('knows the default browser cache per platform', () => {
    expect(defaultBrowsersPath('win32', 'H')).toBe(
      path.join('H', 'AppData', 'Local', 'ms-playwright'),
    );
    expect(defaultBrowsersPath('darwin', 'H')).toBe(
      path.join('H', 'Library', 'Caches', 'ms-playwright'),
    );
    expect(defaultBrowsersPath('linux', 'H')).toBe(path.join('H', '.cache', 'ms-playwright'));
  });

  it('passes context resolution errors to the error handler', async () => {
    const app = express();
    app.use(createE2eRouter({} as E2eService, () => Promise.reject(new Error('resolver down'))));
    app.use(errorMiddleware);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await request(app).get('/e2e/creations').expect(500);
    errorLog.mockRestore();
  });

  it('runs real child processes with timeouts and cancellation', async () => {
    const ok = await runProcess({
      command: process.execPath,
      args: ['-e', 'console.log("out"); console.error("err")'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
    });
    expect(ok).toEqual({ exitCode: 0, stdout: 'out\n', stderr: 'err\n', timedOut: false });
    const slow = await runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 200,
    });
    expect(slow.timedOut).toBe(true);
    const controller = new AbortController();
    const cancelled = runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    expect((await cancelled).exitCode).not.toBe(0);
    await expect(
      runProcess({
        command: 'definitely-not-a-binary',
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  }, 20_000);
});
