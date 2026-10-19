import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  renderSpecificationMarkdown,
  type Specification,
  type SpecTemplate,
} from '../src/modules/spec/domain/specification.js';
import {
  InMemorySpecRepository,
  SpecService,
} from '../src/modules/spec/application/spec-service.js';
import {
  AgentSpecCollaborator,
  parseAgentReply,
} from '../src/modules/spec/adapters/agent-spec-collaborator.js';
import {
  PrismaSpecRepository,
  type PrismaSpecClient,
} from '../src/modules/spec/adapters/prisma-spec-repository.js';
import { createSpecRouter } from '../src/adapters/http/spec-routes.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';

describe('Specification Domain & renderSpecificationMarkdown', () => {
  it('renders markdown properly with sections and empty sections filtered out', () => {
    const spec: Specification = {
      id: 'spec-1',
      workspaceId: 'ws-1',
      title: 'Sistema de Pagamento',
      sections: [
        { templateSectionId: 'sec-1', title: 'Objetivo', content: 'Processar pagamentos via Pix' },
        { templateSectionId: 'sec-2', title: 'Vazio', content: '   ' },
        {
          templateSectionId: 'sec-3',
          title: 'Regras',
          content: 'Limite de R$ 5.000 por transação',
        },
      ],
      messages: [],
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    };

    const md = renderSpecificationMarkdown(spec);
    expect(md).toContain('# Sistema de Pagamento');
    expect(md).toContain('## Objetivo\n\nProcessar pagamentos via Pix');
    expect(md).toContain('## Regras\n\nLimite de R$ 5.000 por transação');
    expect(md).not.toContain('## Vazio');

    const emptySpec: Specification = {
      ...spec,
      sections: [{ templateSectionId: 'sec-1', title: 'Vazio', content: '' }],
    };
    expect(renderSpecificationMarkdown(emptySpec)).toBe('# Sistema de Pagamento\n\n');
  });
});

describe('InMemorySpecRepository', () => {
  it('saves, finds and lists templates and specifications correctly per workspace', async () => {
    const repo = new InMemorySpecRepository();

    const template: SpecTemplate = {
      id: 'tpl-1',
      workspaceId: 'ws-1',
      name: 'Template Padrão',
      sections: [{ id: 's1', title: 'Seção 1', required: true }],
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    };

    await repo.saveTemplate(template);
    expect(await repo.findTemplate('tpl-1', 'ws-1')).toEqual(template);
    expect(await repo.findTemplate('tpl-1', 'ws-other')).toBeNull();
    expect(await repo.findTemplate('tpl-none', 'ws-1')).toBeNull();

    const templatesWs1 = await repo.listTemplates('ws-1');
    expect(templatesWs1).toHaveLength(1);
    expect(templatesWs1[0]).toEqual(template);
    expect(await repo.listTemplates('ws-2')).toHaveLength(0);

    const spec: Specification = {
      id: 'spec-1',
      workspaceId: 'ws-1',
      title: 'Minha Spec',
      sections: [{ templateSectionId: 's1', title: 'Seção 1', content: 'Conteúdo' }],
      messages: [],
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    };

    await repo.saveSpecification(spec);
    expect(await repo.findSpecification('spec-1', 'ws-1')).toEqual(spec);
    expect(await repo.findSpecification('spec-1', 'ws-other')).toBeNull();
    expect(await repo.findSpecification('spec-none', 'ws-1')).toBeNull();

    const specsWs1 = await repo.listSpecifications('ws-1');
    expect(specsWs1).toHaveLength(1);
    expect(specsWs1[0]).toEqual(spec);
    expect(await repo.listSpecifications('ws-2')).toHaveLength(0);
    expect(await repo.deleteSpecification('spec-1', 'ws-other')).toBe(false);
    expect(await repo.deleteSpecification('spec-1', 'ws-1')).toBe(true);
    expect(await repo.deleteSpecification('spec-1', 'ws-1')).toBe(false);
  });
});

