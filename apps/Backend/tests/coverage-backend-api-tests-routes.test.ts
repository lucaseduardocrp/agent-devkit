import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApiTestsRouter } from '../src/adapters/http/api-tests-routes.js';
import type { ApiTestService } from '../src/modules/apitests/application/api-test-service.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { RequestContext } from '../src/shared/context.js';

const admin: RequestContext = {
  requestId: 'r',
  ownerId: 'ws',
  workspaceId: 'ws',
  actorId: 'user-a',
  memberRole: 'ADMIN',
};

function build(context: RequestContext, service: Partial<Record<keyof ApiTestService, unknown>>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => ((req.context = context), next()));
  app.use(createApiTestsRouter(service as unknown as ApiTestService));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApplicationError)
      res.status(error.statusCode).json({ code: error.code, message: error.message });
    else res.status(500).json({ code: 'INTERNAL', message: String(error) });
  });
  return app;
}

describe('API tests routes (context checks)', () => {
  it('needs a signed-in member to load the workspace and actor of a request', async () => {
    const service = { claimLocal: vi.fn() };
    const noActor = build({ ...admin, actorId: undefined }, service);
    const response = await request(noActor)
      .post('/api-tests/runner/claim')
      .send({ runner: { id: 'runner-01', name: 'Laptop', platform: 'win32', version: '1.0.0' } })
      .expect(400);
    expect(response.body.code).toBe('WORKSPACE_REQUIRED');
    expect(service.claimLocal).not.toHaveBeenCalled();

    const noWorkspace = build({ ...admin, workspaceId: undefined }, service);
    await request(noWorkspace)
      .post('/api-tests/runner/claim')
      .send({ runner: { id: 'runner-01', name: 'Laptop', platform: 'win32', version: '1.0.0' } })
      .expect(400);
  });

  it('keeps the devkit runner for workspace members', async () => {
    const app = build({ ...admin, memberRole: undefined }, {});
    const response = await request(app)
      .post('/api-tests/runner/claim')
      .send({ runner: { id: 'runner-01', name: 'Laptop', platform: 'win32', version: '1.0.0' } })
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('answers a null scenario when a generation produced none', async () => {
    const generate = vi.fn().mockResolvedValue({ sources: [] });
    const app = build(admin, { generate });
    const response = await request(app)
      .post('/load-tests/generate')
      .send({ collectionId: 'collection-1' })
      .expect(201);
    expect(response.body).toEqual({ scenario: null, sources: [] });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
