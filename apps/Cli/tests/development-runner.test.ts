import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdkApiError, type AdkApi, type ApiRequest } from '#mcp';
import type { Invocation } from '../src/development/agent-clis.js';
import type { StreamOptions } from '../src/development/process.js';
import {
  artifactFile,
  buildPrompt,
  DevelopmentRunner,
  formatDevelopmentEvent,
  matchesRepository,
  statusOf,
  type DevelopmentRunnerEvent,
  type DevelopmentRunnerOptions,
  type SessionDto,
} from '../src/development/runner.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const session = (fields: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1',
  title: 'Implement login',
  prompt: 'Follow the tasks',
  cli: 'claude',
  attempt: 1,
  repository: null,
  worktree: { branch: 'adk/add-login-1a2b3c4d', baseBranch: 'main' },
  context: { compactAtPercent: 80 },
  maxSubagents: 3,
  ...fields,
});

const change = {
  id: 'c1',
  slug: 'add-login',
  title: 'Add login',
  artifacts: [
    { id: 'a1', kind: 'proposal', path: 'openspec/changes/add-login/proposal.md', content: 'Why' },
    { id: 'a2', kind: 'tasks', path: 'openspec/changes/add-login/tasks.md', content: '- [ ] 1.1' },
    { id: 'a3', kind: 'other', path: '../outside.md', content: 'escape' },
  ],
};

/** A fixed answer, an Error to reject with, or a function deciding per call. */
type Route = unknown;

