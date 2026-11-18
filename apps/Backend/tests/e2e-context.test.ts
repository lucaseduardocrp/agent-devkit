import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceContextReader,
  plainText,
} from '../src/modules/e2e/adapters/workspace-context-reader.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  MAX_CONTEXT_DOCUMENT,
  contextRefs,
  readExplorationContext,
  saveExplorationContext,
} from '../src/modules/e2e/application/e2e-context.js';
import type { E2eContextReader } from '../src/modules/e2e/application/e2e-context.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { readExploration } from '../src/modules/e2e/application/e2e-exploration.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import type { E2eExploreAgent } from '../src/modules/e2e/application/e2e-runner.js';
import { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { LocalE2eDispatcher } from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import type { E2eExplorationContextDocument } from '../src/modules/e2e/domain/e2e-insight.js';
import type { PbiItem } from '../src/modules/pbi/pbi-store.js';
import type { Issue } from '../src/modules/issues/issue-store.js';
import type { KnowledgeChunk } from '../src/modules/knowledge/domain/knowledge-chunk.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const context = { requestId: 'r', ownerId: 'owner', workspaceId: 'ws', actorId: 'user' };

const pbi = (id: string, overrides: Partial<PbiItem> = {}): PbiItem => ({
  id,
  workspaceId: 'ws',
  parentId: null,
  kind: 'pbi',
  title: `PBI ${id}`,
  description: '<p>Filter the <b>files</b> to download</p><ul><li>By type</li></ul>',
  status: 'Active',
  position: 0,
  sourceData: {
    type: 'Product Backlog Item',
    acceptanceCriteria: '<div>Only matching files</div>',
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  links: [],
  ...overrides,
});

const chunk = (
  source: string,
  pageId: string,
  chunkIndex: number,
  content: string,
): KnowledgeChunk => ({
  source,
  pageId,
  chunkIndex,
  content,
  createdAt: '2026-11-12T00:00:00.000Z',
});

function reader(
  options: {
    pbis?: PbiItem[];
    children?: PbiItem[];
    issues?: Issue[];
    chunks?: KnowledgeChunk[];
    failing?: 'pbi' | 'knowledge';
  } = {},
) {
  const pbis = options.pbis ?? [];
  const sources = {
    pbis: {
      get: vi.fn((_ws: string, id: string) =>
        options.failing === 'pbi'
          ? Promise.reject(new Error('database down'))
          : Promise.resolve(pbis.find((item) => item.id === id) ?? null),
      ),
      findByExternal: vi.fn((_ws: string, _provider: string, externalId: string) =>
        Promise.resolve(
          pbis.find((item) => item.links.some((link) => link.externalId === externalId)) ?? null,
        ),
      ),
      listChildren: vi.fn(() => Promise.resolve(options.children ?? [])),
    },
    issues: {
      get: vi.fn((_ws: string, id: string) =>
        Promise.resolve((options.issues ?? []).find((issue) => issue.id === id) ?? null),
      ),
    },
    knowledge: {
      all: vi.fn(() =>
        options.failing === 'knowledge'
          ? Promise.reject(new Error('index down'))
          : Promise.resolve(options.chunks ?? []),
      ),
    },
  };
  return { sources, subject: new WorkspaceContextReader(sources) };
}

describe('WorkspaceContextReader', () => {
  it('reads a PBI with its criteria and child items as plain text', async () => {
    const child = pbi('c1', {
      title: 'Task: build the filter',
      description: '<p>Dropdown by type</p>',
    });
    const { subject } = reader({ pbis: [pbi('p1')], children: [child] });
    const [document] = await subject.read(context, [{ kind: 'pbi', id: 'p1' }]);
    expect(document).toMatchObject({ kind: 'pbi', id: 'p1', title: 'PBI p1' });
    expect(document!.content).toContain('Product Backlog Item · Active');
    expect(document!.content).toContain('Filter the files to download');
    expect(document!.content).toContain('- By type');
    expect(document!.content).toContain('acceptanceCriteria:\nOnly matching files');
    expect(document!.content).toContain('- Task: build the filter: Dropdown by type');
    expect(document!.content).not.toContain('<');
    // A child without a description is listed by its title alone.
    const bare = reader({
      pbis: [pbi('p1')],
      children: [pbi('c2', { title: 'Bare child', description: '' })],
    });
    const [other] = await bare.subject.read(context, [{ kind: 'pbi', id: 'p1' }]);
    expect(other!.content).toContain('- Bare child');
    expect(other!.content).not.toContain('Bare child:');
  });

  it('finds a PBI by the id it has in Azure DevOps, and a card without a type', async () => {
    const linked = pbi('p2', {
      kind: 'card',
      sourceData: {},
      links: [{ providerId: 'azure_devops', externalId: '48325' }] as PbiItem['links'],
    });
    const { subject } = reader({ pbis: [linked] });
    const [document] = await subject.read(context, [{ kind: 'pbi', id: '48325' }]);
    expect(document).toMatchObject({ kind: 'pbi', title: 'PBI p2' });
    expect(document!.content).toContain('card · Active');
  });

  it('reads an issue and the Brain document of a page, in order of its chunks', async () => {
    const issue = {
      id: 'i1',
      title: 'Download fails',
      description: 'It <i>fails</i> &amp; stops',
      status: 'todo',
      priority: 'high',
    } as unknown as Issue;
    const source = 'https://dev.azure.com/o/p/_wiki/wikis/w?pagePath=/Files/Download-rules';
    const { subject } = reader({
      issues: [issue],
      chunks: [
        chunk(source, 'page-9', 1, ' second'),
        chunk(source, 'page-9', 0, 'first'),
        chunk('other', 'page-1', 0, 'unrelated'),
      ],
    });
    const documents = await subject.read(context, [
      { kind: 'issue', id: 'i1' },
      { kind: 'brain', id: `${source}:page-9` },
      { kind: 'brain', id: 'page-9' },
    ]);
    expect(documents[0]).toMatchObject({ kind: 'issue', title: 'Download fails' });
    expect(documents[0]!.content).toContain('todo · high');
    expect(documents[0]!.content).toContain('It fails & stops');
    expect(documents.slice(1)).toEqual([
      { kind: 'brain', id: `${source}:page-9`, title: 'Download-rules', content: 'first second' },
      { kind: 'brain', id: 'page-9', title: 'Download-rules', content: 'first second' },
    ]);
  });

  it('cuts long documents and leaves out what is missing or unreadable', async () => {
    const long = pbi('p1', { description: 'x'.repeat(MAX_CONTEXT_DOCUMENT * 2) });
    const { subject, sources } = reader({ pbis: [long] });
    const documents = await subject.read(context, [
      { kind: 'pbi', id: 'p1' },
      { kind: 'pbi', id: 'gone' },
      { kind: 'issue', id: 'gone' },
      { kind: 'brain', id: 'gone' },
    ]);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.content).toHaveLength(MAX_CONTEXT_DOCUMENT);
    // The Brain is read once, however many of its documents were chosen.
    expect(sources.knowledge.all).toHaveBeenCalledTimes(1);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const failing of ['pbi', 'knowledge'] as const) {
      const broken = reader({
        failing,
        issues: [
          { id: 'i', title: 'T', description: 'd', status: 's', priority: 'p' } as unknown as Issue,
        ],
      });
      const kept = await broken.subject.read(context, [
        { kind: failing === 'pbi' ? 'pbi' : 'brain', id: 'x' },
        { kind: 'issue', id: 'i' },
      ]);
      // One item that cannot be read does not stop the others.
      expect(kept.map((document) => document.kind)).toEqual(['issue']);
    }
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it('reads nothing of a request that has no workspace', async () => {
    const { subject } = reader({ pbis: [pbi('p1')] });
    expect(
      await subject.read({ requestId: 'r', ownerId: 'owner' }, [
        { kind: 'pbi', id: 'p1' },
        { kind: 'issue', id: 'i1' },
      ]),
    ).toEqual([]);
  });

  it('turns HTML into readable text', () => {
    expect(
      plainText(
        '<h1>Title</h1><p>a&nbsp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>line<br/>next<li>item</li>',
      ),
    ).toBe('Title\na b <c> "d" \'e\'\nline\nnext\n- item');
  });
});

describe('the documents of an exploration', () => {
  const documents: E2eExplorationContextDocument[] = [
    { kind: 'pbi', id: 'p1', title: 'PBI 1', content: 'text' },
    { kind: 'spec', id: 'run', title: 'Run', content: 'spec' },
  ];

  it('keeps them for the worker, clears them, and shows them without their text', async () => {
    const artifacts = new InMemoryE2eArtifactStore();
    const run = { workspaceId: 'ws', id: 'c1' };
    expect(await readExplorationContext(artifacts, run)).toEqual([]);
    await saveExplorationContext(artifacts, run, documents);
    expect(await readExplorationContext(artifacts, run)).toEqual(documents);
    await saveExplorationContext(artifacts, run, []);
    expect(await readExplorationContext(artifacts, run)).toEqual([]);
    // What is shown never includes the specification of the run or any text.
    expect(contextRefs(documents)).toEqual([{ kind: 'pbi', id: 'p1', title: 'PBI 1' }]);
  });

  it('reads nothing from content that is not a list of documents', async () => {
    const artifacts = new InMemoryE2eArtifactStore();
    const run = { workspaceId: 'ws', id: 'c1' };
    await artifacts.put('ws/c1/exploration-context.json', Buffer.from('{"not":"a list"}'));
    expect(await readExplorationContext(artifacts, run)).toEqual([]);
    await artifacts.put('ws/c1/exploration-context.json', Buffer.from('broken'));
    expect(await readExplorationContext(artifacts, run)).toEqual([]);
  });
});

describe('exploring with context, from the request to the agent', () => {
  async function pipeline(options: { reader?: boolean } = {}) {
    const store = new InMemoryE2eStore();
    const artifacts = new InMemoryE2eArtifactStore();
    const creation = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'owner',
      actorId: 'user',
      agentId: 'agent',
      name: 'Files filter',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://app',
      executionTarget: 'remote',
      localOrigin: null,
      path: '/',
      username: null,
      passwordSecret: null,
      accessSecret: null,
      prd: 'Users filter the files they download.',
      prdFileNames: [],
      diff: null,
      instructions: null,
      locale: 'en-US',
      repository: null,
      status: 'draft',
      useBrain: false,
      internal: false,
    });
    const runner = { explore: vi.fn().mockResolvedValue({ startUrl: 'http://app/', pages: [] }) };
    const author = { exploreStep: vi.fn().mockResolvedValue({ kind: 'finish', reason: 'done' }) };
    const read = vi.fn((_context: unknown, requests: readonly { kind: string; id: string }[]) =>
      Promise.resolve(
        requests.map((request) => ({
          kind: request.kind,
          id: request.id,
          title: `Title of ${request.id}`,
          content: `Text of ${request.id}`,
        })),
      ),
    );
    const queue = new InMemoryE2eJobQueue();
    const worker = new E2eWorker({
      queue,
      concurrency: 1,
      heartbeatMs: 5,
      executor: new E2eExecutor({
        store,
        artifacts,
        runner,
        author,
        scripts: new FakeScriptRepository(),
      } as never),
    });
    const service = new E2eService({
      store,
      queue,
      dispatcher: new LocalE2eDispatcher(worker),
      artifacts,
      agents: {
        getAgent: vi.fn((_workspaceId: string, id: string) =>
          Promise.resolve({ id, name: 'Explorer' }),
        ),
      } as never,
      scripts: new FakeScriptRepository(),
      ...(options.reader === false
        ? {}
        : { contextReader: { read } as unknown as E2eContextReader }),
    });
    return { service, creation, artifacts, runner, author, read, worker };
  }

  it('reads the chosen items with the permissions of the request and shows them on the exploration', async () => {
    const { service, creation, artifacts, read, worker, runner, author } = await pipeline();
    const started = await service.explore('ws', creation.id, 'someone', {
      context: [
        { kind: 'pbi', id: 'p1' },
        { kind: 'brain', id: 'b1' },
      ],
    });
    expect(started.context).toEqual([
      { kind: 'pbi', id: 'p1', title: 'Title of p1' },
      { kind: 'brain', id: 'b1', title: 'Title of b1' },
    ]);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner', workspaceId: 'ws', actorId: 'someone' }),
      [
        { kind: 'pbi', id: 'p1' },
        { kind: 'brain', id: 'b1' },
      ],
    );
    await worker.idle();

    // The worker gives the agent the text of the context, then the specification of the run.
    const { agent } = runner.explore.mock.calls[0]![0] as { agent: E2eExploreAgent };
    await agent({} as never);
    const request = author.exploreStep.mock.calls[0]![0] as {
      context: { kind: string; title: string; content: string }[];
    };
    expect(request.context.map((item) => [item.kind, item.title, item.content])).toEqual([
      ['pbi', 'Title of p1', 'Text of p1'],
      ['brain', 'Title of b1', 'Text of b1'],
      ['spec', 'Files filter', 'Users filter the files they download.'],
    ]);
    // The state of the finished exploration still says what it read.
    expect((await readExploration(artifacts, creation))!.context).toHaveLength(2);

    // The next exploration without context forgets it.
    await service.explore('ws', creation.id, 'someone', {});
    await worker.idle();
    expect(await readExplorationContext(artifacts, creation)).toEqual([]);
    const again = (runner.explore.mock.calls[1]![0] as { agent: E2eExploreAgent }).agent;
    await again({} as never);
    expect(
      (author.exploreStep.mock.calls[1]![0] as { context: { kind: string }[] }).context.map(
        (item) => item.kind,
      ),
    ).toEqual(['spec']);
    expect((await readExploration(artifacts, creation))!.context).toBeUndefined();
  });

  it("hands the agent the user chose to every step, and the run's own when none was chosen", async () => {
    const { service, creation, artifacts, worker, runner, author } = await pipeline();
    const started = await service.explore('ws', creation.id, 'someone', { agentId: 'explorer' });
    expect(started.agent).toEqual({ id: 'explorer', name: 'Explorer' });
    await worker.idle();
    const first = (runner.explore.mock.calls[0]![0] as { agent: E2eExploreAgent }).agent;
    await first({} as never);
    expect(author.exploreStep.mock.calls[0]![0]).toMatchObject({ agentId: 'explorer' });
    // The finished exploration still says which agent explored.
    expect((await readExploration(artifacts, creation))!.agent).toEqual({
      id: 'explorer',
      name: 'Explorer',
    });

    await service.explore('ws', creation.id, 'someone', {});
    await worker.idle();
    const second = (runner.explore.mock.calls[1]![0] as { agent: E2eExploreAgent }).agent;
    await second({} as never);
    expect(author.exploreStep.mock.calls[1]![0]).not.toHaveProperty('agentId');
    expect((await readExploration(artifacts, creation))!.agent).toBeUndefined();
  });

  it('takes no more than the limit of items, and ignores context when it cannot read it', async () => {
    const limited = await pipeline();
    await limited.service.explore('ws', limited.creation.id, undefined, {
      context: Array.from({ length: 30 }, (_, index) => ({
        kind: 'issue' as const,
        id: `i${index}`,
      })),
    });
    await limited.worker.idle();
    expect((limited.read.mock.calls[0]![1] as unknown[]).length).toBe(20);

    const without = await pipeline({ reader: false });
    const started = await without.service.explore('ws', without.creation.id, undefined, {
      context: [{ kind: 'pbi', id: 'p1' }],
    });
    expect(started.context).toBeUndefined();
    await without.worker.idle();
  });
});
