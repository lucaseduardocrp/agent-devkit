import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaE2eStore } from '../src/modules/e2e/adapters/prisma-e2e-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import type { KnowledgeSearchPort } from '../src/modules/knowledge/application/knowledge-search.js';
import { AgentE2eAuthor, MAX_SOURCE_DOCUMENTS } from '../src/modules/e2e/application/e2e-author.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { ExplorationRecorder } from '../src/modules/e2e/application/e2e-exploration.js';
import type { E2eJob } from '../src/modules/e2e/application/e2e-queue.js';
import type { E2eCreation } from '../src/modules/e2e/domain/e2e.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import type {
  E2eExplorationLogEntry,
  E2eExplorationPage,
} from '../src/modules/e2e/domain/e2e-insight.js';
import {
  buildSourceMap,
  sourcePageKey,
  sourcePrefix,
  type E2eSourceDocumentation,
  type NewE2eSource,
} from '../src/modules/e2e/domain/e2e-source.js';

const page = (
  index: number,
  title: string,
  url: string,
  hasScreenshot = true,
): E2eExplorationPage => ({ index, title, url, summary: title, elements: [], hasScreenshot });

const step = (
  action: E2eExplorationLogEntry['action'],
  target: string,
  result: string | null,
): E2eExplorationLogEntry => ({ atMs: 0, action, target, result });

const source: NewE2eSource = {
  workspaceId: 'ws',
  creationId: 'run',
  environmentId: 'env',
  startUrl: 'http://app/',
  signedInMs: 900,
  script: [
    step('navigate', 'http://app/login', 'Sign in'),
    step('sign_in', 'qa@example.com', 'Home'),
    step('navigate', 'http://app/issues', 'Issues'),
    step('click', 'Settings', 'Settings'),
    step('click', 'General tab', 'Settings'),
    step('click', 'Broken', null),
    step('click', 'Ghost', 'A page that was never captured'),
    step('click', 'Issues link', 'Issues'),
  ],
  pages: [
    page(1, 'Sign in', 'http://app/login'),
    page(2, 'Home', 'http://app/'),
    page(3, 'Issues', 'http://app/issues?open=1'),
    page(4, 'Settings', 'not a url', false),
    page(5, 'Home', 'http://app/home-again'),
    page(6, 'Orphan', 'http://app/orphan'),
  ],
  documentation: null,
  documentationError: null,
  startedAt: new Date('2026-11-11T10:00:00Z'),
  finishedAt: new Date('2026-11-11T10:01:00Z'),
};

const documentation: E2eSourceDocumentation = {
  overview: '# App',
  areas: [{ name: 'Issues', description: '', flows: [] }],
  brainDocuments: [{ title: 'Spec', source: 'wiki://spec' }],
  generatedAt: '2026-11-11T10:02:00.000Z',
};

describe('source map', () => {
  it('keeps the pictures of the source under the workspace', () => {
    expect(sourcePrefix('ws')).toBe('ws/source');
    expect(sourcePageKey('ws', 3)).toBe('ws/source/page-03.jpg');
  });

  it('turns every action that led to a page into a flow from the start of the application', () => {
    const { map, flows } = buildSourceMap(source);

    expect(flows).toEqual([
      { id: 'flow-1', step: 1, action: 'navigate', target: 'http://app/login', group: 'Sign in' },
      { id: 'flow-2', step: 2, action: 'sign_in', target: 'qa@example.com', group: 'Home' },
      { id: 'flow-3', step: 3, action: 'navigate', target: 'http://app/issues', group: 'Issues' },
      { id: 'flow-4', step: 4, action: 'click', target: 'Settings', group: 'Settings' },
      { id: 'flow-5', step: 5, action: 'click', target: 'General tab', group: 'Settings' },
      { id: 'flow-8', step: 8, action: 'click', target: 'Issues link', group: 'Issues' },
    ]);
    // Links leave from the first screen after signing in; clicks go on from the last page.
    expect(map.tests.map((test) => test.path)).toEqual([
      ['1'],
      ['1', '2'],
      ['1', '2', '3'],
      ['1', '2', '4'],
      ['1', '2', '4'],
      ['1', '2', '4', '3'],
    ]);
    expect(map.tests[0]).toEqual({ id: 'flow-1', status: 'passed', path: ['1'], live: null });
    expect(map.edges).toEqual([
      { from: null, to: '1', testIds: flows.map((flow) => flow.id) },
      { from: '1', to: '2', testIds: ['flow-2', 'flow-3', 'flow-4', 'flow-5', 'flow-8'] },
      { from: '2', to: '3', testIds: ['flow-3'] },
      { from: '2', to: '4', testIds: ['flow-4', 'flow-5', 'flow-8'] },
      { from: '4', to: '3', testIds: ['flow-8'] },
    ]);
    expect(map.pages).toEqual([
      expect.objectContaining({
        id: '1',
        path: '/login',
        title: 'Sign in',
        image: { testId: 'source', index: 1 },
        touches: 2,
        failedTestIds: [],
        elements: [],
      }),
      expect.objectContaining({ id: '2', path: '/', touches: 2 }),
      expect.objectContaining({
        id: '3',
        path: '/issues?open=1',
        testIds: ['flow-3', 'flow-8'],
        touches: 0,
      }),
      expect.objectContaining({ id: '4', path: 'not a url', image: null, touches: 2 }),
      // A second page with a name already taken and a page no action led to are in no flow.
      expect.objectContaining({ id: '5', testIds: [], touches: 0 }),
      expect.objectContaining({ id: '6', testIds: [], touches: 0 }),
    ]);
  });

  it('has no flows for an empty script', () => {
    expect(buildSourceMap({ script: [], pages: [] })).toEqual({
      map: { pages: [], edges: [], tests: [] },
      flows: [],
    });
  });
});

