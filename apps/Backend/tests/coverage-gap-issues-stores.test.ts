import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';
import {
  InMemoryRunStore,
  PrismaRunStore,
  type WorkflowRunState,
} from '../src/modules/issues/run-store.js';
import { PrismaIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryPbiStore, withPbiChangeHook } from '../src/modules/pbi/pbi-store.js';
import { PbiService } from '../src/modules/pbi/pbi-service.js';
import { createPbiProvider } from '../src/modules/pbi/providers.js';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';

const state: WorkflowRunState = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  steps: [{ id: 's', name: 'S', instructions: '' }],
  currentStepIndex: 0,
  results: [],
  totalCostMicros: 0,
  allStepsPriced: true,
};
const run = { id: 'run-1', workspaceId: 'ws', issueId: 'issue-1', status: 'running' };

function prismaRunDb() {
  const db = {
    agentRunRecord: {
      findFirst: vi.fn().mockResolvedValue(run),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    issueRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return { db, store: new PrismaRunStore(db as unknown as PrismaClient) };
}

describe('PrismaRunStore workflow checkpoints', () => {
  it('pauses a running run and moves its issue to review', async () => {
    const { db, store } = prismaRunDb();
    expect(await store.checkpoint('ws', 'run-1', 'waiting_input', state, 'out')).toEqual(run);
    expect(db.agentRunRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', workspaceId: 'ws', status: 'running' },
      data: { status: 'waiting_input', workflowState: state, output: 'out' },
    });
    expect(db.issueRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'issue-1', workspaceId: 'ws', activeRunId: 'run-1' },
      data: { status: 'in_review' },
    });
  });

  it('does not pause missing, finished or concurrently changed runs', async () => {
    const { db, store } = prismaRunDb();
    db.agentRunRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.checkpoint('ws', 'run-1', 'waiting_review', state, '')).toBeNull();
    db.agentRunRecord.findFirst.mockResolvedValueOnce({ ...run, status: 'succeeded' });
    expect(await store.checkpoint('ws', 'run-1', 'waiting_review', state, '')).toBeNull();
    db.agentRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.checkpoint('ws', 'run-1', 'waiting_review', state, '')).toBeNull();
    expect(db.issueRecord.updateMany).not.toHaveBeenCalled();
  });

  it('records progress only while the run is running', async () => {
    const { db, store } = prismaRunDb();
    expect(await store.progress('ws', 'run-1', state, 'partial', { costMicros: 5 })).toEqual(run);
    expect(db.agentRunRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', workspaceId: 'ws', status: 'running' },
      data: { costMicros: 5, workflowState: state, output: 'partial' },
    });
    db.agentRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.progress('ws', 'run-1', state, 'partial', {})).toBeNull();
  });

  it('requeues a paused run and its issue, or reports that it cannot be resumed', async () => {
    const { db, store } = prismaRunDb();
    expect(await store.resume('ws', 'run-1', state, 'out')).toEqual(run);
    expect(db.agentRunRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
        workspaceId: 'ws',
        status: { in: ['waiting_review', 'waiting_input'] },
      },
      data: { status: 'queued', workflowState: state, output: 'out' },
    });
    expect(db.issueRecord.updateMany).toHaveBeenCalledWith({
      where: { activeRunId: 'run-1', workspaceId: 'ws' },
      data: { status: 'in_progress' },
    });
    db.agentRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.resume('ws', 'run-1', state, 'out')).toBeNull();
  });
});

