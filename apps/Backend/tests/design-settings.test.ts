import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createDesignRouter } from '../src/adapters/http/design-routes.js';
import { errorMiddleware } from '../src/adapters/http/app.js';
import {
  DesignService,
  type DesignRemoteStore,
  type DesignRepositoryBrowser,
} from '../src/modules/design/application/design-service.js';
import { InMemoryDesignSettingsStore } from '../src/modules/design/application/design-settings-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';

const context = () => ({
  requestId: 'r',
  ownerId: 'ws-1',
  workspaceId: 'ws-1',
  actorId: 'u1',
  memberRole: 'ADMIN' as const,
});

const browser = (): DesignRepositoryBrowser => ({
  listRepositories: vi.fn().mockResolvedValue({
    repositories: [
      { id: '42', provider: 'github', name: 'acme/prototypes', defaultBranch: 'main' },
      { id: 'guid-1', provider: 'azure_devops', name: 'Blue/Opex', defaultBranch: 'develop' },
      // A provider Design cannot use is left out of the listing.
      { id: 'x', provider: 'gitlab', name: 'acme/x', defaultBranch: 'main' },
    ],
    warnings: [
      { provider: 'github', code: 'CREDENTIALS_MISSING' },
      { provider: 'gitlab', code: 'NOT_CONFIGURED' },
    ],
  }),
  listBranches: vi.fn().mockResolvedValue([
    { name: 'main', isDefault: true },
    { name: 'develop', isDefault: false },
  ]),
});

function setup(repositories: DesignRepositoryBrowser | null = browser()) {
  const settings = new InMemoryDesignSettingsStore();
  const store = {
    configuredProviders: vi.fn().mockResolvedValue([]),
  } as unknown as DesignRemoteStore;
  const app = express();
  app.use(express.json());
  app.use(
    createDesignRouter(
      new DesignService(store, {} as AgentService, settings, repositories ?? undefined),
      context,
    ),
  );
  app.use(errorMiddleware);
  return { app, settings };
}

describe('design settings', () => {
  it('lists the usable repositories of every connected provider', async () => {
    const { app } = setup();
    const response = await request(app).get('/design/repositories').expect(200);
    expect(response.body.repositories).toEqual([
      { id: '42', provider: 'github', name: 'acme/prototypes', defaultBranch: 'main' },
      { id: 'guid-1', provider: 'azure', name: 'Blue/Opex', defaultBranch: 'develop' },
    ]);
    expect(response.body.warnings).toEqual([{ provider: 'github', code: 'CREDENTIALS_MISSING' }]);
  });

  it('lists the branches of the chosen repository', async () => {
    const { app } = setup();
    const response = await request(app)
      .get('/design/repositories/branches?provider=azure&repositoryId=guid-1')
      .expect(200);
    expect(response.body.branches).toEqual([
      { name: 'main', isDefault: true },
      { name: 'develop', isDefault: false },
    ]);
  });

  it('saves the chosen repository and branch, and reads them back', async () => {
    const { app } = setup();
    expect((await request(app).get('/design/settings').expect(200)).body.settings).toBeNull();

    const saved = await request(app)
      .put('/design/settings')
      .send({ provider: 'azure', repositoryId: 'guid-1', branch: 'develop' })
      .expect(200);
    expect(saved.body.settings).toEqual({
      provider: 'azure',
      repositoryId: 'guid-1',
      repositoryName: 'Blue/Opex',
      branch: 'develop',
    });
    expect((await request(app).get('/design/settings').expect(200)).body.settings).toMatchObject({
      branch: 'develop',
    });
  });

  it('falls back to the default branch when none is given', async () => {
    const { app } = setup();
    const saved = await request(app)
      .put('/design/settings')
      .send({ provider: 'github', repositoryId: '42', branch: '' })
      .expect(200);
    expect(saved.body.settings.branch).toBe('main');
  });

  it('clears the settings so the workspace can connect another repository', async () => {
    const { app, settings } = setup();
    await request(app)
      .put('/design/settings')
      .send({ provider: 'github', repositoryId: '42', branch: 'main' })
      .expect(200);
    expect(await settings.get('ws-1')).not.toBeNull();
    await request(app).delete('/design/settings').expect(204);
    expect(await settings.get('ws-1')).toBeNull();
    expect((await request(app).get('/design/settings')).body.settings).toBeNull();
  });

  it('refuses to clear settings when the ADK has no settings store configured', async () => {
    const store = { configuredProviders: vi.fn().mockResolvedValue([]) } as unknown as DesignRemoteStore;
    const app = express();
    app.use(express.json());
    app.use(
      createDesignRouter(new DesignService(store, {} as AgentService, undefined, browser()), context),
    );
    app.use(errorMiddleware);
    const response = await request(app).delete('/design/settings');
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).toContain('DESIGN_SETTINGS_UNAVAILABLE');
  });

  it('rejects a repository or branch the workspace cannot reach', async () => {
    const { app } = setup();
    const missingRepository = await request(app)
      .put('/design/settings')
      .send({ provider: 'github', repositoryId: 'nope', branch: 'main' });
    expect(missingRepository.status).toBe(404);
    expect(JSON.stringify(missingRepository.body)).toContain('DESIGN_REPOSITORY_NOT_FOUND');

    const missingBranch = await request(app)
      .put('/design/settings')
      .send({ provider: 'github', repositoryId: '42', branch: 'ghost' });
    expect(missingBranch.status).toBe(404);
    expect(JSON.stringify(missingBranch.body)).toContain('DESIGN_BRANCH_NOT_FOUND');
  });

  it('answers with an empty listing when no repository browser is available', async () => {
    const { app } = setup(null);
    const response = await request(app).get('/design/repositories').expect(200);
    expect(response.body).toEqual({ repositories: [], warnings: [] });
    expect(
      (await request(app).get('/design/repositories/branches?provider=github&repositoryId=42')).body
        .branches,
    ).toEqual([]);
  });

  it('refuses to read or write settings when the ADK has no settings store configured', async () => {
    const store = { configuredProviders: vi.fn().mockResolvedValue([]) } as unknown as DesignRemoteStore;
    const app = express();
    app.use(express.json());
    app.use(
      createDesignRouter(new DesignService(store, {} as AgentService, undefined, browser()), context),
    );
    app.use(errorMiddleware);

    const read = await request(app).get('/design/settings');
    expect(read.status).toBe(503);
    expect(JSON.stringify(read.body)).toContain('DESIGN_SETTINGS_UNAVAILABLE');

    const write = await request(app)
      .put('/design/settings')
      .send({ provider: 'github', repositoryId: '42', branch: 'main' });
    expect(write.status).toBe(503);
    expect(JSON.stringify(write.body)).toContain('DESIGN_SETTINGS_UNAVAILABLE');
  });

  it('forwards a repository listing failure as an error response', async () => {
    const failing: DesignRepositoryBrowser = {
      listRepositories: vi.fn().mockRejectedValue(new Error('provider unreachable')),
      listBranches: vi.fn(),
    };
    const { app } = setup(failing);
    const response = await request(app).get('/design/repositories');
    expect(response.status).toBe(500);
  });

  it('forwards a branch listing failure as an error response', async () => {
    const failing: DesignRepositoryBrowser = {
      listRepositories: vi.fn(),
      listBranches: vi.fn().mockRejectedValue(new Error('provider unreachable')),
    };
    const { app } = setup(failing);
    const response = await request(app).get(
      '/design/repositories/branches?provider=github&repositoryId=42',
    );
    expect(response.status).toBe(500);
  });
});
