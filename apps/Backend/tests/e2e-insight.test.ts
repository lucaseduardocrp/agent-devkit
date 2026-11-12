import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { encryptSecret } from '../src/shared/encryption.js';
import { PrismaE2eEnvironmentStore } from '../src/modules/e2e/adapters/prisma-e2e-environment-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  E2eEnvironmentService,
  InMemoryE2eEnvironmentStore,
  variablesOf,
} from '../src/modules/e2e/application/e2e-environments.js';
import {
  ExplorationRecorder,
  readExploration,
} from '../src/modules/e2e/application/e2e-exploration.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import type { E2ePageSnapshot } from '../src/modules/e2e/application/e2e-runner.js';
import { LocalE2eRunner, decodeRunnerInput } from '../src/modules/e2e/application/local-runner.js';
import { InMemoryE2eRunnerTaskStore } from '../src/modules/e2e/application/runner-tasks.js';
import {
  buildActionMap,
  explorationLiveKey,
  explorationPageKey,
  explorationStateKey,
  liveFrameKey,
  liveLabelKey,
  normalizeVariables,
  trailImageKey,
  trailKey,
  type E2eStoredTrail,
} from '../src/modules/e2e/domain/e2e-insight.js';

const creation = { workspaceId: 'ws', id: 'run' };
const test = { workspaceId: 'ws', creationId: 'run', id: 't1' };

describe('artifact keys of a run', () => {
  it('keeps exploration, trail and live files under the run folder', () => {
    expect(explorationStateKey(creation)).toBe('ws/run/exploration/state.json');
    expect(explorationLiveKey(creation)).toBe('ws/run/exploration/live.jpg');
    expect(explorationPageKey(creation, 3)).toBe('ws/run/exploration/page-03.jpg');
    expect(trailKey(test)).toBe('ws/run/trail/t1/trail.json');
    expect(trailImageKey(test, 'element', 12)).toBe('ws/run/trail/t1/element-012.jpg');
    expect(liveFrameKey(test)).toBe('ws/run/live/t1.jpg');
    expect(liveLabelKey(test)).toBe('ws/run/live/t1.json');
  });
});