describe('source stores', () => {
  it('keeps one source per workspace in memory, replacing the previous one', async () => {
    const store = new InMemoryE2eStore();
    expect(await store.getSource('ws')).toBeNull();
    await store.saveSource(source);
    const replaced = await store.saveSource({ ...source, creationId: 'other-run', script: [] });
    expect(replaced.updatedAt).toBeInstanceOf(Date);
    expect(await store.getSource('ws')).toMatchObject({ creationId: 'other-run', script: [] });
    expect(await store.getSource('elsewhere')).toBeNull();
  });

  it('upserts the row of the workspace and reads unreadable JSON as empty', async () => {
    const row = { ...source, updatedAt: new Date() };
    const db = {
      e2eSourceRecord: {
        upsert: vi.fn().mockResolvedValue(row),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ ...row, script: 'broken', pages: null, documentation: '{x' })
          .mockResolvedValueOnce({ ...row, documentation: JSON.stringify(documentation) })
          .mockResolvedValueOnce(null),
      },
    };
    const store = new PrismaE2eStore(db as unknown as PrismaClient);

    expect(await store.saveSource(source)).toEqual(row);
    const { workspaceId, ...data } = source;
    expect(db.e2eSourceRecord.upsert).toHaveBeenCalledWith({
      where: { workspaceId },
      create: source,
      update: data,
    });
    expect(await store.getSource('ws')).toMatchObject({
      script: [],
      pages: [],
      documentation: null,
    });
    expect((await store.getSource('ws'))!.documentation).toEqual(documentation);

    // The documentation is kept as JSON text.
    await store.saveSource({ ...source, documentation });
    expect(db.e2eSourceRecord.upsert.mock.calls.at(-1)![0].update.documentation).toBe(
      JSON.stringify(documentation),
    );
    expect(db.e2eSourceRecord.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws' } });
    expect(await store.getSource('ws')).toBeNull();
  });
});

