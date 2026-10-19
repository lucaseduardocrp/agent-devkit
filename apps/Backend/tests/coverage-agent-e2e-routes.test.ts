import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { createE2eRunnerRouter } from '../src/adapters/http/e2e-runner-routes.js';
import type { E2eLocalRunnerService } from '../src/modules/e2e/application/local-runner-service.js';
import type { ApplicationError } from '../src/shared/errors.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const { probeTunnel } = vi.hoisted(() => ({ probeTunnel: vi.fn() }));
vi.mock('../src/modules/e2e/application/tunnel-probe.js', () => ({ probeTunnel }));


const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };
const ok = { reachable: true, reason: 'ok', status: 200 };

function setup() {
  return createApp({
    e2eRunner: {
      explore: vi.fn().mockResolvedValue({ startUrl: 'x', pages: [] }),
      run: vi.fn(),
    },
    e2eAuthor: { plan: vi.fn(), writeScript: vi.fn(), analyze: vi.fn() },
    e2eArtifacts: new InMemoryE2eArtifactStore(),
    e2eScripts: new FakeScriptRepository(),
    requestContextResolver: () => ({
      requestId: 'e2e-tunnel-test',
      ownerId: 'ws',
      workspaceId: 'ws',
      actorId: 'user',
      memberRole: 'ADMIN',
      locale: 'en-US',
    }),
  });
}

async function createProtectedRun(app: ReturnType<typeof setup>) {
  const agent = await request(app)
    .post('/agents')
    .send({ name: 'QA', instructions: 'Test things.' })
    .expect(201);
  const created = await request(app)
    .post('/e2e/creations')
    .send({
      name: 'Protected app',
      agentId: agent.body.agent.id,
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'https://app.example.com',
      prd: 'Protected application',
      repository,
      planning: 'host',
      accessClientId: 'saved-id',
      accessClientSecret: 'saved-secret',
    })
    .expect(202);
  return created.body.creation.id as string;
}

beforeEach(() => {
  probeTunnel.mockReset().mockResolvedValue(ok);
});

describe('E2E tunnel check route', () => {
  it('probes with the token saved on the run for its own origin', async () => {
    const app = setup();
    const creationId = await createProtectedRun(app);
    const response = await request(app)
      .post('/e2e/tunnel/check')
      .send({ url: 'https://app.example.com/login', creationId })
      .expect(200);
    expect(response.body).toEqual({ result: ok });
    expect(probeTunnel).toHaveBeenLastCalledWith(
      'https://app.example.com/login',
      undefined,
      undefined,
      { clientId: 'saved-id', clientSecret: 'saved-secret' },
    );

    await request(app)
      .post('/e2e/tunnel/check')
      .send({ url: 'https://other.example.com', creationId })
      .expect(200);
    expect(probeTunnel).toHaveBeenLastCalledWith(
      'https://other.example.com',
      undefined,
      undefined,
      { clientId: undefined, clientSecret: undefined },
    );
  });

  it('prefers the typed fields over the saved token', async () => {
    const app = setup();
    const creationId = await createProtectedRun(app);
    await request(app)
      .post('/e2e/tunnel/check')
      .send({
        url: 'https://app.example.com',
        creationId,
        accessClientId: 'typed-id',
        accessClientSecret: 'typed-secret',
      })
      .expect(200);
    expect(probeTunnel).toHaveBeenLastCalledWith('https://app.example.com', undefined, undefined, {
      clientId: 'typed-id',
      clientSecret: 'typed-secret',
    });

    // A single typed field is forwarded as is, so the probe can reject the incomplete pair.
    await request(app)
      .post('/e2e/tunnel/check')
      .send({ url: 'https://app.example.com', creationId, accessClientSecret: 'typed-secret' })
      .expect(200);
    expect(probeTunnel).toHaveBeenLastCalledWith('https://app.example.com', undefined, undefined, {
      clientId: undefined,
      clientSecret: 'typed-secret',
    });
  });

  it('fails when the run does not exist and probes anonymously without one', async () => {
    const app = setup();
    await request(app)
      .post('/e2e/tunnel/check')
      .send({ url: 'https://app.example.com', creationId: 'missing' })
      .expect(404);
    expect(probeTunnel).not.toHaveBeenCalled();
    await request(app)
      .post('/e2e/tunnel/check')
      .send({ url: 'https://app.example.com' })
      .expect(200);
    expect(probeTunnel).toHaveBeenCalledWith('https://app.example.com', undefined, undefined, {
      clientId: undefined,
      clientSecret: undefined,
    });
  });
});

describe('E2E runner router mounted on its own', () => {
  function standalone(context?: Record<string, unknown>) {
    const service = { runners: vi.fn().mockResolvedValue([]) };
    const app = express();
    app.use((request, _response, next) => {
      if (context) request.context = context as never;
      next();
    });
    app.use(createE2eRunnerRouter(service as unknown as E2eLocalRunnerService));
    app.use(
      (error: ApplicationError, _request: Request, response: Response, _next: NextFunction) => {
        response.status(error.statusCode).json({ code: error.code });
      },
    );
    return { app, service };
  }

  it('reaches the service only with a workspace membership context', async () => {
    const anonymous = standalone();
    await request(anonymous.app).get('/e2e/runners').expect(401);
    const outsider = standalone({ requestId: 'r', ownerId: 'ws', workspaceId: 'ws' });
    expect((await request(outsider.app).get('/e2e/runners').expect(403)).body).toEqual({
      code: 'FORBIDDEN',
    });
    expect(anonymous.service.runners).not.toHaveBeenCalled();
    expect(outsider.service.runners).not.toHaveBeenCalled();

    const member = { requestId: 'r', ownerId: 'ws', workspaceId: 'ws', memberRole: 'ADMIN' };
    const allowed = standalone(member);
    expect((await request(allowed.app).get('/e2e/runners').expect(200)).body).toEqual({
      runners: [],
    });
    expect(allowed.service.runners).toHaveBeenCalledWith(member);
  });
});
