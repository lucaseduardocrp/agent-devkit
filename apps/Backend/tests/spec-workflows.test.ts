import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { SpecWorkflows } from '../src/modules/spec/application/spec-workflows.js';
import {
  InMemorySpecRepository,
  SpecService,
} from '../src/modules/spec/application/spec-service.js';
import {
  InMemoryKnowledgeChunkRepository,
  chunkPage,
} from '../src/modules/knowledge/application/knowledge-provider.js';
import { createApp } from '../src/adapters/http/app.js';
import { resolveEffectiveAccess } from '../src/modules/workspaces/domain/permissions.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { RequestContext } from '../src/shared/context.js';

const context: RequestContext = {
  requestId: 'r',
  ownerId: 'ws',
  workspaceId: 'ws',
  memberRole: 'ADMIN',
};
const input = {
  pageId: 'doc',
  source: 'app://local?title=Source',
  title: 'Source',
  agentId: 'writer',
};
async function fixture() {
  const specs = new InMemorySpecRepository();
  const knowledge = new InMemoryKnowledgeChunkRepository();
  const reply = vi.fn().mockResolvedValue({ content: 'Generated content' });
  const workflows = new SpecWorkflows(specs, knowledge, { reply });
  const service = new SpecService(specs, { reply });
  const spec = await service.saveSpecification('ws', {
    title: 'Ready',
    sections: [{ templateSectionId: 'scope', title: 'Scope', content: 'Requirements' }],
  });
  await knowledge.replacePage(
    { id: input.pageId, source: input.source },
    chunkPage(
      {
        id: input.pageId,
        source: input.source,
        content: '# Source\nFull body',
        updatedAt: '2026-09-16',
      },
      5,
    ).reverse(),
    context,
  );
  return { specs, knowledge, reply, workflows, service, spec };
}