describe('source jobs of the worker', () => {
  const pages = [
    {
      index: 1,
      url: 'http://app/',
      title: 'Home',
      summary: 'Home',
      elements: [],
      hasScreenshot: false,
    },
  ];
  const stored: NewE2eSource = { ...source, workspaceId: 'ws', creationId: 'anchor', pages };

  async function worker(author: object, executionTarget: 'remote' | 'local' = 'remote') {
    const store = new InMemoryE2eStore();
    const artifacts = new InMemoryE2eArtifactStore();
    const anchor = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'owner',
      actorId: 'user',
      agentId: 'agent',
      name: 'Source',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://app',
      executionTarget,
      localOrigin: null,
      path: '/',
      username: null,
      passwordSecret: null,
      accessSecret: null,
      prd: '',
      prdFileNames: [],
      diff: null,
      instructions: null,
      locale: 'en-US',
      repository: null,
      status: 'draft',
      useBrain: true,
      internal: true,
    });
    const runner = {
      explore: vi.fn().mockResolvedValue({ startUrl: 'http://app/', pages: [] }),
    };
    const executor = (runsLocally: boolean) =>
      new E2eExecutor({ store, artifacts, runner, author, runsLocally } as never);
    return {
      store,
      artifacts,
      anchor,
      executor: executor(false),
      runsHere: executor(true),
      runner,
    };
  }
  const job = (creationId: string, kind: 'document' | 'explore') =>
    ({ workspaceId: 'ws', creationId, kind }) as E2eJob;

  it('writes the documentation again from the source, never losing what it has', async () => {
    const documentSource = vi
      .fn()
      .mockResolvedValueOnce(documentation)
      .mockRejectedValueOnce(new Error('overloaded'));
    const { store, anchor, executor } = await worker({ documentSource });

    // Nothing to document before the first exploration.
    await executor.run(job(anchor.id, 'document'), new AbortController().signal);
    expect(documentSource).not.toHaveBeenCalled();

    await store.saveSource({ ...stored, creationId: anchor.id });
    const cancelled = new AbortController();
    cancelled.abort();
    await executor.run(job(anchor.id, 'document'), cancelled.signal);
    expect(documentSource).not.toHaveBeenCalled();

    await executor.run(job(anchor.id, 'document'), new AbortController().signal);
    expect(documentSource.mock.calls[0]![0]).toMatchObject({ pages, script: stored.script });
    expect(await store.getSource('ws')).toMatchObject({ documentation, documentationError: null });

    // A failure keeps the documentation in use and tells why.
    await executor.run(job(anchor.id, 'document'), new AbortController().signal);
    expect(await store.getSource('ws')).toMatchObject({
      documentation,
      documentationError: expect.stringContaining('overloaded'),
    });
  });

  it('stores nothing when the job is cancelled while the documentation is being written', async () => {
    const controller = new AbortController();
    const documentSource = vi.fn(async () => {
      controller.abort();
      return documentation;
    });
    const { store, anchor, executor } = await worker({ documentSource });
    await store.saveSource({ ...stored, creationId: anchor.id });
    await executor.run(job(anchor.id, 'document'), controller.signal);
    expect(documentSource).toHaveBeenCalledOnce();
    expect(await store.getSource('ws')).toMatchObject({ documentation: null });
  });

  it('keeps the map and points to the host tools when the author cannot document', async () => {
    const { store, anchor, executor } = await worker({});
    await store.saveSource({ ...stored, creationId: anchor.id });
    await executor.run(job(anchor.id, 'document'), new AbortController().signal);
    expect(await store.getSource('ws')).toMatchObject({
      documentation: null,
      documentationError: expect.stringContaining('e2e_save_source_documentation'),
      pages,
    });
  });

  it('explores in its own browser when the API is the one on the computer of the user', async () => {
    const { artifacts, anchor, executor, runsHere, runner } = await worker(
      { documentSource: vi.fn().mockResolvedValue(documentation) },
      'local',
    );
    await ExplorationRecorder.start(artifacts, anchor, false, Date.now, { source: true });
    // Elsewhere a local run needs the runner of the user, which is not enabled here.
    await executor.run(job(anchor.id, 'explore'), new AbortController().signal);
    expect(runner.explore).not.toHaveBeenCalled();
    await runsHere.run(job(anchor.id, 'explore'), new AbortController().signal);
    expect(runner.explore).toHaveBeenCalledOnce();
  });

  it('replaces the source with an exploration of a run that has no environment', async () => {
    const { store, artifacts, anchor, executor } = await worker({
      documentSource: vi.fn().mockResolvedValue(documentation),
    });
    await ExplorationRecorder.start(artifacts, anchor, false, Date.now, { source: true });
    await executor.run(job(anchor.id, 'explore'), new AbortController().signal);
    expect(await store.getSource('ws')).toMatchObject({
      creationId: anchor.id,
      environmentId: null,
      documentation,
    });
  });
});

