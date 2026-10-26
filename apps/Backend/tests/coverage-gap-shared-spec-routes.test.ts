import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createSpecRouter } from '../src/adapters/http/spec-routes.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { SpecService } from '../src/modules/spec/application/spec-service.js';

const attachment = {
  id: 'provider:1',
  name: 'log.txt',
  kind: 'document',
  scope: 'spec',
  source: 'url',
  url: 'https://cdn.test/log.txt',
};
const body = {
  title: 'Checkout',
  sections: [{ templateSectionId: 's1', title: 'Goal', content: 'Pay' }],
  attachments: [attachment],
};

function build(store?: InMemoryE2eArtifactStore) {
  const service = {
    saveSpecification: vi.fn(async (_workspace: string, spec: unknown) => spec),
  };
  const app = express();
  app.use(express.json());
  app.use(
    createSpecRouter(
      service as unknown as SpecService,
      async () => ({ requestId: 'r', ownerId: 'ws-1', workspaceId: 'ws-1' }),
      store,
    ),
  );
  app.use(errorMiddleware);
  return { app, service };
}

describe('spec attachments', () => {
  it('validates attachments sent with a specification', async () => {
    const { app, service } = build(new InMemoryE2eArtifactStore());
    const created = await request(app).post('/spec/specifications').send(body);
    expect(created.status).toBe(201);
    expect(created.body.attachments).toEqual([attachment]);
    const updated = await request(app).put('/spec/specifications/spec-1').send(body);
    expect(updated.status).toBe(200);
    expect(service.saveSpecification).toHaveBeenLastCalledWith('ws-1', {
      ...body,
      id: 'spec-1',
    });
  });

  it('refuses attachments when no file storage is configured', async () => {
    const { app, service } = build();
    const response = await request(app).post('/spec/specifications').send(body);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('ATTACHMENTS_UNAVAILABLE');
    expect(service.saveSpecification).not.toHaveBeenCalled();
  });
});
