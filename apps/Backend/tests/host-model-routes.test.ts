import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { KnowledgeSearchPort } from '../src/modules/knowledge/application/knowledge-search.js';
import { DeterministicTestPlanGenerator } from '../src/modules/testplans/application/generate-test-plan.js';
import {
  DesignService,
  type DesignProject,
  type DesignRemoteStore,
} from '../src/modules/design/application/design-service.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';

// Host-model endpoints let an external model (for example an MCP host such as Claude or Codex)
// author content with the workspace grounding, without an LLM API key configured in ADK.

const owned = () => ({ requestId: 'host', ownerId: 'ws-1', workspaceId: 'ws-1' });

function knowledge(): KnowledgeSearchPort {
  const chunk = (source: string, pageId: string, content: string) => ({
    source,
    pageId,
    chunkIndex: 0,
    content,
    createdAt: '2026-09-25T00:00:00Z',
  });
  return {
    search: async () => [
      chunk('https://dev.azure.com/org/wiki?pagePath=%2FCheckout%2FRules', 'p1', 'rules'),
      chunk('https://github.com/org/repo/blob/main/checkout.md', 'p2', 'flow'),
      chunk('https://github.com/org/repo/blob/main/checkout.md', 'p2', 'more flow'),
    ],
  };
}

const plan = {
  title: 'Pay with card',
  description: 'Card payment',
  steps: [
    { action: 'Open the checkout', expected: 'The checkout is displayed' },
    { order: 2, action: 'Pay with a valid card', expectedResult: 'The order is confirmed' },
  ],
};

