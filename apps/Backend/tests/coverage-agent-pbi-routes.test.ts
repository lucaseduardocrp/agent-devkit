import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPbiRouter } from '../src/adapters/http/pbi-routes.js';
import type { PbiService } from '../src/modules/pbi/pbi-service.js';
import type { IssueStore } from '../src/modules/issues/issue-store.js';
import type { RunService } from '../src/modules/issues/run-service.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { RequestContext } from '../src/shared/context.js';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const fields = [{ id: 'cf_1', name: 'Points', type: 'number' }];

function build(service: Partial<Record<keyof PbiService, unknown>>) {
  const app = express();
  app.use(express.json());
  const context: RequestContext = {
    requestId: 'r',
    ownerId: 'ws',
    workspaceId: 'ws',
    actorId: 'user-a',
    memberRole: 'ADMIN',
  };
  app.use(
    createPbiRouter(
      service as unknown as PbiService,
      {} as IssueStore,
      {} as RunService,
      () => context,
    ),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApplicationError)
      res.status(error.statusCode).json({ code: error.code, message: error.message });
    else res.status(500).json({ code: 'INTERNAL', message: String(error) });
  });
  return app;
}
const rejectWith = (code: string, status: number) =>
  vi.fn(() => Promise.reject(new ApplicationError(code, `${code} failed.`, status)));

describe('PBI field catalog route', () => {
  it('returns the provider fields for the requested scope and type', async () => {
    const fieldCatalog = vi.fn(() => Promise.resolve(fields));
    const app = build({ fieldCatalog });
    const response = await request(app)
      .get('/pbi/field-catalog')
      .query({ providerId: 'jira', scope: 'KEY', itemType: 'Story' })
      .expect(200);
    expect(response.body).toEqual({ fields });
    expect(fieldCatalog).toHaveBeenCalledWith('ws', 'jira', 'KEY', 'Story');
  });

  it('validates the provider and forwards service errors', async () => {
    const fieldCatalog = rejectWith('FIELD_MAPPING_UNSUPPORTED', 400);
    const app = build({ fieldCatalog });
    expect(
      (await request(app).get('/pbi/field-catalog').query({ providerId: 'monday' }).expect(400))
        .body.code,
    ).toBe('VALIDATION_ERROR');
    expect(fieldCatalog).not.toHaveBeenCalled();
    expect(
      (await request(app).get('/pbi/field-catalog').query({ providerId: 'trello' }).expect(400))
        .body.code,
    ).toBe('FIELD_MAPPING_UNSUPPORTED');
    expect(fieldCatalog).toHaveBeenCalledWith('ws', 'trello', undefined, undefined);
  });
});

describe('PBI field preview route', () => {
  it('previews mapped values with default scope and item type', async () => {
    const previewFields = vi.fn(() =>
      Promise.resolve({ definitions: fields, values: { cf_1: 3 } }),
    );
    const app = build({ previewFields });
    const response = await request(app)
      .post(`/pbi/items/${ITEM_ID}/field-preview`)
      .send({ providerId: 'azure_devops', templateId: TEMPLATE_ID })
      .expect(200);
    expect(response.body).toEqual({ definitions: fields, values: { cf_1: 3 } });
    expect(previewFields).toHaveBeenCalledWith('ws', ITEM_ID, 'azure_devops', TEMPLATE_ID, '', '');
  });

  it('passes the chosen destination and forwards validation and service errors', async () => {
    const previewFields = rejectWith('FIELD_MAPPING_INVALID', 400);
    const app = build({ previewFields });
    expect(
      (
        await request(app)
          .post(`/pbi/items/${ITEM_ID}/field-preview`)
          .send({ providerId: 'jira', templateId: 'not-a-uuid' })
          .expect(400)
      ).body.code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await request(app)
          .post(`/pbi/items/${ITEM_ID}/field-preview`)
          .send({ providerId: 'jira', templateId: TEMPLATE_ID, scope: 'KEY', itemType: 'Bug' })
          .expect(400)
      ).body.code,
    ).toBe('FIELD_MAPPING_INVALID');
    expect(previewFields).toHaveBeenCalledWith('ws', ITEM_ID, 'jira', TEMPLATE_ID, 'KEY', 'Bug');
  });
});

describe('PBI item route', () => {
  it('returns the item resolved by the service', async () => {
    const get = vi.fn(() => Promise.resolve({ id: ITEM_ID, title: 'Checkout', links: [] }));
    const response = await request(build({ get })).get('/pbi/items/jira:10001').expect(200);
    expect(response.body).toEqual({ item: { id: ITEM_ID, title: 'Checkout', links: [] } });
    expect(get).toHaveBeenCalledWith('ws', 'jira:10001');
  });

  it('forwards a missing item as an error response', async () => {
    const get = rejectWith('PBI_NOT_FOUND', 404);
    const response = await request(build({ get })).get(`/pbi/items/${ITEM_ID}`).expect(404);
    expect(response.body).toEqual({ code: 'PBI_NOT_FOUND', message: 'PBI_NOT_FOUND failed.' });
    expect(get).toHaveBeenCalledWith('ws', ITEM_ID);
  });
});