describe('custom variables', () => {
  it('uppercases names and keeps values as given', () => {
    expect(
      normalizeVariables([
        { key: ' plan ', value: ' Premium ' },
        { key: 'API_KEY2', value: '' },
      ]),
    ).toEqual({ PLAN: ' Premium ', API_KEY2: '' });
  });

  it.each([['1ST'], ['with space'], ['DASH-ED'], ['']])('rejects the name "%s"', (key) => {
    expect(() => normalizeVariables([{ key, value: 'x' }])).toThrow(
      expect.objectContaining({ code: 'E2E_INVALID_VARIABLE' }),
    );
  });

  it('rejects repeated names', () => {
    expect(() =>
      normalizeVariables([
        { key: 'plan', value: 'a' },
        { key: 'PLAN', value: 'b' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'E2E_INVALID_VARIABLE' }));
  });
});

describe('action map', () => {
  const page = (index: number, url: string, title: string, hasScreenshot = true) => ({
    index,
    url,
    title,
    hasScreenshot,
  });
  const element = (index: number, pageIndex: number, name: string, hasScreenshot = true) => ({
    index,
    pageIndex,
    kind: 'button',
    name,
    box: { x: 0, y: 0, width: 0.1, height: 0.1 },
    hasScreenshot,
  });
  const touch = (pageIndex: number, elementIndex: number | null, step = 1) => ({
    atMs: 1,
    step,
    action: 'click' as const,
    pageIndex,
    elementIndex,
    value: null,
  });

  it('merges the trails of the tests into pages, edges and paths', () => {
    const first: E2eStoredTrail = {
      pages: [
        page(1, 'http://app/login?next=%2F', 'Sign in', false),
        page(2, 'http://app/', 'Home'),
      ],
      elements: [element(1, 1, 'Enter', false), element(2, 2, 'New')],
      touches: [touch(1, 1), touch(2, 2), touch(2, null), touch(2, 9), touch(7, 1)],
      // Unknown pages and staying on the same page add no stop; going back does.
      visits: [1, 2, 2, 9, 1],
    };
    const second: E2eStoredTrail = {
      pages: [page(1, 'http://app/login?next=%2F', 'Sign in'), page(2, 'not a url', 'Blank')],
      elements: [element(1, 1, 'Enter')],
      touches: [touch(1, 1, 2)],
      visits: [1, 2],
    };
    const map = buildActionMap([
      { test: { id: 'a', status: 'passed' }, trail: first },
      { test: { id: 'b', status: 'failed' }, trail: second },
      { test: { id: 'c', status: 'error' }, trail: null },
      {
        test: { id: 'd', status: 'running' },
        trail: null,
        live: { step: 1, action: 'click', kind: 'button', name: 'Go' },
      },
    ]);

    const signIn = '/login?next=%2F | Sign in';
    const home = '/ | Home';
    const blank = 'not a url | Blank';
    expect(map.pages.map((item) => [item.id, item.path, item.testIds, item.touches])).toEqual([
      [signIn, '/login?next=%2F', ['a', 'b'], 2],
      [home, '/', ['a'], 3],
      [blank, 'not a url', ['b'], 0],
    ]);
    // The first test had no screenshot of the sign-in page, so the second one's is used.
    expect(map.pages[0]!.image).toEqual({ testId: 'b', index: 1 });
    expect(map.pages[1]!.image).toEqual({ testId: 'a', index: 2 });
    expect(map.pages[2]!.failedTestIds).toEqual(['b']);
    expect(map.pages[0]!.failedTestIds).toEqual([]);

    const enter = map.pages[0]!.elements[0]!;
    expect(enter).toMatchObject({ kind: 'button', name: 'Enter', image: null });
    expect(enter.touches).toEqual([
      { testId: 'a', step: 1, action: 'click', value: null },
      { testId: 'b', step: 2, action: 'click', value: null },
    ]);
    expect(map.pages[1]!.elements).toHaveLength(1);
    expect(map.pages[1]!.elements[0]!.image).toEqual({ testId: 'a', index: 2 });

    expect(map.edges).toEqual([
      { from: null, to: signIn, testIds: ['a', 'b'] },
      { from: signIn, to: home, testIds: ['a'] },
      { from: home, to: signIn, testIds: ['a'] },
      { from: signIn, to: blank, testIds: ['b'] },
    ]);
    expect(map.tests).toEqual([
      { id: 'a', status: 'passed', path: [signIn, home, signIn], live: null },
      { id: 'b', status: 'failed', path: [signIn, blank], live: null },
      { id: 'c', status: 'error', path: [], live: null },
      {
        id: 'd',
        status: 'running',
        path: [],
        live: { step: 1, action: 'click', kind: 'button', name: 'Go' },
      },
    ]);
  });
});

describe('saved environments', () => {
  it('creates, lists, updates and deletes environments without exposing secrets', async () => {
    const store = new InMemoryE2eEnvironmentStore();
    const service = new E2eEnvironmentService(store);
    const created = await service.create('ws', {
      name: ' Staging ',
      baseUrl: 'https://staging.example.com/app',
      username: ' qa@example.com ',
      password: 'pw-1',
      variables: [{ key: 'plan', value: 'premium' }],
    });
    expect(created).toMatchObject({
      name: 'Staging',
      baseUrl: 'https://staging.example.com',
      username: 'qa@example.com',
      hasPassword: true,
      isDefault: true,
      variableNames: ['PLAN'],
    });
    expect(JSON.stringify(created)).not.toMatch(/pw-1|premium|Secret/);

    const bare = await service.create('ws', { name: 'Local', baseUrl: 'http://localhost:3000' });
    expect(bare).toMatchObject({
      username: null,
      hasPassword: false,
      isDefault: false,
      variableNames: [],
    });
    expect((await store.get('ws', bare.id))!.variablesSecret).toBeNull();
    expect((await service.list('ws')).map((item) => [item.name, item.isDefault])).toEqual([
      ['Staging', true],
      ['Local', false],
    ]);
    expect(await service.list('other')).toEqual([]);

    // The account and saved values stay when the form sends neither the password nor the values.
    const kept = await service.update('ws', created.id, {
      name: 'Staging',
      baseUrl: 'https://staging.example.com',
      username: 'qa@example.com',
      variables: [{ key: 'PLAN' }, { key: 'region', value: 'eu' }, { key: 'EMPTY' }],
    });
    expect(kept).toMatchObject({ hasPassword: true, variableNames: ['PLAN', 'REGION', 'EMPTY'] });
    expect(await service.variables('ws', created.id)).toEqual({
      PLAN: 'premium',
      REGION: 'eu',
      EMPTY: '',
    });

    const rotated = await service.update('ws', created.id, {
      name: 'Staging',
      baseUrl: 'https://staging.example.com',
      username: 'qa@example.com',
      password: 'pw-2',
    });
    expect(rotated).toMatchObject({ hasPassword: true, variableNames: [] });
    expect(await service.variables('ws', created.id)).toEqual({});

    // Without an account the password goes too.
    const anonymous = await service.update('ws', created.id, {
      name: 'Staging',
      baseUrl: 'https://staging.example.com',
    });
    expect(anonymous).toMatchObject({ username: null, hasPassword: false });

    await service.delete('ws', created.id);
    expect((await service.list('ws')).map((item) => item.isDefault)).toEqual([true]);
    await expect(service.delete('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_ENVIRONMENT_NOT_FOUND',
    });
    await expect(service.find('other', bare.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await store.update('ws', 'missing', { name: 'x' })).toBeNull();
    expect(await store.delete('ws', 'missing')).toBe(false);
  });

  it('gives no variables for a run without environment or with unreadable ones', async () => {
    const service = new E2eEnvironmentService(new InMemoryE2eEnvironmentStore());
    expect(await service.variables('ws', null)).toEqual({});
    expect(await service.variables('ws', undefined)).toEqual({});
    expect(await service.variables('ws', 'deleted')).toEqual({});
    expect(variablesOf({ variablesSecret: 'not-a-ciphertext' })).toEqual({});
    expect(variablesOf({ variablesSecret: encryptSecret('{"A":"1"}') })).toEqual({ A: '1' });
  });

  it('rejects invalid addresses and too many variables', async () => {
    const service = new E2eEnvironmentService(new InMemoryE2eEnvironmentStore());
    await expect(service.create('ws', { name: 'x', baseUrl: 'ftp://nope' })).rejects.toMatchObject({
      code: 'E2E_INVALID_URL',
    });
    await expect(
      service.create('ws', {
        name: 'x',
        baseUrl: 'http://app',
        variables: Array.from({ length: 31 }, (_, index) => ({ key: `V${index}`, value: '' })),
      }),
    ).rejects.toMatchObject({ code: 'E2E_INVALID_VARIABLE' });
  });

  it('maps the database rows of environments', async () => {
    const row = {
      id: 'e1',
      workspaceId: 'ws',
      name: 'Staging',
      baseUrl: 'https://s',
      username: null,
      passwordSecret: null,
      variablesSecret: null,
      variableNames: ['A', 3],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const record = {
      findMany: vi.fn().mockResolvedValue([row, { ...row, variableNames: 'broken' }]),
      findFirst: vi.fn().mockResolvedValue(row),
      create: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const store = new PrismaE2eEnvironmentStore({
      e2eEnvironmentRecord: record,
    } as unknown as PrismaClient);

    expect((await store.list('ws')).map((item) => item.variableNames)).toEqual([['A'], []]);
    expect(record.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws' },
      orderBy: { createdAt: 'asc' },
    });
    expect(await store.get('ws', 'e1')).toMatchObject({ id: 'e1', variableNames: ['A'] });
    const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = row;
    expect(await store.create({ ...input, variableNames: ['A'] })).toMatchObject({ id: 'e1' });
    expect(await store.update('ws', 'e1', { name: 'Renamed' })).toMatchObject({ id: 'e1' });
    expect(record.updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', workspaceId: 'ws' },
      data: { name: 'Renamed' },
    });
    expect(await store.delete('ws', 'e1')).toBe(true);

    record.findFirst.mockResolvedValue(null);
    record.updateMany.mockResolvedValue({ count: 0 });
    record.deleteMany.mockResolvedValue({ count: 0 });
    expect(await store.get('ws', 'e1')).toBeNull();
    expect(await store.update('ws', 'e1', { name: 'x' })).toBeNull();
    expect(await store.delete('ws', 'e1')).toBe(false);
  });
});

describe('exploration recorder', () => {
  const snapshot = (overrides: Partial<E2ePageSnapshot> = {}): E2ePageSnapshot => ({
    url: 'http://app/',
    title: 'App',
    headings: ['Issues', 'Open', 'Issues'],
    buttons: Array.from({ length: 12 }, (_, index) => `Button ${index}`),
    links: [],
    fields: [],
    testIds: [],
    ...overrides,
  });

  it('records phases, the log, pages and the live frame as the agent reports them', async () => {
    const artifacts = new InMemoryE2eArtifactStore();
    await artifacts.put(explorationPageKey(creation, 9), Buffer.from('from an older exploration'));
    let now = 1_000;
    const recorder = await ExplorationRecorder.start(artifacts, creation, true, () => now);
    expect(await artifacts.get(explorationPageKey(creation, 9))).toBeNull();
    expect(await readExploration(artifacts, creation)).toMatchObject({
      status: 'signing_in',
      signedInMs: null,
      finishedAt: null,
      pages: [],
      log: [],
      hasLiveFrame: false,
    });

    now = 1_700;
    recorder.onProgress({ kind: 'frame', image: Buffer.from('frame-1') });
    // Too close to the previous frame: dropped.
    recorder.onProgress({ kind: 'frame', image: Buffer.from('frame-2') });
    recorder.onProgress({
      kind: 'log',
      action: 'sign_in',
      target: 'qa@example.com',
      result: 'Home',
    });
    recorder.onProgress({ kind: 'phase', phase: 'exploring' });
    recorder.onProgress({
      kind: 'page',
      page: snapshot(),
      screenshot: Buffer.from('page-1'),
    });
    recorder.onProgress({
      kind: 'page',
      page: snapshot({ title: '', headings: [], url: 'http://app/raw' }),
      screenshot: null,
    });
    recorder.onProgress({
      kind: 'page',
      page: snapshot({ title: 'Only title', headings: [] }),
      screenshot: null,
    });
    await vi.waitFor(async () =>
      expect((await readExploration(artifacts, creation))!.pages).toHaveLength(3),
    );
    now = 2_400;
    recorder.onProgress({ kind: 'frame', image: Buffer.from('frame-3') });
    await vi.waitFor(async () =>
      expect((await artifacts.get(explorationLiveKey(creation)))!.toString()).toBe('frame-3'),
    );

    const live = (await readExploration(artifacts, creation))!;
    expect(live).toMatchObject({ status: 'exploring', signedInMs: 700, hasLiveFrame: true });
    expect(live.log).toEqual([
      { atMs: 700, action: 'sign_in', target: 'qa@example.com', result: 'Home' },
    ]);
    expect(live.pages).toEqual([
      {
        index: 1,
        url: 'http://app/',
        title: 'Issues',
        summary: 'App · Issues · Open',
        elements: Array.from({ length: 8 }, (_, index) => `Button ${index}`),
        hasScreenshot: true,
      },
      expect.objectContaining({
        index: 2,
        title: 'http://app/raw',
        summary: '',
        hasScreenshot: false,
      }),
      expect.objectContaining({ index: 3, title: 'Only title', summary: 'Only title' }),
    ]);
    expect((await artifacts.get(explorationPageKey(creation, 1)))!.toString()).toBe('page-1');
    expect(await artifacts.get(explorationPageKey(creation, 2))).toBeNull();

    now = 5_000;
    await recorder.finish();
    expect(await readExploration(artifacts, creation)).toMatchObject({
      status: 'ready',
      error: null,
      hasLiveFrame: false,
      finishedAt: new Date(5_000).toISOString(),
    });
    expect(await artifacts.get(explorationLiveKey(creation))).toBeNull();
  });

  it('stops growing at its limits and records why an exploration failed', async () => {
    const artifacts = new InMemoryE2eArtifactStore();
    const recorder = await ExplorationRecorder.start(artifacts, creation, false);
    expect((await readExploration(artifacts, creation))!.status).toBe('exploring');
    for (let index = 0; index < 62; index++)
      recorder.onProgress({
        kind: 'page',
        page: snapshot({ url: `http://app/${index}` }),
        screenshot: null,
      });
    for (let index = 0; index < 202; index++)
      recorder.onProgress({
        kind: 'log',
        action: 'click',
        target: `Item ${index}`,
        result: null,
      });
    await recorder.fail('The application is unreachable.');
    const state = (await readExploration(artifacts, creation))!;
    expect(state).toMatchObject({
      status: 'failed',
      error: 'The application is unreachable.',
      signedInMs: null,
    });
    expect(state.pages).toHaveLength(60);
    expect(state.log).toHaveLength(200);
  });

  it('keeps the script of every finished exploration in the store, with its description', async () => {
    const artifacts = new InMemoryE2eArtifactStore();
    const store = new InMemoryE2eStore();
    const recorder = await ExplorationRecorder.start(artifacts, creation, false, () => 1_000, {
      description: '  Only the billing screens  ',
      keep: async (script) => {
        await store.saveExplorationScript(script);
        return 'database';
      },
    });
    recorder.onProgress({ kind: 'log', action: 'click', target: 'Billing', result: 'Invoices' });
    recorder.onProgress({
      kind: 'page',
      page: snapshot({ url: 'http://app/billing' }),
      screenshot: Buffer.from('shot'),
    });
    await recorder.finish();
    expect((await readExploration(artifacts, creation))!.description).toBe(
      'Only the billing screens',
    );

    const [kept] = await store.listExplorationScripts('ws', 'run');
    expect(kept).toMatchObject({
      workspaceId: 'ws',
      creationId: 'run',
      description: 'Only the billing screens',
      status: 'ready',
      script: [{ action: 'click', target: 'Billing', result: 'Invoices' }],
      pages: [{ url: 'http://app/billing', hasScreenshot: false }],
    });

    // A later exploration of the run adds another script instead of replacing this one.
    const second = await ExplorationRecorder.start(artifacts, creation, false, () => 2_000, {
      keep: async (script) => {
        await store.saveExplorationScript(script);
        return 'database';
      },
    });
    await second.fail('Unreachable.');
    const all = await store.listExplorationScripts('ws');
    expect(all).toHaveLength(2);
    expect(all.map((script) => script.status).sort()).toEqual(['failed', 'ready']);
    expect(all.find((script) => script.status === 'failed')).toMatchObject({
      description: null,
      error: 'Unreachable.',
    });
    expect(await store.getExplorationScript('other', kept!.id)).toBeNull();
    expect(await store.deleteExplorationScript('ws', kept!.id)).toBe(true);
    expect(await store.deleteExplorationScript('ws', kept!.id)).toBe(false);
  });

  it('keeps recording after a storage failure and reads missing or broken state as none', async () => {
    const artifacts = new InMemoryE2eArtifactStore();
    const recorder = await ExplorationRecorder.start(artifacts, creation, false);
    const put = vi.spyOn(artifacts, 'put').mockRejectedValueOnce(new Error('storage down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    recorder.onProgress({ kind: 'phase', phase: 'signing_in' });
    recorder.onProgress({ kind: 'phase', phase: 'exploring' });
    await recorder.finish();
    expect(logged).toHaveBeenCalledWith('[E2eExploration] Could not record:', expect.any(Error));
    expect((await readExploration(artifacts, creation))!.status).toBe('ready');
    put.mockRestore();
    logged.mockRestore();

    expect(await readExploration(artifacts, { workspaceId: 'ws', id: 'never' })).toBeNull();
    await artifacts.put(explorationStateKey(creation), Buffer.from('{broken'));
    expect(await readExploration(artifacts, creation)).toBeNull();
  });
});

describe('local runner tasks', () => {
  const target = { workspaceId: 'ws', creationId: 'c1', testId: 't1', userId: 'user' };

  function runnerFinishing(result: unknown) {
    const tasks = new InMemoryE2eRunnerTaskStore();
    const create = vi.spyOn(tasks, 'create');
    const get = tasks.get.bind(tasks);
    vi.spyOn(tasks, 'get').mockImplementation(async (id) => {
      const task = await get(id);
      return task && { ...task, status: 'succeeded', result: JSON.stringify(result) };
    });
    const runner = new LocalE2eRunner({
      tasks,
      artifacts: new InMemoryE2eArtifactStore(),
      pollMs: 1,
    }).for(target);
    return { runner, payload: () => decodeRunnerInput(create.mock.lastCall![0].payload) };
  }

  it('sends the test account with an exploration so the runner can sign in', async () => {
    const { runner, payload } = runnerFinishing({ kind: 'explore', snapshot: { pages: [] } });
    const credentials = { username: 'qa', password: 'pw' };
    await runner.explore({ mode: 'frontend', url: 'http://localhost:1/', credentials });
    expect(payload()).toMatchObject({ kind: 'explore', credentials });
    await runner.explore({ mode: 'frontend', url: 'http://localhost:1/' });
    expect(payload()).not.toHaveProperty('credentials');
    expect(payload()).not.toHaveProperty('thorough');
    // The exploration of the Source asks the runner to map the whole application.
    await runner.explore({ mode: 'frontend', url: 'http://localhost:1/', thorough: true });
    expect(payload()).toMatchObject({ kind: 'explore', thorough: true });
  });

  it('sends the custom variables of the environment with a run', async () => {
    const { runner, payload } = runnerFinishing({
      kind: 'run',
      status: 'passed',
      durationMs: 1,
      error: null,
      logs: '',
      steps: [],
      hasVideo: false,
    });
    const input = {
      script: 'x',
      mode: 'frontend' as const,
      baseUrl: 'http://localhost:1',
      locale: 'en-US',
      credentials: { username: null, password: null },
    };
    await runner.run({ ...input, variables: { PLAN: 'premium' } });
    expect(payload()).toMatchObject({ kind: 'run', variables: { PLAN: 'premium' } });
    await runner.run(input);
    expect(payload()).not.toHaveProperty('variables');
  });
});
