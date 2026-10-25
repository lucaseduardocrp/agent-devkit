import { describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '../src/shared/encryption.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  E2eService,
  type SavedCaseForRun,
  type SavedCaseReader,
} from '../src/modules/e2e/application/e2e-service.js';
import { decryptAccessToken } from '../src/modules/e2e/application/access-token.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { LocalE2eDispatcher } from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import type {
  TestManagementProvider,
  TestManagementResolver,
} from '../src/modules/test-management/application/test-management-provider.js';
import type { ExternalTestCase } from '../src/modules/test-management/domain/test-run.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001 - ok', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('x');
});`;
const context = {
  requestId: 'r',
  workspaceId: 'ws',
  ownerId: 'ws',
  actorId: 'user',
  locale: 'en-US' as const,
};
const input = {
  name: 'Protected app',
  agentId: 'agent',
  mode: 'frontend' as const,
  scope: 'codebase' as const,
  baseUrl: 'https://app.example.com',
  path: '/',
  username: 'qa@example.com',
  password: 'secret-pass',
  prd: 'Users sign in.',
  repository: { provider: 'github' as const, id: '42', branch: 'main', path: 'tests/e2e' },
};

function setup(
  options: { testManagement?: TestManagementResolver; savedCases?: SavedCaseReader } = {},
) {
  const store = new InMemoryE2eStore();
  const artifacts = new InMemoryE2eArtifactStore();
  const scripts = new FakeScriptRepository();
  const author = {
    plan: vi.fn().mockResolvedValue({
      summary: 'PRD',
      tests: [{ title: 'Sign in', description: 'd', priority: 'high', steps: ['a'] }],
    }),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze: vi.fn().mockResolvedValue(null),
  };
  const runner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'x', pages: [] }),
    run: vi.fn().mockResolvedValue({
      status: 'passed',
      durationMs: 5,
      error: null,
      logs: 'ok',
      video: null,
      steps: [],
    }),
  };
  const queue = new InMemoryE2eJobQueue();
  const worker = new E2eWorker({
    queue,
    concurrency: 1,
    heartbeatMs: 5,
    executor: new E2eExecutor({
      store,
      artifacts,
      author: author as unknown as E2eAuthor,
      runner,
      scripts,
    }),
  });
  const service = new E2eService({
    store,
    queue,
    dispatcher: new LocalE2eDispatcher(worker),
    artifacts,
    agents: { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) } as never,
    scripts,
    ...options,
  });
  return { service, store, runner, author, scripts, worker };
}

describe('E2eService access credentials', () => {
  it('replaces, keeps or clears the tunnel service token when a run is edited', async () => {
    const { service, store, worker } = setup();
    const created = await service.create(context, {
      ...input,
      accessClientId: 'first-id',
      accessClientSecret: 'first-secret',
    });
    await worker.idle();
    const stored = async () => (await store.getCreation('ws', created.id))!;

    const replaced = await service.update('ws', created.id, {
      ...input,
      accessClientId: 'second-id',
      accessClientSecret: 'second-secret',
    });
    expect(replaced.hasAccessServiceToken).toBe(true);
    expect(decryptAccessToken((await stored()).accessSecret)).toEqual({
      clientId: 'second-id',
      clientSecret: 'second-secret',
    });

    const kept = await service.update('ws', created.id, input);
    expect(kept.hasAccessServiceToken).toBe(true);
    expect(decryptAccessToken((await stored()).accessSecret)?.clientId).toBe('second-id');

    const cleared = await service.update('ws', created.id, {
      ...input,
      clearAccessServiceToken: true,
      accessClientId: 'ignored-id',
      accessClientSecret: 'ignored-secret',
    });
    expect(cleared.hasAccessServiceToken).toBe(false);
    expect((await stored()).accessSecret).toBeNull();

    // Keeping the origin without a saved token stays without one.
    expect((await service.update('ws', created.id, input)).hasAccessServiceToken).toBe(false);
  });

  it('keeps the saved password only while a username is set', async () => {
    const { service, store, worker } = setup();
    const created = await service.create(context, input);
    await worker.idle();
    await service.update('ws', created.id, { ...input, password: undefined });
    expect(decryptSecret((await store.getCreation('ws', created.id))!.passwordSecret!)).toBe(
      'secret-pass',
    );
    const anonymous = await service.update('ws', created.id, {
      ...input,
      username: undefined,
      password: undefined,
    });
    expect(anonymous).toMatchObject({ username: null, hasPassword: false });
  });

  it('reuses the saved token for a probe of the same origin only', async () => {
    const { service, worker } = setup();
    const created = await service.create(context, {
      ...input,
      accessClientId: 'client-id',
      accessClientSecret: 'client-secret',
    });
    await worker.idle();
    await expect(
      service.accessTokenForProbe('ws', created.id, 'https://app.example.com/login?x=1'),
    ).resolves.toEqual({ clientId: 'client-id', clientSecret: 'client-secret' });
    await expect(
      service.accessTokenForProbe('ws', created.id, 'https://other.example.com/'),
    ).resolves.toBeNull();
    await expect(service.accessTokenForProbe('ws', created.id, 'not a url')).resolves.toBeNull();
    await expect(
      service.accessTokenForProbe('ws', 'missing', 'https://app.example.com'),
    ).rejects.toMatchObject({ code: 'E2E_CREATION_NOT_FOUND', statusCode: 404 });
  });
});

describe('E2eService execution target', () => {
  it('leaves a run untouched when it already uses the requested target', async () => {
    const { service, store, worker } = setup();
    const created = await service.create(context, input);
    await worker.idle();
    const update = vi.spyOn(store, 'updateCreation');
    const view = await service.setExecutionTarget('ws', created.id, 'remote');
    expect(view).toMatchObject({ id: created.id, executionTarget: 'remote' });
    expect(update).not.toHaveBeenCalled();
  });

  it('explores a tunnelled run through its public URL when a deleted spec is rewritten', async () => {
    const { service, runner, scripts, worker } = setup();
    const tunnel = {
      ...input,
      baseUrl: 'https://sample.trycloudflare.com',
      localOrigin: 'http://localhost:5173',
    };
    const created = await service.create(context, tunnel);
    await worker.idle();
    const [test] = (await service.get('ws', created.id)).tests;
    scripts.files.clear();
    runner.explore.mockClear();
    await service.rerunTest('ws', test!.id);
    await worker.idle();
    expect(runner.explore).toHaveBeenCalledOnce();
    expect(runner.explore).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:5173/',
        transportUrl: 'https://sample.trycloudflare.com',
      }),
    );
  });
});

const step = { action: 'Open', expectedResult: 'Opened' };
const savedCase = (
  caseId: string,
  remote: SavedCaseForRun['remote'],
  title = `Saved ${caseId}`,
): SavedCaseForRun => ({ caseId, title, description: '', steps: [step], remote });
const external = (caseId: string, planId?: string, suiteId?: string): ExternalTestCase => ({
  provider: 'azure_devops',
  caseId,
  ...(planId ? { planId } : {}),
  ...(suiteId ? { suiteId } : {}),
  title: `Remote ${caseId}`,
  url: `https://dev.azure.com/acme/QA/_workitems/edit/${caseId}`,
  steps: [{ id: '1', action: 'Open', expectedResult: 'Opened' }],
});

