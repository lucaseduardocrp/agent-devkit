import { describe, expect, it, vi } from 'vitest';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  E2eService,
  MAX_IMPORTED_CASES,
  type SavedCaseForRun,
  type SavedCaseReader,
} from '../src/modules/e2e/application/e2e-service.js';
import type { E2eRunResult } from '../src/modules/e2e/application/e2e-runner.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { E2eRunReporter } from '../src/modules/e2e/application/e2e-reporter.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { LocalE2eDispatcher } from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import type { E2eCreation, E2eTestCase } from '../src/modules/e2e/domain/e2e.js';
import type {
  TestManagementProvider,
  TestManagementResolver,
} from '../src/modules/test-management/application/test-management-provider.js';
import type {
  ExternalTestCase,
  TestRunReport,
} from '../src/modules/test-management/domain/test-run.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001 - ok', async ({ page }) => {
  await test.step('Passo 1 - abrir', async () => { await page.goto('/'); });
});`;
const PNG = Buffer.from('png-bytes');

const azureCase = (caseId: string, steps = 2): ExternalTestCase => ({
  provider: 'azure_devops',
  caseId,
  planId: '50398',
  suiteId: '50586',
  title: `Caso ${caseId}`,
  url: `https://dev.azure.com/acme/QA/_workitems/edit/${caseId}`,
  steps: Array.from({ length: steps }, (_, index) => ({
    id: String(index + 2),
    action: `Ação ${index + 1}`,
    expectedResult: `Esperado ${index + 1}`,
  })),
});

const passedTwoSteps: E2eRunResult = {
  status: 'passed',
  durationMs: 3000,
  error: null,
  logs: 'ok',
  video: Buffer.from('webm'),
  steps: [
    {
      position: 1,
      title: 'Passo 1',
      status: 'passed',
      durationMs: 1000,
      error: null,
      screenshot: PNG,
    },
    {
      position: 2,
      title: 'Passo 2',
      status: 'passed',
      durationMs: 1500,
      error: null,
      screenshot: null,
    },
  ],
};

const context = {
  requestId: 'r',
  workspaceId: 'ws',
  ownerId: 'ws',
  actorId: 'user',
  locale: 'pt-BR' as const,
};
const runInput = {
  name: 'Centro de custo',
  agentId: 'agent',
  mode: 'frontend' as const,
  scope: 'codebase' as const,
  baseUrl: 'http://localhost:8014',
  prd: '',
  repository: { provider: 'github' as const, id: '42', branch: 'main', path: 'tests/e2e' },
};

function fakeProvider(cases: ExternalTestCase[] = [azureCase('50605'), azureCase('50606')]) {
  const provider = {
    id: 'azure_devops' as const,
    name: 'Azure DevOps Test Plans',
    capabilities: {
      planLabel: 'Test Plan',
      suiteLabel: 'Suite',
      suiteRequired: true,
      caseIdLabel: 'Test Case ID',
      stepEvidence: true,
    },
    listPlans: vi.fn().mockResolvedValue([{ id: '50398', name: 'Relação N:N' }]),
    listSuites: vi.fn().mockResolvedValue([{ id: '50586', name: 'Suite' }]),
    listCases: vi.fn().mockResolvedValue(cases),
    getCase: vi
      .fn()
      .mockImplementation(({ caseId }: { caseId: string }) =>
        Promise.resolve({ ...azureCase(caseId, 3), planId: undefined, suiteId: undefined }),
      ),
    publishRun: vi.fn().mockResolvedValue({
      provider: 'azure_devops',
      remoteRunId: '1037128',
      url: 'https://dev.azure.com/acme/QA/_testManagement/runs?_a=runCharts&runId=1037128',
      publishedCases: 2,
      warnings: ['remote warning'],
    }),
  };
  return provider as typeof provider & TestManagementProvider;
}

