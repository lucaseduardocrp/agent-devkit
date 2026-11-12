import { describe, expect, it, vi } from 'vitest';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';
import { MAX_BRAIN_CHARACTERS, searchBrain } from '../src/modules/e2e/application/e2e-brain.js';

const creation = { id: 'c1', ownerId: 'o', workspaceId: 'ws', actorId: 'u', locale: 'en-US' };
const chunk = (source: string, pageId: string, content: string, chunkIndex = 0) =>
  ({ source, pageId, chunkIndex, content }) as never;

describe('searchBrain edges', () => {
  it('names a document by its page id when the path has no segment', async () => {
    const search = {
      search: vi.fn(async () => [chunk('https://x/wiki?pagePath=%2F', 'p9', 'text')]),
    };
    const [document] = await searchBrain(search as never, creation as never, ['q']);
    expect(document!.title).toBe('p9');
  });

  it('hands the abort signal of the run to the search', async () => {
    const search = { search: vi.fn(async () => []) };
    const signal = new AbortController().signal;
    await searchBrain(search as never, creation as never, ['q'], signal);
    expect(search.search).toHaveBeenCalledWith('q', expect.objectContaining({ signal }));
  });

  it('stops adding documents once the character budget is used', async () => {
    const search = {
      search: vi.fn(async () => [
        chunk('a', '1', 'x'.repeat(MAX_BRAIN_CHARACTERS)),
        chunk('b', '2', 'never read'),
      ]),
    };
    const documents = await searchBrain(search as never, creation as never, ['q']);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.content).toHaveLength(MAX_BRAIN_CHARACTERS);
  });
});

describe('E2eService without an actor and Source runs', () => {
  const bare = { requestId: 'r', workspaceId: 'ws' } as never;
  const sourceRow = (creationId: string) =>
    ({
      workspaceId: 'ws',
      creationId,
      environmentId: 'env1',
      startUrl: 'https://app.example.com/',
      signedInMs: null,
      script: [],
      pages: [],
      documentation: null,
      documentationError: null,
      startedAt: new Date('2026-11-11T10:00:00Z'),
      finishedAt: new Date('2026-11-11T10:01:00Z'),
    }) as never;
  const internalRun = (internal: boolean) =>
    ({
      workspaceId: 'ws',
      ownerId: 'owner',
      actorId: 'actor',
      agentId: 'agent',
      name: 'Source',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'https://app.example.com',
      path: '/',
      prd: '',
      prdFileNames: [],
      diff: null,
      instructions: null,
      repository: null,
      status: 'draft',
      useBrain: true,
      internal,
    }) as never;

  function setup() {
    const store = new InMemoryE2eStore();
    const service = new E2eService({
      store,
      queue: new InMemoryE2eJobQueue(),
      dispatcher: { wake: () => Promise.resolve() },
      artifacts: new InMemoryE2eArtifactStore(),
      scripts: new FakeScriptRepository(),
      agents: {
        getAgent: vi.fn().mockResolvedValue({ id: 'agent', name: 'A', instructions: '' }),
      } as never,
      environments: {
        find: async () => ({
          id: 'env1',
          baseUrl: 'https://app.example.com',
          username: null,
          passwordSecret: null,
        }),
        variables: async () => ({}),
      } as never,
    });
    return { service, store };
  }

  it('explores the Source for a request with no owner or actor, remotely by default', async () => {
    const { service, store } = setup();
    await service.exploreSource(bare, { environmentId: 'env1', agentId: 'agent' });
    expect(await store.getSourceAnchor('ws')).toMatchObject({
      ownerId: 'ws',
      actorId: 'unknown',
      executionTarget: 'remote',
    });
  });

  it('documents the Source as the person asking, or as the workspace when nobody is', async () => {
    const { service, store } = setup();
    const run = await store.createCreation(internalRun(true));
    await store.saveSource(sourceRow(run.id));
    await expect(service.documentSource(bare)).resolves.toEqual({ busy: true });
    expect(await store.getCreation('ws', run.id)).toMatchObject({
      ownerId: 'ws',
      actorId: 'unknown',
    });
  });

  it('documents a Source whose run is a regular one without rewriting it', async () => {
    const { service, store } = setup();
    const run = await store.createCreation(internalRun(false));
    await store.saveSource(sourceRow(run.id));
    await service.documentSource(bare);
    expect(await store.getCreation('ws', run.id)).toMatchObject({
      ownerId: 'owner',
      actorId: 'actor',
    });
  });

  it('refuses to document a Source whose run is gone', async () => {
    const { service, store } = setup();
    await store.saveSource(sourceRow('gone'));
    await expect(service.documentSource(bare)).rejects.toMatchObject({
      code: 'E2E_SOURCE_RUN_MISSING',
    });
  });

  it('briefs the host on the Source for a request with no owner or actor', async () => {
    const { service, store } = setup();
    await store.saveSource(sourceRow('run'));
    await expect(service.sourceBrief(bare)).resolves.toBeDefined();
  });

  it('tells the host which Brain tools to use when the run reads the Brain', async () => {
    const { service } = setup();
    const created = await service.create(
      { requestId: 'r', workspaceId: 'ws', ownerId: 'ws', actorId: 'user', locale: 'en-US' },
      {
        name: 'Run',
        agentId: 'agent',
        mode: 'frontend',
        scope: 'codebase',
        baseUrl: 'https://app.example.com',
        path: '/',
        prd: '',
        useBrain: true,
        repository: { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' },
      },
    );
    const brief = await service.brief('ws', created.id);
    expect(brief.documents.useBrain).toBe(true);
    expect(brief.documents.brainTools).toContain('brain_search');
  });
});

describe('WorkspaceService member contacts', () => {
  it('leaves out members whose account no longer exists', async () => {
    const { WorkspaceService } =
      await import('../src/modules/workspaces/application/workspace-service.js');
    const repository = {
      searchMembers: vi.fn(async () => ({
        members: [
          { userId: 'gone' },
          { userId: 'here', user: { id: 'here', name: 'Ana', email: 'a@x' } },
        ],
        total: 2,
      })),
    };
    const authRepository = { findById: vi.fn(async () => null) };
    const service = new WorkspaceService(repository as never, authRepository as never);
    const result = await service.searchMemberContacts('ws', { search: '', offset: 0, limit: 5 });
    expect(result).toEqual({ people: [{ id: 'here', name: 'Ana', email: 'a@x' }], total: 2 });
    expect(authRepository.findById).toHaveBeenCalledWith('gone');
  });
});
