import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { resolveEffectiveAccess } from '../src/modules/workspaces/domain/permissions.js';
import {
  auditRequest,
  auditWorkspaceDeletion,
  documentHistoryIds,
  auditedRepositories,
  MemoryAuditPersistence,
  type AuditRepositories,
} from '../src/modules/audit/audit.js';
import { InMemorySpecRepository } from '../src/modules/spec/application/spec-service.js';
import {
  InMemorySavedTestPlanStore,
  createSavedTestPlan,
} from '../src/modules/testplans/application/saved-test-plans.js';
import {
  InMemoryKnowledgeChunkRepository,
  chunkPage,
} from '../src/modules/knowledge/application/knowledge-provider.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
const context = { ownerId: 'ws', workspaceId: 'ws', actorId: 'alice', requestId: 'request-1' };
function fixture() {
  const raw: AuditRepositories = {
    knowledge: new InMemoryKnowledgeChunkRepository(),
    specs: new InMemorySpecRepository(),
    tests: new InMemorySavedTestPlanStore(),
  };
  const persistence = new MemoryAuditPersistence(raw);
  return { raw, persistence, repo: auditedRepositories(raw, persistence) };
}
const page = (id: string, content = 'First', source = 'app://local?title=Doc') => ({
  id,
  source,
  content,
  updatedAt: '2026-09-16T12:00:00Z',
});
const spec = (id: string, parentId?: string) => ({
  id,
  workspaceId: 'ws',
  title: id,
  sections: [],
  messages: [],
  parentId,
  createdAt: '2026-09-16T12:00:00Z',
  updatedAt: '2026-09-16T12:00:00Z',
});

