import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import type {
  E2eExploreInput,
  E2eRunInput,
  E2eRunResult,
  E2eRunner,
  E2eSnapshot,
} from '../src/modules/e2e/application/e2e-runner.js';
import { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import {
  explorationStateKey,
  liveFrameKey,
  trailKey,
} from '../src/modules/e2e/domain/e2e-insight.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };
const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001', async ({ page }) => { await page.goto('/'); await expect(page).toHaveURL('/'); });`;

const pageSnapshot = {
  url: 'http://localhost:4000/',
  title: 'App',
  headings: ['Issues'],
  buttons: ['New issue'],
  links: [],
  fields: [],
  testIds: [],
};
const trail = {
  pages: [
    {
      index: 1,
      url: 'http://localhost:4000/login',
      title: 'Sign in',
      screenshot: Buffer.from('p1'),
    },
    { index: 2, url: 'http://localhost:4000/', title: 'Issues', screenshot: null },
  ],
  elements: [
    {
      index: 1,
      pageIndex: 1,
      kind: 'button',
      name: 'Enter',
      box: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
      screenshot: Buffer.from('e1'),
    },
    { index: 2, pageIndex: 2, kind: 'field', name: 'Search', box: null, screenshot: null },
  ],
  touches: [
    { atMs: 5, step: 1, action: 'click' as const, pageIndex: 1, elementIndex: 1, value: null },
    { atMs: 9, step: 2, action: 'type' as const, pageIndex: 2, elementIndex: 2, value: 'bug' },
  ],
  visits: [1, 2],
};
const passed: E2eRunResult = {
  status: 'passed',
  durationMs: 5,
  error: null,
  logs: 'ok',
  video: null,
  steps: [],
  trail,
};

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function setup(extra: Record<string, unknown> = {}) {
  const scripts = new FakeScriptRepository();
  const artifacts = new InMemoryE2eArtifactStore();
  const gates = { explore: Promise.resolve(), run: Promise.resolve() };
  const results: E2eRunResult[] = [];
  const runner = {
    explore: vi.fn(async (input: E2eExploreInput): Promise<E2eSnapshot> => {
      input.onProgress?.({ kind: 'frame', image: Buffer.from('explore-frame') });
      input.onProgress?.({
        kind: 'page',
        page: pageSnapshot,
        screenshot: Buffer.from('explore-page'),
      });
      input.onProgress?.({
        kind: 'log',
        action: 'navigate',
        target: input.url,
        result: 'Issues',
      });
      await gates.explore;
      return { startUrl: input.url, pages: [pageSnapshot] };
    }),
    run: vi.fn(async (input: E2eRunInput): Promise<E2eRunResult> => {
      input.onLive?.({
        image: Buffer.from('live-frame'),
        activity: { step: 1, action: 'click', kind: 'button', name: 'Enter' },
      });
      await gates.run;
      return results.shift() ?? passed;
    }),
  } satisfies E2eRunner;
  const author = {
    plan: vi.fn().mockResolvedValue({
      summary: 'PRD',
      tests: [
        { title: 'Sign in', description: 'd', priority: 'high', steps: [], category: ' Access ' },
        { title: 'Search', description: 'd', priority: 'low', steps: [] },
      ],
    }),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze: vi.fn(),
  } satisfies E2eAuthor;
  const app = createApp({
    ...extra,
    e2eRunner: runner,
    e2eAuthor: author,
    e2eArtifacts: artifacts,
    e2eScripts: scripts,
    requestContextResolver: (req) => ({
      requestId: 'e2e-insight',
      ownerId: 'ws',
      workspaceId: req.header('x-test-workspace') ?? 'ws',
      actorId: 'user',
      memberRole: 'ADMIN',
      locale: 'en-US',
    }),
  });
  return { app, runner, author, artifacts, scripts, gates, results };
}

type App = ReturnType<typeof setup>['app'];

async function createRun(app: App, overrides: Record<string, unknown> = {}) {
  const agent = await request(app)
    .post('/agents')
    .send({ name: `QA ${Math.random()}`, instructions: 'Test things.' })
    .expect(201);
  return request(app)
    .post('/e2e/creations')
    .send({
      name: 'Run',
      agentId: agent.body.agent.id,
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://localhost:4000',
      prd: 'The product.',
      repository,
      ...overrides,
    });
}

async function waitForStatus(app: App, id: string, status: string) {
  await vi.waitFor(async () => {
    const response = await request(app).get(`/e2e/creations/${id}`).expect(200);
    expect(response.body.creation.status).toBe(status);
  });
  return (await request(app).get(`/e2e/creations/${id}`)).body.creation;
}

const exploration = async (app: App, id: string) =>
  (await request(app).get(`/e2e/creations/${id}/exploration`).expect(200)).body.exploration;

describe('E2E environments routes', () => {
  it('manages the saved environments of a workspace', async () => {
    const { app } = setup();
    expect((await request(app).get('/e2e/environments').expect(200)).body.environments).toEqual([]);

    const created = await request(app)
      .post('/e2e/environments')
      .send({
        name: 'Staging',
        baseUrl: 'https://staging.example.com/',
        username: 'qa@example.com',
        password: 'pw',
        variables: [{ key: 'plan', value: 'premium' }],
      })
      .expect(201);
    const id = created.body.environment.id as string;
    expect(created.body.environment).toMatchObject({
      name: 'Staging',
      baseUrl: 'https://staging.example.com',
      hasPassword: true,
      isDefault: true,
      variableNames: ['PLAN'],
    });
    expect(JSON.stringify(created.body)).not.toContain('premium');

    const updated = await request(app)
      .put(`/e2e/environments/${id}`)
      .send({ name: 'Staging EU', baseUrl: 'https://eu.example.com', variables: [{ key: 'PLAN' }] })
      .expect(200);
    expect(updated.body.environment).toMatchObject({
      name: 'Staging EU',
      username: null,
      hasPassword: false,
      variableNames: ['PLAN'],
    });

    await request(app)
      .post('/e2e/environments')
      .send({
        name: 'Bad',
        baseUrl: 'https://x.example.com',
        variables: [{ key: '1x', value: '' }],
      })
      .expect(400);
    await request(app).post('/e2e/environments').send({ name: '', baseUrl: 'x' }).expect(400);
    await request(app)
      .put('/e2e/environments/missing')
      .send({ name: 'x', baseUrl: 'https://x.example.com' })
      .expect(404);
    await request(app).put(`/e2e/environments/${id}`).send({}).expect(400);
    // Environments belong to their workspace.
    expect(
      (await request(app).get('/e2e/environments').set('x-test-workspace', 'other')).body
        .environments,
    ).toEqual([]);

    await request(app).delete(`/e2e/environments/${id}`).expect(204);
    await request(app).delete(`/e2e/environments/${id}`).expect(404);

    const noWorkspace = createApp({
      requestContextResolver: () => ({ requestId: 'r', ownerId: 'u', memberRole: 'ADMIN' }),
    });
    const response = await request(noWorkspace).get('/e2e/environments').expect(400);
    expect(response.body.code).toBe('WORKSPACE_REQUIRED');
  });

  it('configures runs from an environment: account, password and custom variables', async () => {
    const { app, runner, author } = setup();
    const environment = (
      await request(app)
        .post('/e2e/environments')
        .send({
          name: 'Staging',
          baseUrl: 'http://localhost:4000',
          username: 'qa@example.com',
          password: 'env-password',
          variables: [{ key: 'PLAN', value: 'premium' }],
        })
        .expect(201)
    ).body.environment;

    await (
      await createRun(app, { environmentId: 'missing' })
    ).body;
    expect((await createRun(app, { environmentId: 'missing' })).status).toBe(404);

    const created = await createRun(app, {
      environmentId: environment.id,
      username: 'qa@example.com',
    });
    expect(created.status).toBe(202);
    expect(created.body.creation).toMatchObject({
      environmentId: environment.id,
      hasPassword: true,
    });
    await waitForStatus(app, created.body.creation.id, 'completed');
    expect(runner.explore.mock.calls[0]![0].credentials).toEqual({
      username: 'qa@example.com',
      password: 'env-password',
    });
    expect(runner.run.mock.calls[0]![0]).toMatchObject({
      credentials: { username: 'qa@example.com', password: 'env-password' },
      variables: { PLAN: 'premium' },
    });
    expect(author.writeScript.mock.calls[0]![0].variableNames).toEqual(['PLAN']);

    // Another account does not get the environment's password.
    const other = await createRun(app, { environmentId: environment.id, username: 'someone' });
    expect(other.body.creation).toMatchObject({ hasPassword: false });
    await waitForStatus(app, other.body.creation.id, 'completed');

    // A run moved to the environment takes its password; leaving it out keeps the link.
    const plain = await createRun(app, { username: 'qa@example.com' });
    const runId = plain.body.creation.id as string;
    expect(plain.body.creation).toMatchObject({ environmentId: null, hasPassword: false });
    await waitForStatus(app, runId, 'completed');
    const base = {
      name: 'Run',
      agentId: plain.body.creation.agentId,
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://localhost:4000',
      username: 'qa@example.com',
      prd: 'The product.',
      repository,
    };
    const linked = await request(app)
      .put(`/e2e/creations/${runId}`)
      .send({ ...base, environmentId: environment.id })
      .expect(200);
    expect(linked.body.creation).toMatchObject({
      environmentId: environment.id,
      hasPassword: true,
    });
    const kept = await request(app).put(`/e2e/creations/${runId}`).send(base).expect(200);
    expect(kept.body.creation).toMatchObject({ environmentId: environment.id, hasPassword: true });
    // Saving it again with the same environment keeps the run's own password.
    await request(app)
      .put(`/e2e/creations/${runId}`)
      .send({ ...base, environmentId: environment.id })
      .expect(200);
    const unlinked = await request(app)
      .put(`/e2e/creations/${runId}`)
      .send({ ...base, environmentId: null })
      .expect(200);
    expect(unlinked.body.creation).toMatchObject({ environmentId: null, hasPassword: true });

    // The MCP host is told which variables its specs may read.
    const host = await createRun(app, { environmentId: environment.id, planning: 'host' });
    const brief = await request(app)
      .post(`/e2e/creations/${host.body.creation.id}/brief`)
      .send({})
      .expect(200);
    expect(brief.body.brief.rules.script[0]).toContain('process.env.E2E_VAR_PLAN');
  });

  it('refuses to edit a run into one with neither a PRD nor the Brain', async () => {
    const { app } = setup();
    const created = await createRun(app);
    await request(app)
      .put(`/e2e/creations/${created.body.creation.id}`)
      .send({
        name: 'Run',
        agentId: created.body.creation.agentId,
        mode: 'frontend',
        scope: 'codebase',
        baseUrl: 'http://localhost:4000',
        prd: '',
        repository,
      })
      .expect(400);
  });

  it('refuses environments when the service has none configured', async () => {
    const service = new E2eService({
      store: new InMemoryE2eStore(),
      queue: new InMemoryE2eJobQueue(),
      dispatcher: { wake: () => Promise.resolve() },
      artifacts: new InMemoryE2eArtifactStore(),
      scripts: new FakeScriptRepository(),
      agents: { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) },
    });
    await expect(
      service.create(
        { requestId: 'r', workspaceId: 'ws', ownerId: 'ws', actorId: 'u', locale: 'en-US' },
        {
          name: 'Run',
          agentId: 'agent',
          mode: 'frontend',
          scope: 'codebase',
          baseUrl: 'http://localhost:4000',
          prd: 'x',
          environmentId: 'e1',
          repository: { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' },
        },
      ),
    ).rejects.toMatchObject({ code: 'E2E_ENVIRONMENT_NOT_FOUND' });
  });
});

describe('E2E exploration routes', () => {
  it('follows the exploration of a new run live and keeps what it captured', async () => {
    const { app, gates } = setup();
    const gate = deferred();
    gates.explore = gate.promise;
    const created = await createRun(app, { username: 'qa', password: 'pw' });
    const id = created.body.creation.id as string;

    await vi.waitFor(async () => expect((await exploration(app, id)).pages).toHaveLength(1));
    const live = await exploration(app, id);
    // The run has an account, so the agent starts by signing in.
    expect(live).toMatchObject({ status: 'signing_in', hasLiveFrame: true, finishedAt: null });
    expect(live.pages[0]).toMatchObject({ index: 1, title: 'Issues', hasScreenshot: true });
    expect(live.log).toEqual([expect.objectContaining({ action: 'navigate', result: 'Issues' })]);
    const frame = await request(app)
      .get(`/e2e/creations/${id}/exploration/images/live`)
      .expect(200);
    expect(frame.headers['content-type']).toBe('image/jpeg');
    expect(frame.headers['cache-control']).toBe('no-store');
    expect(frame.body.toString()).toBe('explore-frame');
    const page = await request(app).get(`/e2e/creations/${id}/exploration/images/1`).expect(200);
    expect(page.headers['cache-control']).toBe('private, max-age=300');
    expect(page.body.toString()).toBe('explore-page');
    await request(app).get(`/e2e/creations/${id}/exploration/images/2`).expect(404);
    await request(app).get(`/e2e/creations/${id}/exploration/images/zero`).expect(400);
    // Exploring again waits for the work in progress.
    await request(app).post(`/e2e/creations/${id}/explore`).expect(409);

    gate.release();
    await waitForStatus(app, id, 'completed');
    expect(await exploration(app, id)).toMatchObject({ status: 'ready', hasLiveFrame: false });
    await request(app).get(`/e2e/creations/${id}/exploration/images/live`).expect(404);
    await request(app).get('/e2e/creations/missing/exploration').expect(404);

    // Exploring again starts at the sign-in too, since the run has an account.
    const again = await request(app).post(`/e2e/creations/${id}/explore`).expect(202);
    expect(again.body.exploration).toMatchObject({ status: 'signing_in', pages: [] });
    await vi.waitFor(async () => expect((await exploration(app, id)).status).toBe('ready'));
  });

  it('keeps the script of each exploration, with the description it was asked for', async () => {
    const { app } = setup();
    const created = await createRun(app);
    const id = created.body.creation.id as string;
    await waitForStatus(app, id, 'completed');
    const listed = async (query = '') =>
      (await request(app).get(`/e2e/explorations${query}`).expect(200)).body.explorations;
    // The exploration that came before planning is kept too, without a description.
    await vi.waitFor(async () => expect(await listed()).toHaveLength(1));
    expect((await listed())[0]).toMatchObject({ creationId: id, description: null });

    const started = await request(app)
      .post(`/e2e/creations/${id}/explore`)
      .send({ description: '  Only the issues screen  ' })
      .expect(202);
    expect(started.body.exploration.description).toBe('Only the issues screen');
    await vi.waitFor(async () => expect(await listed(`?creationId=${id}`)).toHaveLength(2));
    const [latest] = await listed();
    expect(latest).toMatchObject({
      status: 'ready',
      description: 'Only the issues screen',
      pages: [expect.objectContaining({ title: 'Issues', hasScreenshot: false })],
      script: [expect.objectContaining({ action: 'navigate' })],
    });

    const one = await request(app).get(`/e2e/explorations/${latest.id}`).expect(200);
    expect(one.body.exploration.description).toBe('Only the issues screen');
    await request(app)
      .post(`/e2e/creations/${id}/explore`)
      .send({ description: 'x'.repeat(2_001) })
      .expect(400);
    await request(app).get('/e2e/explorations/missing').expect(404);
    await request(app).get('/e2e/explorations?creationId=missing').expect(404);
    await request(app).delete(`/e2e/explorations/${latest.id}`).expect(204);
    await request(app).delete(`/e2e/explorations/${latest.id}`).expect(404);
    expect(await listed()).toHaveLength(1);
  });

  it('hands the description to the agent as its focus', async () => {
    const { app, runner } = setup();
    const created = await createRun(app);
    const id = created.body.creation.id as string;
    await waitForStatus(app, id, 'completed');
    // The exploration that precedes planning is open.
    expect(runner.explore.mock.calls[0]![0].focus).toBeUndefined();
    await request(app)
      .post(`/e2e/creations/${id}/explore`)
      .send({ description: 'Only the billing screens' })
      .expect(202);
    await vi.waitFor(async () => expect((await exploration(app, id)).status).toBe('ready'));
    // The description plus what the run's own tests say: nothing from outside the run.
    const tests = (await request(app).get(`/e2e/creations/${id}`).expect(200)).body.creation.tests;
    const focus = runner.explore.mock.calls.at(-1)![0].focus as string;
    expect(focus.startsWith('Only the billing screens')).toBe(true);
    for (const test of tests) expect(focus).toContain(test.title);
  });

  it('keeps the script in the database only, even when asked for the repository', async () => {
    const { app, scripts } = setup();
    const created = await createRun(app);
    const id = created.body.creation.id as string;
    await waitForStatus(app, id, 'completed');
    const listed = async () =>
      (await request(app).get(`/e2e/explorations?creationId=${id}`).expect(200)).body.explorations;
    await vi.waitFor(async () => expect(await listed()).toHaveLength(1));
    const writeFile = vi.spyOn(scripts, 'writeFile');

    await request(app)
      .post(`/e2e/creations/${id}/explore`)
      .send({ description: 'Only the issues screen', storage: 'repository' })
      .expect(202);
    await vi.waitFor(async () => expect(await listed()).toHaveLength(2));
    expect(await exploration(app, id)).toMatchObject({ savedTo: 'database', saveError: null });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('explores again on request without touching the run or its tests', async () => {
    const { app, runner, artifacts, gates } = setup();
    const created = await createRun(app);
    const id = created.body.creation.id as string;
    const before = await waitForStatus(app, id, 'completed');

    const gate = deferred();
    gates.explore = gate.promise;
    const started = await request(app).post(`/e2e/creations/${id}/explore`).expect(202);
    // No account: straight to exploring, starting from nothing.
    expect(started.body.exploration).toMatchObject({ status: 'exploring', pages: [], log: [] });
    gate.release();
    await vi.waitFor(async () => expect((await exploration(app, id)).status).toBe('ready'));
    expect(runner.explore).toHaveBeenCalledTimes(2);
    const after = (await request(app).get(`/e2e/creations/${id}`)).body.creation;
    expect(after.status).toBe('completed');
    expect(after.tests.map((test: { id: string }) => test.id)).toEqual(
      before.tests.map((test: { id: string }) => test.id),
    );

    // An exploration that cannot reach the application says why.
    runner.explore.mockRejectedValueOnce(new Error('connection refused'));
    await request(app).post(`/e2e/creations/${id}/explore`).expect(202);
    await vi.waitFor(async () =>
      expect(await exploration(app, id)).toMatchObject({
        status: 'failed',
        error: 'connection refused',
      }),
    );

    // Left in progress by a worker that stopped: reported as failed instead of running forever.
    const state = JSON.parse(
      (await artifacts.get(explorationStateKey({ workspaceId: 'ws', id })))!.toString(),
    );
    await artifacts.put(
      explorationStateKey({ workspaceId: 'ws', id }),
      Buffer.from(JSON.stringify({ ...state, status: 'exploring', hasLiveFrame: true })),
    );
    expect(await exploration(app, id)).toMatchObject({ status: 'failed', hasLiveFrame: false });
  });

  it('has no exploration for API runs or runs that never explored', async () => {
    const { app } = setup();
    const created = await createRun(app, { mode: 'backend' });
    const id = created.body.creation.id as string;
    await waitForStatus(app, id, 'completed');
    expect(await exploration(app, id)).toBeNull();
  });
});

describe('E2E source routes', () => {
  const state = async (app: App, workspace?: string) =>
    (
      await request(app)
        .get('/e2e/source')
        .set('x-test-workspace', workspace ?? 'ws')
        .expect(200)
    ).body;
  const source = async (app: App) => (await state(app)).source;
  const documentation = {
    overview: '# App',
    areas: [{ name: 'Issues', description: '', flows: [] }],
    brainDocuments: [],
    generatedAt: '2026-11-11T10:00:00.000Z',
  };

  /** An agent and a saved environment of the application, as the sources page offers them. */
  async function sourceInputs(app: App, baseUrl = 'https://staging.example.com/app') {
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'Docs', instructions: 'Document.' })
      .expect(201);
    const environment = await request(app)
      .post('/e2e/environments')
      .send({ name: 'Staging', baseUrl, username: 'qa@example.com', password: 'pw' })
      .expect(201);
    return {
      agentId: agent.body.agent.id as string,
      environmentId: environment.body.environment.id as string,
    };
  }
  const explore = (app: App, body: Record<string, unknown>) =>
    request(app).post('/e2e/source/explore').send(body);

  it('replaces the single source of the workspace with each exploration that ends well', async () => {
    const { app, runner } = setup();
    // The exploration of a run samples its application and never touches the source.
    const created = await createRun(app);
    await waitForStatus(app, created.body.creation.id as string, 'completed');
    expect(runner.explore.mock.calls[0]![0].thorough).toBe(false);
    expect(await state(app)).toEqual({ source: null, anchorId: null, agentId: null, busy: false });
    await request(app).get('/e2e/source/images/1').expect(404);

    const inputs = await sourceInputs(app);
    const started = await explore(app, inputs).expect(202);
    expect(started.body.exploration).toMatchObject({ source: true });
    await vi.waitFor(async () => expect(await source(app)).not.toBeNull());
    // The exploration of the source maps the whole application, signed in as the environment's account.
    expect(runner.explore.mock.calls.at(-1)![0]).toMatchObject({
      thorough: true,
      url: 'https://staging.example.com/',
      credentials: { username: 'qa@example.com', password: 'pw' },
    });
    const { anchorId } = await state(app);
    const first = await source(app);
    expect(first).toMatchObject({
      workspaceId: 'ws',
      creationId: anchorId,
      environmentId: inputs.environmentId,
      startUrl: 'https://staging.example.com/',
      script: [expect.objectContaining({ action: 'navigate', result: 'Issues' })],
      pages: [expect.objectContaining({ index: 1, title: 'Issues', hasScreenshot: true })],
      flows: [{ id: 'flow-1', step: 1, action: 'navigate', group: 'Issues' }],
      map: {
        pages: [expect.objectContaining({ id: '1', image: { testId: 'source', index: 1 } })],
        edges: [{ from: null, to: '1', testIds: ['flow-1'] }],
        tests: [{ id: 'flow-1', status: 'passed', path: ['1'], live: null }],
      },
    });
    const picture = await request(app).get('/e2e/source/images/1').expect(200);
    expect(picture.headers['content-type']).toBe('image/jpeg');
    expect(picture.body.toString()).toBe('explore-page');
    await vi.waitFor(async () =>
      expect(await exploration(app, anchorId)).toMatchObject({
        status: 'ready',
        savedTo: 'source',
      }),
    );

    // The hidden run that carries the source is not one of the user's runs, and is reused.
    const listed = (await request(app).get('/e2e/creations').expect(200)).body.creations;
    expect(listed.map((item: { id: string }) => item.id)).toEqual([created.body.creation.id]);
    await request(app).get(`/e2e/creations/${anchorId}`).expect(200);
    expect(
      (await request(app).get(`/e2e/explorations?creationId=${anchorId}`)).body.explorations,
    ).toHaveLength(0);

    // A failed exploration leaves the source as it was; the agent of the last one is kept.
    runner.explore.mockRejectedValueOnce(new Error('connection refused'));
    await explore(app, { environmentId: inputs.environmentId }).expect(202);
    await vi.waitFor(async () =>
      expect(await exploration(app, anchorId)).toMatchObject({ status: 'failed', savedTo: null }),
    );
    expect((await source(app)).finishedAt).toBe(first.finishedAt);
    expect((await state(app)).anchorId).toBe(anchorId);
    await request(app).get('/e2e/source/images/1').expect(200);

    // The next one that ends well replaces everything, pictures included.
    runner.explore.mockImplementationOnce(async (input: E2eExploreInput) => {
      input.onProgress?.({
        kind: 'page',
        page: { ...pageSnapshot, headings: ['Boards'] },
        screenshot: null,
      });
      input.onProgress?.({ kind: 'log', action: 'navigate', target: input.url, result: 'Boards' });
      return { startUrl: input.url, pages: [pageSnapshot] };
    });
    await explore(app, { environmentId: inputs.environmentId }).expect(202);
    await vi.waitFor(async () =>
      expect((await source(app)).pages).toEqual([
        expect.objectContaining({ title: 'Boards', hasScreenshot: false }),
      ]),
    );
    expect((await source(app)).map.pages[0].image).toBeNull();
    await request(app).get('/e2e/source/images/1').expect(404);
  });

  it('explores a localhost environment from the computer of the user, unless told otherwise', async () => {
    const target = async (app: App) => {
      const { anchorId } = await state(app);
      return (await request(app).get(`/e2e/creations/${anchorId}`).expect(200)).body.creation;
    };
    const local = setup().app;
    const inputs = await sourceInputs(local, 'http://localhost:8014');
    await explore(local, inputs).expect(202);
    expect(await target(local)).toMatchObject({
      executionTarget: 'local',
      baseUrl: 'http://localhost:8014',
      environmentId: inputs.environmentId,
    });

    const remote = setup().app;
    const other = await sourceInputs(remote, 'http://localhost:8014');
    await explore(remote, { ...other, executionTarget: 'remote' }).expect(202);
    expect(await target(remote)).toMatchObject({ executionTarget: 'remote' });
  });

  it('never waits for a runner when the API is the one on the computer of the user', async () => {
    const { app, runner } = setup({ e2eRunsLocally: true });
    const inputs = await sourceInputs(app, 'http://localhost:8014');
    // A localhost environment would use the runner of the user; here the browser is this one.
    await explore(app, { ...inputs, executionTarget: 'local' }).expect(202);
    const { anchorId } = await state(app);
    const target = async () =>
      (await request(app).get(`/e2e/creations/${anchorId}`).expect(200)).body.creation;
    expect(await target()).toMatchObject({ executionTarget: 'remote' });
    await vi.waitFor(async () => expect(await source(app)).not.toBeNull());
    expect(runner.explore.mock.calls.at(-1)![0]).toMatchObject({ url: 'http://localhost:8014/' });

    // The same goes for runs, even when asked to wait for a runner.
    const created = await createRun(app, {
      executionTarget: 'local',
      baseUrl: 'http://localhost:4000',
    });
    expect(created.body.creation.executionTarget).toBe('remote');
    expect(created.body.warnings).toBeUndefined();
    const id = created.body.creation.id as string;
    await waitForStatus(app, id, 'completed');
    const moved = await request(app)
      .put(`/e2e/creations/${id}/execution`)
      .send({ executionTarget: 'local' })
      .expect(200);
    expect(moved.body.creation.executionTarget).toBe('remote');
  });

  it('says whether the source is being updated and refuses a second update meanwhile', async () => {
    const { app, gates } = setup();
    const inputs = await sourceInputs(app);
    const gate = deferred();
    gates.explore = gate.promise;
    await explore(app, inputs).expect(202);
    const { anchorId, busy, source: none } = await state(app);
    expect(none).toBeNull();
    expect(busy).toBe(true);
    expect(anchorId).toEqual(expect.any(String));
    await explore(app, inputs).expect(409);
    await request(app).post('/e2e/source/document').expect(404);
    gate.release();
    await vi.waitFor(async () => expect((await state(app)).busy).toBe(false));
    expect(await source(app)).not.toBeNull();
  });

  it('documents the system with the AI, again on request, or says why it could not', async () => {
    const { app, author, runner } = setup();
    const inputs = await sourceInputs(app);
    const documentSource = vi.fn().mockResolvedValue(documentation);
    Object.assign(author, { documentSource });

    await explore(app, inputs).expect(202);
    await vi.waitFor(async () => expect((await source(app))?.documentation).toEqual(documentation));
    expect((await source(app)).documentationError).toBeNull();
    expect(documentSource.mock.calls[0]![0]).toMatchObject({
      startUrl: 'https://staging.example.com/',
      pages: [expect.objectContaining({ title: 'Issues' })],
      script: [expect.objectContaining({ action: 'navigate' })],
    });

    // Without a usable answer the map is still replaced and the reason is kept.
    documentSource.mockRejectedValueOnce(new Error('no model configured'));
    await explore(app, inputs).expect(202);
    await vi.waitFor(async () =>
      expect(await source(app)).toMatchObject({
        documentation: null,
        documentationError: 'no model configured',
      }),
    );

    // Written again from what was discovered, without exploring.
    const explored = runner.explore.mock.calls.length;
    const next = { ...documentation, overview: '# Updated' };
    documentSource.mockResolvedValueOnce(next);
    const accepted = await request(app).post('/e2e/source/document').expect(202);
    expect(accepted.body).toEqual({ busy: true });
    await vi.waitFor(async () => expect((await source(app)).documentation).toEqual(next));
    expect((await source(app)).documentationError).toBeNull();
    expect(runner.explore).toHaveBeenCalledTimes(explored);
    expect(documentSource.mock.calls.at(-1)![0].pages).toEqual([
      expect.objectContaining({ title: 'Issues' }),
    ]);

    // When it fails the documentation in use stays, with the reason next to it.
    documentSource.mockRejectedValueOnce(new Error('model overloaded'));
    await request(app).post('/e2e/source/document').expect(202);
    await vi.waitFor(async () =>
      expect(await source(app)).toMatchObject({
        documentation: next,
        documentationError: 'model overloaded',
      }),
    );
  });

  it('lets an MCP host write the documentation from a brief', async () => {
    const { app } = setup();
    const inputs = await sourceInputs(app);
    await request(app).get('/e2e/source/brief').expect(404);
    await explore(app, inputs).expect(202);
    // The default author cannot document: the reason names the host tools.
    await vi.waitFor(async () =>
      expect((await source(app))?.documentationError).toEqual(expect.any(String)),
    );
    expect((await source(app)).documentation).toBeNull();

    const { brief } = (await request(app).get('/e2e/source/brief').expect(200)).body;
    expect(brief).toMatchObject({
      applicationUrl: 'https://staging.example.com/',
      brainKnowledge: [],
      discoveredPages: [expect.objectContaining({ name: 'Issues', controls: ['New issue'] })],
      discoveredNavigation: [expect.objectContaining({ action: 'navigate', ledTo: 'Issues' })],
      currentDocumentation: null,
    });
    expect(brief.rules.join(' ')).toContain('ALL flows of the system');
    expect(brief.responseFormat).toContain('"overview"');

    const written = {
      overview: '# Escrita pelo host',
      areas: [
        {
          name: 'Issues',
          flows: [{ title: 'Criar', steps: ['Abrir'], pages: ['Issues'], origin: 'both' }],
        },
      ],
      brainDocuments: [{ title: 'Spec', source: 'wiki://spec' }],
    };
    const saved = await request(app).put('/e2e/source/documentation').send(written).expect(200);
    expect(saved.body.documentation).toMatchObject({
      overview: '# Escrita pelo host',
      areas: [
        { name: 'Issues', description: '', flows: [expect.objectContaining({ origin: 'both' })] },
      ],
      brainDocuments: [{ title: 'Spec', source: 'wiki://spec' }],
      generatedAt: expect.any(String),
    });
    expect(await source(app)).toMatchObject({
      documentation: expect.objectContaining({ overview: '# Escrita pelo host' }),
      documentationError: null,
    });
    // The rest of the source is untouched.
    expect((await source(app)).pages).toHaveLength(1);
    // Without the titles of the documents, none are listed.
    const bare = await request(app)
      .put('/e2e/source/documentation')
      .send({ overview: '# x', areas: [] })
      .expect(200);
    expect(bare.body.documentation.brainDocuments).toEqual([]);
    await request(app)
      .put('/e2e/source/documentation')
      .send({ overview: '# x', areas: [{ name: 'A', flows: [{ title: 'F', origin: 'guessed' }] }] })
      .expect(400);
  });

  it('reads the Brain for the brief and says when the run of the source is gone', async () => {
    const search = vi.fn().mockResolvedValue([
      {
        source: 'wiki://spec',
        pageId: 'spec',
        chunkIndex: 0,
        content: '# Especificação\nRegras.',
        createdAt: '2026-11-01T00:00:00Z',
      },
    ]);
    const store = new InMemoryE2eStore();
    const { app } = setup({ e2eStore: store, knowledgeSearch: { search } });
    // A source whose hidden run was deleted can still be read and documented by a host.
    await store.saveSource({
      workspaceId: 'ws',
      creationId: 'gone',
      environmentId: null,
      startUrl: 'https://staging.example.com/',
      signedInMs: null,
      script: [],
      pages: [],
      documentation: null,
      documentationError: null,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    expect(await state(app)).toMatchObject({ anchorId: null, busy: false });
    const { brief } = (await request(app).get('/e2e/source/brief').expect(200)).body;
    expect(brief.brainKnowledge).toEqual([
      { title: 'Especificação', source: 'wiki://spec', content: '# Especificação\nRegras.' },
    ]);
    expect(search).toHaveBeenCalledWith(
      expect.stringMatching(/sistema|system/),
      expect.objectContaining({ workspaceId: 'ws' }),
    );
    // The AI needs the run to write as; without it the host is the way.
    const gone = await request(app).post('/e2e/source/document').expect(409);
    expect(gone.body.code).toBe('E2E_SOURCE_RUN_MISSING');
  });

  it('fails the source request when the store does', async () => {
    const store = Object.assign(new InMemoryE2eStore(), {
      getSource: () => Promise.reject(new Error('db down')),
    });
    const { app } = setup({ e2eStore: store });
    await request(app).get('/e2e/source').expect(500);
  });

  it('validates what is asked of the source', async () => {
    const { app } = setup();
    await explore(app, {}).expect(400);
    await explore(app, { environmentId: 'missing', agentId: 'a' }).expect(404);
    const inputs = await sourceInputs(app);
    // The first exploration needs the agent that documents the system.
    const noAgent = await explore(app, { environmentId: inputs.environmentId }).expect(400);
    expect(noAgent.body.code).toBe('E2E_AGENT_REQUIRED');
    await explore(app, { ...inputs, agentId: 'missing' }).expect(404);
    await request(app).get('/e2e/source/images/0').expect(400);
    // Another workspace has no source, environments or documentation of this one.
    expect(await state(app, 'other')).toEqual({
      source: null,
      anchorId: null,
      agentId: null,
      busy: false,
    });
    await request(app)
      .post('/e2e/source/explore')
      .set('x-test-workspace', 'other')
      .send(inputs)
      .expect(404);
    await request(app).post('/e2e/source/document').set('x-test-workspace', 'other').expect(404);
    await request(app)
      .put('/e2e/source/documentation')
      .set('x-test-workspace', 'other')
      .send({ overview: '# x', areas: [] })
      .expect(404);
  });
});

describe('E2E run view routes', () => {
  it('builds the action map of a run from the trails of its tests', async () => {
    const { app, artifacts, results } = setup();
    const created = await createRun(app);
    const id = created.body.creation.id as string;
    const creation = await waitForStatus(app, id, 'completed');
    // The plan's feature areas group the tests.
    expect(creation.tests.map((test: { category: string | null }) => test.category)).toEqual([
      'Access',
      null,
    ]);
    const [first, second] = creation.tests as { id: string }[];

    const { map } = (await request(app).get(`/e2e/creations/${id}/action-map`).expect(200)).body;
    expect(
      map.pages.map((page: { path: string; title: string }) => [page.path, page.title]),
    ).toEqual([
      ['/login', 'Sign in'],
      ['/', 'Issues'],
    ]);
    expect(map.pages[0]).toMatchObject({
      testIds: [first!.id, second!.id],
      touches: 2,
      image: { testId: first!.id, index: 1 },
    });
    expect(map.pages[1].image).toBeNull();
    expect(map.edges).toHaveLength(2);
    expect(map.tests).toEqual([
      expect.objectContaining({ id: first!.id, status: 'passed', live: null }),
      expect.objectContaining({ id: second!.id, status: 'passed', live: null }),
    ]);

    const page = await request(app).get(`/e2e/tests/${first!.id}/trail/page/1`).expect(200);
    expect(page.headers['content-type']).toBe('image/jpeg');
    expect(page.body.toString()).toBe('p1');
    const element = await request(app).get(`/e2e/tests/${first!.id}/trail/element/1`).expect(200);
    expect(element.body.toString()).toBe('e1');
    await request(app).get(`/e2e/tests/${first!.id}/trail/page/2`).expect(404);
    await request(app).get(`/e2e/tests/${first!.id}/trail/video/1`).expect(400);
    await request(app).get('/e2e/tests/missing/trail/page/1').expect(404);
    await request(app).get('/e2e/creations/missing/action-map').expect(404);

    // A run that leaves no trail (e.g. on the user's computer) drops the old one.
    results.push({ ...passed, trail: undefined });
    await request(app).post(`/e2e/tests/${first!.id}/run`).send({}).expect(202);
    await vi.waitFor(async () => {
      const next = (await request(app).get(`/e2e/creations/${id}/action-map`)).body.map;
      expect(next.pages[0].testIds).toEqual([second!.id]);
    });
    await waitForStatus(app, id, 'completed');
    await request(app).get(`/e2e/tests/${first!.id}/trail/page/1`).expect(404);

    // An unreadable trail counts as none.
    await artifacts.put(
      trailKey({ workspaceId: 'ws', creationId: id, id: second!.id }),
      Buffer.from('{broken'),
    );
    const broken = (await request(app).get(`/e2e/creations/${id}/action-map`)).body.map;
    expect(broken.pages).toEqual([]);
    expect(broken.tests.every((test: { path: string[] }) => test.path.length === 0)).toBe(true);
  });

  it('shows the browser of a running test and what it is doing', async () => {
    const { app, artifacts, gates } = setup();
    const gate = deferred();
    gates.run = gate.promise;
    const created = await createRun(app);
    const id = created.body.creation.id as string;
    let testId = '';
    await vi.waitFor(async () => {
      const creation = (await request(app).get(`/e2e/creations/${id}`)).body.creation;
      testId = creation.tests.find((test: { status: string }) => test.status === 'running').id;
      await request(app).get(`/e2e/tests/${testId}/live`).expect(200);
    });
    const frame = await request(app).get(`/e2e/tests/${testId}/live`).expect(200);
    expect(frame.headers['cache-control']).toBe('no-store');
    expect(frame.body.toString()).toBe('live-frame');
    const { map } = (await request(app).get(`/e2e/creations/${id}/action-map`)).body;
    expect(map.tests[0]).toMatchObject({
      id: testId,
      status: 'running',
      live: { step: 1, action: 'click', kind: 'button', name: 'Enter' },
    });
    expect(map.tests[1].live).toBeNull();

    gate.release();
    await waitForStatus(app, id, 'completed');
    // The frame only exists while the test runs.
    await request(app).get(`/e2e/tests/${testId}/live`).expect(404);
    expect(
      await artifacts.get(liveFrameKey({ workspaceId: 'ws', creationId: id, id: testId })),
    ).toBeNull();
  });

  it('finishes the test when a live frame cannot be stored', async () => {
    const { app, artifacts } = setup();
    const put = artifacts.put.bind(artifacts);
    vi.spyOn(artifacts, 'put').mockImplementation((key, content) =>
      key.includes('/live/') ? Promise.reject(new Error('storage down')) : put(key, content),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const created = await createRun(app);
    await waitForStatus(app, created.body.creation.id, 'completed');
    expect(logged).toHaveBeenCalledWith('[E2eExecutor] Live frame lost:', expect.any(Error));
    logged.mockRestore();
  });

  it('keeps the feature area of the tests of a plan written by the MCP host', async () => {
    const { app } = setup();
    const created = await createRun(app, { planning: 'host' });
    const id = created.body.creation.id as string;
    await vi.waitFor(async () => {
      const brief = await request(app).post(`/e2e/creations/${id}/brief`).send({}).expect(200);
      expect(brief.body.brief.snapshot.status).toBe('ready');
    });
    await request(app)
      .put(`/e2e/creations/${id}/plan`)
      .send({
        tests: [
          { title: 'Sign in', priority: 'high', steps: ['a'], script: SCRIPT, category: 'Access' },
          { title: 'Browse', priority: 'low', steps: ['b'], script: SCRIPT },
        ],
      })
      .expect(202);
    const creation = await waitForStatus(app, id, 'completed');
    expect(creation.tests.map((test: { category: string | null }) => test.category)).toEqual([
      'Access',
      null,
    ]);
  });
});
