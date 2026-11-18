import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiError,
  createApi,
  DevelopmentHost,
  parseState,
  worktreesDir,
  type DevelopmentHostOptions,
} from '../src/main/development.js';
import type { DevelopmentRunnerOptions } from '../src/vendor/development/runner.js';

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe('parseState', () => {
  it('starts over from a damaged or foreign file', () => {
    const empty = { assignments: {}, lastRepoPath: null, autonomy: 'safe' };
    expect(parseState('')).toEqual(empty);
    expect(parseState('3')).toEqual(empty);
    expect(parseState('{"assignments":4,"autonomy":"wild","lastRepoPath":7}')).toEqual(empty);
  });

  it('keeps the assignments that have a folder', () => {
    const state = parseState(
      JSON.stringify({
        lastRepoPath: '/repo',
        autonomy: 'auto',
        assignments: {
          s1: { repoPath: '/repo', autonomy: 'auto', worktreePath: '/wt/s1' },
          s2: { repoPath: '/repo', autonomy: 'x' },
          s3: { autonomy: 'auto' },
          s4: null,
        },
      }),
    );
    expect(state).toEqual({
      lastRepoPath: '/repo',
      autonomy: 'auto',
      assignments: {
        s1: { repoPath: '/repo', autonomy: 'auto', worktreePath: '/wt/s1' },
        s2: { repoPath: '/repo', autonomy: 'safe', worktreePath: null },
      },
    });
  });
});

describe('createApi', () => {
  it('refuses to call the API with nobody signed in', async () => {
    const fetcher = vi.fn();
    const api = createApi(
      () => 'http://127.0.0.1:3000',
      () => undefined,
      fetcher,
    );
    await expect(api.request({ method: 'GET', path: '/development/sessions' })).rejects.toThrow(
      new ApiError(401, 'Not signed in.'),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls the API as the signed-in person', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({ ok: true })));
    const api = createApi(
      () => 'http://127.0.0.1:3000',
      () => ({ token: 't0', workspaceId: 'ws' }),
      fetcher,
    );
    expect(
      await api.request({
        method: 'POST',
        path: '/development/sessions/s1/claim',
        query: { a: '1' },
        body: { runner: 'me' },
      }),
    ).toEqual({ ok: true });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:3000/development/sessions/s1/claim?a=1');
    expect(init).toEqual({
      method: 'POST',
      headers: {
        authorization: 'Bearer t0',
        'x-workspace-id': 'ws',
        'content-type': 'application/json',
      },
      body: '{"runner":"me"}',
    });
  });

  it('sends no workspace or body when there is none, and explains failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(undefined, 204))
      .mockResolvedValueOnce(json({ message: 'Session not found.' }, 404))
      .mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    const api = createApi(
      () => 'http://127.0.0.1:3000',
      () => ({ token: 't0', workspaceId: null }),
      fetcher,
    );
    expect(await api.request({ method: 'GET', path: '/development/sessions' })).toBeNull();
    expect(fetcher.mock.calls[0]![1]).toEqual({
      method: 'GET',
      headers: { authorization: 'Bearer t0' },
    });
    await expect(api.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      status: 404,
      message: 'Session not found.',
    });
    await expect(api.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      status: 502,
      message: 'HTTP 502',
    });
  });
});