describe('Content audit history', () => {
  it('ignores incomplete legacy snapshots when resolving document identities', () => {
    expect(
      documentHistoryIds(
        [
          {
            entityId: 'legacy',
            action: 'update',
            before: null,
            after: { source: 12, pageId: 'x' },
          },
          { entityId: 'legacy', action: 'update', before: 'text', after: { source: 'wiki' } },
        ],
        'requested',
      ),
    ).toEqual(['requested']);
  });
  it('filters individual document history through rename and Wiki publication without crossing workspaces', async () => {
    const { repo, persistence } = fixture();
    const original = page('one', 'Original', 'app://local?title=First');
    const renamed = page('one', 'Edited', 'app://local?title=Renamed');
    const published = page('remote-one', 'Edited', 'https://wiki.test/one');
    const unrelated = page('two', 'Other', 'app://local?title=Other');
    await repo.knowledge.replacePage(original, chunkPage(original), context);
    await repo.knowledge.replacePage(unrelated, chunkPage(unrelated), context);
    await repo.knowledge.movePages(
      [{ previous: original, page: renamed, chunks: chunkPage(renamed) }],
      context,
    );
    await repo.knowledge.movePages(
      [{ previous: renamed, page: published, chunks: chunkPage(published) }],
      context,
    );
    await repo.knowledge.replacePage(published, chunkPage(published), {
      ...context,
      ownerId: 'other',
      workspaceId: 'other',
    });
    const query = {
      workspaceId: 'ws',
      entityType: 'document' as const,
      entityId: JSON.stringify([published.source, published.id]),
      offset: 0,
      limit: 2,
    };
    const result = await persistence.list(query);
    expect(result.total).toBe(3);
    expect(result.items.map((event) => event.action)).toEqual(['update', 'update']);
    expect((await persistence.list({ ...query, offset: 2 })).items[0]).toMatchObject({
      action: 'create',
      after: { content: 'Original' },
    });
    expect((await persistence.list({ ...query, workspaceId: 'other' })).total).toBe(1);
    expect((await persistence.list({ ...query, entityId: 'missing' })).total).toBe(0);
  });
  it('identifies system changes without inventing an author and delegates atomic workspace deletion', async () => {
    const { raw, repo, persistence } = fixture();
    await repo.specs.saveSpecification(spec('system'));
    expect(await repo.specs.listSpecifications('ws')).toHaveLength(1);
    expect(await repo.specs.listSpecifications('other')).toEqual([]);
    expect(await repo.specs.findTemplate('missing', 'ws')).toBeNull();
    const document = page('system-doc');
    await repo.knowledge.replacePage(document, chunkPage(document), {
      ownerId: 'ws',
      requestId: 'system',
    });
    const fallback = vi.fn().mockResolvedValue(undefined);
    await auditWorkspaceDeletion(persistence, 'ws', fallback);
    expect(fallback).toHaveBeenCalledOnce();
    const history = await persistence.list({
      workspaceId: 'ws',
      entityType: 'specification',
      offset: 0,
      limit: 20,
    });
    expect(history.items[0]).toMatchObject({
      action: 'delete',
      actorId: null,
      requestId: 'system',
      operation: 'deleteWorkspace',
    });
    expect(history.items[1]).toMatchObject({
      action: 'create',
      actorId: null,
      requestId: 'system',
      operation: 'saveSpecification',
    });
    const deleteWorkspace = vi.fn().mockResolvedValue(undefined);
    await auditWorkspaceDeletion(
      {
        run: (workspace, work) =>
          persistence.run(workspace, (unit) => work({ ...unit, deleteWorkspace })),
        list: (query) => persistence.list(query),
      },
      'ws',
      fallback,
    );
    expect(deleteWorkspace).toHaveBeenCalledWith('ws');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await raw.specs.listSpecifications('ws')).toEqual([]);
  });
  it('records synchronization, Wiki publication, document-to-Spec generation and Tests CRUD', async () => {
    let remote = page('remote', 'Imported body', 'https://wiki.test/page');
    const provider = {
      name: 'wiki',
      listPages: async () => [remote],
      ownsSource: (source: string) => source.startsWith('https://wiki.test'),
    };
    const app = createApp({
      requestContextResolver: () => ({ ...context, memberRole: 'ADMIN' }),
      dynamicProviderFactory: {
        resolveKnowledgeProvider: async () => provider,
        resolveAzureDevOpsWikiProvider: async () => ({
          pushPage: async ({ content }: { content: string }) => ({
            ...remote,
            id: 'published',
            content,
          }),
        }),
      } as unknown as DynamicProviderFactory,
      agentService: {
        executeAgent: async () => ({ result: '# Generated\nSpecification body' }),
      } as unknown as AgentService,
      testPlanGenerator: {
        generate: async () => ({
          title: 'Generated tests',
          description: 'Tests',
          steps: [],
          plans: [{ title: 'Generated tests', description: 'Tests', steps: [] }],
        }),
      },
    });
    await request(app).post('/knowledge/sync').expect(200);
    remote = { ...remote, content: 'Updated import' };
    await request(app).post('/knowledge/sync').expect(200);
    await request(app).post('/knowledge/sync').expect(200);
    const native = await request(app)
      .post('/knowledge/documents')
      .send({ title: 'Native', content: 'Text' })
      .expect(201);
    await request(app)
      .post('/knowledge/documents/' + native.body.document.pageId + '/push')
      .expect(200);
    const documents = await request(app).get('/audit/history?entityType=document').expect(200);
    expect(documents.body.total).toBe(4);
    expect(documents.body.items[0]).toMatchObject({
      action: 'update',
      before: { pageId: native.body.document.pageId },
      after: { pageId: 'published' },
    });
    await request(app)
      .post('/spec/from-knowledge')
      .send({ pageId: 'remote', source: remote.source, title: 'Generated spec', agentId: 'writer' })
      .expect(201);
    const specifications = await request(app)
      .get('/audit/history?entityType=specification')
      .expect(200);
    expect(specifications.body.items[0]).toMatchObject({
      action: 'create',
      actorId: 'alice',
      operation: 'POST /spec/from-knowledge',
    });
    const generated = await request(app)
      .post('/TestPlan/generate')
      .send({ prompt: 'Generate tests' })
      .expect(200);
    const id = generated.body.savedPlan.id;
    await request(app)
      .put('/TestPlan/' + id)
      .send({
        title: 'Revised',
        plans: [{ title: 'Edited case', description: 'Changed', steps: [] }],
      })
      .expect(200);
    await request(app)
      .delete('/TestPlan/' + id)
      .expect(204);
    const tests = await request(app)
      .get('/audit/history?entityType=testplan&entityId=' + id)
      .expect(200);
    expect(tests.body.items.map((e: { action: string }) => e.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
    expect(tests.body.items[1]).toMatchObject({
      before: { title: 'Generated tests' },
      after: { title: 'Revised', plans: [{ title: 'Edited case' }] },
    });
  });
  it('audits workspace deletion of every content family after authorization', async () => {
    const { raw, persistence } = fixture();
    const app = createApp({
      knowledgeRepository: raw.knowledge,
      specRepository: raw.specs,
      savedTestPlans: raw.tests,
      auditPersistence: persistence,
    });
    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'audit@example.com', name: 'Author', password: 'StrongPassword123!' })
      .expect(201);
    const auth = 'Bearer ' + registered.body.token;
    const workspaces = await request(app).get('/workspaces').set('Authorization', auth).expect(200);
    const workspaceId = workspaces.body[0].workspace.id;
    await request(app)
      .post('/knowledge/documents')
      .set('Authorization', auth)
      .send({ title: 'Delete me', content: 'Body' })
      .expect(201);
    await request(app)
      .post('/spec/specifications')
      .set('Authorization', auth)
      .send({ title: 'Spec', sections: [] })
      .expect(201);
    await request(app)
      .post('/spec/templates')
      .set('Authorization', auth)
      .send({ name: 'Template', sections: [] })
      .expect(201);
    await raw.tests.save(createSavedTestPlan(workspaceId, { title: 'Plan' }, []));
    await request(app)
      .delete('/workspaces/' + workspaceId)
      .set('Authorization', auth)
      .expect(200);
    for (const entityType of ['document', 'specification', 'template', 'testplan'] as const) {
      const history = await persistence.list({ workspaceId, entityType, offset: 0, limit: 20 });
      expect(history.items[0]).toMatchObject({
        action: 'delete',
        actorId: registered.body.user.id,
        actorName: 'Author',
        actorEmail: 'audit@example.com',
        operation: 'DELETE /workspaces/' + workspaceId,
      });
    }
    expect(await raw.knowledge.all({ ownerId: workspaceId, requestId: 'r' })).toEqual([]);
    expect(await raw.specs.listSpecifications(workspaceId)).toEqual([]);
    expect(await raw.tests.count(workspaceId)).toBe(0);
  });
  it('records before/after, author and relations; does not record unchanged sync or failed mutations', async () => {
    const { repo, persistence } = fixture();
    const first = page('a');
    const second = page('b');
    await repo.knowledge.replacePage(first, chunkPage(first), context);
    await repo.knowledge.replacePage(first, chunkPage(first), context);
    await repo.knowledge.replacePage(second, chunkPage(second), context);
    await repo.knowledge.addRelation('a', 'b', context);
    await repo.knowledge.deleteRelation('a', 'b', context);
    await expect(repo.knowledge.addRelation('missing', 'b', context)).rejects.toBeDefined();
    const changed = page('a', 'Second');
    await repo.knowledge.replacePage(changed, chunkPage(changed), context);
    await repo.knowledge.deletePage(first, context);
    const result = await persistence.list({
      workspaceId: 'ws',
      entityType: 'document',
      offset: 0,
      limit: 50,
    });
    expect(result.total).toBe(8);
    expect(result.items[0]).toMatchObject({
      action: 'delete',
      actorId: 'alice',
      requestId: 'request-1',
      before: { content: 'Second' },
      after: null,
    });
    expect(result.items[1]).toMatchObject({
      action: 'update',
      before: { content: 'First' },
      after: { content: 'Second' },
    });
    expect(
      await persistence.list({
        workspaceId: 'other',
        entityType: 'document',
        offset: 0,
        limit: 50,
      }),
    ).toEqual({ items: [], total: 0 });
    result.items[0]!.before = 'tampered';
    expect(
      (await persistence.list({ workspaceId: 'ws', entityType: 'document', offset: 0, limit: 1 }))
        .items[0]!.before,
    ).not.toBe('tampered');
  });
  it('captures template detachment, descendant deletion and saved test edits/deletion', async () => {
    const { repo, persistence } = fixture();
    await auditRequest.run({ context: () => context, operation: 'DELETE /spec' }, async () => {
      await repo.specs.saveTemplate({
        id: 't',
        workspaceId: 'ws',
        name: 'Template',
        sections: [],
        createdAt: '',
        updatedAt: '',
      });
      await repo.specs.saveSpecification({ ...spec('parent'), templateId: 't' });
      await repo.specs.saveSpecification(spec('child', 'parent'));
      await repo.specs.deleteTemplate('t', 'ws');
      await repo.specs.deleteSpecification('parent', 'ws');
      expect(await repo.specs.deleteSpecification('missing', 'ws')).toBe(false);
      const plan = createSavedTestPlan('ws', { title: 'Test' }, []);
      await repo.tests.save(plan);
      await repo.tests.save({ ...plan, title: 'Edited' });
      await repo.tests.delete(plan.id, 'ws');
      const tests = await persistence.list({
        workspaceId: 'ws',
        entityType: 'testplan',
        offset: 0,
        limit: 50,
      });
      expect(tests.items.map((e) => e.action)).toEqual(['delete', 'update', 'create']);
      expect(tests.items[1]).toMatchObject({
        actorId: 'alice',
        before: { title: 'Test' },
        after: { title: 'Edited' },
      });
    });
    const history = await persistence.list({
      workspaceId: 'ws',
      entityType: 'specification',
      offset: 0,
      limit: 50,
    });
    expect(
      history.items
        .filter((e) => e.action === 'delete')
        .map((e) => e.entityId)
        .sort(),
    ).toEqual(['child', 'parent']);
    expect(history.items.find((e) => e.action === 'update')?.before).toMatchObject({
      templateId: 't',
    });
    await expect(
      auditRequest.run({ context: () => context, operation: 'save' }, () =>
        repo.specs.saveSpecification({ ...spec('other'), workspaceId: 'other' }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it('audits HTTP CRUD, agent chat, context clearing and publication with request attribution', async () => {
    const executeAgent = vi.fn().mockResolvedValue({ result: 'Agent reply' });
    const app = createApp({
      agentService: { executeAgent } as unknown as AgentService,
      requestContextResolver: (req) => ({
        ...context,
        memberRole: 'ADMIN',
        requestId: req.header('x-request-id') ?? 'r',
      }),
    });
    const created = await request(app)
      .post('/knowledge/documents')
      .set('x-request-id', 'create-doc')
      .send({ title: 'Doc', content: 'Body', actorId: 'forged' })
      .expect(201);
    await request(app)
      .put('/knowledge/documents/' + created.body.document.pageId)
      .send({ title: 'Renamed', content: 'Edited' })
      .expect(200);
    await request(app)
      .delete('/knowledge/documents/' + created.body.document.pageId)
      .expect(200);
    const createdSpec = await request(app)
      .post('/spec/specifications')
      .send({
        title: 'Spec',
        sections: [{ templateSectionId: 'scope', title: 'Scope', content: 'Requirement' }],
      })
      .expect(201);
    const id = createdSpec.body.id;
    await request(app)
      .post('/spec/specifications/' + id + '/chat')
      .send({ agentId: 'writer', content: 'Help' })
      .expect(200);
    await request(app)
      .delete('/spec/specifications/' + id + '/messages')
      .expect(200);
    await request(app)
      .post('/spec/specifications/' + id + '/knowledge')
      .expect(201);
    await request(app)
      .delete('/spec/specifications/' + id)
      .expect(204);
    const history = await request(app)
      .get('/audit/history?entityType=specification&pageSize=2')
      .expect(200);
    expect(history.body.total).toBe(4);
    expect(history.body.totalPages).toBe(2);
    expect(history.body.items[0]).toMatchObject({
      action: 'delete',
      actorId: 'alice',
      entityId: id,
    });
    const docs = await request(app).get('/audit/history?entityType=document').expect(200);
    expect(
      docs.body.items.find((e: { requestId: string }) => e.requestId === 'create-doc'),
    ).toMatchObject({ actorId: 'alice', action: 'create' });
    await request(app).get('/audit/history?entityType=nope').expect(400);
    await request(app).get('/audit/history?entityType=document&pageSize=51').expect(400);
    await request(createApp()).get('/audit/history?entityType=document').expect(403);
    await request(
      createApp({
        requestContextResolver: () => ({
          ...context,
          memberRole: 'MEMBER' as const,
          access: resolveEffectiveAccess('MEMBER', {}, []),
        }),
      }),
    )
      .get('/audit/history?entityType=document')
      .expect(403);
  });
  it('isolates simultaneous actors/workspaces and retains test history after deletion', async () => {
    const app = createApp({
      requestContextResolver: (req) => ({
        ownerId: req.header('x-workspace-id'),
        actorId: req.header('x-actor'),
        requestId: 'r',
      }),
    });
    await Promise.all(
      ['a', 'b'].map(async (owner) => {
        const doc = await request(app)
          .post('/knowledge/documents')
          .set('x-workspace-id', owner)
          .set('x-actor', owner + '-actor')
          .send({ title: owner, content: 'body' })
          .expect(201);
        await request(app)
          .delete('/knowledge/documents/' + doc.body.document.pageId)
          .set('x-workspace-id', owner)
          .set('x-actor', owner + '-actor')
          .expect(200);
      }),
    );
    for (const owner of ['a', 'b']) {
      const history = await request(app)
        .get('/audit/history?entityType=document')
        .set('x-workspace-id', owner)
        .expect(200);
      expect(history.body.items).toHaveLength(2);
      expect(
        history.body.items.every((e: { actorId: string }) => e.actorId === owner + '-actor'),
      ).toBe(true);
    }
  });
});
