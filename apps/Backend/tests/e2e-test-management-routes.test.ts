import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eRunner } from '../src/modules/e2e/application/e2e-runner.js';
import type { TestManagementResolver } from '../src/modules/test-management/application/test-management-provider.js';
import type { ExternalTestCase } from '../src/modules/test-management/domain/test-run.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };
const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001', async ({ page }) => {
  await test.step('Passo 1 - abrir', async () => { await expect(page).toHaveURL('/'); });
});`;
const remoteCase: ExternalTestCase = {
  provider: 'azure_devops',
  caseId: '50605',
  planId: '50398',
  suiteId: '50586',
  title: 'Grupo de Usuários exibe a sessão Empresas',
  steps: [{ id: '2', action: 'Abrir Grupos de Usuários', expectedResult: 'Formulário exibido' }],
};

function setup() {
  const provider = {
    id: 'azure_devops',
    name: 'Azure DevOps Test Plans',
    capabilities: {
      planLabel: 'Test Plan',
      suiteLabel: 'Suite',
      suiteRequired: true,
      caseIdLabel: 'Test Case ID',
      stepEvidence: true,
    },
    listPlans: vi.fn().mockResolvedValue([{ id: '50398', name: 'Plano' }]),
    listSuites: vi.fn().mockResolvedValue([{ id: '50586', name: 'Suite' }]),
    listCases: vi.fn().mockResolvedValue([remoteCase]),
    getCase: vi.fn().mockResolvedValue(remoteCase),
    publishRun: vi.fn().mockResolvedValue({
      provider: 'azure_devops',
      remoteRunId: '1',
      url: 'https://dev.azure.com/acme/QA/_testManagement/runs?runId=1',
      publishedCases: 1,
      warnings: [],
    }),
  };
  const testManagement: TestManagementResolver = {
    listTestManagementProviders: vi.fn().mockResolvedValue([
      {
        id: 'azure_devops',
        name: provider.name,
        configured: true,
        capabilities: provider.capabilities,
      },
    ]),
    resolveTestManagementProvider: vi.fn().mockResolvedValue(provider),
  };
  const runner: E2eRunner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'x', pages: [] }),
    run: vi.fn().mockResolvedValue({
      status: 'passed',
      durationMs: 5,
      error: null,
      logs: 'ok',
      video: null,
      steps: [
        {
          position: 1,
          title: 'Passo 1 - abrir',
          status: 'passed',
          durationMs: 5,
          error: null,
          screenshot: Buffer.from('png'),
        },
      ],
    }),
  };
  const author: E2eAuthor = {
    plan: vi.fn(),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze: vi.fn(),
  };
  const app = createApp({
    e2eRunner: runner,
    e2eAuthor: author,
    e2eArtifacts: new InMemoryE2eArtifactStore(),
    e2eScripts: new FakeScriptRepository(),
    testManagement,
    requestContextResolver: () => ({
      requestId: 'e2e-test',
      ownerId: 'ws',
      workspaceId: 'ws',
      actorId: 'user',
      memberRole: 'ADMIN',
      locale: 'pt-BR',
    }),
  });
  return { app, provider, testManagement, author };
}

async function waitFor(
  app: ReturnType<typeof setup>['app'],
  id: string,
  check: (creation: Record<string, unknown>) => boolean,
) {
  let creation: Record<string, unknown> = {};
  await vi.waitFor(async () => {
    creation = (await request(app).get(`/e2e/creations/${id}`).expect(200)).body.creation;
    expect(check(creation)).toBe(true);
  });
  return creation;
}

describe('E2E test management routes', () => {
  it('browses a platform, automates its cases and publishes the run', async () => {
    const { app, provider } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const agentId = agent.body.agent.id as string;

    const providers = await request(app).get('/e2e/test-management/providers').expect(200);
    expect(providers.body.providers[0]).toMatchObject({ id: 'azure_devops', configured: true });
    const plans = await request(app).get('/e2e/test-management/azure_devops/plans').expect(200);
    expect(plans.body.plans).toEqual([{ id: '50398', name: 'Plano' }]);
    const suites = await request(app)
      .get('/e2e/test-management/azure_devops/plans/50398/suites')
      .expect(200);
    expect(suites.body.suites).toHaveLength(1);
    const cases = await request(app)
      .get('/e2e/test-management/azure_devops/cases?planId=50398&suiteId=50586')
      .expect(200);
    expect(cases.body.cases[0]).toMatchObject({ caseId: '50605' });
    await request(app).get('/e2e/test-management/zephyr/plans').expect(400);

    const base = {
      name: 'Empresas',
      agentId,
      mode: 'frontend',
      baseUrl: 'http://localhost:8014',
      repository,
    };
    // A product document is required unless the tests come from a platform.
    await request(app).post('/e2e/creations').send(base).expect(400);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        ...base,
        importCases: { provider: 'azure_devops', planId: '50398', suiteId: '50586' },
      })
      .expect(202);
    const id = created.body.creation.id as string;
    const done = await waitFor(
      app,
      id,
      (creation) => (creation['lastReport'] as { status?: string } | null)?.status === 'published',
    );
    const [test] = done['tests'] as { id: string; stepResults: unknown[] }[];
    expect(test!.stepResults).toEqual([
      expect.objectContaining({ position: 1, status: 'passed', hasScreenshot: true }),
    ]);
    const screenshot = await request(app)
      .get(`/e2e/tests/${test!.id}/steps/1/screenshot`)
      .expect(200);
    expect(screenshot.headers['content-type']).toBe('image/png');
    expect(screenshot.body).toEqual(Buffer.from('png'));
    await request(app).get(`/e2e/tests/${test!.id}/steps/0/screenshot`).expect(400);

    const imported = await request(app)
      .post(`/e2e/creations/${id}/import-cases`)
      .send({ provider: 'azure_devops', planId: '50398', suiteId: '50586' })
      .expect(200);
    expect(imported.body.result).toMatchObject({ imported: 0, skipped: 1 });

    const linked = await request(app)
      .put(`/e2e/tests/${test!.id}/external-case`)
      .send({ externalCase: { provider: 'azure_devops', caseId: '50605' } })
      .expect(200);
    expect(linked.body.test.externalCase).toMatchObject({ caseId: '50605' });

    const reporting = await request(app)
      .put(`/e2e/creations/${id}/reporting`)
      .send({ reporting: { provider: 'azure_devops', planId: '50398', suiteId: '50586' } })
      .expect(200);
    expect(reporting.body.creation.reporting).toMatchObject({ autoPublish: true });

    const publishing = await request(app).post(`/e2e/creations/${id}/publish`).expect(202);
    expect(publishing.body.creation.lastReport.status).toBe('publishing');
    await waitFor(
      app,
      id,
      (creation) => (creation['lastReport'] as { status?: string }).status === 'published',
    );
    expect(provider.publishRun).toHaveBeenCalledTimes(2);
  });

  it('automates an imported Test Plan without creating its cases again', async () => {
    const { app } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const imported = await request(app)
      .post('/TestPlan/import')
      .send({ providerId: 'azure_devops', planId: '50398' })
      .expect(201);
    const suiteId = imported.body.result.rootSuiteId as string;
    const base = {
      name: 'Plano importado',
      agentId: agent.body.agent.id as string,
      mode: 'frontend',
      baseUrl: 'http://localhost:8014',
      repository,
      planning: 'host',
    };
    await request(app)
      .post('/e2e/creations')
      .send({ ...base, savedCases: {} })
      .expect(400);
    await request(app)
      .post('/e2e/creations')
      .send({
        ...base,
        savedCases: { suiteId },
        importCases: { provider: 'azure_devops', planId: '50398', suiteId: '50586' },
      })
      .expect(400);
    const created = await request(app)
      .post('/e2e/creations')
      .send({ ...base, savedCases: { suiteId } })
      .expect(202);
    expect(created.body.creation.reporting).toMatchObject({
      provider: 'azure_devops',
      planId: '50398',
      suiteId: '50586',
    });
    const detail = await request(app)
      .get(`/e2e/creations/${created.body.creation.id as string}`)
      .expect(200);
    expect(detail.body.creation.tests).toEqual([
      expect.objectContaining({
        title: '50605 - Grupo de Usuários exibe a sessão Empresas',
        externalCase: expect.objectContaining({ caseId: '50605' }),
      }),
    ]);
  });

  it('waits for the user to generate the tests, from the PRD or from saved Test Plan cases', async () => {
    const { app, author } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const base = {
      name: 'Run',
      agentId: agent.body.agent.id as string,
      mode: 'frontend',
      baseUrl: 'http://localhost:8014',
      repository,
      prd: 'The product.',
      start: false,
    };
    // Creating a run only saves it: nothing is explored, planned or executed.
    const created = await request(app).post('/e2e/creations').send(base).expect(202);
    const id = created.body.creation.id as string;
    expect(created.body.creation.status).toBe('draft');
    await request(app).get(`/e2e/creations/${id}`).expect(200);
    expect(author.plan).not.toHaveBeenCalled();

    // Only generate: the agent plans the tests from the PRD, as it always did.
    vi.mocked(author.plan).mockResolvedValueOnce({
      summary: 'PRD',
      tests: [{ title: 'Sign in', description: 'd', priority: 'high', steps: [] }],
    });
    await request(app).post(`/e2e/creations/${id}/generate`).send({}).expect(202);
    const planned = await waitFor(app, id, (creation) => creation.status === 'completed');
    expect(planned.tests).toEqual([expect.objectContaining({ title: 'Sign in' })]);
    // Planning again would replace those tests.
    await request(app).post(`/e2e/creations/${id}/generate`).send({}).expect(409);

    // Saved Test Plan cases are added to the run and automated.
    const imported = await request(app)
      .post('/TestPlan/import')
      .send({ providerId: 'azure_devops', planId: '50398' })
      .expect(201);
    const suiteId = imported.body.result.rootSuiteId as string;
    await request(app).post(`/e2e/creations/${id}/generate`).send({ savedCases: {} }).expect(400);
    await request(app)
      .post(`/e2e/creations/${id}/generate`)
      .send({ savedCases: { suiteId } })
      .expect(202);
    const withCases = await waitFor(
      app,
      id,
      (creation) => creation.status === 'completed' && (creation.tests as unknown[]).length === 2,
    );
    expect(withCases.reporting).toMatchObject({ provider: 'azure_devops', planId: '50398' });
    expect(withCases.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '50605 - Grupo de Usuários exibe a sessão Empresas',
        }),
      ]),
    );
    await request(app).post('/e2e/creations/missing/generate').send({}).expect(404);
  });

  it('saves a run without a product document and asks for one only when the tests are planned', async () => {
    const { app, author } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const base = {
      name: 'Run',
      agentId: agent.body.agent.id as string,
      mode: 'frontend',
      baseUrl: 'http://localhost:8014',
      repository,
    };
    // A run that starts planning right away still needs a source; one that is only saved does not.
    await request(app).post('/e2e/creations').send(base).expect(400);
    const created = await request(app)
      .post('/e2e/creations')
      .send({ ...base, start: false })
      .expect(202);
    const id = created.body.creation.id as string;
    expect(created.body.creation.status).toBe('draft');

    // Nothing to plan from: the AI would invent the tests, so it is refused before it starts.
    const refused = await request(app).post(`/e2e/creations/${id}/generate`).send({}).expect(400);
    expect(refused.body.code).toBe('E2E_PRD_REQUIRED');
    await request(app).post(`/e2e/creations/${id}/run`).expect(400);
    expect(author.plan).not.toHaveBeenCalled();

    // Editing needs no document either; the one attached when generating becomes the run's.
    await request(app)
      .put(`/e2e/creations/${id}`)
      .send({ ...base, prd: '' })
      .expect(200);
    vi.mocked(author.plan).mockResolvedValueOnce({
      summary: 'PRD',
      tests: [{ title: 'Sign in', description: 'd', priority: 'high', steps: [] }],
    });
    await request(app)
      .post(`/e2e/creations/${id}/generate`)
      .send({ prd: 'The product.' })
      .expect(202);
    await waitFor(app, id, (creation) => creation.status === 'completed');

    // The Brain is a source too: a run that uses it can plan without a document.
    const brain = await request(app)
      .post('/e2e/creations')
      .send({ ...base, start: false, useBrain: true })
      .expect(202);
    vi.mocked(author.plan).mockResolvedValueOnce({
      summary: 'Brain',
      tests: [{ title: 'Search', description: 'd', priority: 'low', steps: [] }],
    });
    await request(app)
      .post(`/e2e/creations/${brain.body.creation.id as string}/generate`)
      .send({})
      .expect(202);
  });

  it('plans from the PRD written when the tests are generated, instead of the one of the run', async () => {
    const { app, author } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'Run',
        agentId: agent.body.agent.id as string,
        mode: 'frontend',
        baseUrl: 'http://localhost:8014',
        repository,
        useBrain: true,
        start: false,
      })
      .expect(202);
    const id = created.body.creation.id as string;
    // A PRD or saved cases, never both; and a PRD cannot be empty.
    await request(app)
      .post(`/e2e/creations/${id}/generate`)
      .send({ prd: 'Doc', savedCases: { suiteId: 's1' } })
      .expect(400);
    await request(app).post(`/e2e/creations/${id}/generate`).send({ prd: '   ' }).expect(400);

    vi.mocked(author.plan).mockResolvedValueOnce({
      summary: 'PRD',
      tests: [{ title: 'Sign in', description: 'd', priority: 'high', steps: [] }],
    });
    await request(app)
      .post(`/e2e/creations/${id}/generate`)
      .send({
        prd: '# spec.pdf\n\nLogin.\n\n![print](/attachments/files/6f1c2a90-1f0e-4a3b-8f4e-5a2c9d7e1b11)',
        prdFileNames: ['spec.pdf'],
      })
      .expect(202);
    const planned = await waitFor(app, id, (creation) => creation.status === 'completed');
    expect(planned.tests).toEqual([expect.objectContaining({ title: 'Sign in' })]);
    // The run now plans from that document and no longer from the Brain.
    expect(vi.mocked(author.plan).mock.calls.at(-1)?.[0].creation).toMatchObject({
      prd: expect.stringContaining('![print](/attachments/files/6f1c2a90'),
      prdFileNames: ['spec.pdf'],
      useBrain: false,
      prdSummary: null,
    });

    // Files are optional: only the text is kept.
    const second = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'Run 2',
        agentId: agent.body.agent.id as string,
        mode: 'frontend',
        baseUrl: 'http://localhost:8014',
        repository,
        prd: 'Old',
        start: false,
      })
      .expect(202);
    const secondId = second.body.creation.id as string;
    vi.mocked(author.plan).mockResolvedValueOnce({
      summary: 'PRD',
      tests: [{ title: 'Sign out', description: 'd', priority: 'high', steps: [] }],
    });
    await request(app)
      .post(`/e2e/creations/${secondId}/generate`)
      .send({ prd: 'Only text' })
      .expect(202);
    await waitFor(app, secondId, (creation) => creation.status === 'completed');
    expect(vi.mocked(author.plan).mock.calls.at(-1)?.[0].creation).toMatchObject({
      prd: 'Only text',
      prdFileNames: [],
    });
  });

  it('keeps the destination of a run that already has one when cases are added', async () => {
    const { app } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const imported = await request(app)
      .post('/TestPlan/import')
      .send({ providerId: 'azure_devops', planId: '50398' })
      .expect(201);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'Run',
        agentId: agent.body.agent.id as string,
        mode: 'frontend',
        baseUrl: 'http://localhost:8014',
        repository,
        prd: 'The product.',
        start: false,
        reporting: { provider: 'azure_devops', planId: '1', suiteId: '2', autoPublish: false },
      })
      .expect(202);
    const id = created.body.creation.id as string;
    await request(app)
      .post(`/e2e/creations/${id}/generate`)
      .send({ savedCases: { suiteId: imported.body.result.rootSuiteId as string } })
      .expect(202);
    const done = await waitFor(app, id, (creation) => creation.status === 'completed');
    expect(done.reporting).toMatchObject({ planId: '1', suiteId: '2' });
  });

  it('reports failures of the platform routes', async () => {
    const { app, provider, testManagement } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    provider.listPlans.mockRejectedValueOnce(new Error('down'));
    vi.mocked(testManagement.listTestManagementProviders).mockRejectedValueOnce(new Error('down'));
    await request(app).get('/e2e/test-management/providers').expect(500);
    provider.listSuites.mockRejectedValueOnce(new Error('down'));
    provider.listCases.mockRejectedValueOnce(new Error('down'));
    await request(app).get('/e2e/test-management/azure_devops/plans').expect(500);
    await request(app).get('/e2e/test-management/azure_devops/plans/1/suites').expect(500);
    await request(app).get('/e2e/test-management/azure_devops/cases').expect(500);
    await request(app)
      .post('/e2e/creations/missing/import-cases')
      .send({ provider: 'azure_devops' })
      .expect(404);
    await request(app)
      .put('/e2e/creations/missing/reporting')
      .send({ reporting: null })
      .expect(404);
    await request(app).post('/e2e/creations/missing/publish').expect(404);
    await request(app)
      .put('/e2e/tests/missing/external-case')
      .send({ externalCase: null })
      .expect(404);
    await request(app).get('/e2e/tests/missing/steps/1/screenshot').expect(404);
    errors.mockRestore();
  });
});
