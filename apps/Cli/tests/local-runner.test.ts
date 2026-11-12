import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AdkApiError, type AdkApi, type ApiRequest } from '#mcp';
import {
  formatRunnerEvent,
  LocalRunnerAgent,
  type ClaimedTask,
  type LocalBrowser,
  type RunnerEvent,
} from '../src/e2e/local-runner/agent.js';
import { loadLocalConfig } from '../src/e2e/local-runner/local-config.js';
import {
  chromiumInstalled,
  ensureChromium,
  loadRunnerIdentity,
  playwrightPackageRoot,
  prepareWorkspaceRoot,
  runnerHome,
} from '../src/e2e/local-runner/playwright-setup.js';
import { runLocally } from '../src/e2e/local-runner/run-command.js';
import { E2eRunnerError } from '../src/vendor/e2e/application/e2e-runner.js';

const SCRIPT = `import { test } from '@playwright/test';\ntest('TC001', async ({ page }) => { await page.goto('/'); });`;
const identity = { id: 'runner-0001', name: 'QA-LAPTOP', platform: 'win32', version: '0.2.0' };

function runTask(overrides: Partial<Extract<ClaimedTask['input'], { kind: 'run' }>> = {}) {
  return {
    id: 'task-1',
    kind: 'run',
    creationId: 'c1',
    testId: 't1',
    label: { run: 'Checkout', test: 'TC001 - Pay' },
    input: {
      kind: 'run',
      script: SCRIPT,
      mode: 'frontend',
      baseUrl: 'http://localhost:3000',
      locale: 'pt-BR',
      credentials: { username: 'saved', password: 'saved-pass' },
      accessToken: { clientId: 'id', clientSecret: 'secret' },
      ...overrides,
    },
  } satisfies ClaimedTask;
}

