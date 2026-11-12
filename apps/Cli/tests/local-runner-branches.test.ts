import { describe, expect, it, vi, type Mock } from 'vitest';
import { AdkApiError, type AdkApi, type ApiRequest } from '#mcp';
import {
  LocalRunnerAgent,
  type ClaimedTask,
  type LocalBrowser,
  type RunnerEvent,
} from '../src/e2e/local-runner/agent.js';

const SCRIPT = `import { test } from '@playwright/test';\ntest('TC001', async ({ page }) => { await page.goto('/'); });`;
const HOOK = 'export default async function (page: unknown) { void page; }';
const identity = { id: 'runner-0001', name: 'QA-LAPTOP', platform: 'win32', version: '0.2.0' };

type RunInput = Extract<ClaimedTask['input'], { kind: 'run' }>;

function runTask(overrides: Partial<RunInput> = {}, id = 'task-1') {
  return {
    id,
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
      credentials: { username: null, password: null },
      accessToken: null,
      ...overrides,
    },
  } satisfies ClaimedTask;
}

const exploreTask = {
  ...runTask(),
  kind: 'explore',
  input: { kind: 'explore', mode: 'frontend', url: 'http://localhost:3000', accessToken: null },
} satisfies ClaimedTask;

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

const outcome = (overrides: Record<string, unknown> = {}) => ({
  status: 'failed' as const,
  durationMs: 10,
  error: 'Expected visible',
  logs: '1 failed',
  video: null,
  steps: [
    {
      position: 1,
      title: 'Open',
      status: 'failed' as const,
      durationMs: 5,
      error: 'Not found',
      screenshot: null,
    },
  ],
  ...overrides,
});

function browser(overrides: Partial<FakeBrowser> = {}): FakeBrowser {
  return {
    run: vi.fn<LocalBrowser['run']>().mockResolvedValue(outcome()),
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

const GONE = () => new AdkApiError(404, 'E2E_RUNNER_TASK_NOT_FOUND', 'gone');

describe('LocalRunnerAgent branches', () => {
  it('reports errors and steps that failed, and works with the default heartbeat', async () => {
    const { api, calls } = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    });
    const { agent, events } = agentWith(api, browser(), { heartbeatMs: undefined });
    await agent.poll();
    expect(calls.at(-1)?.body).toMatchObject({
      outcome: {
        status: 'failed',
        error: 'Expected visible',
        steps: [{ error: 'Not found', hasScreenshot: false }],
        hasVideo: false,
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'failed' });
  });

  it('hands the Before Run and After Run hooks to the browser', async () => {
    const { api } = fakeApi({
      'POST /e2e/runner/claim': {
        task: runTask({ hooks: { beforeRun: HOOK, afterRun: '   ' } }),
      },
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    });
    const local = browser();
    await agentWith(api, local).agent.poll();
    expect(local.run).toHaveBeenCalledWith(
      expect.objectContaining({ hooks: { beforeRun: HOOK, afterRun: '   ' } }),
    );
  });

  it('rejects a hook that leaves the browser-automation surface', async () => {
    const { api, calls } = fakeApi({
      'POST /e2e/runner/claim': {
        task: runTask({ hooks: { beforeRun: null, afterRun: 'process.exit(1)' } }),
      },
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    });
    const local = browser();
    const { agent, events } = agentWith(api, local);
    await agent.poll();
    expect(local.run).not.toHaveBeenCalled();
    expect(calls.at(-1)?.body).toMatchObject({
      outcome: { kind: 'error', code: 'E2E_SCRIPT_REJECTED' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'failed' });
    expect((events.at(-1) as { message: string }).message).toContain('afterRun: ');
  });

  it('stops without reporting when the browser finishes after the task was cancelled', async () => {
    for (const task of [runTask(), exploreTask]) {
      const stop = new AbortController();
      const { api, calls } = fakeApi({ 'POST /e2e/runner/claim': { task } });
      const local = browser({
        run: vi.fn<LocalBrowser['run']>(async () => {
          stop.abort();
          return outcome({ status: 'passed', error: null });
        }),
        explore: vi.fn<LocalBrowser['explore']>(async () => {
          stop.abort();
          return { startUrl: 'http://localhost:3000/', pages: [] };
        }),
      });
      const { agent, events } = agentWith(api, local);
      await agent.poll({ signal: stop.signal });
      expect(events.at(-1)?.type).toBe('cancelled');
      expect(calls.some((call) => call.path.endsWith('/complete'))).toBe(false);
    }
  });

  it('treats a task ADK already removed as cancelled when reporting a failure', async () => {
    const { api } = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'POST /e2e/runner/tasks/task-1/complete': GONE(),
    });
    const failing = browser({
      run: vi.fn<LocalBrowser['run']>().mockRejectedValue(new Error('boom')),
    });
    const { agent, events } = agentWith(api, failing);
    await agent.poll();
    expect(events.map((event) => event.type)).toEqual(['claimed', 'cancelled']);
  });

  it('gives up when a failure cannot be reported for another reason', async () => {
    const { api } = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'POST /e2e/runner/tasks/task-1/complete': new AdkApiError(500, 'INTERNAL_ERROR', 'down'),
    });
    const failing = browser({
      run: vi.fn<LocalBrowser['run']>().mockRejectedValue(new Error('boom')),
    });
    await expect(agentWith(api, failing).agent.poll()).rejects.toThrow('down');
  });

  it('reports a failure that is not an Error by its text', async () => {
    const { api, calls } = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    });
    const failing = browser({
      run: vi.fn<LocalBrowser['run']>().mockRejectedValue('plain failure'),
    });
    const { agent, events } = agentWith(api, failing);
    await agent.poll();
    expect(calls.at(-1)?.body).toMatchObject({
      outcome: { kind: 'error', code: 'E2E_RUNNER_FAILED', message: 'plain failure' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'failed', message: 'plain failure' });
  });

  it('refuses task ids that could escape the route', async () => {
    const { api } = fakeApi({ 'POST /e2e/runner/claim': { task: runTask({}, '..') } });
    await expect(agentWith(api, browser()).agent.poll()).rejects.toThrow('Invalid identifier');
  });

  it('doubles the pause between failed attempts and describes failures that are not errors', async () => {
    const stop = new AbortController();
    let claims = 0;
    const { api } = fakeApi({
      'POST /e2e/runner/claim': () => {
        claims += 1;
        if (claims === 3) stop.abort();
        throw claims === 1 ? 'refused' : new AdkApiError(0, 'ADK_API_UNREACHABLE', 'offline');
      },
    });
    const { agent, events } = agentWith(api, browser());
    await agent.serve({ signal: stop.signal });
    expect(events).toEqual([
      { type: 'offline', message: 'refused', retryInMs: 2_000 },
      { type: 'offline', message: 'offline', retryInMs: 4_000 },
      { type: 'offline', message: 'offline', retryInMs: 8_000 },
    ]);
  });

  it('ignores a heartbeat that fails and keeps running', async () => {
    const { api } = fakeApi({
      'POST /e2e/runner/claim': { task: runTask() },
      'POST /e2e/runner/tasks/task-1/heartbeat': new Error('network'),
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    });
    const slow = browser({
      run: vi.fn<LocalBrowser['run']>(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return outcome({ status: 'passed', error: null });
      }),
    });
    const { agent, events } = agentWith(api, slow);
    await agent.poll();
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'passed' });
  });
});

