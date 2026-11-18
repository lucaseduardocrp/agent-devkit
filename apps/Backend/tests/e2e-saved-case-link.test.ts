import { describe, expect, it, vi } from 'vitest';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import {
  InMemorySavedTestPlanStore,
  createSavedTestPlan,
} from '../src/modules/testplans/application/saved-test-plans.js';
import {
  SavedTestCaseReader,
  savedCasesOf,
} from '../src/modules/testplans/application/saved-test-cases.js';
import { ObservedSavedTestPlanStore } from '../src/modules/testplans/application/observed-saved-test-plans.js';
import { InMemoryTestSuiteStore } from '../src/modules/testplans/application/test-suites.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const context = {
  requestId: 'r',
  workspaceId: 'ws',
  ownerId: 'ws',
  actorId: 'user',
  locale: 'pt-BR' as const,
};
const runInput = {
  name: 'Run',
  agentId: 'agent',
  mode: 'frontend' as const,
  scope: 'codebase' as const,
  baseUrl: 'http://localhost:8014',
  prd: '',
  start: false,
  repository: { provider: 'github' as const, id: '42', branch: 'main', path: 'tests/e2e' },
};

const testCase = (caseId: string, title: string) => ({
  title,
  description: `<p>Valida <b>${title}</b></p>`,
  steps: [{ action: `Abrir ${title}`, expectedResult: 'Aberto' }],
  metadata: { caseId },
});

function newService(savedCases?: SavedTestCaseReader) {
  const store = new InMemoryE2eStore();
  const queue = new InMemoryE2eJobQueue();
  const service = new E2eService({
    store,
    queue,
    dispatcher: { wake: vi.fn().mockResolvedValue(undefined) },
    artifacts: new InMemoryE2eArtifactStore(),
    agents: { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) } as never,
    scripts: new FakeScriptRepository(),
    ...(savedCases ? { savedCases } : {}),
  });
  return { store, service, queue };
}

