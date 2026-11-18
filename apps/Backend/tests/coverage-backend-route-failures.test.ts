import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createDesignRouter } from '../src/adapters/http/design-routes.js';
import { createMessagingRouter } from '../src/adapters/http/messaging-routes.js';
import { createSpecRouter } from '../src/adapters/http/spec-routes.js';
import { createWorkItemTypesRouter } from '../src/adapters/http/work-item-types-routes.js';
import { registerHubAgentRoutes } from '../src/adapters/http/hub-agents-routes.js';
import type { DesignService } from '../src/modules/design/application/design-service.js';
import type { HubAgentService } from '../src/modules/hub/application/hub-agent-service.js';
import type { MessagingChatStore } from '../src/modules/messaging/application/messaging-chat-store.js';
import type { SpecService } from '../src/modules/spec/application/spec-service.js';
import type { TelegramGateway } from '../src/modules/messaging/telegram/telegram-gateway.js';
import type { TelegramPairingCodes } from '../src/modules/messaging/telegram/telegram-pairing.js';
import type { WorkItemTypeStore } from '../src/modules/work-item-types/work-item-types.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { RequestContext } from '../src/shared/context.js';

const context: RequestContext = {
  requestId: 'r',
  ownerId: 'ws',
  workspaceId: 'ws',
  actorId: 'user-a',
  memberRole: 'ADMIN',
};

const boom = () => Promise.reject(new ApplicationError('BOOM', 'Service failed.', 409));

function mount(setup: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  setup(app);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApplicationError)
      res.status(error.statusCode).json({ code: error.code, message: error.message });
    else res.status(500).json({ code: 'INTERNAL', message: String(error) });
  });
  return app;
}

describe('hub agent routes', () => {
  it('forwards a failing catalog to the error handler', async () => {
    const app = mount((server) => {
      const router = express.Router();
      registerHubAgentRoutes(
        router,
        { catalog: vi.fn(boom) } as unknown as HubAgentService,
        () => 'ws',
      );
      server.use((req, _res, next) => ((req.context = context), next()), router);
    });
    expect((await request(app).get('/agents/hub').expect(409)).body.code).toBe('BOOM');
  });
});

describe('work item type routes', () => {
  const build = (store: Partial<Record<keyof WorkItemTypeStore, unknown>>) =>
    mount((app) =>
      app.use(createWorkItemTypesRouter(store as unknown as WorkItemTypeStore, () => context)),
    );

  it('forwards a failing context resolver', async () => {
    const app = mount((server) =>
      server.use(
        createWorkItemTypesRouter({} as WorkItemTypeStore, () => {
          throw new ApplicationError('UNAUTHORIZED', 'No session.', 401);
        }),
      ),
    );
    await request(app).get('/work-item-types').expect(401);
  });

  it('forwards store failures when reading and saving', async () => {
    const app = build({ get: vi.fn(boom), save: vi.fn(boom) });
    expect((await request(app).get('/work-item-types').expect(409)).body.code).toBe('BOOM');
    const saved = await request(app)
      .put('/work-item-types')
      .send({ types: [{ key: 'epic', label: 'Epic', color: '#112233', icon: 'flag' }] });
    expect(saved.status).toBe(409);
  });
});

describe('design routes failures', () => {
  it('forwards failures of providers, settings and branches', async () => {
    const service = {
      providers: vi.fn(boom),
      getSettings: vi.fn(boom),
      listRepositories: vi.fn(boom),
      saveSettings: vi.fn(boom),
      listBranches: vi.fn(boom),
    } as unknown as DesignService;
    const app = mount((server) => server.use(createDesignRouter(service, () => context)));
    expect((await request(app).get('/design/providers').expect(409)).body.code).toBe('BOOM');
    await request(app).get('/design/settings').expect(409);
    await request(app).get('/design/repositories').expect(409);
    const settings = await request(app)
      .put('/design/settings')
      .send({ provider: 'github', repositoryId: '1', repositoryName: 'acme/ui', branch: 'main' });
    expect(settings.status).toBe(409);
    await request(app).put('/design/settings').send({}).expect(400);
    await request(app).get('/design/repositories/branches').expect(500);
    await request(app)
      .get('/design/repositories/branches?provider=github&repositoryId=1')
      .expect(409);
  });
});

describe('spec routes attachments', () => {
  const link = {
    id: 'https://files.example.test/a.pdf',
    name: 'a.pdf',
    scope: 'spec',
    source: 'url',
    url: 'https://files.example.test/a.pdf',
  };
  const specification = { title: 'Spec', sections: [], attachments: [link] };

  it('answers 503 for attachments when no file storage is configured', async () => {
    const service = { saveSpecification: vi.fn() } as unknown as SpecService;
    const app = mount((server) => server.use(createSpecRouter(service, () => context)));
    const response = await request(app)
      .post('/spec/specifications')
      .send(specification)
      .expect(503);
    expect(response.body.code).toBe('ATTACHMENTS_UNAVAILABLE');
    await request(app).put('/spec/specifications/spec-1').send(specification).expect(503);
    expect(service.saveSpecification).not.toHaveBeenCalled();
  });
});

describe('spec routes attachments with file storage', () => {
  it('validates attachments against the store and saves them', async () => {
    const saveSpecification = vi.fn(async (_ws: string, saved: unknown) => saved);
    const app = mount((server) =>
      server.use(
        createSpecRouter(
          { saveSpecification } as unknown as SpecService,
          () => context,
          new InMemoryE2eArtifactStore(),
        ),
      ),
    );
    const link = {
      id: 'https://files.example.test/a.pdf',
      name: 'a.pdf',
      scope: 'spec',
      source: 'url',
      url: 'https://files.example.test/a.pdf',
    };
    const saved = await request(app)
      .post('/spec/specifications')
      .send({ title: 'Spec', sections: [], attachments: [link] })
      .expect(201);
    expect(saved.body.attachments).toEqual([link]);
  });
});

describe('messaging routes', () => {
  function build(options: {
    context?: RequestContext;
    chats?: Partial<Record<keyof MessagingChatStore, unknown>>;
    status?: Record<string, unknown>;
  }) {
    const gateway = {
      status: vi.fn(() => options.status ?? { running: true, botUsername: 'adk_bot' }),
    } as unknown as TelegramGateway;
    const pairing = {
      create: vi.fn(async () => ({ code: 'ABC', expiresAt: new Date(0) })),
    } as unknown as TelegramPairingCodes;
    return mount((server) =>
      server.use(
        createMessagingRouter(
          {
            gateway,
            chats: (options.chats ?? {}) as unknown as MessagingChatStore,
            pairing,
            workspaceName: async () => 'Workspace',
          },
          () => options.context ?? context,
        ) as Router,
      ),
    );
  }

  it('forwards a failing chat listing', async () => {
    const app = build({ chats: { list: vi.fn(boom) } });
    expect(
      (await request(app).get('/integrations/MESSAGING/telegram/chats').expect(409)).body.code,
    ).toBe('BOOM');
  });

  it('needs a signed-in user to create a pairing code', async () => {
    const app = build({ context: { ...context, actorId: undefined } });
    const response = await request(app)
      .post('/integrations/MESSAGING/telegram/pairing-code')
      .expect(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('answers 404 when the chat to update is not paired', async () => {
    const app = build({ chats: { update: vi.fn(async () => null) } });
    const response = await request(app)
      .patch('/integrations/MESSAGING/telegram/chats/chat-1')
      .send({ notifications: false })
      .expect(404);
    expect(response.body.code).toBe('MESSAGING_CHAT_NOT_FOUND');
  });
});