function setup(
  options: {
    provider?: ReturnType<typeof fakeProvider> | null;
    results?: E2eRunResult[];
    withResolver?: boolean;
    withReporter?: boolean;
    savedCases?: SavedCaseReader;
  } = {},
) {
  // Null means "not configured"; tests that pass null never touch the provider itself.
  const provider = (
    options.provider === undefined ? fakeProvider() : options.provider
  ) as ReturnType<typeof fakeProvider>;
  const store = new InMemoryE2eStore();
  const artifacts = new InMemoryE2eArtifactStore();
  const scripts = new FakeScriptRepository();
  const resolver: TestManagementResolver = {
    listTestManagementProviders: vi.fn().mockResolvedValue([
      {
        id: 'azure_devops',
        name: 'Azure DevOps Test Plans',
        configured: Boolean(provider),
        capabilities: fakeProvider().capabilities,
      },
    ]),
    resolveTestManagementProvider: vi.fn().mockResolvedValue(provider),
  };
  const author: E2eAuthor = {
    plan: vi.fn().mockResolvedValue({
      summary: 'PRD',
      tests: [{ title: 'Planned', description: 'd', priority: 'high', steps: ['a'] }],
    }),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze: vi.fn().mockResolvedValue({ verdict: 'app_bug', summary: 'App is wrong.' }),
  };
  const results = [...(options.results ?? [passedTwoSteps])];
  const runner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'x', pages: [] }),
    run: vi
      .fn()
      .mockImplementation(() => Promise.resolve(results.length > 1 ? results.shift() : results[0])),
  };
  const reporter = new E2eRunReporter({ store, artifacts, testManagement: resolver });
  const queue = new InMemoryE2eJobQueue();
  const worker = new E2eWorker({
    queue,
    concurrency: 1,
    heartbeatMs: 5,
    executor: new E2eExecutor({
      store,
      artifacts,
      author,
      runner,
      scripts,
      reporter: options.withReporter === false ? null : reporter,
    }),
  });
  const service = new E2eService({
    store,
    queue,
    dispatcher: new LocalE2eDispatcher(worker),
    artifacts,
    agents: { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) } as never,
    scripts,
    ...(options.withResolver === false ? {} : { testManagement: resolver }),
    ...(options.savedCases ? { savedCases: options.savedCases } : {}),
  });
  return { service, store, artifacts, provider, resolver, author, runner, reporter, worker };
}

const report = (provider: { publishRun: { mock: { calls: unknown[][] } } }) =>
  provider.publishRun.mock.calls.at(-1)![0] as TestRunReport;