/** Answers by "METHOD /path"; a function decides per call, an Error rejects. */
function fakeApi(routes: Record<string, Route>) {
  const calls: ApiRequest[] = [];
  const api: AdkApi = {
    request: <T>(request: ApiRequest) => {
      calls.push(request);
      const route = routes[`${request.method} ${request.path}`];
      try {
        const value =
          typeof route === 'function' ? (route as (r: ApiRequest) => unknown)(request) : route;
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value as T);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  const sent = (key: string) =>
    calls.filter((call) => `${call.method} ${call.path}` === key).map((call) => call.body);
  return { api, calls, sent };
}

const routesFor = (item: SessionDto, extra: Record<string, Route> = {}): Record<string, Route> => ({
  'GET /development/sessions': { sessions: [item] },
  'POST /development/sessions/s1/claim': { session: item },
  'GET /development/sessions/s1/brief': { session: item, change: null, feedback: [] },
  'POST /development/sessions/s1/report': { directives: { cancel: false } },
  'PUT /development/sessions/s1/diff': {},
  'POST /development/sessions/s1/complete': {},
  ...extra,
});

type Agent = (
  invocation: Invocation,
  options: Pick<StreamOptions, 'cwd' | 'stdin' | 'signal' | 'onLine'>,
) => Promise<{ exitCode: number; stderr: string }>;

const result = (text: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', result: text });
const say = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

async function setup(
  routes: Record<string, Route>,
  agent: Agent = async (_invocation, options) => {
    options.onLine(result('Done'));
    return { exitCode: 0, stderr: '' };
  },
  overrides: Partial<DevelopmentRunnerOptions> = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-runner-'));
  temporary.push(root);
  const fake = fakeApi(routes);
  const events: DevelopmentRunnerEvent[] = [];
  const git = {
    ensureWorktree: vi.fn(async (_repo: string, worktree: { path: string }) => {
      await fs.mkdir(worktree.path, { recursive: true });
      return 'created' as const;
    }),
    diff: vi.fn(async () => [
      { path: 'src/login.ts', status: 'added' as const, additions: 2, deletions: 0, patch: '+a' },
    ]),
  };
  const runAgent = vi.fn(agent);
  const runner = new DevelopmentRunner({
    api: fake.api,
    runnerName: 'laptop',
    repoRoot: path.join(root, 'repo'),
    remoteUrl: 'https://github.com/acme/shop.git',
    worktreesDir: path.join(root, 'worktrees'),
    git,
    runAgent,
    autonomy: 'safe',
    reportMs: 5,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  const worktree = path.join(root, 'worktrees', 'adk-add-login-1a2b3c4d');
  return { ...fake, runner, events, git, runAgent, worktree, root };
}

describe('DevelopmentRunner.poll', () => {
  it('runs a session of a change: worktree, artifacts, agent, reports, diff and completion', async () => {
    const item = session();
    const { runner, sent, calls, events, git, runAgent, worktree } = await setup(
      routesFor(item, {
        'GET /development/sessions/s1/brief': { session: item, change, feedback: [] },
        'PUT /development/changes/c1': {},
      }),
      async (invocation, options) => {
        expect(invocation.command).toBe('claude');
        expect(invocation.env).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' });
        expect(options.stdin).toContain('Follow the tasks');
        options.onLine(say('Working on it'));
        // The agent ticks its task off in the worktree.
        await fs.writeFile(
          path.join(options.cwd, 'openspec/changes/add-login/tasks.md'),
          '- [x] 1.1',
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        options.onLine(result('Login added'));
        return { exitCode: 0, stderr: '' };
      },
    );
    expect(await runner.poll()).toBe(item);

    expect(calls[0]).toMatchObject({ query: { status: 'queued', mine: 'true' } });
    expect(sent('POST /development/sessions/s1/claim')).toEqual([
      { runner: 'laptop', worktreePath: worktree },
    ]);
    expect(git.ensureWorktree).toHaveBeenCalledWith(expect.stringContaining('repo'), {
      branch: 'adk/add-login-1a2b3c4d',
      baseBranch: 'main',
      path: worktree,
    });
    expect(runAgent.mock.calls[0]![1].cwd).toBe(worktree);
    expect(
      await fs.readFile(path.join(worktree, 'openspec/changes/add-login/proposal.md'), 'utf8'),
    ).toBe('Why');
    // A path that leaves the worktree is never written.
    await expect(fs.access(path.join(worktree, '..', 'outside.md'))).rejects.toThrow();

    const reports = sent('POST /development/sessions/s1/report') as {
      events: { kind: string; text: string }[];
    }[];
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports.flatMap((report) => report.events)).toEqual([
      { kind: 'status', text: 'Worktree created: adk-add-login-1a2b3c4d' },
      { kind: 'message', text: 'Working on it' },
    ]);
    expect(sent('PUT /development/changes/c1')).toEqual([
      {
        artifacts: [
          change.artifacts[0],
          { ...change.artifacts[1], content: '- [x] 1.1' },
          change.artifacts[2],
        ],
      },
    ]);
    expect(git.diff).toHaveBeenCalledWith(worktree, 'main');
    expect(sent('PUT /development/sessions/s1/diff')).toEqual([
      { files: [expect.objectContaining({ path: 'src/login.ts' })] },
    ]);
    expect(sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'succeeded', summary: 'Login added' },
    ]);
    expect(events.map((event) => event.type)).toEqual(['claimed', 'worktree', 'finished']);
    expect(events[2]).toMatchObject({ outcome: 'succeeded', files: 1, error: null });
  });

  it('leaves the change alone when the agent did not touch its artifacts', async () => {
    const item = session();
    const { runner, sent } = await setup(
      routesFor(item, {
        'GET /development/sessions/s1/brief': {
          session: item,
          change: { ...change, artifacts: change.artifacts.slice(0, 2) },
          feedback: [],
        },
      }),
      async (_invocation, options) => {
        await fs.rm(path.join(options.cwd, 'openspec/changes/add-login/tasks.md'));
        return { exitCode: 0, stderr: '' };
      },
    );
    await runner.poll();
    expect(sent('PUT /development/changes/c1')).toEqual([]);
    expect(sent('POST /development/sessions/s1/complete')).toEqual([{ outcome: 'succeeded' }]);
  });

  it('still finishes when ADK refuses the artifact update or the completion', async () => {
    const item = session();
    const { runner, events } = await setup(
      routesFor(item, {
        'GET /development/sessions/s1/brief': { session: item, change, feedback: [] },
        'PUT /development/changes/c1': new Error('locked'),
        'POST /development/sessions/s1/complete': new Error('gone'),
      }),
      async (_invocation, options) => {
        await fs.writeFile(path.join(options.cwd, 'openspec/changes/add-login/tasks.md'), 'x');
        return { exitCode: 0, stderr: '' };
      },
    );
    await runner.poll();
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'succeeded' });
  });

  it('waits when nothing is queued for this runner', async () => {
    const other = session({ id: 's2', repository: { id: 'acme/other', name: 'other' } });
    const none = await setup({ 'GET /development/sessions': { sessions: [] } });
    expect(await none.runner.poll()).toBeNull();
    const mismatch = await setup({ 'GET /development/sessions': { sessions: [other] } });
    expect(await mismatch.runner.poll()).toBeNull();
    const wanted = await setup(
      { 'GET /development/sessions': { sessions: [session()] } },
      undefined,
      { sessionId: 'another' },
    );
    expect(await wanted.runner.poll()).toBeNull();
  });

  it('takes the oldest session, a chosen one, or one of another repository when told to', async () => {
    const oldest = session();
    const newest = session({ id: 's2', title: 'Newer' });
    const first = await setup(
      routesFor(oldest, { 'GET /development/sessions': { sessions: [newest, oldest] } }),
    );
    expect(await first.runner.poll()).toBe(oldest);

    const chosen = await setup(
      {
        ...routesFor(oldest),
        'GET /development/sessions': { sessions: [newest, oldest] },
        'POST /development/sessions/s2/claim': {},
        'GET /development/sessions/s2/brief': { session: newest, change: null, feedback: [] },
        'POST /development/sessions/s2/report': { directives: { cancel: false } },
        'PUT /development/sessions/s2/diff': {},
        'POST /development/sessions/s2/complete': {},
      },
      undefined,
      { sessionId: 's2' },
    );
    expect(await chosen.runner.poll()).toBe(newest);

    const foreign = session({ repository: { id: 'acme/other', name: 'other' } });
    const any = await setup(routesFor(foreign), undefined, { anyRepository: true });
    expect(await any.runner.poll()).toBe(foreign);
  });

  it('skips a session another runner claimed first and reports other claim errors', async () => {
    const taken = await setup(
      routesFor(session(), {
        'POST /development/sessions/s1/claim': new AdkApiError(409, 'INVALID_STATE', 'taken'),
      }),
    );
    expect(await taken.runner.poll()).toBeNull();
    expect(taken.runAgent).not.toHaveBeenCalled();
    const broken = await setup(
      routesFor(session(), { 'POST /development/sessions/s1/claim': new Error('boom') }),
    );
    await expect(broken.runner.poll()).rejects.toThrow('boom');
  });

  it('fails the session when the agent exits with an error or reports one', async () => {
    const withStderr = await setup(routesFor(session()), async () => ({
      exitCode: 2,
      stderr: ' not signed in \n',
    }));
    await withStderr.runner.poll();
    expect(withStderr.sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'failed', error: 'not signed in' },
    ]);
    // The diff of a failed attempt is still sent: it shows how far the agent got.
    expect(withStderr.sent('PUT /development/sessions/s1/diff')).toHaveLength(1);

    const silent = await setup(routesFor(session({ cli: 'codex' })), async () => ({
      exitCode: 1,
      stderr: '',
    }));
    await silent.runner.poll();
    expect(silent.sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'failed', error: 'The codex CLI exited with code 1.' },
    ]);

    const reported = await setup(routesFor(session()), async (_invocation, options) => {
      options.onLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }));
      return { exitCode: 0, stderr: '' };
    });
    await reported.runner.poll();
    expect(reported.sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'failed', error: 'error_max_turns' },
    ]);
    expect(formatDevelopmentEvent(reported.events.at(-1)!)).toBe(
      '[devkit] Session "Implement login" failed: error_max_turns',
    );
  });

  it('fails the session when the work cannot even start', async () => {
    const unknown = await setup(routesFor(session({ cli: 'cursor' })));
    await unknown.runner.poll();
    expect(unknown.sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'failed', error: 'This runner does not know the "cursor" CLI.' },
    ]);
    expect(unknown.runAgent).not.toHaveBeenCalled();

    const noBase = await setup(routesFor(session()));
    noBase.git.ensureWorktree.mockRejectedValueOnce('no base branch');
    await noBase.runner.poll();
    expect(noBase.sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'failed', error: 'no base branch' },
    ]);
  });

  it('stops the agent when the session is cancelled in ADK', async () => {
    const { runner, sent, events } = await setup(
      routesFor(session(), {
        'POST /development/sessions/s1/report': { directives: { cancel: true } },
      }),
      (_invocation, options) =>
        new Promise((resolve) => {
          options.signal!.addEventListener('abort', () => resolve({ exitCode: 1, stderr: '' }));
        }),
    );
    await runner.poll();
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(sent('POST /development/sessions/s1/complete')).toEqual([]);
    expect(sent('PUT /development/sessions/s1/diff')).toEqual([]);
  });

  it('fails the session when the runner itself is stopped', async () => {
    const controller = new AbortController();
    const during = await setup(routesFor(session()), (_invocation, options) => {
      options.signal!.addEventListener('abort', () => undefined);
      controller.abort();
      return Promise.resolve({ exitCode: 1, stderr: '' });
    });
    await during.runner.poll(controller.signal);
    expect(during.sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'failed', error: 'The runner was stopped before the agent finished.' },
    ]);

    const before = new AbortController();
    before.abort();
    const early = await setup(routesFor(session()), (_invocation, options) =>
      Promise.resolve({ exitCode: options.signal!.aborted ? 1 : 0, stderr: '' }),
    );
    await early.runner.poll(before.signal);
    expect(early.sent('POST /development/sessions/s1/complete')).toEqual([
      { outcome: 'failed', error: 'The runner was stopped before the agent finished.' },
    ]);
  });

  it('keeps going when a report fails and sends nothing when nothing changed', async () => {
    let reports = 0;
    const { runner, sent } = await setup(
      routesFor(session(), {
        'POST /development/sessions/s1/report': () => {
          reports += 1;
          if (reports === 1) throw new Error('offline');
          return { directives: { cancel: false } };
        },
      }),
      async (_invocation, options) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        options.onLine(say('Second batch'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { exitCode: 0, stderr: '' };
      },
    );
    await runner.poll();
    expect(reports).toBe(2);
    expect(sent('POST /development/sessions/s1/complete')).toEqual([{ outcome: 'succeeded' }]);
  });

  it('reports on its default interval', async () => {
    const { runner, sent } = await setup(routesFor(session()), undefined, {
      reportMs: undefined,
    });
    await runner.poll();
    expect(sent('POST /development/sessions/s1/report')).toHaveLength(1);
  });
});