describe('DevelopmentHost', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function host(overrides: Partial<DevelopmentHostOptions> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'adk-dev-host-'));
    temporary.push(dir);
    const logs: string[] = [];
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({ sessions: [] })));
    const created: DevelopmentRunnerOptions[] = [];
    const options: DevelopmentHostOptions = {
      apiUrl: () => 'http://127.0.0.1:3000',
      stateFile: join(dir, 'state', 'development.json'),
      runnerName: 'Desktop',
      git: {
        root: (folder: string) =>
          folder === '/nowhere'
            ? Promise.reject(new Error('git rev-parse failed'))
            : Promise.resolve(`${folder}-root`),
        ensureWorktree: () => Promise.resolve('created' as const),
        diff: () => Promise.resolve([]),
      },
      runAgent: () => Promise.resolve({ exitCode: 0, stderr: '' }),
      log: (line) => logs.push(line),
      fetch: fetcher,
      createRunner: (runnerOptions) => {
        created.push(runnerOptions);
        return { poll: () => Promise.resolve(null) };
      },
      ...overrides,
    };
    return { dir, logs, fetcher, created, options, instance: new DevelopmentHost(options) };
  }
  const queued = (...ids: string[]) =>
    Promise.resolve(json({ sessions: ids.map((id) => ({ id })) }));

  it('puts the worktrees next to the repository', () => {
    expect(worktreesDir(join('work', 'shop'))).toBe(join('work', '.adk-worktrees', 'shop'));
  });

  it('remembers the folder of each session between launches', async () => {
    const { instance, options } = await host();
    await instance.load();
    expect(instance.preferences()).toEqual({ lastRepoPath: null, autonomy: 'safe' });
    expect(instance.assignment('s1')).toBeNull();
    expect(() => instance.worktree('s1')).toThrow('no worktree');

    expect(await instance.assign('s1', '/repo', 'auto')).toEqual({
      repoPath: '/repo-root',
      autonomy: 'auto',
      worktreePath: null,
    });
    await expect(instance.assign('s2', '/nowhere', 'safe')).rejects.toThrow('git rev-parse');
    expect(() => instance.worktree('s1')).toThrow('no worktree');

    const again = new DevelopmentHost(options);
    await again.load();
    expect(again.preferences()).toEqual({ lastRepoPath: '/repo-root', autonomy: 'auto' });
    expect(again.assignment('s1')?.repoPath).toBe('/repo-root');
  });

  it('does nothing until somebody is signed in', async () => {
    const { instance, fetcher } = await host();
    await instance.tick();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('starts the queued sessions that have a folder and records their worktree', async () => {
    const { instance, fetcher, logs, options } = await host({
      createRunner: (runnerOptions) => ({
        poll: () => {
          runnerOptions.onEvent?.({ type: 'offline', message: 'x', retryInMs: 1000 });
          runnerOptions.onEvent?.({ type: 'worktree', path: '/wt/s1', state: 'created' });
          return Promise.resolve(null);
        },
      }),
    });
    fetcher.mockImplementation(() => queued('s1', 's2'));
    instance.connect({ token: 't0', workspaceId: 'ws' });
    await instance.assign('s1', '/repo', 'safe');
    await instance.tick();
    await vi.waitFor(async () =>
      expect(
        (JSON.parse(await readFile(options.stateFile, 'utf8')) as { assignments: unknown })
          .assignments,
      ).toEqual({ s1: { repoPath: '/repo-root', autonomy: 'safe', worktreePath: '/wt/s1' } }),
    );
    expect(instance.worktree('s1')).toBe('/wt/s1');
    expect(logs).toEqual([
      '[development] ADK is unreachable (x); retrying development sessions in 1 s.',
      '[development] Worktree created: /wt/s1',
    ]);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:3000/development/sessions?status=queued&mine=true',
    );
    // A new folder for the session keeps the worktree it already has.
    expect((await instance.assign('s1', '/other', 'auto')).worktreePath).toBe('/wt/s1');
  });

  it('hands the runner the folder, the autonomy and the session to execute', async () => {
    const { instance, fetcher, created } = await host();
    fetcher.mockImplementation(() => queued('s1'));
    instance.connect({ token: 't0', workspaceId: null });
    await instance.assign('s1', join('work', 'shop'), 'auto');
    await instance.tick();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      runnerName: 'Desktop',
      repoRoot: `${join('work', 'shop')}-root`,
      worktreesDir: join('work', '.adk-worktrees', 'shop-root'),
      autonomy: 'auto',
      sessionId: 's1',
      anyRepository: true,
    });
  });

  it('runs a session once at a time and stops the agents on request', async () => {
    let finish = () => {};
    let signal: AbortSignal | undefined;
    const polls = vi.fn((given?: AbortSignal) => {
      signal = given;
      return new Promise<null>((resolve) => (finish = () => resolve(null)));
    });
    const { instance, fetcher } = await host({ createRunner: () => ({ poll: polls }) });
    let release = () => {};
    fetcher.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(json({ sessions: [{ id: 's1' }] })))),
    );
    fetcher.mockImplementation(() => queued('s1'));
    instance.connect({ token: 't0', workspaceId: null });
    await instance.assign('s1', '/repo', 'safe');

    const first = instance.tick();
    await instance.tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    await first;
    await instance.tick();
    expect(polls).toHaveBeenCalledTimes(1);

    instance.stop();
    expect(signal?.aborted).toBe(true);
    finish();
    await vi.waitFor(async () => {
      await instance.tick();
      expect(polls).toHaveBeenCalledTimes(2);
    });
  });

  it('logs a session that could not run and a state that could not be saved', async () => {
    const { instance, fetcher, logs, dir } = await host({
      createRunner: (runnerOptions) => ({
        poll: () => {
          runnerOptions.onEvent?.({ type: 'worktree', path: '/wt/s1', state: 'reused' });
          return Promise.reject(new Error('git is missing'));
        },
      }),
    });
    fetcher.mockImplementation(() => queued('s1'));
    instance.connect({ token: 't0', workspaceId: null });
    await instance.assign('s1', '/repo', 'safe');
    // The folder of the state file becomes a file: nothing can be written there anymore.
    await rm(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state'), '');
    await instance.tick();
    await vi.waitFor(() => expect(logs).toHaveLength(3));
    expect(logs[0]).toBe('[development] Worktree reused: /wt/s1');
    expect(logs).toContain('[development] Session s1: Error: git is missing');
    expect(instance.worktree('s1')).toBe('/wt/s1');
  });

  it('signs out when the session expired and logs other failures', async () => {
    const { instance, fetcher, logs } = await host();
    fetcher
      .mockResolvedValueOnce(json({ message: 'boom' }, 500))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ message: 'expired' }, 401));
    instance.connect({ token: 't0', workspaceId: null });
    await instance.tick();
    await instance.tick();
    expect(logs).toEqual(['[development] Error: boom', '[development] Error: offline']);
    await instance.tick();
    await instance.tick();
    expect(fetcher).toHaveBeenCalledTimes(3);
    instance.connect(undefined);
  });

  it('executes with the runner of the CLI by default', async () => {
    const { instance, fetcher, dir } = await host({ createRunner: undefined });
    await mkdir(join(dir, 'repo'));
    fetcher.mockImplementationOnce(() => queued('s1'));
    instance.connect({ token: 't0', workspaceId: null });
    await instance.assign('s1', join(dir, 'repo'), 'safe');
    await instance.tick();
    // The runner asks for the queue itself and finds the session gone.
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
