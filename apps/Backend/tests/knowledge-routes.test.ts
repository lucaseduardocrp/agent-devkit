import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import {
  InMemoryKnowledgeChunkRepository,
  type KnowledgeContentProvider,
  type KnowledgePage,
} from '../src/modules/knowledge/application/knowledge-provider.js';

describe('Knowledge HTTP Routes (/knowledge/sync & /knowledge/stats)', () => {
  it('creates, lists, removes, and validates document correlations', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const repository = new InMemoryKnowledgeChunkRepository();
    const app = createApp({ authService, knowledgeRepository: repository });
    const registration = await request(app).post('/auth/register').send({
      email: 'relations@example.com',
      password: 'StrongPassword123!',
      name: 'Relations User',
    });
    const authorization = `Bearer ${registration.body.token}`;
    const first = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', authorization)
      .send({ title: 'First', content: 'First content' });
    const second = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', authorization)
      .send({ title: 'Second', content: 'Second content' });

    const created = await request(app)
      .post('/knowledge/relations')
      .set('Authorization', authorization)
      .send({
        sourcePageId: first.body.document.pageId,
        targetPageId: second.body.document.pageId,
      });
    expect(created.status).toBe(201);
    expect(created.body.relations).toHaveLength(1);
    const listed = await request(app)
      .get('/knowledge/relations')
      .set('Authorization', authorization);
    expect(listed.body.relations).toEqual(created.body.relations);
    const rename = await request(app)
      .put('/knowledge/documents/' + first.body.document.pageId)
      .set('Authorization', authorization)
      .send({ title: 'Renamed', content: 'Updated body' });
    expect(rename.status).toBe(200);
    expect(rename.body.document.content).toBe('# Renamed\n\nUpdated body');
    const afterRename = await request(app)
      .get('/knowledge/relations')
      .set('Authorization', authorization);
    expect(afterRename.body.relations).toEqual(created.body.relations);
    const beforeFailure = (
      await request(app).get('/knowledge/documents').set('Authorization', authorization)
    ).body;
    vi.spyOn(repository, 'movePages').mockRejectedValueOnce(new Error('Write failed'));
    expect(
      (
        await request(app)
          .put('/knowledge/documents/' + first.body.document.pageId)
          .set('Authorization', authorization)
          .send({ title: 'Failed rename', content: 'Lost' })
      ).status,
    ).toBe(500);
    expect(
      (await request(app).get('/knowledge/documents').set('Authorization', authorization)).body,
    ).toEqual(beforeFailure);
    expect(
      (await request(app).get('/knowledge/relations').set('Authorization', authorization)).body
        .relations,
    ).toEqual(created.body.relations);

    expect(
      (
        await request(app)
          .post('/knowledge/relations')
          .set('Authorization', authorization)
          .send({ sourcePageId: first.body.document.pageId })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .delete('/knowledge/relations')
          .query({
            sourcePageId: first.body.document.pageId,
            targetPageId: second.body.document.pageId,
          })
          .set('Authorization', authorization)
      ).status,
    ).toBe(204);

    vi.spyOn(repository, 'listRelations').mockRejectedValueOnce(new Error('List failed'));
    expect(
      (await request(app).get('/knowledge/relations').set('Authorization', authorization)).status,
    ).toBe(500);
    vi.spyOn(repository, 'deleteRelation').mockRejectedValueOnce(new Error('Delete failed'));
    expect(
      (
        await request(app)
          .delete('/knowledge/relations')
          .query({ targetPageId: second.body.document.pageId })
          .set('Authorization', authorization)
      ).status,
    ).toBe(500);
    expect(
      (
        await request(app)
          .delete('/knowledge/relations')
          .query({ sourcePageId: first.body.document.pageId })
          .set('Authorization', authorization)
      ).status,
    ).toBe(204);
  });

  it('rejects unauthenticated requests with 403', async () => {
    const app = createApp();

    const syncRes = await request(app).post('/knowledge/sync');
    expect(syncRes.status).toBe(403);

    const statsRes = await request(app).get('/knowledge/stats');
    expect(statsRes.status).toBe(403);

    const docsRes = await request(app).get('/knowledge/documents');
    expect(docsRes.status).toBe(403);
  });

  it('returns 400 when no knowledge provider is active for the authenticated user', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const app = createApp({ authService, integrationsService });

    const reg = await request(app).post('/auth/register').send({
      email: 'nosync@example.com',
      password: 'StrongPassword123!',
      name: 'No Sync User',
    });
    const token = reg.body.token;

    const res = await request(app).post('/knowledge/sync').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_ACTIVE_KNOWLEDGE_PROVIDER');
    expect(res.body.message).toContain('Nenhum provedor de documentação está ativo');
  });

  it('synchronizes knowledge on-demand and updates repository and stats', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const knowledgeRepository = new InMemoryKnowledgeChunkRepository();

    const mockPages: readonly KnowledgePage[] = [
      {
        id: 'wiki-page-1',
        source:
          'https://dev.azure.com/org/proj/_wiki/wikis/w1?pagePath=%2FLan%C3%A7amento%20de%20Gratifica%C3%A7%C3%B5es',
        content: 'This is the first documentation page for Acme testing.',
        updatedAt: '2026-09-11T10:00:00.000Z',
      },
      {
        id: 'wiki-page-2',
        source: 'https://wiki.example.com/docs/arch-guide',
        content: 'Second page covering QA flows and acceptance criteria.',
        updatedAt: '2026-09-11T11:00:00.000Z',
      },
      {
        id: 'wiki-page-3',
        source: 'plain-source-without-url',
        content: 'Third page content repeated to generate multiple chunks. '.repeat(40),
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
      {
        id: 'wiki-page-4',
        source: 'https://dev.azure.com/org/proj/_wiki?pagePath=%2F',
        content: 'Root pagePath fallback',
        updatedAt: '2026-09-11T13:00:00.000Z',
      },
      {
        id: 'wiki-page-5',
        source: 'https://example.com/',
        content: 'Root url fallback',
        updatedAt: '2026-09-11T14:00:00.000Z',
      },
    ];

    const mockProvider: KnowledgeContentProvider = {
      name: 'azure_devops_wiki',
      listPages: async () => mockPages,
    };

    const mockFactory = {
      resolveKnowledgeProvider: async () => mockProvider,
    } as unknown as DynamicProviderFactory;

    const app = createApp({
      authService,
      integrationsService,
      knowledgeRepository,
      dynamicProviderFactory: mockFactory,
    });

    const reg = await request(app).post('/auth/register').send({
      email: 'syncer@example.com',
      password: 'StrongPassword123!',
      name: 'Syncer User',
    });
    const token = reg.body.token;

    // Initially stats and documents should be empty
    const initialStats = await request(app)
      .get('/knowledge/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(initialStats.status).toBe(200);
    expect(initialStats.body).toEqual({ documentsCount: 0, chunksCount: 0 });

    const initialDocs = await request(app)
      .get('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`);
    expect(initialDocs.status).toBe(200);
    expect(initialDocs.body).toEqual({ documents: [] });

    // Perform forced sync
    const syncRes = await request(app)
      .post('/knowledge/sync')
      .set('Authorization', `Bearer ${token}`);
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.success).toBe(true);

    // Query stats again
    const updatedStats = await request(app)
      .get('/knowledge/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(updatedStats.status).toBe(200);
    expect(updatedStats.body.documentsCount).toBe(5);

    // Query documents list
    const updatedDocs = await request(app)
      .get('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`);
    expect(updatedDocs.status).toBe(200);
    expect(updatedDocs.body.documents).toHaveLength(5);

    const doc1 = updatedDocs.body.documents.find(
      (d: { pageId: string }) => d.pageId === 'wiki-page-1',
    );
    expect(doc1).toMatchObject({
      pageId: 'wiki-page-1',
      title: 'Lançamento de Gratificações',
      chunksCount: 1,
    });

    const doc2 = updatedDocs.body.documents.find(
      (d: { pageId: string }) => d.pageId === 'wiki-page-2',
    );
    expect(doc2).toMatchObject({
      pageId: 'wiki-page-2',
      title: 'arch-guide',
      chunksCount: 1,
    });

    const doc3 = updatedDocs.body.documents.find(
      (d: { pageId: string }) => d.pageId === 'wiki-page-3',
    );
    expect(doc3).toMatchObject({
      pageId: 'wiki-page-3',
      title: 'wiki-page-3',
    });
    expect(doc3.chunksCount).toBeGreaterThan(1);
    expect(doc3.content).toBe(mockPages[2]!.content);

    const doc4 = updatedDocs.body.documents.find(
      (d: { pageId: string }) => d.pageId === 'wiki-page-4',
    );
    expect(doc4).toMatchObject({
      pageId: 'wiki-page-4',
      title: 'wiki-page-4',
    });

    const doc5 = updatedDocs.body.documents.find(
      (d: { pageId: string }) => d.pageId === 'wiki-page-5',
    );
    expect(doc5).toMatchObject({
      pageId: 'wiki-page-5',
      title: 'wiki-page-5',
    });
  });

  it('handles provider failures during synchronization gracefully', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const knowledgeRepository = new InMemoryKnowledgeChunkRepository();

    const failingProvider: KnowledgeContentProvider = {
      name: 'failing_provider',
      listPages: async () => {
        throw new Error('Azure DevOps Wiki API connection timed out.');
      },
    };

    const mockFactory = {
      resolveKnowledgeProvider: async () => failingProvider,
    } as unknown as DynamicProviderFactory;

    const app = createApp({
      authService,
      integrationsService,
      knowledgeRepository,
      dynamicProviderFactory: mockFactory,
    });

    const reg = await request(app).post('/auth/register').send({
      email: 'failure@example.com',
      password: 'StrongPassword123!',
      name: 'Failure User',
    });
    const token = reg.body.token;

    const res = await request(app).post('/knowledge/sync').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('Ocorreu um erro inesperado.');
  });

  it('supports creating, editing, and deleting application documents while forbidding editing external documents', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const knowledgeRepository = new InMemoryKnowledgeChunkRepository();

    const app = createApp({
      authService,
      integrationsService,
      knowledgeRepository,
    });

    const reg = await request(app).post('/auth/register').send({
      email: 'crud@example.com',
      password: 'StrongPassword123!',
      name: 'CRUD User',
    });
    const token = reg.body.token;
    const wsRes = await request(app).get('/workspaces').set('Authorization', `Bearer ${token}`);
    const activeOwnerId = wsRes.body[0]?.workspace.id ?? reg.body.user.id;

    // Validation checks on POST
    const emptyTitleRes = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '', content: 'hello' });
    expect(emptyTitleRes.status).toBe(400);
    expect(emptyTitleRes.body.code).toBe('INVALID_DOCUMENT_TITLE');

    const invalidContentRes = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Title', content: 123 });
    expect(invalidContentRes.status).toBe(400);
    expect(invalidContentRes.body.code).toBe('INVALID_DOCUMENT_CONTENT');

    // Create custom document with heading normalization
    const createRes = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Nota de Teste', content: '# Nota\n\nConteúdo inicial da aplicação.' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.document).toMatchObject({
      title: 'Nota de Teste',
      isCustom: true,
      content: '# Nota de Teste\n\nConteúdo inicial da aplicação.',
    });
    const pageId = createRes.body.document.pageId;

    // Create custom document with empty content and content without heading
    const emptyDocRes = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Nota Vazia', content: '' });
    expect(emptyDocRes.status).toBe(201);
    expect(emptyDocRes.body.document.content).toBe('# Nota Vazia');

    const noHeadingDocRes = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Nota Sem Heading', content: 'Texto direto sem título' });
    expect(noHeadingDocRes.status).toBe(201);
    expect(noHeadingDocRes.body.document.content).toBe(
      '# Nota Sem Heading\n\nTexto direto sem título',
    );

    // Create large custom document (> 1000 characters) to test standard chunk fragmentation
    const largeBody = 'A'.repeat(1200);
    const largeDocRes = await request(app)
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Documento Grande', content: largeBody });
    expect(largeDocRes.status).toBe(201);
    // '# Documento Grande\n\n' (20 chars) + 1200 chars = 1220 chars => 3 chunks (500 + 500 + 220)
    expect(largeDocRes.body.document.chunksCount).toBe(3);
    expect(largeDocRes.body.document.totalCharacters).toBe(1220);

    // Verify GET /knowledge/documents lists the new custom document
    const listRes = await request(app)
      .get('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const createdDoc = listRes.body.documents.find((d: { pageId: string }) => d.pageId === pageId);
    expect(createdDoc).toBeDefined();
    expect(createdDoc.isCustom).toBe(true);
    expect(createdDoc.title).toBe('Nota de Teste');

    // Seed a custom chunk without title in URL to test fallback title extraction from content
    const fallbackPage = {
      id: 'doc-fallback-h1',
      source: 'app://local',
      content: '# Título Extraído do Conteúdo\n\nTexto do documento.',
      updatedAt: new Date().toISOString(),
    };
    await knowledgeRepository.replacePage(
      fallbackPage,
      [
        {
          source: fallbackPage.source,
          pageId: fallbackPage.id,
          chunkIndex: 0,
          content: fallbackPage.content,
          createdAt: fallbackPage.updatedAt,
        },
      ],
      {
        ownerId: activeOwnerId,
        requestId: 'req-fallback',
      },
    );
    const listWithFallback = await request(app)
      .get('/knowledge/documents')
      .set('Authorization', `Bearer ${token}`);
    const fallbackDoc = listWithFallback.body.documents.find(
      (d: { pageId: string }) => d.pageId === fallbackPage.id,
    );
    expect(fallbackDoc).toBeDefined();
    expect(fallbackDoc.title).toBe('Título Extraído do Conteúdo');

    // Validation checks on PUT
    const putEmptyTitleRes = await request(app)
      .put(`/knowledge/documents/${pageId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '   ', content: 'novo' });
    expect(putEmptyTitleRes.status).toBe(400);
    expect(putEmptyTitleRes.body.code).toBe('INVALID_DOCUMENT_TITLE');

    const putInvalidContentRes = await request(app)
      .put(`/knowledge/documents/${pageId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Novo Titulo', content: null });
    expect(putInvalidContentRes.status).toBe(400);
    expect(putInvalidContentRes.body.code).toBe('INVALID_DOCUMENT_CONTENT');

    const putNotFoundRes = await request(app)
      .put('/knowledge/documents/non-existent-doc')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Titulo', content: 'texto' });
    expect(putNotFoundRes.status).toBe(404);
    expect(putNotFoundRes.body.code).toBe('DOCUMENT_NOT_FOUND');

    // Update custom document (with new title and content)
    const updateRes = await request(app)
      .put(`/knowledge/documents/${pageId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Nota Atualizada', content: '# Nota Atualizada\n\nNovo conteúdo.' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);
    expect(updateRes.body.document).toMatchObject({
      title: 'Nota Atualizada',
      content: '# Nota Atualizada\n\nNovo conteúdo.',
    });

    // Seed an external integration document directly
    const externalPage = {
      id: 'ext-wiki-1',
      source: 'https://dev.azure.com/org/proj/_wiki/wikis/wiki?pagePath=/Arquitetura',
      content: 'Conteúdo da wiki externa',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    await knowledgeRepository.replacePage(
      externalPage,
      [
        {
          source: externalPage.source,
          pageId: externalPage.id,
          chunkIndex: 0,
          content: externalPage.content,
          createdAt: externalPage.updatedAt,
        },
      ],
      { requestId: 'req-crud-1', ownerId: activeOwnerId },
    );

    // Attempt to edit external document -> FORBIDDEN (400 CANNOT_EDIT_EXTERNAL_DOCUMENT)
    const editExternalRes = await request(app)
      .put(`/knowledge/documents/${externalPage.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Tentativa de Hack', content: 'Conteúdo alterado' });
    expect(editExternalRes.status).toBe(400);
    expect(editExternalRes.body.code).toBe('CANNOT_EDIT_EXTERNAL_DOCUMENT');

    // External documents remain managed by the Wiki.
    const deleteExternalRes = await request(app)
      .delete(`/knowledge/documents/${externalPage.id}`)
      .query({ source: externalPage.source })
      .set('Authorization', `Bearer ${token}`);
    expect(deleteExternalRes.status).toBe(200);
    expect(deleteExternalRes.body.success).toBe(true);

    // Deleting custom document -> ALLOWED
    const deleteCustomRes = await request(app)
      .delete(`/knowledge/documents/${pageId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleteCustomRes.status).toBe(200);
    expect(deleteCustomRes.body.success).toBe(true);

    // Deleting non-existent document -> 404
    const deleteNotFoundRes = await request(app)
      .delete('/knowledge/documents/never-existed')
      .set('Authorization', `Bearer ${token}`);
    expect(deleteNotFoundRes.status).toBe(404);
    expect(deleteNotFoundRes.body.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('rejects mutations when user has VIEWER role', async () => {
    const knowledgeRepository = new InMemoryKnowledgeChunkRepository();
    const mockContextResolver = vi.fn().mockResolvedValue({
      requestId: 'req-viewer',
      actorId: 'viewer-user',
      ownerId: 'ws-test',
      workspaceId: 'ws-test',
      memberRole: 'VIEWER',
    });

    const app = createApp({
      knowledgeRepository,
      requestContextResolver: mockContextResolver,
    });

    const createRes = await request(app)
      .post('/knowledge/documents')
      .send({ title: 'Nota', content: 'Corpo' });
    expect(createRes.status).toBe(403);
    expect(createRes.body.code).toBe('MODULE_PERMISSION_DENIED');

    const syncRes = await request(app).post('/knowledge/sync').send();
    expect(syncRes.status).toBe(403);
    expect(syncRes.body.code).toBe('MODULE_PERMISSION_DENIED');
  });
});
