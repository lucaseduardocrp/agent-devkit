import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createWorkspacesRouter } from '../src/adapters/http/workspaces-routes.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { distributeProposalSections } from '../src/modules/spec/application/proposal-sections.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { PrismaWorkspaceRepository } from '../src/modules/workspaces/adapters/prisma-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import { ApplicationError } from '../src/shared/errors.js';
import { resolveLocale } from '../src/shared/i18n.js';

describe('WorkspaceService defaults', () => {
  function setup() {
    const repository = new InMemoryWorkspaceRepository();
    const service = new WorkspaceService(repository, new InMemoryAuthRepository());
    return { repository, service };
  }

  it('deletes a workspace directly when no audited delete is provided', async () => {
    const { repository, service } = setup();
    const { workspace } = await service.createWorkspace('admin-1', 'Disposable');
    await service.deleteWorkspace(workspace.id, 'admin-1');
    await expect(repository.findById(workspace.id)).resolves.toBeNull();
  });

  it('creates groups without members and updates only the provided fields', async () => {
    const { service } = setup();
    const { workspace } = await service.createWorkspace('admin-1', 'Groups');
    const group = await service.createGroup(workspace.id, 'admin-1', {
      name: 'Readers',
      modules: { brain: 'view' },
    });
    expect(group).toMatchObject({ name: 'Readers', description: '', memberIds: [] });

    const updated = await service.updateGroup(workspace.id, 'admin-1', group.id, {});
    expect(updated).toMatchObject({
      name: 'Readers',
      description: '',
      modules: group.modules,
      memberIds: [],
    });
    await expect(
      service.updateGroup(workspace.id, 'admin-1', group.id, { description: '  Read only  ' }),
    ).resolves.toMatchObject({ name: 'Readers', description: 'Read only' });
  });
});

describe('workspaces router context failures', () => {
  it('forwards context resolver errors to the error handler', async () => {
    const service = new WorkspaceService(
      new InMemoryWorkspaceRepository(),
      new InMemoryAuthRepository(),
    );
    const app = express();
    app.use(express.json());
    app.use(
      createWorkspacesRouter(service, async () => {
        throw new ApplicationError('UNAUTHORIZED', 'Invalid token.', 401);
      }),
    );
    app.use(errorMiddleware);
    const response = await request(app).get('/workspaces');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });
});

describe('PrismaWorkspaceRepository.findBySlug', () => {
  it('returns null when no workspace uses the slug', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repository = new PrismaWorkspaceRepository({
      workspaceRecord: { findUnique },
    } as unknown as ConstructorParameters<typeof PrismaWorkspaceRepository>[0]);
    await expect(repository.findBySlug('missing')).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledWith({ where: { slug: 'missing' } });
  });
});

describe('resolveLocale quality values', () => {
  it('skips languages explicitly refused with q=0', () => {
    expect(resolveLocale('en;q=0')).toBe('pt-BR');
    expect(resolveLocale('pt;q=0, en;q=0.5')).toBe('en-US');
  });
});

describe('proposal sections from JSON envelopes', () => {
  const sections = [
    { templateSectionId: 'actors', title: 'Atores', content: '' },
    { templateSectionId: 'extra', title: 'Notas', content: '' },
  ];

  it('unwraps a JSON object with a single content field', () => {
    expect(
      distributeProposalSections(
        [
          {
            templateSectionId: 'actors',
            content: JSON.stringify({ content: 'Users\\nAdmins' }, null, 2),
          },
        ],
        sections,
      ),
    ).toEqual([{ templateSectionId: 'actors', content: 'Users\nAdmins' }]);
  });

  it('keeps JSON without sections or content, and malformed JSON, as Markdown', () => {
    expect(
      distributeProposalSections(
        [
          { templateSectionId: 'actors', content: '{"other": 1}' },
          { templateSectionId: 'actors', content: '[1, 2]' },
          { templateSectionId: 'extra', content: '{not json' },
        ],
        sections,
      ),
    ).toEqual([
      { templateSectionId: 'actors', content: '{"other": 1}\n\n[1, 2]' },
      { templateSectionId: 'extra', content: '{not json' },
    ]);
  });
});