async function setup() {
  const suites = new InMemoryTestSuiteStore();
  await suites.save({
    id: 'suite-1',
    workspaceId: 'ws',
    name: 'Suite',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
  const plans = new ObservedSavedTestPlanStore(new InMemorySavedTestPlanStore());
  const plan = await plans.save(
    createSavedTestPlan('ws', { title: 'Plano', suiteId: 'suite-1' }, [
      testCase('c-1', 'Login'),
      testCase('c-2', 'Logout'),
    ]),
  );
  const { store, service, queue } = newService(new SavedTestCaseReader(plans, suites));
  plans.observe({
    saved: (saved) => service.syncSavedPlan(saved.workspaceId, saved.id, savedCasesOf(saved)),
    deleted: (workspaceId, planId) => service.unlinkSavedPlan(workspaceId, planId),
  });
  const run = await service.create(context, runInput);
  return { service, store, plans, plan, run, queue };
}

describe('E2E tests linked to saved test cases', () => {
  it('links a whole suite to a run, skipping the cases the run already has', async () => {
    const { service, store, plan, run } = await setup();
    const first = await service.linkSavedCases('ws', run.id, { suiteId: 'suite-1' });
    expect(first).toMatchObject({ imported: 2, skipped: 0 });
    const again = await service.linkSavedCases('ws', run.id, { planId: plan.id });
    expect(again).toMatchObject({ imported: 0, skipped: 2 });

    const tests = await store.listTests('ws', run.id);
    expect(tests.map((test) => [test.title, test.savedCase])).toEqual([
      ['Login', { planId: plan.id, caseId: 'c-1' }],
      ['Logout', { planId: plan.id, caseId: 'c-2' }],
    ]);
  });

  it('refuses a suite that would overflow the run and one that is not there', async () => {
    const { service, run, plans } = await setup();
    await expect(
      service.linkSavedCases('ws', run.id, { suiteId: 'missing' }),
    ).rejects.toMatchObject({ code: 'TEST_SUITE_NOT_FOUND' });
    const many = Array.from({ length: 101 }, (_, index) => testCase(`b-${index}`, `T${index}`));
    await plans.save(createSavedTestPlan('ws', { title: 'Big', suiteId: 'suite-1' }, many));
    await expect(
      service.linkSavedCases('ws', run.id, { suiteId: 'suite-1' }),
    ).rejects.toMatchObject({
      code: 'E2E_TOO_MANY_TESTS',
    });
  });

  it('links the tests of a run created from saved cases, or generated from them', async () => {
    const { service, store, plan } = await setup();
    const created = await service.create(context, {
      ...runInput,
      planning: 'host',
      start: true,
      savedCases: { planId: plan.id, caseIds: ['c-2'] },
    });
    expect((await store.listTests('ws', created.id)).map((test) => test.savedCase)).toEqual([
      { planId: plan.id, caseId: 'c-2' },
    ]);

    const empty = await service.create(context, runInput);
    await service.generate('ws', empty.id, { savedCases: { planId: plan.id } });
    expect((await store.listTests('ws', empty.id)).map((test) => test.savedCase?.caseId)).toEqual([
      'c-1',
      'c-2',
    ]);
  });

  it('keeps the tests a run already has and refuses to grow past the limit', async () => {
    const { service, store, plans, plan, run } = await setup();
    const creation = (await store.getCreation('ws', run.id))!;
    await store.appendTests(creation, [
      { title: 'Manual', description: 'd', steps: [], priority: 'medium' },
    ]);
    expect(await service.linkSavedCases('ws', run.id, { planId: plan.id })).toMatchObject({
      imported: 2,
    });

    const many = Array.from({ length: 97 }, (_, index) => testCase(`m-${index}`, `M${index}`));
    const big = await plans.save(
      createSavedTestPlan('ws', { title: 'Big', suiteId: 'suite-1' }, many),
    );
    await service.linkSavedCases('ws', run.id, { planId: big.id });
    const extra = await plans.save(
      createSavedTestPlan('ws', { title: 'Extra', suiteId: 'suite-1' }, [testCase('x-1', 'X')]),
    );
    await expect(service.linkSavedCases('ws', run.id, { planId: extra.id })).rejects.toMatchObject({
      code: 'E2E_TOO_MANY_TESTS',
    });
  });

  it('keeps the links when the host saves a plan, unless it says otherwise', async () => {
    const { service, store, plan, run, queue } = await setup();
    await service.linkSavedCases('ws', run.id, { planId: plan.id });
    const spec = `import { test, expect } from '@playwright/test';
test('TC001 - ok', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('x');
});`;
    const planned = (title: string, extra = {}) => ({
      title,
      description: '',
      priority: 'medium' as const,
      steps: [],
      script: spec,
      ...extra,
    });
    const links = async () =>
      (await store.listTests('ws', run.id)).map((test) => test.savedCase?.caseId ?? null);

    await service.savePlan('ws', run.id, { tests: [planned('Login'), planned('Logout')] });
    await queue.cancel('ws', run.id);
    expect(await links()).toEqual(['c-1', 'c-2']);

    await service.savePlan('ws', run.id, {
      tests: [
        planned('Login', { savedCase: null }),
        planned('Logout', { savedCase: { planId: plan.id, caseId: 'c-1' } }),
      ],
    });
    expect(await links()).toEqual([null, 'c-1']);
    await queue.cancel('ws', run.id);

    await expect(
      service.savePlan('ws', run.id, {
        tests: [planned('A', { savedCase: { planId: plan.id, caseId: 'nope' } }), planned('B')],
      }),
    ).rejects.toMatchObject({ code: 'E2E_SAVED_CASES_NOT_FOUND' });

    // A different set of tests has nothing to inherit.
    await service.savePlan('ws', run.id, { tests: [planned('Only one')] });
    expect(await links()).toEqual([null]);
  });

  it('links one test to a case and takes its content', async () => {
    const { service, store, plan, run } = await setup();
    await service.linkSavedCases('ws', run.id, { planId: plan.id, caseIds: ['c-1'] });
    const [test] = await store.listTests('ws', run.id);
    const unlinked = await service.linkSavedCase('ws', test!.id, null);
    expect(unlinked.savedCase).toBeNull();

    const linked = await service.linkSavedCase('ws', test!.id, { planId: plan.id, caseId: 'c-2' });
    expect(linked).toMatchObject({
      savedCase: { planId: plan.id, caseId: 'c-2' },
      title: 'Logout',
      description: 'Valida Logout',
      steps: ['Abrir Logout => Aberto'],
    });
    await expect(
      service.linkSavedCase('ws', test!.id, { planId: plan.id, caseId: 'nope' }),
    ).rejects.toMatchObject({ code: 'E2E_SAVED_CASES_NOT_FOUND' });
  });

  it('needs the saved test cases module to link', async () => {
    const { service } = newService();
    const run = await service.create(context, runInput);
    await expect(
      service.linkSavedCases('ws', run.id, { suiteId: 'suite-1' }),
    ).rejects.toMatchObject({ code: 'E2E_SAVED_CASES_UNAVAILABLE' });
  });

  it('updates linked tests when the case is edited and unlinks them when it is removed', async () => {
    const { service, store, plans, plan, run } = await setup();
    await service.linkSavedCases('ws', run.id, { planId: plan.id });
    const before = await store.listTests('ws', run.id);

    // Same content: nothing is rewritten.
    await plans.save({ ...plan, updatedAt: 'later' });
    expect((await store.listTests('ws', run.id)).map((test) => test.updatedAt)).toEqual(
      before.map((test) => test.updatedAt),
    );

    await plans.save({
      ...plan,
      plans: [
        { ...plan.plans[0]!, title: 'Login novo', description: '' },
        { ...plan.plans[1]!, steps: [{ action: 'Sair', expectedResult: '' }] },
      ],
    });
    const edited = await store.listTests('ws', run.id);
    expect(edited[0]).toMatchObject({
      title: 'Login novo',
      description: 'Automates the saved test case "Login novo".',
    });
    expect(edited[1]!.steps).toEqual(['Sair']);

    await plans.save({ ...plan, plans: [plan.plans[0]!] });
    const afterRemoval = await store.listTests('ws', run.id);
    expect(afterRemoval.map((test) => test.savedCase?.caseId ?? null)).toEqual(['c-1', null]);

    expect(await plans.delete(plan.id, 'ws')).toBe(true);
    expect(await plans.delete(plan.id, 'ws')).toBe(false);
    expect((await store.listTests('ws', run.id)).every((test) => test.savedCase === null)).toBe(
      true,
    );
  });

  it('keeps the run reporting target it already has when linking a suite', async () => {
    const { service, run } = await setup();
    const result = await service.linkSavedCases('ws', run.id, { suiteId: 'suite-1' });
    expect(result.creation.reporting).toBeNull();
  });
});

describe('ObservedSavedTestPlanStore', () => {
  it('delegates reads and keeps going when an observer fails', async () => {
    const inner = new InMemorySavedTestPlanStore();
    const store = new ObservedSavedTestPlanStore(inner);
    const failing = {
      saved: vi.fn().mockRejectedValue(new Error('boom')),
      deleted: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.observe(failing);
    const plan = await store.save(createSavedTestPlan('ws', { title: 'P' }, [testCase('c', 'T')]));
    expect(await store.find(plan.id, 'ws')).toEqual(plan);
    expect(await store.count('ws')).toBe(1);
    expect(await store.list('ws', 0, 10)).toEqual([plan]);
    expect(await store.delete(plan.id, 'ws')).toBe(true);
    expect(failing.saved).toHaveBeenCalledWith(plan);
    expect(failing.deleted).toHaveBeenCalledWith('ws', plan.id);
    expect(quiet).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });
});