describe('DevelopmentRunner.serve', () => {
  it('stops after one session when asked to', async () => {
    const { runner, events } = await setup(routesFor(session()));
    await runner.serve({ once: true });
    expect(events.at(-1)).toMatchObject({ type: 'finished' });
  });

  it('polls again right away after a session when not asked to stop', async () => {
    const controller = new AbortController();
    let polls = 0;
    const sleeps: number[] = [];
    const { runner, events } = await setup(
      routesFor(session(), {
        'GET /development/sessions': () => {
          polls += 1;
          if (polls === 2) controller.abort();
          return { sessions: polls === 1 ? [session()] : [] };
        },
      }),
      undefined,
      {
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    await runner.serve({ signal: controller.signal });
    expect(polls).toBe(2);
    expect(events.map((event) => event.type)).toContain('finished');
    // The session was followed by a poll, not by a pause.
    expect(sleeps).toHaveLength(1);
  });

  it('idles between polls and retries with backoff while ADK is unreachable', async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    let polls = 0;
    const { runner, events } = await setup(
      {
        'GET /development/sessions': () => {
          polls += 1;
          if (polls === 1) return { sessions: [] };
          if (polls <= 7) throw polls === 2 ? 'socket closed' : new Error('ADK is down');
          controller.abort();
          return { sessions: [] };
        },
      },
      undefined,
      {
        idleMs: 7,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    await runner.serve({ signal: controller.signal });
    expect(sleeps).toEqual([7, 2000, 4000, 8000, 16000, 30000, 30000, 7]);
    expect(events[0]).toEqual({ type: 'offline', message: 'socket closed', retryInMs: 2000 });
    expect(events[1]).toMatchObject({ message: 'ADK is down' });
  });

  it('gives up when the session is no longer valid', async () => {
    const { runner } = await setup({
      'GET /development/sessions': new AdkApiError(401, 'UNAUTHORIZED', 'Sign in again'),
    });
    await expect(runner.serve()).rejects.toThrow('Sign in again');
  });

  it('waits with its own timer and wakes up when stopped', async () => {
    const controller = new AbortController();
    let polls = 0;
    const { runner } = await setup(
      {
        'GET /development/sessions': () => {
          polls += 1;
          if (polls === 2) setTimeout(() => controller.abort(), 10);
          if (polls === 3) controller.abort();
          return { sessions: [] };
        },
      },
      undefined,
      { idleMs: 5 },
    );
    const started = Date.now();
    const quick = await setup({ 'GET /development/sessions': { sessions: [] } }, undefined, {
      idleMs: 60_000,
    });
    const stopQuick = new AbortController();
    const serving = quick.runner.serve({ signal: stopQuick.signal });
    setTimeout(() => stopQuick.abort(), 20);
    await serving;
    expect(Date.now() - started).toBeLessThan(5_000);

    await runner.serve({ signal: controller.signal });
    expect(polls).toBeGreaterThanOrEqual(2);

    // Stopped while a poll was in flight: the wait that follows returns at once.
    const late = new AbortController();
    const last = await setup(
      {
        'GET /development/sessions': () => {
          late.abort();
          return { sessions: [] };
        },
      },
      undefined,
      { idleMs: 60_000 },
    );
    await last.runner.serve({ signal: late.signal });
  });

  it('uses the default idle time when none is given', async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    const { runner } = await setup({ 'GET /development/sessions': { sessions: [] } }, undefined, {
      sleep: (ms) => {
        sleeps.push(ms);
        controller.abort();
        return Promise.resolve();
      },
    });
    await runner.serve({ signal: controller.signal });
    expect(sleeps).toEqual([5000]);
  });
});

describe('runner helpers', () => {
  it('reads the HTTP status of a failed API call', () => {
    expect(statusOf(new AdkApiError(409, 'INVALID_STATE', 'taken'))).toBe(409);
    expect(statusOf({ status: '409' })).toBeUndefined();
    expect(statusOf(new Error('offline'))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf('offline')).toBeUndefined();
  });

  it('matches a session to the repository the runner was started in', () => {
    const remote = 'https://github.com/Acme/Shop.git';
    expect(matchesRepository(remote, null)).toBe(true);
    expect(matchesRepository(remote, { id: 'acme/shop', name: 'shop' })).toBe(true);
    expect(
      matchesRepository('https://dev.azure.com/org/proj/_git/Shop', { id: 'guid-1', name: 'shop' }),
    ).toBe(true);
    expect(matchesRepository(remote, { id: 'acme/other', name: 'other' })).toBe(false);
    expect(matchesRepository(remote, { id: '', name: '' })).toBe(false);
    expect(matchesRepository('', { id: 'acme/shop', name: 'shop' })).toBe(false);
  });

  it('keeps artifact files inside the worktree', () => {
    const root = path.resolve('/work/tree');
    expect(artifactFile(root, 'openspec/changes/a/tasks.md')).toBe(
      path.join(root, 'openspec', 'changes', 'a', 'tasks.md'),
    );
    expect(artifactFile(root, '../outside.md')).toBeNull();
    expect(artifactFile(root, path.resolve('/etc/passwd'))).toBeNull();
    expect(artifactFile(root, '.')).toBeNull();
  });

  it('writes the prompt with the rules, the change and the review feedback', () => {
    const plain = buildPrompt({ session: session(), change: null, feedback: [] }, '/work/tree');
    expect(plain).toContain(
      'inside the git worktree at /work/tree, on branch adk/add-login-1a2b3c4d',
    );
    expect(plain).toContain('at most 3 subagents');
    expect(plain).not.toContain('implements the change');
    expect(plain).not.toContain('reviewer asked');
    expect(plain.endsWith('Task:\nFollow the tasks')).toBe(true);

    const full = buildPrompt(
      {
        session: session({ attempt: 2 }),
        change,
        feedback: [
          { authorName: 'Alice', path: 'src/login.ts', line: 12, body: 'Handle empty password' },
          { authorName: 'Bob', path: 'src/a.ts', line: null, body: 'Rename this' },
          { authorName: 'Carol', path: null, line: null, body: 'Add tests' },
        ],
      },
      '/work/tree',
    );
    expect(full).toContain('implements the change "Add login" (add-login)');
    expect(full).toContain('  - openspec/changes/add-login/tasks.md (tasks)');
    expect(full).toContain('asked for changes on attempt 1');
    expect(full).toContain('- Alice on src/login.ts:12: Handle empty password');
    expect(full).toContain('- Bob on src/a.ts: Rename this');
    expect(full).toContain('- Carol: Add tests');
  });

  it('describes every event in one line', () => {
    const item = session();
    expect(formatDevelopmentEvent({ type: 'claimed', session: item })).toBe(
      '[devkit] Session "Implement login" (claude, attempt 1) started on this computer.',
    );
    expect(formatDevelopmentEvent({ type: 'worktree', path: '/w', state: 'reused' })).toBe(
      '[devkit] Worktree reused: /w',
    );
    expect(
      formatDevelopmentEvent({
        type: 'finished',
        session: item,
        outcome: 'succeeded',
        files: 2,
        error: null,
      }),
    ).toBe(
      '[devkit] Session "Implement login" finished: 2 changed file(s) sent for review in ADK.',
    );
    expect(formatDevelopmentEvent({ type: 'cancelled', session: item })).toContain(
      'was cancelled in ADK',
    );
    expect(formatDevelopmentEvent({ type: 'offline', message: 'down', retryInMs: 4000 })).toBe(
      '[devkit] ADK is unreachable (down); retrying development sessions in 4 s.',
    );
  });
});