function resolverFor(provider: Partial<TestManagementProvider> | null | Error) {
  return {
    listTestManagementProviders: vi.fn().mockResolvedValue([]),
    resolveTestManagementProvider:
      provider instanceof Error
        ? vi.fn().mockRejectedValue(provider)
        : vi.fn().mockResolvedValue(provider),
  } as TestManagementResolver & { resolveTestManagementProvider: ReturnType<typeof vi.fn> };
}

const hostRun = { ...input, planning: 'host' as const, savedCases: { suiteId: 'suite-1' } };

describe('E2eService saved test cases', () => {
  it('reports to one platform plan only when every linked case shares it', async () => {
    const listCases = vi
      .fn()
      .mockImplementation(({ planId }: { planId?: string }) =>
        Promise.resolve(
          planId === 'p1' ? [external('11', 'p1', 's1')] : [external('22', 'p2', 's1')],
        ),
      );
    const testManagement = resolverFor({ listCases } as Partial<TestManagementProvider>);
    const savedCases = {
      listSavedCases: vi
        .fn()
        .mockResolvedValue([
          savedCase('a', { provider: 'azure_devops', caseId: '11', planId: 'p1', suiteId: 's1' }),
          savedCase('b', { provider: 'azure_devops', caseId: '22', planId: 'p2', suiteId: 's1' }),
        ]),
    };
    const { service, store } = setup({ testManagement, savedCases });
    const created = await service.create(context, hostRun);
    expect(listCases).toHaveBeenCalledTimes(2);
    expect(created.reporting).toEqual({
      provider: 'azure_devops',
      planId: null,
      suiteId: 's1',
      autoPublish: true,
    });
    expect((await store.listTests('ws', created.id)).map((test) => test.title)).toEqual([
      '11 - Remote 11',
      '22 - Remote 22',
    ]);
  });

  it('reads a location without plan or suite and reports without them', async () => {
    const listCases = vi.fn().mockResolvedValue([external('7')]);
    const testManagement = resolverFor({ listCases } as Partial<TestManagementProvider>);
    const savedCases = {
      listSavedCases: vi
        .fn()
        .mockResolvedValue([savedCase('a', { provider: 'azure_devops', caseId: '7' })]),
    };
    const { service } = setup({ testManagement, savedCases });
    const created = await service.create(context, hostRun);
    expect(listCases).toHaveBeenCalledWith({});
    expect(created.reporting).toEqual({
      provider: 'azure_devops',
      planId: null,
      suiteId: null,
      autoPublish: true,
    });
  });

  it('automates the saved copies when the platform cannot be read', async () => {
    const remote = { provider: 'azure_devops', caseId: '7', planId: 'p1' };
    const savedCases = {
      listSavedCases: vi
        .fn()
        .mockResolvedValue([savedCase('a', remote, 'Saved copy'), savedCase('b', null, 'Local')]),
    };
    const titles = async (testManagement?: TestManagementResolver) => {
      const { service, store } = setup({
        ...(testManagement ? { testManagement } : {}),
        savedCases,
      });
      const created = await service.create(context, hostRun);
      expect(created.reporting).toBeNull();
      return (await store.listTests('ws', created.id)).map((test) => [
        test.title,
        test.externalCase,
      ]);
    };
    const expected = [
      ['Saved copy', null],
      ['Local', null],
    ];

    // No test management module, a resolver that fails, and a listing that fails.
    expect(await titles()).toEqual(expected);
    const failing = resolverFor(new Error('not configured'));
    expect(await titles(failing)).toEqual(expected);
    expect(failing.resolveTestManagementProvider).toHaveBeenCalledWith('ws', 'azure_devops');
    const listCases = vi.fn().mockRejectedValue(new Error('timeout'));
    expect(await titles(resolverFor({ listCases } as Partial<TestManagementProvider>))).toEqual(
      expected,
    );
    expect(listCases).toHaveBeenCalledWith({ planId: 'p1' });
  });

  it('ignores remote links to unknown platforms', async () => {
    const testManagement = resolverFor(null);
    const savedCases = {
      listSavedCases: vi
        .fn()
        .mockResolvedValue([savedCase('a', { provider: 'unknown', caseId: '7' }, 'Orphan')]),
    };
    const { service, store } = setup({ testManagement, savedCases });
    const created = await service.create(context, hostRun);
    expect(testManagement.resolveTestManagementProvider).not.toHaveBeenCalled();
    expect(created.reporting).toBeNull();
    expect((await store.listTests('ws', created.id))[0]?.title).toBe('Orphan');
  });
});
