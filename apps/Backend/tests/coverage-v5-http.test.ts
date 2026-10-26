import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgentsRouter } from '../src/adapters/http/agents-routes.js';
import { createApp, errorMiddleware } from '../src/adapters/http/app.js';
import { createAttachmentsRouter } from '../src/adapters/http/attachments-routes.js';
import { createAuditRouter } from '../src/adapters/http/audit-routes.js';
import { createAuthMiddleware } from '../src/adapters/http/auth-middleware.js';
import { createE2eRouter } from '../src/adapters/http/e2e-routes.js';
import { createReleaseNoteRouter } from '../src/adapters/http/release-note-routes.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { AuditPersistence, AuditQuery } from '../src/modules/audit/audit.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import type { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryRunStore } from '../src/modules/issues/run-store.js';
import type { ReleaseNoteService } from '../src/modules/release-notes/release-note-service.js';

describe('routers mounted without a context resolver', () => {
  const mounted = (router: express.Router) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorMiddleware);
    return app;
  };

  it('still require an authenticated user', async () => {
    await request(mounted(createAgentsRouter({} as AgentService)))
      .get('/agents')
      .expect(401);
    await request(mounted(createE2eRouter({} as E2eService)))
      .get('/e2e/creations')
      .expect(401);
    await request(mounted(createReleaseNoteRouter({} as ReleaseNoteService)))
      .get('/release-notes')
      .expect(401);
    await request(mounted(createAttachmentsRouter(new InMemoryE2eArtifactStore())))
      .get('/attachments/proxy?url=https%3A%2F%2Fexample.com%2Fa.png')
      .expect(401);
  });
});

describe('createApp startup', () => {
  it('uses the given e2e dispatcher and logs failed recoveries', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runStore = new InMemoryRunStore();
    vi.spyOn(runStore, 'incomplete').mockRejectedValue(new Error('runs down'));
    const e2eStore = new InMemoryE2eStore();
    vi.spyOn(e2eStore, 'incompleteCreations').mockRejectedValue(new Error('e2e down'));
    const wake = vi.fn(async () => undefined);
    createApp({ runStore, e2eStore, e2eDispatcher: { wake } });
    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith('[RunService] Recovery failed:', expect.any(Error));
      expect(errors).toHaveBeenCalledWith('[E2eService] Recovery failed:', expect.any(Error));
    });
    errors.mockRestore();
  });
});

describe('test case history', () => {
  it('reads the plan history in batches until every event is loaded', async () => {
    const queries: AuditQuery[] = [];
    const persistence: AuditPersistence = {
      run: () => Promise.reject(new Error('not used')),
      list: (query) => {
        queries.push(query);
        return Promise.resolve({ items: [], total: 750 });
      },
    };
    const app = express();
    app.use(createAuditRouter(persistence, async () => ({ requestId: 'r', ownerId: 'ws' })));
    app.use(errorMiddleware);
    const response = await request(app)
      .get('/audit/history?entityType=testcase&entityId=plan:case')
      .expect(200);
    expect(response.body).toMatchObject({ items: [], total: 0 });
    expect(queries.map((query) => query.offset)).toEqual([0, 500]);
  });
});

describe('auth middleware', () => {
  it('leaves the request anonymous when the token matches no user', async () => {
    const authService = { authenticateToken: vi.fn(async () => null) };
    const middleware = createAuthMiddleware(authService as unknown as AuthService);
    const req = { header: () => 'Bearer unknown-token' } as unknown as Request;
    const next = vi.fn();
    await middleware(req, {} as Response, next);
    expect(authService.authenticateToken).toHaveBeenCalledWith('unknown-token');
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });
});
