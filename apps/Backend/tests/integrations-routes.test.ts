import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';

import { createIntegrationsRouter } from '../src/adapters/http/integrations-routes.js';
import {
  resolveEffectiveAccess,
  type ModuleAccess,
} from '../src/modules/workspaces/domain/permissions.js';

describe('Integrations HTTP Routes & Multi-tenant Isolation', () => {
  it('instantiates default dynamicProviderFactory when omitted', () => {
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const router = createIntegrationsRouter(integrationsService, vi.fn());
    expect(router).toBeDefined();
  });
  it('allows authenticated users to CRUD integrations and enforces secret masking', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const app = createApp({ authService, integrationsService });

    // Register user
    const reg = await request(app).post('/auth/register').send({
      email: 'integrator@example.com',
      password: 'StrongPassword123!',
      name: 'Integrator',
    });
    const token = reg.body.token;

    // 1. Initial list is empty
    const initialList = await request(app)
      .get('/integrations')
      .set('Authorization', `Bearer ${token}`);
    expect(initialList.status).toBe(200);
    expect(initialList.body).toEqual([]);

    // 2. PUT integration with a secret
    const putRes = await request(app)
      .put('/integrations/KNOWLEDGE/azure_devops_wiki')
      .set('Authorization', `Bearer ${token}`)
      .send({
        isEnabled: true,
        settings: { organization: 'MyOrg', projectId: 'MyProject' },
        secret: 'my-azure-devops-pat-token',
      });

    expect(putRes.status).toBe(200);
    expect(putRes.body.category).toBe('KNOWLEDGE');
    expect(putRes.body.providerId).toBe('azure_devops_wiki');
    expect(putRes.body.hasSecret).toBe(true);
    expect(putRes.body.maskedSecret).toBe('••••••••');
    // Plaintext secret is never present
    expect(JSON.stringify(putRes.body)).not.toContain('my-azure-devops-pat-token');

    // 3. GET list shows the created integration
    const listRes = await request(app).get('/integrations').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].providerId).toBe('azure_devops_wiki');
    expect(listRes.body[0].hasSecret).toBe(true);
    expect(listRes.body[0].maskedSecret).toBe('••••••••');

    // 4. DELETE integration
    const delRes = await request(app)
      .delete('/integrations/KNOWLEDGE/azure_devops_wiki')
      .set('Authorization', `Bearer ${token}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ success: true, deleted: true });

    // 5. Subsequent list is empty again
    const emptyList = await request(app)
      .get('/integrations')
      .set('Authorization', `Bearer ${token}`);
    expect(emptyList.body).toEqual([]);
  });

  it('rejects unauthenticated requests and invalid parameters', async () => {
    const app = createApp();

    // No auth
    const unauthedGet = await request(app).get('/integrations');
    expect(unauthedGet.status).toBe(403);
    expect(unauthedGet.body.code).toBe('OWNER_CONTEXT_REQUIRED');

    const unauthedPut = await request(app)
      .put('/integrations/KNOWLEDGE/azure_devops_wiki')
      .send({ isEnabled: true });
    expect(unauthedPut.status).toBe(403);

    const unauthedDel = await request(app).delete('/integrations/KNOWLEDGE/azure_devops_wiki');
    expect(unauthedDel.status).toBe(403);

    // Register user for invalid parameter checks
    const reg = await request(app).post('/auth/register').send({
      email: 'validation@example.com',
      password: 'StrongPassword123!',
      name: 'Validation User',
    });
    const token = reg.body.token;

    // Invalid category
    const invalidCatPut = await request(app)
      .put('/integrations/INVALID_CATEGORY/azure_devops_wiki')
      .set('Authorization', `Bearer ${token}`)
      .send({ isEnabled: true });
    expect(invalidCatPut.status).toBe(400);
    expect(invalidCatPut.body.code).toBe('INVALID_INTEGRATION_CATEGORY');

    const invalidCatDel = await request(app)
      .delete('/integrations/INVALID_CATEGORY/azure_devops_wiki')
      .set('Authorization', `Bearer ${token}`);
    expect(invalidCatDel.status).toBe(400);
    expect(invalidCatDel.body.code).toBe('INVALID_INTEGRATION_CATEGORY');

    // Empty or whitespace providerId
    const emptyProviderPut = await request(app)
      .put('/integrations/KNOWLEDGE/%20%20')
      .set('Authorization', `Bearer ${token}`)
      .send({ isEnabled: true });
    expect(emptyProviderPut.status).toBe(400);
    expect(emptyProviderPut.body.code).toBe('PROVIDER_ID_REQUIRED');

    const emptyProviderDel = await request(app)
      .delete('/integrations/KNOWLEDGE/%20%20')
      .set('Authorization', `Bearer ${token}`);
    expect(emptyProviderDel.status).toBe(400);
    expect(emptyProviderDel.body.code).toBe('PROVIDER_ID_REQUIRED');
  });

  it('enforces strict multi-tenant isolation between users', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const app = createApp({ authService, integrationsService });

    // Register User 1
    const reg1 = await request(app).post('/auth/register').send({
      email: 'user1@example.com',
      password: 'Password123!',
      name: 'User 1',
    });
    const token1 = reg1.body.token;

    // Register User 2
    const reg2 = await request(app).post('/auth/register').send({
      email: 'user2@example.com',
      password: 'Password123!',
      name: 'User 2',
    });
    const token2 = reg2.body.token;

    // User 1 configures Azure DevOps
    await request(app)
      .put('/integrations/KNOWLEDGE/azure_devops_wiki')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        isEnabled: true,
        settings: { organization: 'User1Org' },
        secret: 'pat-user-1',
      });

    // User 2 configures GitHub Projects
    await request(app)
      .put('/integrations/PROJECT_MANAGEMENT/github_projects')
      .set('Authorization', `Bearer ${token2}`)
      .send({
        isEnabled: true,
        settings: { organization: 'User2Org' },
        secret: 'pat-user-2',
      });

    // User 1 list has only Azure DevOps
    const list1 = await request(app).get('/integrations').set('Authorization', `Bearer ${token1}`);
    expect(list1.body).toHaveLength(1);
    expect(list1.body[0].providerId).toBe('azure_devops_wiki');
    expect(list1.body[0].settings.organization).toBe('User1Org');

    // User 2 list has only GitHub Projects
    const list2 = await request(app).get('/integrations').set('Authorization', `Bearer ${token2}`);
    expect(list2.body).toHaveLength(1);
    expect(list2.body[0].providerId).toBe('github_projects');
    expect(list2.body[0].settings.organization).toBe('User2Org');

    // User 1 attempts to delete User 2's integration -> deleted: false
    const crossDel = await request(app)
      .delete('/integrations/PROJECT_MANAGEMENT/github_projects')
      .set('Authorization', `Bearer ${token1}`);
    expect(crossDel.status).toBe(200);
    expect(crossDel.body).toEqual({ success: true, deleted: false });

    // User 2's integration is still completely intact
    const verifyUser2 = await request(app)
      .get('/integrations')
      .set('Authorization', `Bearer ${token2}`);
    expect(verifyUser2.body).toHaveLength(1);
    expect(verifyUser2.body[0].providerId).toBe('github_projects');
  });

  it('tests provider connectivity with custom input and fallback saved config', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const app = createApp({ authService, integrationsService });

    const reg = await request(app).post('/auth/register').send({
      email: 'prober@example.com',
      password: 'Password123!',
      name: 'Prober',
    });
    const token = reg.body.token;

    // Save Ollama config first
    await request(app)
      .put('/integrations/LLM/ollama')
      .set('Authorization', `Bearer ${token}`)
      .send({
        isEnabled: true,
        settings: { baseUrl: 'http://localhost:11434' },
      });

    // Probe with direct settings in body
    const directProbe = await request(app)
      .post('/integrations/LLM/ollama/test')
      .set('Authorization', `Bearer ${token}`)
      .send({
        settings: { baseUrl: 'http://localhost:11434' },
      });
    expect(directProbe.status).toBe(200);
    expect(directProbe.body).toHaveProperty('ok');

    // Probe with fallback to saved settings (empty body)
    const fallbackProbe = await request(app)
      .post('/integrations/LLM/ollama/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(fallbackProbe.status).toBe(200);
    expect(fallbackProbe.body).toHaveProperty('ok');

    // Probe unsaved provider with empty body (line 105 fallback)
    const unsavedProbe = await request(app)
      .post('/integrations/LLM/gemini/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(unsavedProbe.status).toBe(200);
    expect(unsavedProbe.body).toHaveProperty('ok');

    // Invalid parameters
    const invalidCat = await request(app)
      .post('/integrations/INVALID_CAT/ollama/test')
      .set('Authorization', `Bearer ${token}`);
    expect(invalidCat.status).toBe(400);

    const emptyProvider = await request(app)
      .post('/integrations/LLM/%20%20/test')
      .set('Authorization', `Bearer ${token}`);
    expect(emptyProvider.status).toBe(400);

    // Unauthenticated
    const unauthedProbe = await request(app).post('/integrations/LLM/ollama/test');
    expect(unauthedProbe.status).toBe(403);
  });

  it('requires integrations edit to change and delete to remove integrations', async () => {
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const member = (integrations: ModuleAccess) => ({
      requestId: `req-${integrations}`,
      actorId: 'member-user',
      ownerId: 'ws-test',
      workspaceId: 'ws-test',
      memberRole: 'MEMBER' as const,
      access: resolveEffectiveAccess('MEMBER', {}, [{ modules: { integrations } }]),
    });
    const mockContextResolver = vi.fn().mockResolvedValue(member('view'));
    const app = createApp({
      integrationsService,
      requestContextResolver: mockContextResolver,
    });

    // Viewing is allowed for any member: other modules list the configured providers.
    expect((await request(app).get('/integrations')).status).toBe(200);
    const putRes = await request(app).put('/integrations/LLM/ollama').send({ isEnabled: true });
    expect(putRes.status).toBe(403);
    expect(putRes.body.code).toBe('MODULE_PERMISSION_DENIED');
    expect((await request(app).delete('/integrations/LLM/ollama')).status).toBe(403);
    expect((await request(app).post('/integrations/LLM/ollama/test')).status).toBe(403);

    // Legacy contexts that only carry a role keep the defaults that role had.
    mockContextResolver.mockResolvedValueOnce({
      requestId: 'req-viewer',
      actorId: 'viewer-user',
      ownerId: 'ws-test',
      workspaceId: 'ws-test',
      memberRole: 'VIEWER',
    });
    expect((await request(app).delete('/integrations/LLM/ollama')).status).toBe(403);

    mockContextResolver.mockResolvedValueOnce(member('edit'));
    expect(
      (await request(app).put('/integrations/LLM/ollama').send({ isEnabled: true })).status,
    ).toBe(200);
    mockContextResolver.mockResolvedValueOnce(member('edit'));
    expect((await request(app).delete('/integrations/LLM/ollama')).status).toBe(403);
    mockContextResolver.mockResolvedValueOnce(member('delete'));
    expect((await request(app).delete('/integrations/LLM/ollama')).status).toBe(200);
  });

  it('supports GET /integrations/azure-devops/members for authenticated users and handles errors', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const app = createApp({ authService, integrationsService });

    // 1. Unauthenticated returns 403 (owner context required)
    const unauthed = await request(app).get('/integrations/azure-devops/members');
    expect(unauthed.status).toBe(403);

    // Register user
    const reg = await request(app).post('/auth/register').send({
      email: 'azure-user@example.com',
      password: 'StrongPassword123!',
      name: 'Azure User',
    });
    const token = reg.body.token;

    // 2. Not configured returns configured: false
    const resEmpty = await request(app)
      .get('/integrations/azure-devops/members')
      .set('Authorization', `Bearer ${token}`);
    expect(resEmpty.status).toBe(200);
    expect(resEmpty.body.configured).toBe(false);
    expect(resEmpty.body.members).toEqual([]);

    // 3. Mock dynamicProviderFactory error handling
    const mockContextResolver = vi.fn().mockResolvedValue({
      requestId: 'req-az-err',
      ownerId: 'owner-err',
      actorId: 'owner-err',
    });
    const mockFactory = {
      getAzureDevOpsProjectMembers: vi
        .fn()
        .mockRejectedValue(new Error('Azure service unavailable')),
    } as any;

    const errorApp = createApp({
      authService,
      dynamicProviderFactory: mockFactory,
      requestContextResolver: mockContextResolver,
    });
    const errRes = await request(errorApp)
      .get('/integrations/azure-devops/members')
      .set('Authorization', `Bearer ${token}`);
    expect(errRes.status).toBe(500);
  });
});