/** Answers like the ADK API; `routes` maps "METHOD path" to a response or a thrown error. */
function fakeApi(routes: Record<string, unknown>) {
  const calls: ApiRequest[] = [];
  const api: AdkApi = {
    request: <T>(request: ApiRequest) => {
      calls.push(request);
      const handler = routes[`${request.method} ${request.path}`];
      try {
        const value: unknown =
          typeof handler === 'function'
            ? (handler as (call: ApiRequest) => unknown)(request)
            : handler;
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value as T);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { api, calls };
}

interface FakeBrowser {
  run: Mock<LocalBrowser['run']>;
  explore: Mock<LocalBrowser['explore']>;
}

function browser(overrides: Partial<FakeBrowser> = {}): FakeBrowser {
  return {
    run: vi.fn<LocalBrowser['run']>().mockResolvedValue({
      status: 'passed',
      durationMs: 1234.4,
      error: null,
      logs: '1 passed',
      video: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      steps: [
        {
          position: 1,
          title: 'Open',
          status: 'passed',
          durationMs: 10,
          error: null,
          screenshot: new Uint8Array([0x89, 0x50]),
        },
        {
          position: 2,
          title: 'Pay',
          status: 'passed',
          durationMs: 5,
          error: null,
          screenshot: null,
        },
      ],
    }),
    explore: vi
      .fn<LocalBrowser['explore']>()
      .mockResolvedValue({ startUrl: 'http://localhost:3000/', pages: [] }),
    ...overrides,
  };
}

function agentWith(api: AdkApi, local: LocalBrowser, extra: Record<string, unknown> = {}) {
  const events: RunnerEvent[] = [];
  const agent = new LocalRunnerAgent({
    api,
    browser: local,
    identity,
    heartbeatMs: 5,
    onEvent: (event) => events.push(event),
    sleep: () => Promise.resolve(),
    ...extra,
  });
  return { agent, events };
}

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-runner-test-'));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('LocalRunnerAgent', () => {
  it('runs a claimed test with local settings and uploads the evidence to ADK', async () => {
    const { api, calls } = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'PUT /e2e/runner/tasks/task-1/artifacts/video.webm': undefined,
      'PUT /e2e/runner/tasks/task-1/artifacts/step-01.png': undefined,
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    });
    const local = browser();
    const { agent, events } = agentWith(api, local, {
      overrides: { baseUrl: 'http://127.0.0.1:8014/ignored', username: 'me', password: 'mine' },
    });

    await expect(agent.poll({ creationId: 'c1', waitSeconds: 3 })).resolves.toMatchObject({
      id: 'task-1',
    });
    expect(calls[0]).toMatchObject({
      body: { runner: identity, waitSeconds: 3, creationId: 'c1' },
      timeoutMs: 33_000,
    });
    expect(local.run).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:8014',
        localOrigin: null,
        credentials: { username: 'me', password: 'mine' },
        // The saved token belongs to the saved address only.
        accessToken: null,
      }),
    );
    const uploads = calls.filter((call) => call.method === 'PUT');
    expect(uploads.map((call) => [call.path, call.rawBody?.contentType, call.headers])).toEqual([
      [
        '/e2e/runner/tasks/task-1/artifacts/video.webm',
        'video/webm',
        { 'x-adk-runner-id': identity.id },
      ],
      [
        '/e2e/runner/tasks/task-1/artifacts/step-01.png',
        'image/png',
        { 'x-adk-runner-id': identity.id },
      ],
    ]);
    expect(calls.at(-1)?.body).toEqual({
      runnerId: identity.id,
      outcome: {
        kind: 'run',
        status: 'passed',
        durationMs: 1234,
        error: null,
        logs: '1 passed',
        steps: [
          {
            position: 1,
            title: 'Open',
            status: 'passed',
            durationMs: 10,
            error: null,
            hasScreenshot: true,
          },
          {
            position: 2,
            title: 'Pay',
            status: 'passed',
            durationMs: 5,
            error: null,
            hasScreenshot: false,
          },
        ],
        hasVideo: true,
      },
    });
    expect(events.map((event) => event.type)).toEqual(['claimed', 'finished']);
  });

  it('explores the application and keeps the saved target without overrides', async () => {
    const routes = {
      'POST /e2e/runner/claim': {
        task: {
          ...runTask(),
          kind: 'explore',
          input: {
            kind: 'explore',
            mode: 'frontend',
            url: 'https://app.example.com/login?next=1',
            accessToken: { clientId: 'id', clientSecret: 'secret' },
          },
        },
      },
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    };
    const { api, calls } = fakeApi(routes);
    const local = browser();
    const { agent, events } = agentWith(api, local);
    await agent.poll();
    expect(local.explore).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://app.example.com/login?next=1',
        accessToken: { clientId: 'id', clientSecret: 'secret' },
      }),
    );
    expect(calls.at(-1)?.body).toMatchObject({ outcome: { kind: 'explore' } });
    expect(events.at(-1)?.type).toBe('explored');

    const overridden = browser();
    await agentWith(fakeApi(routes).api, overridden, {
      overrides: { baseUrl: 'http://localhost:8014' },
    }).agent.poll();
    expect(overridden.explore).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:8014/login?next=1', accessToken: null }),
    );
  });

  it('rejects unsafe specs before opening a browser and reports runner errors', async () => {
    const rejected = fakeApi({
      'POST /e2e/runner/claim': { task: runTask({ script: 'process.exit(1)' }) },
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    });
    const local = browser();
    await agentWith(rejected.api, local).agent.poll();
    expect(local.run).not.toHaveBeenCalled();
    expect(rejected.calls.at(-1)?.body).toMatchObject({
      outcome: { kind: 'error', code: 'E2E_SCRIPT_REJECTED' },
    });

    for (const [error, code] of [
      [
        new E2eRunnerError('E2E_BROWSER_NOT_INSTALLED', 'Run devkit e2e setup.'),
        'E2E_BROWSER_NOT_INSTALLED',
      ],
      [new E2eRunnerError('E2E_LOCAL_RUNNER_LOST', 'n/a'), 'E2E_RUNNER_FAILED'],
      [new Error('boom'), 'E2E_RUNNER_FAILED'],
    ] as const) {
      const failing = fakeApi({
        'POST /e2e/runner/claim': { task: runTask() },
        'POST /e2e/runner/tasks/task-1/complete': undefined,
      });
      const { agent, events } = agentWith(
        failing.api,
        browser({ run: vi.fn<LocalBrowser['run']>().mockRejectedValue(error) }),
      );
      await agent.poll();
      expect(failing.calls.at(-1)?.body).toMatchObject({ outcome: { kind: 'error', code } });
      expect(events.at(-1)).toMatchObject({ type: 'failed', message: error.message });
    }
  });

  it('stops the browser when ADK cancels the task', async () => {
    const { api, calls } = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'POST /e2e/runner/tasks/task-1/heartbeat': { status: 'cancelled' },
    });
    const local = browser({
      run: vi.fn<LocalBrowser['run']>(
        ({ signal }) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('killed'))),
          ),
      ),
    });
    const { agent, events } = agentWith(api, local);
    await agent.poll();
    expect(events.at(-1)?.type).toBe('cancelled');
    expect(calls.some((call) => call.path.endsWith('/complete'))).toBe(false);

    const gone = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'PUT /e2e/runner/tasks/task-1/artifacts/video.webm': new AdkApiError(
        404,
        'E2E_RUNNER_TASK_NOT_FOUND',
        'gone',
      ),
    });
    const lost = agentWith(gone.api, browser());
    await lost.agent.poll();
    expect(lost.events.at(-1)?.type).toBe('cancelled');

    const stop = new AbortController();
    const slow = agentWith(
      fakeApi({ 'POST /e2e/runner/claim': { task: runTask() } }).api,
      browser({
        run: vi.fn<LocalBrowser['run']>(({ signal }) => {
          stop.abort();
          return Promise.reject(new Error(signal?.aborted ? 'aborted' : 'still running'));
        }),
      }),
    );
    await slow.agent.poll({ signal: stop.signal });
    expect(slow.events.at(-1)?.type).toBe('cancelled');
  });

  it('keeps serving through connection problems and stops on sign-in errors', async () => {
    let claims = 0;
    const { api } = fakeApi({
      'POST /e2e/runner/claim': () => {
        claims += 1;
        if (claims === 1) throw new AdkApiError(0, 'ADK_API_UNREACHABLE', 'offline');
        return { task: null };
      },
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { agent, events } = agentWith(api, browser(), { sleep });
    let checks = 0;
    await agent.serve({
      creationId: 'c1',
      waitSeconds: 1,
      done: () => Promise.resolve(++checks > 1),
    });
    expect(events[0]).toEqual({ type: 'offline', message: 'offline', retryInMs: 2_000 });
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
    expect(claims).toBe(3);

    const denied = fakeApi({
      'POST /e2e/runner/claim': new AdkApiError(401, 'UNAUTHORIZED', 'Sign in.'),
    });
    await expect(agentWith(denied.api, browser()).agent.serve()).rejects.toThrow('Sign in.');

    const stopped = new AbortController();
    stopped.abort();
    await expect(
      agentWith(denied.api, browser()).agent.serve({ signal: stopped.signal }),
    ).resolves.toBeUndefined();
  });

  it('waits between retries until the signal stops the loop', async () => {
    const stop = new AbortController();
    const { api } = fakeApi({
      'POST /e2e/runner/claim': () => {
        setTimeout(() => stop.abort(), 5);
        throw new AdkApiError(0, 'ADK_API_UNREACHABLE', 'offline');
      },
    });
    const { agent, events } = agentWith(api, browser(), { sleep: undefined });
    const started = Date.now();
    await agent.serve({ signal: stop.signal });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events).toEqual([{ type: 'offline', message: 'offline', retryInMs: 2_000 }]);
  });

  it('formats every event for the terminal', () => {
    const task = runTask();
    const lines = (
      [
        { type: 'claimed', task },
        { type: 'claimed', task: { ...task, kind: 'explore' } },
        { type: 'finished', task, status: 'passed', durationMs: 1500, error: null },
        { type: 'finished', task, status: 'failed', durationMs: 900, error: 'Timeout\nstack' },
        { type: 'finished', task, status: 'failed', durationMs: 900, error: null },
        { type: 'explored', task },
        { type: 'failed', task, message: 'No browser\nmore' },
        { type: 'cancelled', task },
        { type: 'offline', message: 'down', retryInMs: 4_000 },
      ] satisfies RunnerEvent[]
    ).map(formatRunnerEvent);
    expect(lines).toEqual([
      '▶ TC001 - Pay ("Checkout")',
      '▶ Exploring the application for "Checkout"',
      '  ✔ passed in 1.5s',
      '  ✖ failed in 0.9s: Timeout',
      '  ✖ failed in 0.9s',
      '  ✔ snapshot sent to ADK',
      '  ✖ No browser',
      '  ■ stopped: the run was cancelled in ADK',
      'ADK unavailable (down). Retrying in 4s.',
    ]);
    expect(
      formatRunnerEvent({ type: 'claimed', task: { ...task, label: { run: 'R', test: null } } }),
    ).toBe('▶ Test ("R")');
  });
});