describe('Test Plan host-model routes', () => {
  it('prepares a grounded generation brief without calling an LLM', async () => {
    const app = createApp({ requestContextResolver: owned, knowledgeSearch: knowledge() });
    const response = await request(app)
      .post('/TestPlan/brief')
      .send({ prompt: 'The user must pay the checkout order', criteria: 'Card only' });

    expect(response.status).toBe(200);
    expect(response.body.instruction).toContain('Return only the JSON array.');
    expect(response.body.context).toContain('## Contexto da Base de Conhecimento');
    expect(response.body.context).toContain('Card only');
    expect(response.body.outputLanguage).toBe('English');
    expect(response.body.knowledgeSources).toEqual(['Checkout/Rules', 'checkout.md']);
  });

  it('prepares an ungrounded brief when the Brain has no matches', async () => {
    const app = createApp({ requestContextResolver: owned });
    const response = await request(app).post('/TestPlan/brief').send({ prompt: 'Cadastro' });

    expect(response.status).toBe(200);
    expect(response.body.context).toContain('## Requisito');
    expect(response.body.knowledgeSources).toEqual([]);
  });

  it('rejects briefs without a workspace, with invalid input, or without support', async () => {
    const anonymous = createApp({ requestContextResolver: () => ({ requestId: 'x' }) });
    expect((await request(anonymous).post('/TestPlan/brief').send({ prompt: 'A' })).status).toBe(
      403,
    );
    const app = createApp({ requestContextResolver: owned });
    expect((await request(app).post('/TestPlan/brief').send({ prompt: '' })).status).toBe(400);

    const unsupported = createApp({
      requestContextResolver: owned,
      testPlanGenerator: new DeterministicTestPlanGenerator(),
    });
    const response = await request(unsupported).post('/TestPlan/brief').send({ prompt: 'A' });
    expect(response.status).toBe(501);
    expect(response.body.code).toBe('TEST_PLAN_BRIEF_UNAVAILABLE');
  });

  it('saves authored plans in the default suite and reads them back', async () => {
    const app = createApp({ requestContextResolver: owned });
    const saved = await request(app)
      .post('/TestPlan')
      .send({ title: 'Checkout', plans: [plan], sourceType: 'brain', sourceId: 'p1' });

    expect(saved.status).toBe(201);
    expect(saved.body.savedPlan).toMatchObject({
      workspaceId: 'ws-1',
      title: 'Checkout',
      sourceType: 'brain',
      sourceId: 'p1',
    });
    expect(saved.body.plans[0].steps).toEqual([
      { order: 1, action: 'Open the checkout', expectedResult: 'The checkout is displayed' },
      { order: 2, action: 'Pay with a valid card', expectedResult: 'The order is confirmed' },
    ]);
    expect(saved.body.csv).toContain('Pay with card');

    const suites = await request(app).get('/TestPlan/suites');
    expect(suites.body).toEqual([
      expect.objectContaining({ id: saved.body.savedPlan.suiteId, name: 'Test' }),
    ]);

    const found = await request(app).get(`/TestPlan/${saved.body.savedPlan.id}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(saved.body.savedPlan.id);
    expect((await request(app).get('/TestPlan/missing')).status).toBe(404);
  });

  it('renders authored cases as CSV without saving or calling an LLM', async () => {
    const app = createApp({ requestContextResolver: owned });
    const response = await request(app)
      .post('/TestPlan/csv')
      .send({ plans: [plan] })
      .expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('Pay with card');
    expect((await request(app).get('/TestPlan').expect(200)).body.total).toBe(0);
    await request(app)
      .post('/TestPlan/csv')
      .send({ plans: [{ title: 'Missing expected result', steps: [{ action: 'Open' }] }] })
      .expect(400);
  });

  it('saves authored plans in an explicit suite and rejects unknown suites', async () => {
    const app = createApp({ requestContextResolver: owned });
    const suite = await request(app).post('/TestPlan/suites').send({ name: 'Regression' });
    const saved = await request(app)
      .post('/TestPlan')
      .send({ plans: [plan], suiteId: suite.body.id });
    expect(saved.status).toBe(201);
    expect(saved.body.savedPlan).toMatchObject({ suiteId: suite.body.id, title: 'Pay with card' });

    const missing = await request(app)
      .post('/TestPlan')
      .send({ plans: [plan], suiteId: 'missing' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TEST_SUITE_NOT_FOUND');
  });

  it('rejects authored plans without expected results or a workspace', async () => {
    const app = createApp({ requestContextResolver: owned });
    const invalid = await request(app)
      .post('/TestPlan')
      .send({ plans: [{ title: 'T', steps: [{ action: 'Open' }] }] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');

    const anonymous = createApp({ requestContextResolver: () => ({ requestId: 'x' }) });
    expect(
      (
        await request(anonymous)
          .post('/TestPlan')
          .send({ plans: [plan] })
      ).status,
    ).toBe(403);
    expect((await request(anonymous).get('/TestPlan/any')).status).toBe(403);
  });
});

describe('Spec host-model chat', () => {
  it('records a client-authored reply without a workspace LLM', async () => {
    const app = createApp({
      requestContextResolver: () => ({ ...owned(), actorId: 'u1', memberRole: 'ADMIN' as const }),
    });
    const created = await request(app)
      .post('/spec/specifications')
      .send({
        title: 'Checkout',
        sections: [{ templateSectionId: 'rules', title: 'Rules', content: 'Accept cards.' }],
      })
      .expect(201);
    const id = created.body.id as string;
    const saved = await request(app)
      .post(`/spec/specifications/${id}/chat/host`)
      .send({ userMessage: 'What about declined cards?', assistantMessage: 'Add a failure case.' })
      .expect(200);
    expect(saved.body.messages).toMatchObject([
      { role: 'user', content: 'What about declined cards?' },
      { role: 'assistant', content: 'Add a failure case.' },
    ]);
    expect(saved.body.sections).toEqual(created.body.sections);
    await request(app)
      .post(`/spec/specifications/${id}/chat/host`)
      .send({ userMessage: ' ', assistantMessage: 'Reply' })
      .expect(400);
    await request(app)
      .post('/spec/specifications/missing/chat/host')
      .send({ userMessage: 'Question', assistantMessage: 'Reply' })
      .expect(404);
  });
});

function designStore(): DesignRemoteStore {
  const records = new Map<string, DesignProject>();
  return {
    configuredProviders: vi.fn().mockResolvedValue(['github']),
    list: vi.fn().mockResolvedValue([]),
    find: vi.fn(async (_workspaceId, _provider, id: string) => records.get(id) ?? null),
    save: vi.fn(async (_workspaceId, project: DesignProject) => {
      records.set(project.id, project);
      return project;
    }),
    delete: vi.fn().mockResolvedValue(true),
    listDesignSystems: vi.fn().mockResolvedValue([]),
    saveDesignSystem: vi.fn(async (_workspaceId, _provider, system) => system),
    deleteDesignSystem: vi.fn().mockResolvedValue(true),
  };
}

const files = [
  { name: 'index.html', language: 'html', content: '<main>Hi</main>' },
  { name: 'styles.css', language: 'css', content: 'main{}' },
];

describe('Design host-model creation', () => {
  it('creates a prototype from authored files without invoking an agent', async () => {
    const executeAgent = vi.fn();
    const service = new DesignService(designStore(), { executeAgent } as unknown as AgentService);
    const created = await service.create('ws', {
      title: 'Login',
      prompt: 'Login page',
      provider: 'github',
      files,
      summary: 'Login prototype',
    });
    expect(executeAgent).not.toHaveBeenCalled();
    expect(created).toMatchObject({ agentId: '', files });
    expect(created.messages.map((message) => message.content)).toEqual([
      'Login page',
      'Login prototype',
    ]);

    const fallback = await service.create('ws', {
      title: 'Home',
      prompt: 'Home page',
      provider: 'github',
      files,
    });
    expect(fallback.messages[1]!.content).toBe('Protótipo criado pelo assistente.');
  });

  it('requires an agent when no files are authored', async () => {
    const service = new DesignService(designStore(), {} as AgentService);
    await expect(
      service.create('ws', { title: 'X', prompt: 'Y', provider: 'github' }),
    ).rejects.toMatchObject({ code: 'DESIGN_AGENT_REQUIRED' });
  });

  it('accepts authored files over HTTP and validates the request', async () => {
    const app = createApp({
      designStore: designStore(),
      requestContextResolver: () => ({ ...owned(), actorId: 'u1', memberRole: 'ADMIN' as const }),
    });
    const created = await request(app)
      .post('/design/projects')
      .send({ title: 'Login', prompt: 'Login page', provider: 'github', files });
    expect(created.status).toBe(201);
    expect(created.body.files).toEqual(files);

    const withoutAgent = await request(app)
      .post('/design/projects')
      .send({ title: 'Login', prompt: 'Login page', provider: 'github' });
    expect(withoutAgent.status).toBe(400);

    const withoutIndex = await request(app)
      .post('/design/projects')
      .send({ title: 'Login', prompt: 'Login page', provider: 'github', files: [files[1]] });
    expect(withoutIndex.status).toBe(400);
  });
});