describe('LocalRunnerAgent test account and environment variables', () => {
  const routes = (task: ClaimedTask) =>
    fakeApi({
      'POST /e2e/runner/claim': { task },
      'POST /e2e/runner/tasks/task-1/complete': undefined,
    }).api;

  it('signs in before exploring with the account of the task, or the one set on this computer', async () => {
    const credentials = { username: 'qa@example.com', password: 'pw' };
    const task = { ...exploreTask, input: { ...exploreTask.input, credentials } };
    const local = browser();
    await agentWith(routes(task), local).agent.poll();
    expect(local.explore).toHaveBeenCalledWith(expect.objectContaining({ credentials }));

    const mine = browser();
    await agentWith(routes(task), mine, { overrides: { username: 'me@example.com' } }).agent.poll();
    expect(mine.explore).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { username: 'me@example.com', password: 'pw' } }),
    );

    // Servers older than the sign-in send no account: the exploration stays signed out.
    const old = browser();
    await agentWith(routes(exploreTask), old).agent.poll();
    expect(old.explore.mock.calls[0]![0]).not.toHaveProperty('credentials');
    expect(old.explore.mock.calls[0]![0]).not.toHaveProperty('thorough');

    // A Source exploration maps the whole application.
    const whole = browser();
    const thorough = { ...exploreTask, input: { ...exploreTask.input, thorough: true } };
    await agentWith(routes(thorough), whole).agent.poll();
    expect(whole.explore).toHaveBeenCalledWith(expect.objectContaining({ thorough: true }));
  });

  it('gives the spec the custom variables of the run environment', async () => {
    const local = browser();
    await agentWith(routes(runTask({ variables: { PLAN: 'premium' } })), local).agent.poll();
    expect(local.run).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { PLAN: 'premium' } }),
    );

    const plain = browser();
    await agentWith(routes(runTask()), plain).agent.poll();
    expect(plain.run.mock.calls[0]![0]).not.toHaveProperty('variables');
  });
});