describe('devkit e2e run', () => {
  const creation = (overrides: Record<string, unknown> = {}) => ({
    id: 'c1',
    name: 'Checkout',
    status: 'completed',
    executionTarget: 'local',
    baseUrl: 'http://localhost:8014',
    error: null,
    tests: [
      { id: 't1', code: 'TC001', title: 'Pay', status: 'passed', error: null, durationMs: 1200 },
      {
        id: 't2',
        code: 'TC002',
        title: 'Refund',
        status: 'failed',
        error: 'Boom\nstack',
        durationMs: null,
      },
    ],
    ...overrides,
  });

  it('requires an explicit switch for runs on the ADK servers', async () => {
    const { api } = fakeApi({
      'GET /e2e/creations/c1': { creation: creation({ executionTarget: 'remote' }) },
    });
    await expect(
      runLocally(api, { serve: vi.fn() }, { creationId: 'c1' }, () => undefined),
    ).rejects.toThrow('--set-local');
  });

  it('pushes edited specs, starts the run, serves it here and summarizes the results', async () => {
    const folder = await tempDir();
    await fs.writeFile(path.join(folder, 'tc001-pay.spec.ts'), 'edited\r\n');
    await fs.writeFile(path.join(folder, 'tc002-refund.spec.ts'), 'same');
    await fs.writeFile(path.join(folder, 'other.spec.ts'), 'x');
    let reads = 0;
    const { api, calls } = fakeApi({
      'GET /e2e/creations/c1': () => ({
        creation: creation(reads++ === 0 ? { executionTarget: 'remote', status: 'failed' } : {}),
      }),
      'PUT /e2e/creations/c1/execution': { creation: creation({ status: 'failed' }) },
      'GET /e2e/tests/t1/script': { path: 'tests/e2e/tc001-pay.spec.ts', content: 'original' },
      'GET /e2e/tests/t2/script': { path: 'tests/e2e/tc002-refund.spec.ts', content: 'same\n' },
      'PUT /e2e/tests/t1/script': undefined,
      'POST /e2e/creations/c1/run': new AdkApiError(409, 'E2E_ALREADY_RUNNING', 'busy'),
    });
    const serve = vi.fn(async ({ done }: { done: () => Promise<boolean> }) => {
      expect(await done()).toBe(true);
    });
    const lines: string[] = [];
    const summary = await runLocally(
      api,
      { serve },
      { creationId: 'c1', scriptsDir: folder, setLocal: true },
      (line) => lines.push(line),
    );
    expect(
      calls.find((call) => call.method === 'PUT' && call.path === '/e2e/tests/t1/script')?.body,
    ).toEqual({
      content: 'edited\r\n',
    });
    expect(
      calls.some((call) => call.path === '/e2e/tests/t2/script' && call.method === 'PUT'),
    ).toBe(false);
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ creationId: 'c1', waitSeconds: 5 }),
    );
    expect(summary).toMatchObject({ passed: 1, failed: 1 });
    expect(lines).toEqual([
      '"Checkout" now runs on this computer (http://localhost:8014).',
      'Pushed TC001 script (tests/e2e/tc001-pay.spec.ts).',
      'Skipped other.spec.ts: no test of this run uses it.',
      '"Checkout" is already running; executing its browser work here.',
      '✔ TC001 Pay — passed (1.2s)',
      '✖ TC002 Refund — failed\n    Boom',
    ]);
  });

  it('runs a single test by code and cancels the run when stopped here', async () => {
    const stop = new AbortController();
    const { api, calls } = fakeApi({
      'GET /e2e/creations/c1': { creation: creation({ error: 'Interrupted.' }) },
      'POST /e2e/tests/t2/run': undefined,
      'POST /e2e/creations/c1/cancel': new AdkApiError(409, 'E2E_NOT_RUNNING', 'idle'),
    });
    const lines: string[] = [];
    const summary = await runLocally(
      api,
      { serve: vi.fn(() => Promise.resolve(stop.abort())) },
      { creationId: 'c1', test: 'tc002', signal: stop.signal },
      (line) => lines.push(line),
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain('POST /e2e/tests/t2/run');
    expect(summary).toMatchObject({ passed: 0, failed: 1 });
    expect(lines).toContain('Started TC002 - Refund.');
    expect(lines).toContain('Cancelled "Checkout" in ADK.');
    expect(lines.at(-1)).toBe('Interrupted.');
    await expect(
      runLocally(api, { serve: vi.fn() }, { creationId: 'c1', test: 'TC999' }, () => undefined),
    ).rejects.toThrow('TC999');

    const other = fakeApi({
      'GET /e2e/creations/c1': { creation: creation() },
      'POST /e2e/creations/c1/run': new AdkApiError(500, 'INTERNAL_ERROR', 'down'),
    });
    await expect(
      runLocally(other.api, { serve: vi.fn() }, { creationId: 'c1' }, () => undefined),
    ).rejects.toThrow('down');
  });
});

