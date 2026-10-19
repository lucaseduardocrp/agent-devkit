import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaE2eStore } from '../src/modules/e2e/adapters/prisma-e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  LocalE2eRunner,
  decodeRunnerInput,
  runnerTaskPrefix,
} from '../src/modules/e2e/application/local-runner.js';
import { InMemoryE2eRunnerTaskStore } from '../src/modules/e2e/application/runner-tasks.js';
import { normalizeLocalBrowserOrigin } from '../src/modules/e2e/domain/e2e.js';

const reporting = {
  provider: 'azure_devops',
  planId: 'p1',
  suiteId: null,
  autoPublish: true,
};
const externalCase = {
  provider: 'azure_devops',
  caseId: '7',
  title: 'Case',
  url: 'https://dev.azure.com/acme/QA/_workitems/edit/7',
  steps: [],
};
const stepResults = [
  {
    position: 1,
    title: 'Open',
    status: 'passed',
    durationMs: 10,
    error: null,
    screenshotKey: null,
  },
];

function fakeDb() {
  const creationRow = {
    id: 'c1',
    workspaceId: 'ws',
    name: 'run',
    mode: 'frontend',
    scope: 'codebase',
    status: 'completed',
    executionTarget: 'remote',
    prdFileNames: [],
    reporting: JSON.stringify(reporting),
    lastReport: '{truncated',
    repoProvider: null,
    repoId: null,
    repoName: null,
    repoBranch: null,
    repoPath: null,
  };
  const testRow = {
    id: 't1',
    creationId: 'c1',
    workspaceId: 'ws',
    position: 1,
    steps: ['a', 1],
    externalCase: JSON.stringify(externalCase),
    stepResults,
  };
  const db = {
    e2eCreationRecord: {
      findFirst: vi.fn().mockResolvedValue(creationRow),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    e2eTestCaseRecord: {
      findFirst: vi.fn().mockResolvedValue(testRow),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { db, testRow, store: new PrismaE2eStore(db as unknown as PrismaClient) };
}

describe('PrismaE2eStore JSON columns', () => {
  it('parses stored reporting targets and drops unreadable reports', async () => {
    const { store } = fakeDb();
    const creation = await store.getCreation('ws', 'c1');
    expect(creation).toMatchObject({ reporting, lastReport: null, repository: null });
  });

  it('writes reporting changes as JSON text and clears them with NULL', async () => {
    const { db, store } = fakeDb();
    const lastReport = { status: 'published', provider: 'azure_devops', remoteRunId: '9' };
    await store.updateCreation('ws', 'c1', { reporting: null, lastReport } as never);
    expect(db.e2eCreationRecord.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'c1', workspaceId: 'ws' },
      data: { reporting: null, lastReport: JSON.stringify(lastReport) },
    });
  });

  it('maps linked cases and step results of tests both ways', async () => {
    const { db, testRow, store } = fakeDb();
    expect(await store.getTest('ws', 't1')).toMatchObject({
      steps: ['a'],
      externalCase,
      stepResults,
    });
    db.e2eTestCaseRecord.findFirst.mockResolvedValueOnce({
      ...testRow,
      externalCase: null,
      stepResults: { not: 'an array' },
    });
    expect(await store.getTest('ws', 't1')).toMatchObject({ externalCase: null, stepResults: [] });

    await store.updateTest('ws', 't1', { externalCase: null, stepResults } as never);
    expect(db.e2eTestCaseRecord.updateMany).toHaveBeenLastCalledWith({
      where: { id: 't1', workspaceId: 'ws' },
      data: { externalCase: null, stepResults },
    });
    await store.updateTest('ws', 't1', { externalCase } as never);
    expect(db.e2eTestCaseRecord.updateMany.mock.lastCall![0].data).toEqual({
      externalCase: JSON.stringify(externalCase),
    });
  });

  it('does not touch the run when the updated test vanished before it was read back', async () => {
    const { db, store } = fakeDb();
    db.e2eTestCaseRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.updateTest('ws', 't1', { status: 'passed' })).toBeNull();
    expect(db.e2eCreationRecord.updateMany).not.toHaveBeenCalled();
  });
});

describe('normalizeLocalBrowserOrigin', () => {
  it('ignores empty values and rejects unparseable ones', () => {
    expect(normalizeLocalBrowserOrigin(undefined, 'frontend')).toBeNull();
    expect(normalizeLocalBrowserOrigin('   ', 'frontend')).toBeNull();
    expect(() => normalizeLocalBrowserOrigin('localhost 5173', 'frontend')).toThrow(
      expect.objectContaining({
        code: 'E2E_INVALID_URL',
        message: 'Local browser origin is invalid.',
        details: [{ field: 'localOrigin' }],
      }),
    );
    expect(normalizeLocalBrowserOrigin(' http://127.0.0.1:5173 ', 'frontend')).toBe(
      'http://127.0.0.1:5173',
    );
  });
});

describe('LocalE2eRunner task payloads and cancellation', () => {
  const target = { workspaceId: 'ws', creationId: 'c1', testId: null, userId: 'user' };
  const snapshot = { startUrl: 'http://localhost:5173/', pages: [] };

  function runnerFinishingExplore() {
    const tasks = new InMemoryE2eRunnerTaskStore();
    const create = vi.spyOn(tasks, 'create');
    const get = tasks.get.bind(tasks);
    vi.spyOn(tasks, 'get').mockImplementation(async (id) => {
      const task = await get(id);
      return (
        task && {
          ...task,
          status: 'succeeded',
          result: JSON.stringify({ kind: 'explore', snapshot }),
        }
      );
    });
    const runner = new LocalE2eRunner({
      tasks,
      artifacts: new InMemoryE2eArtifactStore(),
      pollMs: 1,
    }).for(target);
    const payload = () => decodeRunnerInput(create.mock.lastCall![0].payload);
    return { runner, payload };
  }

  it('drops the tunnel token when the runner reaches the localhost origin directly', async () => {
    const { runner, payload } = runnerFinishingExplore();
    const token = { clientId: 'adk-local-1', clientSecret: 'tunnel-secret' };
    await expect(
      runner.explore({
        mode: 'frontend',
        url: 'http://localhost:5173/',
        transportUrl: 'https://sample.trycloudflare.com',
        accessToken: token,
      }),
    ).resolves.toEqual(snapshot);
    expect(payload()).toEqual({
      kind: 'explore',
      mode: 'frontend',
      url: 'http://localhost:5173/',
      accessToken: null,
    });

    await runner.explore({ mode: 'frontend', url: 'https://app.example.com/', accessToken: token });
    expect(payload()).toMatchObject({ url: 'https://app.example.com/', accessToken: token });
  });

  it('cancels and cleans up when the task disappears while waiting', async () => {
    const tasks = new InMemoryE2eRunnerTaskStore();
    const artifacts = new InMemoryE2eArtifactStore();
    vi.spyOn(tasks, 'get').mockResolvedValue(null);
    const remove = vi.spyOn(tasks, 'remove');
    const removePrefix = vi.spyOn(artifacts, 'removePrefix');
    const create = vi.spyOn(tasks, 'create');
    const runner = new LocalE2eRunner({ tasks, artifacts, pollMs: 1 }).for(target);
    await expect(runner.explore({ mode: 'frontend', url: 'http://localhost:1/' })).rejects.toThrow(
      'Local run cancelled.',
    );
    const created = await create.mock.results[0]!.value;
    expect(remove).toHaveBeenCalledWith(created.id);
    expect(removePrefix).toHaveBeenCalledWith(runnerTaskPrefix(created));
  });
});