describe('run store claims and resumes', () => {
  it('claims a Prisma run without workflow state', async () => {
    const create = vi.fn(async ({ data }: { data: object }) => data);
    const tx = {
      issueRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agentRunRecord: { create },
    };
    const db = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const store = new PrismaRunStore(db as unknown as PrismaClient);
    await store.claim({
      workspaceId: 'ws',
      issueId: 'issue-1',
      agentId: 'a',
      actorId: 'u',
      ownerId: 'ws',
      mode: 'host',
      workflowState: null,
      prompt: 'p',
      attempt: 1,
    });
    expect(create.mock.calls[0]![0].data).toMatchObject({
      mode: 'host',
      workflowState: Prisma.DbNull,
    });
  });

  it('only resumes in-memory runs that wait for the user', async () => {
    const store = new InMemoryRunStore();
    const run = (await store.claim({
      workspaceId: 'ws',
      issueId: 'issue-1',
      agentId: 'a',
      actorId: 'u',
      ownerId: 'ws',
      mode: 'server',
      prompt: 'p',
      attempt: 1,
      workflowState: state,
    }))!;
    expect(await store.resume('ws', 'missing', state, '')).toBeNull();
    expect(await store.resume('ws', run.id, state, '')).toBeNull();
    await store.start('ws', run.id);
    await store.checkpoint('ws', run.id, 'waiting_input', state, 'q');
    expect(await store.resume('ws', run.id, state, 'a')).toMatchObject({
      status: 'queued',
      output: 'a',
    });
  });
});

describe('PrismaIssueStore lookups', () => {
  it('returns null for an issue outside the workspace', async () => {
    const db = { issueRecord: { findFirst: vi.fn().mockResolvedValue(null) } };
    const store = new PrismaIssueStore(db as unknown as PrismaClient);
    expect(await store.get('ws', 'missing')).toBeNull();
  });
});

describe('PBI store and service fallbacks', () => {
  it('reads several items through the change hook without invalidating caches', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const store = withPbiChangeHook(new InMemoryPbiStore(), onChange);
    const item = await store.create('ws', { kind: 'pbi', title: 'A' });
    onChange.mockClear();
    expect((await store.getMany('ws', [item.id])).map((found) => found.title)).toEqual(['A']);
    expect(await store.findByExternal('ws', 'jira', 'J-1')).toBeNull();
    expect(
      (await store.search('ws', { page: 1, pageSize: 10 })).items.map((found) => found.title),
    ).toEqual(['A']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lists summaries without a cache and rejects pulling an unconfigured provider', async () => {
    const store = new InMemoryPbiStore();
    await store.create('ws', { kind: 'pbi', title: 'A' });
    const integrations = {
      listIntegrations: vi.fn().mockResolvedValue([
        {
          providerId: 'trello',
          category: 'PROJECT_MANAGEMENT',
          isEnabled: true,
          hasSecret: true,
          settings: {},
        },
      ]),
    } as unknown as IntegrationsService;
    const service = new PbiService(store, integrations);
    expect(JSON.parse(await service.summariesJson('ws')).items).toEqual([
      expect.objectContaining({ title: 'A' }),
    ]);
    await expect(service.pull('ws', true, 'jira')).rejects.toMatchObject({
      code: 'PBI_PROVIDER_CONFIG',
      message: 'Configure jira in Integrations first.',
    });
  });

  it('names Azure attachments without a name or file segment "file"', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('workitemsbatch')
        ? {
            value: [
              {
                id: 11,
                fields: { 'System.WorkItemType': 'Task', 'System.Title': 'Child' },
                relations: [
                  { rel: 'AttachedFile', url: 'https://files.example/a/' },
                  { rel: 'AttachedFile', url: 'https://files.example/b.png', attributes: {} },
                  {
                    rel: 'AttachedFile',
                    url: 'https://files.example/c',
                    attributes: { name: ' spec.pdf ' },
                  },
                ],
              },
            ],
          }
        : {
            relations: [
              {
                rel: 'System.LinkTypes.Hierarchy-Forward',
                url: 'https://dev.azure.com/org/_apis/wit/workItems/11',
              },
            ],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = createPbiProvider(
      { id: 'azure_devops', settings: { organization: 'org', project: 'p' }, secret: 'pat' },
      fetcher as unknown as typeof fetch,
    );
    const [child] = await provider.pullChildren!('10');
    expect(child!.attachments).toEqual([
      expect.objectContaining({ name: 'file', url: 'https://files.example/a/?fileName=file' }),
      expect.objectContaining({ name: 'b.png', kind: 'image' }),
      expect.objectContaining({
        name: 'spec.pdf',
        url: 'https://files.example/c?fileName=spec.pdf',
      }),
    ]);
  });
});
