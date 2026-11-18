import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };
const plan = (title: string) => ({
  title,
  description: '<p>Valida o fluxo</p>',
  steps: [{ order: 1, action: 'Abrir a tela', expectedResult: 'Tela aberta' }],
});

function setup() {
  return createApp({
    e2eRunner: { explore: vi.fn(), run: vi.fn() },
    e2eAuthor: { plan: vi.fn(), writeScript: vi.fn(), analyze: vi.fn() },
    e2eArtifacts: new InMemoryE2eArtifactStore(),
    e2eScripts: new FakeScriptRepository(),
    requestContextResolver: () => ({
      requestId: 'e2e-test',
      ownerId: 'ws',
      workspaceId: 'ws',
      actorId: 'user',
      memberRole: 'ADMIN',
      locale: 'pt-BR',
    }),
  });
}

describe('E2E tests linked to saved test cases over HTTP', () => {
  it('links a suite and a test, and keeps both sides in sync', async () => {
    const app = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const suite = await request(app)
      .post('/TestPlan/suites')
      .send({ name: 'Checkout' })
      .expect(201);
    const saved = await request(app)
      .post('/TestPlan')
      .send({ title: 'Plano', plans: [plan('Login'), plan('Logout')], suiteId: suite.body.id })
      .expect(201);
    const planId = saved.body.savedPlan.id as string;
    const caseIds = (saved.body.savedPlan.plans as { metadata: { caseId: string } }[]).map(
      (item) => item.metadata.caseId,
    );

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
      })
      .expect(202);
    const id = created.body.creation.id as string;

    const linkedSuite = await request(app)
      .post(`/e2e/creations/${id}/saved-cases`)
      .send({ suiteId: suite.body.id })
      .expect(200);
    expect(linkedSuite.body.result).toMatchObject({ imported: 2, skipped: 0 });
    await request(app).post(`/e2e/creations/${id}/saved-cases`).send({}).expect(400);

    const detail = await request(app).get(`/e2e/creations/${id}`).expect(200);
    const [first] = detail.body.creation.tests as { id: string; title: string }[];
    expect(first!.title).toBe('Login');

    // Editing the case on its own screen reaches the test.
    await request(app)
      .put(`/TestPlan/${planId}`)
      .send({
        plans: [
          { ...plan('Login v2'), metadata: { caseId: caseIds[0] } },
          { ...plan('Logout'), metadata: { caseId: caseIds[1] } },
        ],
      })
      .expect(200);
    const synced = await request(app).get(`/e2e/tests/${first!.id}`).expect(200);
    expect(synced.body.test).toMatchObject({
      title: 'Login v2',
      savedCase: { planId, caseId: caseIds[0] },
    });

    // A host that rewrites the plan without ids and with structured descriptions keeps the links.
    const rewritten = await request(app)
      .put(`/TestPlan/${planId}`)
      .send({
        plans: [
          { ...plan('Login v3'), description: { useCase: 'Valida o login', preconditions: 'x' } },
          plan('Logout'),
        ],
      })
      .expect(200);
    expect(
      (rewritten.body.plans as { metadata: { caseId: string } }[]).map(
        (item) => item.metadata.caseId,
      ),
    ).toEqual(caseIds);
    expect(typeof rewritten.body.plans[0].description).toBe('string');
    const kept = await request(app).get(`/e2e/tests/${first!.id}`).expect(200);
    expect(kept.body.test).toMatchObject({
      title: 'Login v3',
      savedCase: { planId, caseId: caseIds[0] },
    });

    // Unlinking and linking one test by hand.
    const unlinked = await request(app)
      .put(`/e2e/tests/${first!.id}/saved-case`)
      .send({ savedCase: null })
      .expect(200);
    expect(unlinked.body.test.savedCase).toBeNull();
    const relinked = await request(app)
      .put(`/e2e/tests/${first!.id}/saved-case`)
      .send({ savedCase: { planId, caseId: caseIds[1] } })
      .expect(200);
    expect(relinked.body.test).toMatchObject({
      title: 'Logout',
      savedCase: { caseId: caseIds[1] },
    });
    await request(app).put(`/e2e/tests/${first!.id}/saved-case`).send({}).expect(400);
    await request(app).put('/e2e/tests/missing/saved-case').send({ savedCase: null }).expect(404);
    await request(app).post('/e2e/creations/missing/saved-cases').send({ planId }).expect(404);
  });
});