describe('Spec/Brain application workflows', () => {
  it('permanently clears context while preserving fields, and starts a fresh conversation', async () => {
    const f = await fixture();
    await f.specs.saveSpecification({
      ...f.spec,
      proposal: { sections: [] },
      messages: [{ id: 'old', role: 'user', content: 'Old private context', createdAt: '' }],
    });
    const cleared = await f.workflows.clearMessages('ws', f.spec.id);
    expect(cleared.messages).toEqual([]);
    expect(cleared.proposal).toBeUndefined();
    expect(cleared.sections).toEqual(f.spec.sections);
    expect((await f.specs.findSpecification(f.spec.id, 'ws'))?.messages).toEqual([]);
    await f.service.chat('ws', f.spec.id, 'writer', 'Fresh request');
    expect(f.reply.mock.calls[0]![0].conversation).toMatchObject([{ content: 'Fresh request' }]);
    await expect(f.workflows.clearMessages('other', f.spec.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('publishes saved content without chat, updates one document and retains correlations', async () => {
    const f = await fixture();
    await f.specs.saveSpecification({
      ...f.spec,
      messages: [{ id: 'm', role: 'user', content: 'Secret chat', createdAt: '' }],
    });
    const first = await f.workflows.publish('ws', f.spec.id, context);
    await f.knowledge.addRelation(first.pageId, input.pageId, context);
    await f.service.saveSpecification('ws', { ...f.spec, title: 'Renamed' });
    expect((await f.workflows.publish('ws', f.spec.id, context)).pageId).toBe(first.pageId);
    const chunks = (await f.knowledge.all(context)).filter(
      (chunk) => chunk.pageId === first.pageId,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe('# Renamed\n\n## Scope\n\nRequirements\n');
    expect(await f.knowledge.listRelations(context)).toHaveLength(1);
    const empty = await f.service.saveSpecification('ws', { title: 'Empty', sections: [] });
    await expect(f.workflows.publish('ws', empty.id, context)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('grounds the chosen agent in full ordered content and direct correlations only', async () => {
    const f = await fixture();
    for (const id of ['before', 'z-after', 'unrelated', 'other']) {
      const page = { id, source: 'wiki', content: id, updatedAt: '2026-09-16' };
      await f.knowledge.replacePage(page, chunkPage(page), context);
    }
    await f.knowledge.addRelation('before', input.pageId, context);
    await f.knowledge.addRelation(input.pageId, 'z-after', context);
    await f.knowledge.addRelation('unrelated', 'other', context);
    const privatePage = {
      id: 'private',
      source: 'wiki',
      content: 'Private tenant',
      updatedAt: '2026-09-16',
    };
    await f.knowledge.replacePage(privatePage, chunkPage(privatePage), {
      ...context,
      ownerId: 'other-tenant',
    });
    f.reply.mockResolvedValue({
      content: 'Visible',
      title: 'Generated',
      sections: [
        { templateSectionId: 'requirements', content: 'Implement source' },
        { templateSectionId: 'unknown', content: 'Extras' },
      ],
    });
    const generated = await f.workflows.generate('ws', input, { ...context, locale: 'en-US' });
    const call = f.reply.mock.calls[0]![0];
    expect(call.agentId).toBe('writer');
    expect(call.conversation[0].content).toContain('# Source\nFull body');
    expect(call.conversation[0].content).toContain('wiki:before');
    expect(call.conversation[0].content).toContain('wiki:z-after');
    expect(call.conversation[0].content).not.toContain('unrelated');
    expect(call.conversation[0].content).not.toContain('Private tenant');
    expect(
      generated.sections.find((section) => section.templateSectionId === 'requirements')?.content,
    ).toBe('Implement source');
    expect(generated.sections.at(-1)?.content).toBe('Extras');
    expect(generated.title).toBe('Generated');
    expect(generated.messages).toEqual([]);
    expect(await f.specs.findSpecification(generated.id, 'ws')).toEqual(generated);
    expect(await f.specs.findSpecification(generated.id, 'other')).toBeNull();
  });

  it('uses configured templates and falls back from empty templates or unstructured output', async () => {
    const f = await fixture();
    const template = await f.service.saveTemplate('ws', {
      name: 'Custom',
      sections: [{ id: 'custom', title: 'Custom', required: true }],
    });
    const generated = await f.workflows.generate('ws', input, context);
    expect(generated.templateId).toBe(template.id);
    expect(generated.sections).toEqual([
      { templateSectionId: 'custom', title: 'Custom', content: 'Generated content' },
    ]);
    await f.service.saveTemplate('ws', { ...template, sections: [] });
    expect((await f.workflows.generate('ws', input, context)).sections).toHaveLength(5);
  });

  it('does not create orphan specs on missing input, empty output or agent failure', async () => {
    const f = await fixture();
    await expect(
      f.workflows.generate('ws', { ...input, source: 'wrong' }, context),
    ).rejects.toMatchObject({ statusCode: 404 });
    f.reply
      .mockResolvedValueOnce({ content: '  ', sections: [] })
      .mockRejectedValueOnce(new Error('offline'));
    await expect(f.workflows.generate('ws', input, context)).rejects.toMatchObject({
      statusCode: 502,
    });
    await expect(f.workflows.generate('ws', input, context)).rejects.toThrow('offline');
    expect(await f.specs.listSpecifications('ws')).toHaveLength(1);
  });
});

describe('Spec workflow HTTP routes', () => {
  it('composes all three actions and uses the selected workspace agent', async () => {
    const f = await fixture();
    const executeAgent = vi.fn().mockResolvedValue({
      result:
        '```spec-update\n{"sections":[{"templateSectionId":"requirements","content":"Generated requirements"}]}\n```',
    });
    const app = createApp({
      specRepository: f.specs,
      knowledgeRepository: f.knowledge,
      requestContextResolver: async () => context,
      agentService: { executeAgent } as unknown as AgentService,
    });
    const cleared = await request(app).delete(`/spec/specifications/${f.spec.id}/messages`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.messages).toEqual([]);
    expect((await request(app).post(`/spec/specifications/${f.spec.id}/knowledge`)).status).toBe(
      201,
    );
    const generated = await request(app).post('/spec/from-knowledge').send(input);
    expect(generated.status).toBe(201);
    expect(
      generated.body.sections.find(
        (section: { templateSectionId: string }) => section.templateSectionId === 'requirements',
      ).content,
    ).toBe('Generated requirements');
    expect(executeAgent).toHaveBeenCalledWith(
      'ws',
      'writer',
      expect.objectContaining({ includeKnowledge: true }),
      expect.objectContaining({ ownerId: 'ws' }),
    );
    expect((await request(app).post('/spec/from-knowledge').send({})).status).toBe(400);
    expect((await request(app).delete('/spec/specifications/missing/messages')).status).toBe(404);
    expect((await request(app).post('/spec/specifications/missing/knowledge')).status).toBe(404);
    expect(
      (
        await request(app)
          .post('/spec/from-knowledge')
          .send({ ...input, pageId: 'missing' })
      ).status,
    ).toBe(404);
  });

  it('enforces viewer and Brain read/write permissions for the new actions', async () => {
    const f = await fixture();
    const mutable: { value: RequestContext } = { value: { ...context, memberRole: 'VIEWER' } };
    const app = createApp({
      specRepository: f.specs,
      requestContextResolver: async () => mutable.value,
    });
    expect((await request(app).delete(`/spec/specifications/${f.spec.id}/messages`)).status).toBe(
      403,
    );
    expect((await request(app).post(`/spec/specifications/${f.spec.id}/knowledge`)).status).toBe(
      403,
    );
    expect((await request(app).post('/spec/from-knowledge').send(input)).status).toBe(403);
    mutable.value = {
      ...context,
      memberRole: 'MEMBER',
      access: resolveEffectiveAccess('MEMBER', {}, [{ modules: { specs: 'delete' } }]),
    };
    expect((await request(app).delete(`/spec/specifications/${f.spec.id}/messages`)).status).toBe(
      200,
    );
    expect((await request(app).post('/spec/from-knowledge').send(input)).status).toBe(403);
    mutable.value = {
      ...context,
      memberRole: 'MEMBER',
      access: resolveEffectiveAccess('MEMBER', {}, [
        { modules: { specs: 'delete', brain: 'view' } },
      ]),
    };
    expect((await request(app).post(`/spec/specifications/${f.spec.id}/knowledge`)).status).toBe(
      403,
    );
    expect((await request(app).post('/spec/from-knowledge').send(input)).status).toBe(404);
    mutable.value = { requestId: 'anonymous' };
    expect((await request(app).delete(`/spec/specifications/${f.spec.id}/messages`)).status).toBe(
      401,
    );
  });
});