describe('local runner setup', () => {
  it('links the bundled Playwright into the run folder once', async () => {
    const home = await tempDir();
    const packageRoot = playwrightPackageRoot();
    const root = await prepareWorkspaceRoot(home, packageRoot);
    const linked = path.join(root, 'node_modules', '@playwright', 'test');
    expect(await fs.realpath(linked)).toBe(
      await fs.realpath(path.join(packageRoot, 'node_modules', '@playwright', 'test')),
    );
    expect(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))).toEqual({
      private: true,
      type: 'module',
    });
    await expect(prepareWorkspaceRoot(home, packageRoot)).resolves.toBe(root);
    expect(runnerHome({ ADK_RUNNER_HOME: home })).toBe(home);
    expect(runnerHome({})).toContain(path.join('.adk', 'e2e-runner'));
  });

  it('downloads Chromium only when it is missing', async () => {
    const browsers = await tempDir();
    const env = { PLAYWRIGHT_BROWSERS_PATH: browsers };
    const lines: string[] = [];
    const install = vi.fn().mockResolvedValue(0);
    await ensureChromium((line) => lines.push(line), install, env);
    expect(install).toHaveBeenCalledOnce();
    expect(lines[0]).toContain('Chromium');
    await expect(
      ensureChromium(() => undefined, vi.fn().mockResolvedValue(1), env),
    ).rejects.toThrow('devkit e2e setup');
    await fs.mkdir(path.join(browsers, 'chromium-1234'));
    expect(await chromiumInstalled(env)).toBe(true);
    await ensureChromium(() => undefined, install, env);
    expect(install).toHaveBeenCalledOnce();
  });

  it('keeps a stable runner id per computer', async () => {
    const home = await tempDir();
    const first = await loadRunnerIdentity(home, '0.2.0');
    expect(first.id).toMatch(/^runner-[0-9a-f]{24}$/);
    expect(first).toMatchObject({ platform: process.platform, version: '0.2.0' });
    await expect(loadRunnerIdentity(home, '0.3.0')).resolves.toMatchObject({ id: first.id });
    await fs.writeFile(path.join(home, 'runner.json'), '{"id":"../bad"}');
    expect((await loadRunnerIdentity(home, '0.3.0')).id).not.toBe('../bad');
  });

  it('reads optional local settings next to the project', async () => {
    const folder = await tempDir();
    const file = path.join(folder, 'adk-e2e.json');
    await expect(loadLocalConfig(file)).resolves.toEqual({});
    await fs.writeFile(
      file,
      JSON.stringify({ run: 'c1', baseUrl: 'http://localhost:8014', scripts: 'e2e' }),
    );
    await expect(loadLocalConfig(file)).resolves.toEqual({
      run: 'c1',
      baseUrl: 'http://localhost:8014',
      scripts: path.join(folder, 'e2e'),
    });
    await fs.writeFile(file, JSON.stringify({ run: 'c2' }));
    await expect(loadLocalConfig(file)).resolves.toEqual({ run: 'c2' });
    await fs.writeFile(file, JSON.stringify({ baseUrl: 'not a url' }));
    await expect(loadLocalConfig(file)).rejects.toThrow('adk-e2e.json');
    await expect(loadLocalConfig(folder)).rejects.toThrow();
  });
});
