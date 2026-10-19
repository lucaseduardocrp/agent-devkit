import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { DynamicProviderFactory as ProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { InMemoryKnowledgeChunkRepository } from '../src/modules/knowledge/application/knowledge-provider.js';
import { ApplicationError } from '../src/shared/errors.js';

describe('POST /knowledge/documents/:pageId/push', () => {
  it('lists configured push integrations and Trello lists as destinations', async () => {
    const app = createApp({
      requestContextResolver: async () => ({
        ownerId: 'push-destinations',
        requestId: 'push-destinations',
      }),
      dynamicProviderFactory: {
        listBrainPushProviders: async () => [
          { providerId: 'trello', name: 'Trello', settings: { boardId: 'board-1' } },
        ],
        resolveBrainBoardPushProvider: async () => ({
          pull: async () => [
            { externalId: 'list-1', title: 'Docs', sourceData: { trelloType: 'list' } },
            { externalId: 'card-1', title: 'Card', sourceData: { trelloType: 'card' } },
          ],
        }),
      } as unknown as DynamicProviderFactory,
    });
    const providers = await request(app).get('/knowledge/push-providers');
    expect(providers.body.providers).toEqual([
      { providerId: 'trello', name: 'Trello', settings: { boardId: 'board-1' } },
    ]);
    const destinations = await request(app).get('/knowledge/push-destinations/trello');
    expect(destinations.body.destinations).toEqual([{ id: 'list-1', label: 'Docs' }]);
  });

  it('publishes only the selected document at an explicit Wiki path and keeps local pages', async () => {
    const pushPage = vi.fn(async ({ path, content }: { path: string; content: string }) => ({
      id: 'remote-child',
      source: `https://dev.azure.com/wiki?pagePath=${encodeURIComponent(path)}`,
      content,
      updatedAt: 'now',
    }));
    const resolveAzureDevOpsWikiProvider = vi.fn(async () => ({ pushPage }));
    const app = createApp({
      requestContextResolver: async () => ({
        ownerId: 'explicit-path',
        requestId: 'explicit-path',
      }),
      knowledgeRepository: new InMemoryKnowledgeChunkRepository(),
      dynamicProviderFactory: {
        resolveAzureDevOpsWikiProvider,
      } as unknown as DynamicProviderFactory,
    });
    const parent = (
      await request(app).post('/knowledge/documents').send({ title: 'Doc 1', content: 'parent' })
    ).body.document;
    const child = (
      await request(app)
        .post('/knowledge/documents')
        .send({ title: 'Doc 2', content: 'child', parentPageId: parent.pageId })
    ).body.document;
    const result = await request(app)
      .post(`/knowledge/documents/${child.pageId}/push`)
      .send({
        providerId: 'azure_devops_wiki',
        destination: { parentPath: '/Doc 1/Doc 3.1', wikiIdentifier: 'wiki-2' },
      });
    expect(result.status).toBe(200);
    expect(pushPage).toHaveBeenCalledWith({
      id: child.pageId,
      content: '# Doc 2\n\nchild',
      path: '/Doc 1/Doc 3.1/Doc 2',
    });
    expect(resolveAzureDevOpsWikiProvider).toHaveBeenCalledWith(
      'explicit-path',
      undefined,
      'wiki-2',
    );
    expect((await request(app).get('/knowledge/documents')).body.documents).toMatchObject([
      { pageId: parent.pageId, isCustom: true },
      { pageId: child.pageId, isCustom: true, parentPageId: parent.pageId },
    ]);
  });

  it('requires a Trello list and publishes the selected document as a card', async () => {
    const push = vi.fn(async () => ({ externalUrl: 'https://trello.com/c/card' }));
    const app = createApp({
      requestContextResolver: async () => ({ ownerId: 'trello-push', requestId: 'trello-push' }),
      knowledgeRepository: new InMemoryKnowledgeChunkRepository(),
      dynamicProviderFactory: {
        resolveBrainBoardPushProvider: async () => ({ push }),
      } as unknown as DynamicProviderFactory,
    });
    const doc = (
      await request(app).post('/knowledge/documents').send({ title: 'Note', content: 'Body' })
    ).body.document;
    const missing = await request(app)
      .post(`/knowledge/documents/${doc.pageId}/push`)
      .send({ providerId: 'trello', destination: {} });
    expect(missing.status).toBe(400);
    const result = await request(app)
      .post(`/knowledge/documents/${doc.pageId}/push`)
      .send({ providerId: 'trello', destination: { listId: 'list-1' } });
    expect(result.status).toBe(200);
    expect(result.body.remoteUrl).toBe('https://trello.com/c/card');
    expect(push).toHaveBeenCalledWith(
      { kind: 'card', title: 'Note', description: '# Note\n\nBody', status: 'backlog' },
      { listId: 'list-1' },
    );
  });

  it('uses the workspace Azure integration and writes through the Wiki API', async () => {
    const service = new IntegrationsService(new InMemoryUserIntegrationStore());
    let pushedContent = '';
    let pushedPath = '';
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/_apis/wiki/wikis?'))
        return {
          ok: true,
          status: 200,
          json: async () => ({ value: [{ id: 'wiki-1' }] }),
        } as Response;
      if (init?.method === 'PUT') {
        expect(url).toContain('/wikis/wiki-1/pages?');
        expect(init.headers).toMatchObject({
          authorization: `Basic ${Buffer.from(':pat').toString('base64')}`,
        });
        pushedContent = JSON.parse(String(init.body)).content as string;
        pushedPath = new URL(url).searchParams.get('path') ?? '';
        return { ok: true, status: 201 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 42,
          path: pushedPath,
          content: pushedContent,
          remoteUrl: 'https://dev.azure.com/wiki/published',
        }),
      } as Response;
    });
    const app = createApp({
      authService: new AuthService(new InMemoryAuthRepository()),
      integrationsService: service,
      dynamicProviderFactory: new ProviderFactory(service, fetcher),
    });
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'integrated-push@example.com', password: 'StrongPassword123!', name: 'User' });
    const token = reg.body.token as string;
    const ws = await request(app).get('/workspaces').set('Authorization', `Bearer ${token}`);
    const ownerId = ws.body[0]?.workspace.id ?? reg.body.user.id;
    await service.saveIntegration(ownerId, 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'org', project: 'project' },
      secret: 'pat',
    });
    const doc = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Teste 9', content: 'Body' });
    const result = await request(app)
      .post(`/knowledge/documents/${doc.body.document.pageId}/push`)
      .set('Authorization', `Bearer ${token}`);
    expect(result.status).toBe(200);
    expect(result.body.remoteUrl).toContain('https://dev.azure.com/wiki/published?pagePath=');
    expect(pushedPath).toBe('/Teste 9');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('forbids writers with a read-only Brain permission', async () => {
    const app = createApp({
      requestContextResolver: async () => ({
        requestId: 'readonly',
        ownerId: 'workspace',
        memberRole: 'VIEWER',
      }),
    });
    const response = await request(app).post(
      '/knowledge/documents/doc-11111111-1111-4111-8111-111111111111/push',
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MODULE_PERMISSION_DENIED');
  });
  it('publishes only the authenticated owner’s native document', async () => {
    const pushPage = vi.fn().mockResolvedValue({
      id: '42',
      source: 'https://dev.azure.com/wiki/page',
      content: `# My Note\n\n${'A'.repeat(600)}`,
      updatedAt: 'now',
    });
    const resolveAzureDevOpsWikiProvider = vi.fn().mockResolvedValue({ pushPage });
    const app = createApp({
      authService: new AuthService(new InMemoryAuthRepository()),
      knowledgeRepository: new InMemoryKnowledgeChunkRepository(),
      dynamicProviderFactory: {
        resolveAzureDevOpsWikiProvider,
      } as unknown as DynamicProviderFactory,
    });
    const register = async (email: string) => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email, password: 'StrongPassword123!', name: 'User' });
      return res.body.token as string;
    };
    const ownerToken = await register('push-owner@example.com');
    const otherToken = await register('push-other@example.com');
    const create = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'My Note', content: 'A'.repeat(600) });
    expect(create.status).toBe(201);
    const pageId = create.body.document.pageId as string;

    expect((await request(app).post(`/knowledge/documents/${pageId}/push`)).status).toBe(403);
    expect(
      (
        await request(app)
          .post(`/knowledge/documents/${pageId}/push`)
          .set('Authorization', `Bearer ${otherToken}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/knowledge/documents/bad-id/push')
          .set('Authorization', `Bearer ${ownerToken}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/knowledge/documents/${'a'.repeat(501)}/push`)
          .set('Authorization', `Bearer ${ownerToken}`)
      ).status,
    ).toBe(404);

    const sent = await request(app)
      .post(`/knowledge/documents/${pageId}/push`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      success: true,
      remoteUrl: 'https://dev.azure.com/wiki/page',
    });
    expect(pushPage).toHaveBeenCalledWith({
      id: pageId,
      content: `# My Note\n\n${'A'.repeat(600)}`,
      path: '/My Note',
    });
    expect(resolveAzureDevOpsWikiProvider).toHaveBeenCalledTimes(1);
    const docs = await request(app)
      .get('/knowledge/documents')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(docs.body.documents).toHaveLength(1);
    expect(docs.body.documents[0]).toMatchObject({
      pageId: '42',
      source: 'https://dev.azure.com/wiki/page',
      isCustom: false,
    });
    const deletePublished = await request(app)
      .delete('/knowledge/documents/42')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(deletePublished.status).toBe(200);
    expect(deletePublished.body.success).toBe(true);
  });

  it('requires the Azure integration and rejects external documents', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const app = createApp({
      authService: new AuthService(new InMemoryAuthRepository()),
      knowledgeRepository: repository,
      dynamicProviderFactory: {
        resolveAzureDevOpsWikiProvider: async () => null,
      } as unknown as DynamicProviderFactory,
    });
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'push-missing@example.com', password: 'StrongPassword123!', name: 'User' });
    const token = reg.body.token as string;
    const create = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Note', content: 'Body' });
    const pageId = create.body.document.pageId as string;
    const unavailable = await request(app)
      .post(`/knowledge/documents/${pageId}/push`)
      .set('Authorization', `Bearer ${token}`);
    expect(unavailable.status).toBe(400);
    expect(unavailable.body.code).toBe('AZURE_WIKI_NOT_CONFIGURED');
    const ws = await request(app).get('/workspaces').set('Authorization', `Bearer ${token}`);
    const ownerId = ws.body[0]?.workspace.id ?? reg.body.user.id;
    const externalId = 'doc-11111111-1111-4111-8111-111111111111';
    await repository.replacePage(
      { id: externalId, source: 'https://dev.azure.com/wiki/page' },
      [
        {
          pageId: externalId,
          source: 'https://dev.azure.com/wiki/page',
          chunkIndex: 0,
          content: '# External',
          createdAt: '2026-09-14',
        },
      ],
      { ownerId, requestId: 'test' },
    );
    const external = await request(app)
      .post(`/knowledge/documents/${externalId}/push`)
      .set('Authorization', `Bearer ${token}`);
    expect(external.status).toBe(404);
    expect(external.body.code).toBe('DOCUMENT_NOT_FOUND');
    const untitledId = 'doc-22222222-2222-4222-8222-222222222222';
    await repository.replacePage(
      { id: untitledId, source: 'app://local?title=' },
      [
        {
          pageId: untitledId,
          source: 'app://local?title=',
          chunkIndex: 0,
          content: '# Untitled',
          createdAt: '2026-09-14',
        },
      ],
      { ownerId, requestId: 'test' },
    );
    const untitled = await request(app)
      .post(`/knowledge/documents/${untitledId}/push`)
      .set('Authorization', `Bearer ${token}`);
    expect(untitled.status).toBe(400);
    expect(untitled.body.code).toBe('INVALID_DOCUMENT_TITLE');
  });

  it('creates native subpages, publishes the tree, and makes every published page read-only', async () => {
    let remoteId = 100;
    const pushPage = vi.fn(async ({ path, content }: { path: string; content: string }) => ({
      id: String(remoteId++),
      source: `https://dev.azure.com/wiki?pagePath=${encodeURIComponent(path)}`,
      content,
      updatedAt: 'now',
    }));
    const app = createApp({
      requestContextResolver: async () => ({ ownerId: 'tree-owner', requestId: 'tree' }),
      knowledgeRepository: new InMemoryKnowledgeChunkRepository(),
      dynamicProviderFactory: {
        resolveAzureDevOpsWikiProvider: async () => ({ pushPage }),
      } as unknown as DynamicProviderFactory,
    });
    const create = (title: string, parentPageId?: string) =>
      request(app).post('/knowledge/documents').send({ title, content: title, parentPageId });
    const parent = (await create('Parent')).body.document;
    const child = (await create('Child', parent.pageId)).body.document;
    await create('Grandchild', child.pageId);
    const updatedChild = await request(app)
      .put(`/knowledge/documents/${child.pageId}`)
      .send({ title: 'Child Updated', content: 'Updated child' });
    expect(updatedChild.body.document).toMatchObject({
      title: 'Child Updated',
      parentPageId: parent.pageId,
    });
    expect((await create('Orphan', 'missing')).body.code).toBe('PARENT_DOCUMENT_NOT_FOUND');
    const before = await request(app).get('/knowledge/documents');
    expect(
      before.body.documents.find((doc: { pageId: string }) => doc.pageId === child.pageId)
        .parentPageId,
    ).toBe(parent.pageId);
    expect((await request(app).delete(`/knowledge/documents/${parent.pageId}`)).body.code).toBe(
      'DOCUMENT_HAS_SUBPAGES',
    );
    expect(
      (
        await request(app)
          .post('/knowledge/relations')
          .send({ sourcePageId: parent.pageId, targetPageId: child.pageId })
      ).status,
    ).toBe(201);
    const pushed = await request(app).post(`/knowledge/documents/${child.pageId}/push`);
    expect(pushed.status).toBe(200);
    expect(pushed.body.published).toHaveLength(3);
    expect(pushed.body.remoteUrl).toContain(encodeURIComponent('/Parent/Child Updated'));
    expect(pushPage.mock.calls.map(([page]) => page.path)).toEqual([
      '/Parent',
      '/Parent/Child Updated',
      '/Parent/Child Updated/Grandchild',
    ]);
    const after = await request(app).get('/knowledge/documents');
    expect(after.body.documents).toHaveLength(3);
    expect(after.body.documents.every((doc: { isCustom: boolean }) => !doc.isCustom)).toBe(true);
    expect(
      after.body.documents.find((doc: { title: string }) => doc.title === 'Child Updated'),
    ).toMatchObject({
      title: 'Child Updated',
      pagePath: '/Parent/Child Updated',
    });
    const publishedChild = after.body.documents.find(
      (doc: { title: string }) => doc.title === 'Child Updated',
    );
    expect((await request(app).get('/knowledge/relations')).body.relations).toMatchObject([
      { sourcePageId: '100', targetPageId: '101' },
    ]);
    const deletePublished = await request(app).delete(
      `/knowledge/documents/${publishedChild.pageId}`,
    );
    expect(deletePublished.status).toBe(200);
    expect(deletePublished.body.success).toBe(true);
  });

  it('keeps native documents when Azure fails and preserves typed conflicts', async () => {
    const pushPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new ApplicationError('AZURE_WIKI_CONFLICT', 'Changed', 409))
      .mockRejectedValueOnce(
        new ApplicationError('AZURE_WIKI_VERIFICATION_FAILED', 'Unverified', 502),
      );
    const app = createApp({
      requestContextResolver: async () => ({ ownerId: 'failure-owner', requestId: 'failure' }),
      knowledgeRepository: new InMemoryKnowledgeChunkRepository(),
      dynamicProviderFactory: {
        resolveAzureDevOpsWikiProvider: async () => ({ pushPage }),
      } as unknown as DynamicProviderFactory,
    });
    const doc = (
      await request(app).post('/knowledge/documents').send({ title: 'Retry', content: 'Body' })
    ).body.document;
    const endpoint = `/knowledge/documents/${doc.pageId}/push`;
    expect((await request(app).post(endpoint)).body.code).toBe('AZURE_WIKI_ERROR');
    expect((await request(app).post(endpoint)).body.code).toBe('AZURE_WIKI_CONFLICT');
    expect((await request(app).post(endpoint)).body.code).toBe('AZURE_WIKI_VERIFICATION_FAILED');
    expect((await request(app).get('/knowledge/documents')).body.documents[0]).toMatchObject({
      source: doc.source,
      isCustom: true,
    });
  });

  it('rejects cyclic hierarchies and descendants without a title', async () => {
    const context = { ownerId: 'invalid-tree-owner', requestId: 'invalid-tree' };
    const repository = new InMemoryKnowledgeChunkRepository();
    const firstId = 'doc-11111111-1111-4111-8111-111111111111';
    const secondId = 'doc-22222222-2222-4222-8222-222222222222';
    const seed = (id: string, source: string) =>
      repository.replacePage(
        { id, source },
        [{ pageId: id, source, chunkIndex: 0, content: 'Body', createdAt: '2026-09-14' }],
        context,
      );

    await seed(firstId, `app://local?title=First&parentPageId=${secondId}`);
    await seed(secondId, `app://local?title=Second&parentPageId=${firstId}`);
    const app = createApp({
      requestContextResolver: async () => context,
      knowledgeRepository: repository,
      dynamicProviderFactory: {
        resolveAzureDevOpsWikiProvider: async () => ({
          pushPage: vi.fn().mockResolvedValue('https://dev.azure.com/wiki/page'),
        }),
      } as unknown as DynamicProviderFactory,
    });

    const cyclic = await request(app).post(`/knowledge/documents/${firstId}/push`);
    expect(cyclic.status).toBe(409);
    expect(cyclic.body.code).toBe('INVALID_DOCUMENT_HIERARCHY');

    const validRootId = 'doc-33333333-3333-4333-8333-333333333333';
    const untitledChildId = 'doc-44444444-4444-4444-8444-444444444444';
    await seed(validRootId, 'app://local?title=Valid');
    await seed(untitledChildId, `app://local?title=%20&parentPageId=${validRootId}`);

    const untitledDescendant = await request(app).post(`/knowledge/documents/${validRootId}/push`);
    expect(untitledDescendant.status).toBe(400);
    expect(untitledDescendant.body.code).toBe('INVALID_DOCUMENT_TITLE');
  });
});