describe('SpecService', () => {
  it('creates and updates templates', async () => {
    const repo = new InMemorySpecRepository();
    const service = new SpecService(repo);

    const created = await service.saveTemplate('ws-1', {
      name: 'Novo Template',
      sections: [{ id: 's1', title: 'Título', required: false, guidance: 'Guia' }],
    });
    expect(created.id).toBeDefined();
    expect(created.name).toBe('Novo Template');
    expect(created.sections).toHaveLength(1);

    const updated = await service.saveTemplate('ws-1', {
      id: created.id,
      name: 'Template Atualizado',
      sections: created.sections,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Template Atualizado');
    expect(updated.createdAt).toBe(created.createdAt);

    const list = await service.listTemplates('ws-1');
    expect(list).toHaveLength(1);

    const specification = await service.saveSpecification('ws-1', {
      templateId: created.id,
      title: 'Uses template',
      sections: [],
    });
    await expect(service.deleteTemplate('other-workspace', created.id)).rejects.toThrow(
      'Template não encontrado.',
    );
    await service.deleteTemplate('ws-1', created.id);
    expect(await service.listTemplates('ws-1')).toEqual([]);
    expect((await service.getSpecification('ws-1', specification.id)).templateId).toBeUndefined();
  });

  it('creates and updates specifications', async () => {
    const repo = new InMemorySpecRepository();
    const service = new SpecService(repo);

    const created = await service.saveSpecification('ws-1', {
      title: 'Nova Especificação',
      sections: [{ templateSectionId: 's1', title: 'Título', content: 'Texto inicial' }],
    });
    expect(created.id).toBeDefined();
    expect(created.title).toBe('Nova Especificação');

    const updated = await service.saveSpecification('ws-1', {
      id: created.id,
      title: 'Especificação Editada',
      sections: [{ templateSectionId: 's1', title: 'Título', content: 'Texto editado' }],
    });
    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe('Especificação Editada');

    const found = await service.getSpecification('ws-1', created.id);
    expect(found.title).toBe('Especificação Editada');

    await expect(service.getSpecification('ws-1', 'inexistente')).rejects.toThrow(ApplicationError);

    const list = await service.listSpecifications('ws-1');
    expect(list).toHaveLength(1);
    await service.deleteSpecification('ws-1', created.id);
    await expect(service.deleteSpecification('ws-1', created.id)).rejects.toThrow(
      'Especificação não encontrada.',
    );
  });

  it('creates hierarchies, rejects invalid parents and deletes descendants', async () => {
    const repo = new InMemorySpecRepository();
    const service = new SpecService(repo);
    const root = await service.saveSpecification('ws-1', {
      title: 'Raiz',
      sections: [],
    });
    const child = await service.saveSpecification('ws-1', {
      parentId: root.id,
      title: 'Filha',
      sections: [],
    });
    const grandchild = await service.saveSpecification('ws-1', {
      parentId: child.id,
      title: 'Neta',
      sections: [],
    });

    expect(child.parentId).toBe(root.id);
    expect(grandchild.parentId).toBe(child.id);
    await expect(
      service.saveSpecification('ws-1', {
        id: root.id,
        parentId: root.id,
        title: root.title,
        sections: root.sections,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC_PARENT' });

    await expect(
      service.saveSpecification('ws-1', {
        parentId: 'missing',
        title: 'Órfã',
        sections: [],
      }),
    ).rejects.toMatchObject({ code: 'SPEC_PARENT_NOT_FOUND' });
    await expect(
      service.saveSpecification('ws-1', {
        id: root.id,
        parentId: grandchild.id,
        title: root.title,
        sections: root.sections,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC_PARENT' });

    const orphanParent = { ...root, id: 'orphan-parent', parentId: 'missing-ancestor' };
    await repo.saveSpecification(orphanParent);
    await expect(
      service.saveSpecification('ws-1', {
        id: child.id,
        parentId: orphanParent.id,
        title: child.title,
        sections: child.sections,
      }),
    ).resolves.toMatchObject({ parentId: orphanParent.id });

    await service.deleteSpecification('ws-1', root.id);
    await service.deleteSpecification('ws-1', orphanParent.id);
    expect(await service.listSpecifications('ws-1')).toEqual([]);
  });

  it('handles chat interaction with collaborator and throws if collaborator unavailable', async () => {
    const repo = new InMemorySpecRepository();
    const serviceWithoutCollab = new SpecService(repo);

    const created = await serviceWithoutCollab.saveSpecification('ws-1', {
      title: 'Spec para chat',
      sections: [
        { templateSectionId: 'security', title: 'Segurança', content: '' },
        { templateSectionId: 'scope', title: 'Escopo', content: 'Atual' },
      ],
    });

    await expect(serviceWithoutCollab.chat('ws-1', created.id, 'agent-1', 'Olá')).rejects.toThrow(
      'Colaborador de especificação indisponível.',
    );

    const mockCollaborator = {
      reply: vi.fn().mockResolvedValue({
        content: 'Sugiro adicionar uma seção de segurança.',
        title: 'Spec revisada',
        sections: [{ templateSectionId: 'security', content: 'Usar MFA.' }],
      }),
    };
    const serviceWithCollab = new SpecService(repo, mockCollaborator);

    const result = await serviceWithCollab.chat('ws-1', created.id, 'agent-1', 'Como melhorar?');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toBe('Como melhorar?');
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[1]!.content).toBe('Sugiro adicionar uma seção de segurança.');
    expect(result.title).toBe('Spec para chat');
    expect(result.proposal).toEqual({
      title: 'Spec revisada',
      sections: [{ templateSectionId: 'security', content: 'Usar MFA.' }],
    });
    expect(mockCollaborator.reply).toHaveBeenCalledTimes(1);

    mockCollaborator.reply.mockResolvedValueOnce({
      content: 'Nenhuma alteração necessária.',
      title: ' Spec para chat ',
      sections: [
        { templateSectionId: 'scope', content: ' Atual ' },
        { templateSectionId: 'unknown', content: 'Ignorar' },
        { templateSectionId: 'security', content: '   ' },
      ],
    });
    const unchanged = await serviceWithCollab.chat('ws-1', created.id, 'agent-1', 'Pode concluir?');
    expect(unchanged.proposal).toBeUndefined();
  });
});

describe('AgentSpecCollaborator', () => {
  it('calls agent service with formatted prompt and returns agent response', async () => {
    const mockAgentService = {
      executeAgent: vi.fn().mockResolvedValue({ result: 'Resposta do assistente para a spec' }),
    } as unknown as AgentService;

    const collaborator = new AgentSpecCollaborator(mockAgentService);

    const spec: Specification = {
      id: 'spec-1',
      workspaceId: 'ws-1',
      title: 'App Mobile',
      sections: [
        { templateSectionId: 's1', title: 'Escopo', content: 'MVP de compras' },
        { templateSectionId: 's2', title: 'Segurança', content: '' },
      ],
      messages: [],
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    };

    const reply = await collaborator.reply({
      workspaceId: 'ws-1',
      agentId: 'agent-spec-writer',
      conversation: [
        { id: 'm1', role: 'user', content: 'Quais os passos?', createdAt: '2026-09-15' },
      ],
      specification: spec,
    });

    expect(reply).toEqual({ content: 'Resposta do assistente para a spec' });
    expect(mockAgentService.executeAgent).toHaveBeenCalledWith(
      'ws-1',
      'agent-spec-writer',
      expect.objectContaining({
        prompt: expect.stringContaining('Escopo: MVP de compras'),
        includeKnowledge: true,
      }),
      expect.objectContaining({
        workspaceId: 'ws-1',
        ownerId: 'ws-1',
      }),
    );

    // Custom context
    const customContextCollab = new AgentSpecCollaborator(mockAgentService, (ws) => ({
      requestId: 'custom-req',
      ownerId: 'custom-owner',
      workspaceId: ws,
    }));
    await customContextCollab.reply({
      workspaceId: 'ws-2',
      agentId: 'agent-2',
      conversation: [],
      specification: spec,
      locale: 'en-US',
    });
    expect(mockAgentService.executeAgent).toHaveBeenCalledWith(
      'ws-2',
      'agent-2',
      expect.objectContaining({ prompt: expect.stringContaining('You are collaborating') }),
      expect.objectContaining({
        requestId: 'custom-req',
        ownerId: 'custom-owner',
        locale: 'en-US',
      }),
    );
  });

  it('extracts safe structured Spec updates from the Agent response', () => {
    const specification: Specification = {
      id: 'spec-1',
      workspaceId: 'ws-1',
      title: 'Rascunho',
      sections: [{ templateSectionId: 'scope', title: 'Escopo', content: '' }],
      messages: [],
      createdAt: '',
      updatedAt: '',
    };
    const reply = parseAgentReply(
      '# Análise\n\nTexto legível.\n```spec-update\n{"title":"Login","sections":[{"templateSectionId":"scope","content":"Login seguro"},{"templateSectionId":"unknown","content":"ignorar"},{},{"title":"Escopo","content":1},null]}\n```',
      specification,
    );

    expect(reply).toEqual({
      content: '# Análise\n\nTexto legível.',
      title: 'Login',
      sections: [{ templateSectionId: 'scope', content: 'Login seguro\n\nignorar' }],
    });
    expect(
      parseAgentReply(
        'Texto\n```spec-update\n{"sections":[{"title":"ESCOPO","content":"Novo escopo"},{"id":"scope","content":"Por id"},{"title":"Escopo","content":"   "}]}\n```',
        specification,
      ),
    ).toEqual({
      content: 'Texto',
      title: undefined,
      sections: [{ templateSectionId: 'scope', content: 'Novo escopo\n\nPor id' }],
    });
    expect(parseAgentReply('Visível\n```spec-update\ninválido\n```', specification)).toEqual({
      content: 'Visível',
    });
    expect(parseAgentReply('Visível\n```spec-update\nnull\n```', specification)).toEqual({
      content: 'Visível',
    });
    expect(parseAgentReply('Visível\n```spec-update\n{}\n```', specification)).toEqual({
      content: 'Visível',
      title: undefined,
      sections: undefined,
    });
  });
});

describe('PrismaSpecRepository', () => {
  it('maps and executes saveTemplate, listTemplates and findTemplate', async () => {
    const templateRecord = {
      id: 'tpl-1',
      workspaceId: 'ws-1',
      name: 'Template Prisma',
      sections: [{ id: 's1', title: 'Sec 1', required: true }],
      createdAt: new Date('2026-09-15T10:00:00.000Z'),
      updatedAt: new Date('2026-09-15T10:00:00.000Z'),
    };

    const client: PrismaSpecClient = {
      specTemplateRecord: {
        upsert: vi.fn().mockResolvedValue(templateRecord),
        findMany: vi.fn().mockResolvedValue([templateRecord]),
        findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
          return where.id === 'tpl-1' ? templateRecord : null;
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      specificationRecord: {
        upsert: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    const repo = new PrismaSpecRepository(client);

    const saved = await repo.saveTemplate({
      id: 'tpl-1',
      workspaceId: 'ws-1',
      name: 'Template Prisma',
      sections: [{ id: 's1', title: 'Sec 1', required: true }],
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
    expect(saved.id).toBe('tpl-1');
    expect(saved.createdAt).toBe('2026-09-15T10:00:00.000Z');

    const list = await repo.listTemplates('ws-1');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('tpl-1');

    const found = await repo.findTemplate('tpl-1', 'ws-1');
    expect(found?.id).toBe('tpl-1');

    const notFound = await repo.findTemplate('tpl-2', 'ws-1');
    expect(notFound).toBeNull();
    expect(await repo.deleteTemplate('tpl-1', 'ws-1')).toBe(true);
    expect(client.specTemplateRecord.deleteMany).toHaveBeenCalledWith({
      where: { id: 'tpl-1', workspaceId: 'ws-1' },
    });
  });

  it('maps and executes saveSpecification, listSpecifications and findSpecification', async () => {
    const specRecord = {
      id: 'spec-1',
      workspaceId: 'ws-1',
      templateId: null,
      agentId: null,
      title: 'Spec Prisma',
      sections: [{ templateSectionId: 's1', title: 'Sec 1', content: 'Conteúdo' }],
      messages: null,
      createdAt: new Date('2026-09-15T10:00:00.000Z'),
      updatedAt: new Date('2026-09-15T10:00:00.000Z'),
    };

    const client: PrismaSpecClient = {
      specTemplateRecord: {
        upsert: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        deleteMany: vi.fn(),
      },
      specificationRecord: {
        upsert: vi.fn().mockResolvedValue(specRecord),
        findMany: vi.fn().mockResolvedValue([specRecord]),
        findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
          return where.id === 'spec-1' ? specRecord : null;
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const repo = new PrismaSpecRepository(client);

    const saved = await repo.saveSpecification({
      id: 'spec-1',
      workspaceId: 'ws-1',
      title: 'Spec Prisma',
      sections: [{ templateSectionId: 's1', title: 'Sec 1', content: 'Conteúdo' }],
      messages: [],
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
    expect(saved.id).toBe('spec-1');
    expect(saved.templateId).toBeUndefined();
    expect(saved.agentId).toBeUndefined();
    expect(saved.messages).toEqual([]);

    const list = await repo.listSpecifications('ws-1');
    expect(list).toHaveLength(1);

    const found = await repo.findSpecification('spec-1', 'ws-1');
    expect(found?.id).toBe('spec-1');

    const notFound = await repo.findSpecification('spec-none', 'ws-1');
    expect(notFound).toBeNull();
    expect(await repo.deleteSpecification('spec-1', 'ws-1')).toBe(true);
    expect(client.specificationRecord.deleteMany).toHaveBeenCalledWith({
      where: { id: 'spec-1', workspaceId: 'ws-1' },
    });
  });
});

describe('Spec HTTP Routes', () => {
  function buildTestApp(customResolver?: Parameters<typeof createSpecRouter>[1]) {
    const app = express();
    app.use(express.json());

    // Mock auth middleware injects context
    const repo = new InMemorySpecRepository();
    const service = new SpecService(repo, {
      reply: vi.fn().mockResolvedValue({ content: 'Assistente respondeu com sucesso.' }),
    });

    const router = createSpecRouter(service, customResolver);
    app.use((req, _res, next) => {
      // Mock authenticated context
      req.context = {
        requestId: 'req-1',
        ownerId: 'owner-1',
        workspaceId: 'ws-1',
        memberRole: 'ADMIN',
      };
      next();
    });
    app.use(router);

    // Global error handler
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = err.statusCode || (err.status ? err.status : 500);
      res.status(status).json({ message: err.message });
    });

    return { app, service, repo };
  }

  it('handles contextResolver execution and error forwarding', async () => {
    const errorResolver = vi.fn().mockRejectedValue(new Error('Resolver error'));
    const { app } = buildTestApp(errorResolver);

    const res = await request(app).get('/spec/templates');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Resolver error');
  });

  it('handles template CRUD endpoints and validation', async () => {
    const validResolver = vi.fn().mockResolvedValue({
      requestId: 'test-req',
      ownerId: 'test-owner',
      workspaceId: 'ws-1',
      memberRole: 'ADMIN',
    });
    const { app } = buildTestApp(validResolver);

    // List empty
    const listRes = await request(app).get('/spec/templates');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual([]);

    // Invalid body on create
    const invalidCreate = await request(app).post('/spec/templates').send({ name: '' });
    expect(invalidCreate.status).toBe(400);

    // Valid create
    const createRes = await request(app)
      .post('/spec/templates')
      .send({
        name: 'Template Teste',
        sections: [{ id: 's1', title: 'Objetivos', required: true }],
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('Template Teste');
    const templateId = createRes.body.id;

    // Invalid update
    const invalidUpdate = await request(app)
      .put(`/spec/templates/${templateId}`)
      .send({ name: '' });
    expect(invalidUpdate.status).toBe(400);

    // Valid update
    const updateRes = await request(app)
      .put(`/spec/templates/${templateId}`)
      .send({
        name: 'Template Atualizado',
        sections: [{ id: 's1', title: 'Objetivos Alterados', required: false }],
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('Template Atualizado');

    expect((await request(app).delete(`/spec/templates/${templateId}`)).status).toBe(204);
    expect((await request(app).delete(`/spec/templates/${templateId}`)).status).toBe(404);
  });

  it('handles specification CRUD, chat, export and validation', async () => {
    const { app } = buildTestApp();

    // List empty
    const listRes = await request(app).get('/spec/specifications');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual([]);

    // Invalid create
    const invalidCreate = await request(app).post('/spec/specifications').send({ title: '' });
    expect(invalidCreate.status).toBe(400);

    // Valid create
    const createRes = await request(app)
      .post('/spec/specifications')
      .send({
        title: 'Spec Nova',
        sections: [
          { templateSectionId: 's1', title: 'Visão Geral', content: 'Detalhamento do produto' },
        ],
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.title).toBe('Spec Nova');
    const specId = createRes.body.id;

    // Invalid update
    const invalidUpdate = await request(app)
      .put(`/spec/specifications/${specId}`)
      .send({ title: '' });
    expect(invalidUpdate.status).toBe(400);

    // Valid update
    const updateRes = await request(app)
      .put(`/spec/specifications/${specId}`)
      .send({
        title: 'Spec Atualizada',
        sections: [
          { templateSectionId: 's1', title: 'Visão Geral', content: 'Conteúdo atualizado' },
        ],
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.title).toBe('Spec Atualizada');

    // Invalid chat
    const invalidChat = await request(app)
      .post(`/spec/specifications/${specId}/chat`)
      .send({ agentId: '', content: '' });
    expect(invalidChat.status).toBe(400);

    // Valid chat
    const chatRes = await request(app)
      .post(`/spec/specifications/${specId}/chat`)
      .send({ agentId: 'agent-1', content: 'Como posso melhorar?' });
    expect(chatRes.status).toBe(200);
    expect(chatRes.body.messages).toHaveLength(2);

    // Export markdown
    const exportRes = await request(app).get(`/spec/specifications/${specId}/export`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toContain('text/markdown');
    expect(exportRes.text).toContain('# Spec Atualizada');

    // Export non-existent
    const export404 = await request(app).get('/spec/specifications/not-found/export');
    expect(export404.status).toBe(404);

    expect((await request(app).delete(`/spec/specifications/${specId}`)).status).toBe(204);
    expect((await request(app).delete(`/spec/specifications/${specId}`)).status).toBe(404);
  });

  it('restricts template customization to workspace managers', async () => {
    const resolver = vi.fn().mockResolvedValue({
      requestId: 'member',
      actorId: 'user-1',
      ownerId: 'ws-1',
      workspaceId: 'ws-1',
      memberRole: 'MEMBER',
    });
    const { app } = buildTestApp(resolver);
    expect(
      (await request(app).post('/spec/templates').send({ name: 'X', sections: [] })).status,
    ).toBe(403);
    expect(
      (await request(app).put('/spec/templates/x').send({ name: 'X', sections: [] })).status,
    ).toBe(403);
    expect((await request(app).delete('/spec/templates/x')).status).toBe(403);
  });

  it('forwards service errors to next() in all spec route handlers', async () => {
    const errorService = {
      listTemplates: vi.fn().mockRejectedValue(new Error('listTemplates failed')),
      saveTemplate: vi.fn().mockRejectedValue(new Error('saveTemplate failed')),
      deleteTemplate: vi.fn().mockRejectedValue(new Error('deleteTemplate failed')),
      listSpecifications: vi.fn().mockRejectedValue(new Error('listSpecifications failed')),
      saveSpecification: vi.fn().mockRejectedValue(new Error('saveSpecification failed')),
      chat: vi.fn().mockRejectedValue(new Error('chat failed')),
      getSpecification: vi.fn().mockRejectedValue(new Error('getSpecification failed')),
      deleteSpecification: vi.fn().mockRejectedValue(new Error('deleteSpecification failed')),
    } as unknown as SpecService;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.context = {
        requestId: 'r1',
        ownerId: 'o1',
        workspaceId: 'ws-1',
        memberRole: 'ADMIN',
      };
      next();
    });
    app.use(createSpecRouter(errorService));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ message: err.message });
    });

    const res1 = await request(app).get('/spec/templates');
    expect(res1.status).toBe(500);

    const res2 = await request(app)
      .post('/spec/templates')
      .send({ name: 'T', sections: [{ id: 's1', title: 'S1', required: false }] });
    expect(res2.status).toBe(500);

    const res3 = await request(app)
      .put('/spec/templates/123')
      .send({ name: 'T', sections: [{ id: 's1', title: 'S1', required: false }] });
    expect(res3.status).toBe(500);

    const deleteTemplateRes = await request(app).delete('/spec/templates/123');
    expect(deleteTemplateRes.status).toBe(500);

    const res4 = await request(app).get('/spec/specifications');
    expect(res4.status).toBe(500);

    const res5 = await request(app)
      .post('/spec/specifications')
      .send({ title: 'S', sections: [{ templateSectionId: 's1', title: 'T', content: 'C' }] });
    expect(res5.status).toBe(500);

    const res6 = await request(app)
      .put('/spec/specifications/123')
      .send({ title: 'S', sections: [{ templateSectionId: 's1', title: 'T', content: 'C' }] });
    expect(res6.status).toBe(500);

    const res7 = await request(app)
      .post('/spec/specifications/123/chat')
      .send({ agentId: 'a1', content: 'hello' });
    expect(res7.status).toBe(500);

    const res8 = await request(app).get('/spec/specifications/123/export');
    expect(res8.status).toBe(500);

    const res9 = await request(app).delete('/spec/specifications/123');
    expect(res9.status).toBe(500);
  });
});