describe('documenting the system for its source', () => {
  const creation = {
    id: 'run',
    workspaceId: 'ws',
    ownerId: 'owner',
    actorId: 'user',
    agentId: 'agent',
    locale: 'pt-BR',
    useBrain: false,
  } as E2eCreation;
  const chunk = (pageId: string, content: string) => ({
    pageId,
    source: `wiki://${pageId}`,
    chunkIndex: 0,
    content,
  });

  function subject(answer: string, search?: (query: string) => Promise<unknown[]>) {
    const complete = vi.fn((_request: { prompt: string; instruction?: string }) =>
      Promise.resolve({ text: answer, provider: 'fake' }),
    );
    const author = new AgentE2eAuthor({
      agents: {
        getAgent: vi.fn().mockResolvedValue({ instructions: 'You are QA.', model: null }),
        getWorkflow: vi.fn().mockResolvedValue({ enabled: false, steps: [] }),
      } as unknown as AgentService,
      defaultLlm: { provider: 'fake', complete, stream: vi.fn() } as unknown as LlmPort,
      ...(search ? { knowledge: { search } as unknown as KnowledgeSearchPort } : {}),
    });
    return { author, complete };
  }
  const input = { creation, startUrl: 'http://app/', pages: source.pages, script: source.script };
  const answer = JSON.stringify({
    overview: '# Sistema',
    areas: [
      {
        name: 'Issues',
        flows: [
          { title: 'Criar issue', steps: ['Abrir', 'Salvar'], pages: ['Issues'], origin: 'both' },
          { title: 'Filtrar', origin: 'guessed' },
        ],
      },
      { name: 'Vazia' },
    ],
  });

  it('reads the whole Brain and what was discovered, whatever the run uses', async () => {
    const search = vi.fn(async (query: string) =>
      query.startsWith('visão geral')
        ? [chunk('spec', '# Especificação\nRegras.'), chunk('long', 'x'.repeat(9_000))]
        : query === 'Issues'
          ? [chunk('spec', '# Especificação\nRegras.'), chunk('issues', '# Issues')]
          : [],
    );
    const { author, complete } = subject(`Segue:\n${answer}`, search);
    const result = await author.documentSource(input);

    expect(result.overview).toBe('# Sistema');
    expect(result.areas).toEqual([
      {
        name: 'Issues',
        description: '',
        flows: [
          {
            title: 'Criar issue',
            description: '',
            steps: ['Abrir', 'Salvar'],
            pages: ['Issues'],
            origin: 'both',
          },
          { title: 'Filtrar', description: '', steps: [], pages: [], origin: 'discovered' },
        ],
      },
      { name: 'Vazia', description: '', flows: [] },
    ]);
    // Each document once, in the order it was found.
    expect(result.brainDocuments).toEqual([
      { title: 'Especificação', source: 'wiki://spec' },
      { title: 'long', source: 'wiki://long' },
      { title: 'Issues', source: 'wiki://issues' },
    ]);
    expect(Date.parse(result.generatedAt)).not.toBeNaN();
    // General questions first, then one per distinct page name.
    const asked = search.mock.calls.map(([query]) => query);
    expect(asked.slice(0, 3).every((query) => /sistema|system|fluxos/.test(query))).toBe(true);
    expect(asked.slice(3)).toEqual(['Sign in', 'Home', 'Issues', 'Settings', 'Orphan']);
    const { prompt, instruction } = complete.mock.calls[0]![0];
    expect(instruction).toContain('ALL flows of the system');
    expect(prompt).toContain('discoveredNavigation');
    expect(prompt).toContain('Especificação');
    // Long documents are cut so many of them fit.
    expect(prompt).not.toContain('x'.repeat(6_001));
  });

  it('stops collecting documents at its limit and works without a Brain', async () => {
    let next = 0;
    const many = vi.fn(async () =>
      Array.from({ length: 12 }, () => chunk(`doc-${next++}`, '# Doc')),
    );
    const pages = Array.from({ length: 16 }, (_, index) =>
      page(index + 1, `Screen ${index}`, 'http://app/'),
    );
    const full = await subject(answer, many).author.documentSource({ ...input, pages });
    expect(full.brainDocuments).toHaveLength(MAX_SOURCE_DOCUMENTS);

    const { author, complete } = subject(answer);
    expect((await author.documentSource(input)).brainDocuments).toEqual([]);
    expect(complete.mock.calls[0]![0].prompt).toContain('brainKnowledge');
  });

  it('rejects an answer that is not a documentation', async () => {
    await expect(subject('{"areas": []}').author.documentSource(input)).rejects.toMatchObject({
      code: 'E2E_SOURCE_INVALID',
    });
  });
});
