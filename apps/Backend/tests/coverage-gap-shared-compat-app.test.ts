import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, errorMiddleware } from '../src/adapters/http/app.js';
import { createCompatibilityRouter } from '../src/adapters/http/compatibility-routes.js';
import { ApiTestWorker } from '../src/modules/apitests/application/api-test-worker.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import { InMemoryFieldMappingStore } from '../src/modules/field-mapping/field-mapping.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { relativeWikiAttachments } from '../src/modules/knowledge/adapters/wiki-providers.js';
import {
  InMemorySavedTestPlanStore,
  createSavedTestPlan,
} from '../src/modules/testplans/application/saved-test-plans.js';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
} from '../src/modules/testplans/application/test-suites.js';

const owner = () => ({ requestId: 'r', ownerId: 'ws' });
const plan = (title: string, action: string) => ({
  title,
  description: 'Cenário',
  steps: [{ action, expectedResult: 'Ok' }],
});

function build(factory?: object) {
  const suites = new InMemoryTestSuiteStore();
  const plans = new InMemorySavedTestPlanStore();
  const app = express();
  app.use(express.json());
  app.use(
    createCompatibilityRouter(
      undefined,
      undefined,
      owner,
      plans,
      suites,
      factory as DynamicProviderFactory | undefined,
      new InMemoryFieldMappingStore(),
    ),
  );
  app.use(errorMiddleware);
  return { app, suites, plans };
}

describe('test plan compatibility edges', () => {
  it('publishes a suite with only the work item list', async () => {
    const publish = vi.fn(async () => ({
      provider: 'azure_devops',
      remotePlanId: '1',
      remoteSuiteId: '2',
      remoteUrl: 'https://example.com',
      suitesCount: 1,
      casesCount: 1,
    }));
    const { app, suites, plans } = build({
      resolveTestSuitePublisher: vi.fn(async () => ({ publish })),
    });
    const root = await new TestSuiteService(suites).create('ws', 'Root');
    await plans.save(
      createSavedTestPlan('ws', { suiteId: root.id }, [
        { title: 'Case', description: 'd', steps: [{ action: 'Open', expectedResult: 'Ok' }] },
      ]),
    );
    const response = await request(app)
      .post(`/TestPlan/suites/${root.id}/push`)
      .send({ providerId: 'azure_devops', workItemIds: ['51', '51', '52'] });
    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workItemIds: ['51', '52'] }),
    );
  });

  it('writes the CSV of Portuguese plans with Portuguese headers', async () => {
    const { app } = build();
    const response = await request(app)
      .post('/TestPlan/csv')
      .send({
        plans: [
          plan('Pagar com cartão de crédito', 'Abrir a página de pagamento e clicar no botão'),
        ],
      });
    expect(response.status).toBe(200);
    expect(response.text).toContain('Pagar com cartão');
  });
});

describe('Azure wiki attachment links', () => {
  it('keeps malformed escapes as they are', () => {
    const url =
      'https://dev.azure.com/o/p/_apis/git/repositories/r/items?path=%2F.attachments%2Fbad%ZZ.png&download=true&api-version=7.0';
    expect(relativeWikiAttachments(`![a](${url})`)).toBe('![a](%2F.attachments%2Fbad%ZZ.png)');
  });
});

describe('app wiring', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports whether workers reach localhost', async () => {
    const local = createApp({ requestContextResolver: owner, hostAlias: 'host.docker.internal' });
    expect((await request(local).get('/capabilities')).body).toEqual({
      workersReachLocalhost: true,
    });
    const cloud = createApp({ requestContextResolver: owner });
    expect((await request(cloud).get('/capabilities')).body).toEqual({
      workersReachLocalhost: false,
    });
  });

  it('wakes its own API test worker for remote runs when no dispatcher is given', async () => {
    const wake = vi.spyOn(ApiTestWorker.prototype, 'wake').mockImplementation(() => undefined);
    const authRepo = new InMemoryAuthRepository();
    const app = createApp({
      authService: new AuthService(authRepo),
      workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
    });
    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'gap@example.com', password: 'StrongPassword123!', name: 'QA' });
    const token = registered.body.token as string;
    const workspace = await request(app)
      .post('/workspaces')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'Gap WS', slug: 'gap-ws' });
    const call = (path: string) =>
      request(app)
        .post(path)
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', workspace.body.workspace.id as string);
    const collection = await call('/integration-tests/collections').send({
      name: 'Orders',
      variables: [],
      auth: { type: 'none' },
      items: [{ name: 'List', method: 'GET', url: 'https://api.example.test/orders' }],
    });
    expect(collection.body).toMatchObject({ collection: {} });
    const started = await call('/integration-tests/runs').send({
      collectionId: collection.body.collection.id,
    });
    expect(started.body).toMatchObject({ run: { target: 'remote' } });
    expect(wake).toHaveBeenCalled();
  });
});