describe('E2E runs reported to test management platforms', () => {
  it('imports cases, runs one spec per case and publishes steps with their evidence', async () => {
    const { service, store, provider, author, worker, artifacts } = setup();
    const created = await service.create(context, {
      ...runInput,
      importCases: { provider: 'azure_devops', planId: '50398', suiteId: '50586' },
    });
    expect(created.reporting).toEqual({
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
      autoPublish: true,
    });
    await worker.idle();

    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('completed');
    expect(detail.tests.map((test) => [test.title, test.status])).toEqual([
      ['50605 - Caso 50605', 'passed'],
      ['50606 - Caso 50606', 'passed'],
    ]);
    expect(detail.tests[0]!.steps).toEqual(['Ação 1 => Esperado 1', 'Ação 2 => Esperado 2']);
    expect(detail.tests[0]!.stepResults).toEqual([
      expect.objectContaining({ position: 1, status: 'passed', hasScreenshot: true }),
      expect.objectContaining({ position: 2, status: 'passed', hasScreenshot: false }),
    ]);
    // The spec author sees the external steps of each case.
    expect(vi.mocked(author.writeScript).mock.calls[0]![0].test.externalCase?.caseId).toBe('50605');
    expect(await service.stepScreenshot('ws', detail.tests[0]!.id, 1)).toEqual(PNG);
    await expect(service.stepScreenshot('ws', detail.tests[0]!.id, 2)).rejects.toMatchObject({
      code: 'E2E_EVIDENCE_NOT_FOUND',
    });
    await expect(service.stepScreenshot('ws', detail.tests[0]!.id, 9)).rejects.toMatchObject({
      code: 'E2E_EVIDENCE_NOT_FOUND',
    });

    const published = report(provider);
    expect(published).toMatchObject({
      name: 'Centro de custo (ADK E2E)',
      target: { planId: '50398', suiteId: '50586' },
    });
    expect(published.environment).toContain('http://localhost:8014/');
    expect(published.results).toHaveLength(2);
    expect(published.results[0]).toMatchObject({
      outcome: 'passed',
      durationMs: 3000,
      errorMessage: null,
      testCase: { caseId: '50605', planId: '50398', suiteId: '50586' },
      attachments: [expect.objectContaining({ fileName: 'TC001.webm', contentType: 'video/webm' })],
    });
    expect(published.results[0]!.steps).toEqual([
      expect.objectContaining({
        position: 1,
        stepId: '2',
        outcome: 'passed',
        evidence: [
          expect.objectContaining({ fileName: 'TC001-passo-01.png', contentType: 'image/png' }),
        ],
      }),
      expect.objectContaining({ position: 2, stepId: '3', outcome: 'passed', evidence: [] }),
    ]);

    const after = await store.getCreation('ws', created.id);
    expect(after!.lastReport).toMatchObject({
      status: 'published',
      remoteRunId: '1037128',
      publishedCases: 2,
      warnings: ['remote warning'],
    });

    // A rerun clears the previous step results and replaces the screenshots.
    await service.rerunTest('ws', detail.tests[0]!.id);
    expect((await store.getTest('ws', detail.tests[0]!.id))!.stepResults).toEqual([]);
    await worker.idle();
    expect(await artifacts.get(`ws/${created.id}/steps/${detail.tests[0]!.id}/01.png`)).toEqual(
      PNG,
    );
    expect(report(provider).results.map((result) => result.testCase.caseId)).toEqual(['50605']);
  });

  it('marks unreached steps as not executed and reports failures with their analysis', async () => {
    const failing: E2eRunResult = {
      status: 'failed',
      durationMs: 2000,
      error: 'Esperado não visível',
      logs: 'x',
      video: null,
      steps: [
        {
          position: 1,
          title: 'Passo 1',
          status: 'failed',
          durationMs: 2000,
          error: 'Esperado não visível',
          screenshot: PNG,
        },
      ],
    };
    const { service, provider, worker } = setup({ results: [failing] });
    await service.create(context, {
      ...runInput,
      importCases: {
        provider: 'azure_devops',
        planId: '50398',
        suiteId: '50586',
        caseIds: ['50606'],
      },
    });
    await worker.idle();
    const published = report(provider);
    expect(published.results).toHaveLength(1);
    expect(published.results[0]).toMatchObject({
      outcome: 'failed',
      errorMessage: 'Esperado não visível',
      comment: 'App is wrong.',
      attachments: [],
    });
    expect(published.results[0]!.steps.map((step) => [step.outcome, step.actualResult])).toEqual([
      ['failed', 'Esperado não visível'],
      ['not_executed', null],
    ]);
  });

  it('lets the MCP host write the specs for imported cases and keeps them linked', async () => {
    const { service, store, worker } = setup();
    const created = await service.create(context, {
      ...runInput,
      planning: 'host',
      reporting: null,
      importCases: { provider: 'azure_devops', planId: '50398', suiteId: '50586' },
    });
    expect(created).toMatchObject({ status: 'draft', reporting: null });
    await worker.idle();
    const brief = await service.brief('ws', created.id);
    expect(brief.existingTests[0]).toMatchObject({
      steps: ['Ação 1 => Esperado 1', 'Ação 2 => Esperado 2'],
      externalCase: { caseId: '50605' },
    });
    await service.savePlan('ws', created.id, {
      tests: brief.existingTests.map((test) => ({
        title: test.title,
        description: '',
        priority: 'medium' as const,
        steps: [...test.steps],
        script: SCRIPT,
        externalCase: test.externalCase,
      })),
    });
    await worker.idle();
    const tests = await store.listTests('ws', created.id);
    expect(tests.map((test) => test.externalCase?.caseId)).toEqual(['50605', '50606']);
  });

  it('browses the platforms and validates what is imported', async () => {
    const { service, provider } = setup();
    expect(await service.testManagementProviders('ws')).toEqual([
      expect.objectContaining({ id: 'azure_devops', configured: true }),
    ]);
    expect(await service.remotePlans('ws', 'azure_devops')).toEqual([
      { id: '50398', name: 'Relação N:N' },
    ]);
    expect(await service.remoteSuites('ws', 'azure_devops', '50398')).toHaveLength(1);
    expect(provider.listSuites).toHaveBeenCalledWith('50398');
    expect(await service.remoteCases('ws', 'azure_devops', { planId: '1' })).toHaveLength(2);

    await expect(
      service.create(context, {
        ...runInput,
        importCases: { provider: 'azure_devops', caseIds: ['999'] },
      }),
    ).rejects.toMatchObject({ code: 'TEST_MANAGEMENT_CASE_NOT_FOUND', statusCode: 404 });
    expect(provider.listCases).toHaveBeenLastCalledWith({});

    const many = Array.from({ length: MAX_IMPORTED_CASES + 1 }, (_, index) =>
      azureCase(String(index + 1), 1),
    );
    const crowded = setup({ provider: fakeProvider(many) });
    await expect(
      crowded.service.create(context, {
        ...runInput,
        importCases: { provider: 'azure_devops', planId: '1', suiteId: '2' },
      }),
    ).rejects.toMatchObject({ code: 'E2E_TOO_MANY_TESTS' });

    const missing = setup({ provider: null });
    await expect(missing.service.remotePlans('ws', 'azure_devops')).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_NOT_CONFIGURED',
    });
    const unwired = setup({ withResolver: false });
    await expect(unwired.service.testManagementProviders('ws')).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_NOT_CONFIGURED',
    });
  });

  it('imports into an existing run, links tests and chooses where results go', async () => {
    const { service, store, provider, worker } = setup();
    const created = await service.create(context, {
      ...runInput,
      prd: 'Product',
      reporting: { provider: 'azure_devops', planId: ' ', autoPublish: false },
    });
    expect(created.reporting).toEqual({
      provider: 'azure_devops',
      planId: null,
      suiteId: null,
      autoPublish: false,
    });
    await worker.idle();
    // Generated runs are not published unless asked.
    expect(provider.publishRun).not.toHaveBeenCalled();

    const first = await service.importCases('ws', created.id, {
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
    });
    expect(first).toMatchObject({ imported: 2, skipped: 0 });
    // The run already had a destination, so it is kept.
    expect(first.creation.reporting?.autoPublish).toBe(false);
    const again = await service.importCases('ws', created.id, {
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
    });
    expect(again).toMatchObject({ imported: 0, skipped: 2 });

    const tests = await store.listTests('ws', created.id);
    const planned = tests[0]!;
    const linked = await service.linkCase('ws', planned.id, {
      provider: 'azure_devops',
      caseId: '50700',
      planId: '50398',
      suiteId: '50586',
    });
    expect(linked.externalCase?.caseId).toBe('50700');
    expect(linked.steps).toHaveLength(3);
    expect(provider.getCase).toHaveBeenCalledWith({
      caseId: '50700',
      planId: '50398',
      suiteId: '50586',
    });
    await service.linkCase('ws', planned.id, { provider: 'azure_devops', caseId: '50701' });
    expect(provider.getCase).toHaveBeenLastCalledWith({ caseId: '50701' });
    const unlinked = await service.linkCase('ws', planned.id, null);
    expect(unlinked.externalCase).toBeNull();

    const cleared = await service.setReporting('ws', created.id, null);
    expect(cleared.reporting).toBeNull();
    await expect(service.publish('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_REPORTING_REQUIRED',
    });
    const set = await service.setReporting('ws', created.id, {
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
    });
    expect(set.reporting).toMatchObject({ planId: '50398', autoPublish: true });

    const fresh = setup();
    const empty = await fresh.service.create(context, { ...runInput, prd: 'Product' });
    await fresh.worker.idle();
    const imported = await fresh.service.importCases('ws', empty.id, {
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
      caseIds: ['50605'],
    });
    // Without a destination the run reports to where its cases came from.
    expect(imported.creation.reporting).toEqual({
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
      autoPublish: true,
    });
    const crowded = setup({
      provider: fakeProvider(
        Array.from({ length: MAX_IMPORTED_CASES }, (_, index) => azureCase(String(index + 1), 1)),
      ),
    });
    const run = await crowded.service.create(context, { ...runInput, prd: 'Product' });
    await crowded.worker.idle();
    await expect(
      crowded.service.importCases('ws', run.id, { provider: 'azure_devops' }),
    ).rejects.toMatchObject({ code: 'E2E_TOO_MANY_TESTS' });
  });

  it('publishes on request through the worker and records failures', async () => {
    const { service, store, provider, worker } = setup();
    const created = await service.create(context, {
      ...runInput,
      reporting: {
        provider: 'azure_devops',
        planId: '50398',
        suiteId: '50586',
        autoPublish: false,
      },
      importCases: { provider: 'azure_devops', planId: '50398', suiteId: '50586' },
    });
    await worker.idle();
    expect(provider.publishRun).not.toHaveBeenCalled();

    const publishing = await service.publish('ws', created.id);
    expect(publishing.lastReport).toMatchObject({ status: 'publishing', provider: 'azure_devops' });
    await worker.idle();
    expect((await store.getCreation('ws', created.id))!.lastReport).toMatchObject({
      status: 'published',
      url: expect.stringContaining('runId=1037128'),
    });

    provider.publishRun.mockRejectedValueOnce(new Error('HTTP 500'));
    await service.publish('ws', created.id);
    await worker.idle();
    expect((await store.getCreation('ws', created.id))!.lastReport).toMatchObject({
      status: 'failed',
      error: 'HTTP 500',
      remoteRunId: null,
    });
  });

  it('records why nothing could be reported', async () => {
    const { reporter, store, service, worker } = setup({ provider: null });
    const created = await service.create(context, { ...runInput, prd: 'Product' });
    await worker.idle();
    const creation = (await store.getCreation('ws', created.id)) as E2eCreation;
    const target = {
      provider: 'azure_devops' as const,
      planId: null,
      suiteId: null,
      autoPublish: true,
    };
    expect(await reporter.publish(creation, target)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Configure'),
    });

    const configured = setup();
    const run = await configured.service.create(context, { ...runInput, prd: 'Product' });
    await configured.worker.idle();
    const stored = (await configured.store.getCreation('ws', run.id)) as E2eCreation;
    // Planned tests are not linked to any case.
    expect(await configured.reporter.publish(stored, target)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Nenhum teste'),
    });
  });

  it('builds results from whatever the latest execution left', async () => {
    const { reporter, store, artifacts, service, worker } = setup();
    const created = await service.create(context, { ...runInput, prd: 'Product' });
    await worker.idle();
    const creation = (await store.getCreation('ws', created.id)) as E2eCreation;
    const [test] = await store.listTests('ws', created.id);
    const base = test as E2eTestCase;
    await artifacts.put('ws/run/big.mp4', Buffer.alloc(30));
    await store.updateTest('ws', base.id, {
      externalCase: { ...azureCase('1', 2), planId: undefined, suiteId: '77' },
      status: 'passed',
      durationMs: null,
      lastRunAt: null,
      videoKey: 'ws/run/big.mp4',
      stepResults: [
        {
          position: 1,
          title: 'Passo 1',
          status: 'passed',
          durationMs: 400,
          error: null,
          screenshotKey: 'ws/run/missing.png',
        },
      ],
    });
    const small = new E2eRunReporter({
      store,
      artifacts,
      testManagement: {} as never,
      maxVideoBytes: 10,
    });
    const target = {
      provider: 'azure_devops' as const,
      planId: '9',
      suiteId: '8',
      autoPublish: true,
    };
    const { run, warnings } = await small.buildReport(creation, target);
    expect(run.results[0]).toMatchObject({
      durationMs: 400,
      attachments: [],
      // The case keeps its own suite; only the missing plan comes from the destination.
      testCase: { planId: '9', suiteId: '77' },
    });
    expect(run.results[0]!.steps[0]!.evidence).toEqual([]);
    expect(run.results[0]!.steps[1]!.outcome).toBe('not_executed');
    expect(warnings[0]).toContain('1 step(s) for the 2');

    await store.updateTest('ws', base.id, { videoKey: 'ws/run/gone.mp4' });
    expect((await reporter.buildReport(creation, target)).run.results[0]!.attachments).toEqual([]);
    await store.updateTest('ws', base.id, { videoKey: 'ws/run/big.mp4' });
    expect((await reporter.buildReport(creation, target)).run.results[0]!.attachments).toEqual([
      expect.objectContaining({ fileName: 'TC001.mp4', contentType: 'video/mp4' }),
    ]);
    await store.updateTest('ws', base.id, {
      externalCase: { ...azureCase('1', 2), planId: '5', suiteId: undefined },
    });
    expect((await reporter.buildReport(creation, target)).run.results[0]!.testCase).toMatchObject({
      planId: '5',
      suiteId: '8',
    });
    const noTarget = { ...target, planId: null, suiteId: null };
    const built = await reporter.buildReport(creation, noTarget);
    expect(built.run.target).toEqual({});
    expect(built.run.results[0]!.testCase.suiteId).toBeUndefined();
  });

  it('runs without a reporter and survives a failing automatic publication', async () => {
    const quiet = setup({ withReporter: false });
    const created = await quiet.service.create(context, {
      ...runInput,
      importCases: { provider: 'azure_devops', planId: '50398', suiteId: '50586' },
    });
    await quiet.worker.idle();
    expect(quiet.provider!.publishRun).not.toHaveBeenCalled();
    // A requested publication that cannot be handled closes the pending state.
    await quiet.service.publish('ws', created.id);
    await quiet.worker.idle();
    expect((await quiet.store.getCreation('ws', created.id))!.lastReport).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('plataforma'),
    });

    const broken = setup();
    vi.spyOn(broken.reporter, 'publish').mockRejectedValue(new Error('store down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = await broken.service.create(context, {
      ...runInput,
      importCases: { provider: 'azure_devops', planId: '50398', suiteId: '50586' },
    });
    await broken.worker.idle();
    expect((await broken.service.get('ws', run.id)).status).toBe('completed');
    expect(errors).toHaveBeenCalledWith(
      '[E2eExecutor] Publishing the results failed:',
      expect.any(Error),
    );
    errors.mockRestore();
  });

  it('automates saved test cases, re-reading imported ones from their platform', async () => {
    const step = { action: 'Abrir', expectedResult: 'Aberto' };
    const saved: SavedCaseForRun[] = [
      {
        caseId: 'local-1',
        title: 'Caso importado',
        description: '',
        steps: [step],
        remote: { provider: 'azure_devops', caseId: '50605', planId: '50398', suiteId: '50586' },
      },
      {
        caseId: 'local-2',
        title: 'Removido da plataforma',
        description: '',
        steps: [step],
        remote: { provider: 'azure_devops', caseId: '50999', planId: '50398', suiteId: '50586' },
      },
      {
        caseId: 'local-3',
        title: 'Só no ADK',
        description: '<p>Valida o <b>carrinho</b></p>',
        steps: [step, { action: 'Pagar', expectedResult: 'Pago' }],
        remote: null,
      },
    ];
    const reader: SavedCaseReader = { listSavedCases: vi.fn().mockResolvedValue(saved) };
    const { service, store, provider } = setup({ savedCases: reader });
    const created = await service.create(context, {
      ...runInput,
      planning: 'host',
      savedCases: { suiteId: 'suite-1' },
    });
    expect(reader.listSavedCases).toHaveBeenCalledWith('ws', { suiteId: 'suite-1' });
    expect(provider.listCases).toHaveBeenCalledTimes(1);
    expect(created.reporting).toEqual({
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
      autoPublish: true,
    });
    const tests = await store.listTests('ws', created.id);
    expect(tests.map((test) => [test.title, test.externalCase?.caseId ?? null])).toEqual([
      ['50605 - Caso 50605', '50605'],
      ['Removido da plataforma', null],
      ['Só no ADK', null],
    ]);
    expect(tests[2]).toMatchObject({
      description: 'Valida o carrinho',
      steps: ['Abrir => Aberto', 'Pagar => Pago'],
    });
  });

  it('automates saved cases without reporting when their platform is unavailable', async () => {
    const reader: SavedCaseReader = {
      listSavedCases: vi.fn().mockResolvedValue([
        {
          caseId: 'local-1',
          title: 'Sem plataforma',
          description: '',
          steps: [],
          remote: { provider: 'azure_devops', caseId: '50605' },
        },
      ]),
    };
    const { service, store } = setup({ provider: null, savedCases: reader });
    const created = await service.create(context, {
      ...runInput,
      planning: 'host',
      savedCases: { planId: 'plan-1' },
    });
    expect(created.reporting).toBeNull();
    const [test] = await store.listTests('ws', created.id);
    expect(test).toMatchObject({
      title: 'Sem plataforma',
      description: 'Automates the saved test case "Sem plataforma".',
      externalCase: null,
    });
  });

  it('rejects saved case selections it cannot automate', async () => {
    await expect(
      setup().service.create(context, { ...runInput, savedCases: { suiteId: 's' } }),
    ).rejects.toMatchObject({ code: 'E2E_SAVED_CASES_UNAVAILABLE' });
    const empty = setup({ savedCases: { listSavedCases: vi.fn().mockResolvedValue([]) } });
    await expect(
      empty.service.create(context, { ...runInput, savedCases: { suiteId: 's' } }),
    ).rejects.toMatchObject({ code: 'E2E_SAVED_CASES_NOT_FOUND', statusCode: 404 });
    const many = setup({
      savedCases: {
        listSavedCases: vi.fn().mockResolvedValue(
          Array.from({ length: MAX_IMPORTED_CASES + 1 }, (_, index) => ({
            caseId: String(index),
            title: 'T',
            description: '',
            steps: [],
            remote: null,
          })),
        ),
      },
    });
    await expect(
      many.service.create(context, { ...runInput, savedCases: { suiteId: 's' } }),
    ).rejects.toMatchObject({ code: 'E2E_TOO_MANY_TESTS' });
  });
});
