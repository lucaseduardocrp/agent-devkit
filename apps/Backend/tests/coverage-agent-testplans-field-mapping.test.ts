import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createFieldMappingRouter } from '../src/adapters/http/field-mapping-routes.js';
import type { RequestContext } from '../src/shared/context.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  InMemoryFieldMappingStore,
  resolveFieldMapping,
  type FieldDefinition,
  type FieldMappingRule,
  type FieldMappingTemplate,
  type FieldMappingStore,
  type MappableItem,
} from '../src/modules/field-mapping/field-mapping.js';
import { PrismaFieldMappingStore } from '../src/modules/field-mapping/prisma-field-mapping.js';

const template = (rules: FieldMappingRule[]): FieldMappingTemplate => ({
  id: 'template',
  workspaceId: 'ws',
  name: 'Mapping',
  entityType: 'test_case',
  providerId: 'azure_devops',
  scope: '',
  itemType: '',
  createdAt: new Date(),
  updatedAt: new Date(),
  rules,
});

const resolveOne = (item: MappableItem, rule: FieldMappingRule, definition: FieldDefinition) =>
  resolveFieldMapping(item, template([rule]), [definition]);

const item: MappableItem = { title: 'Case title', description: 'Case body', status: 'Ready' };
const text: FieldDefinition = { id: 'target', name: 'Target', type: 'text' };

describe('InMemoryFieldMappingStore', () => {
  it('rejects updates to a template that does not exist in the workspace', async () => {
    const store = new InMemoryFieldMappingStore();
    const saved = await store.save('ws-1', null, {
      name: 'Private',
      entityType: 'pbi',
      providerId: 'jira',
      scope: '',
      itemType: '',
      rules: [],
    });
    await expect(store.save('ws-2', saved.id, { ...saved, name: 'Stolen' })).rejects.toMatchObject({
      code: 'FIELD_MAPPING_NOT_FOUND',
      statusCode: 404,
    });
    expect((await store.get('ws-1', saved.id))?.name).toBe('Private');
  });
});

describe('resolveFieldMapping sources', () => {
  it('reads core title, description and status fields', () => {
    expect(
      resolveFieldMapping(
        item,
        template([
          { targetFieldId: 'a', source: { kind: 'core', key: 'title' } },
          { targetFieldId: 'b', source: { kind: 'core', key: 'description' } },
          { targetFieldId: 'c', source: { kind: 'core', key: 'status' } },
        ]),
        [
          { id: 'a', name: 'A', type: 'text' },
          { id: 'b', name: 'B', type: 'text' },
          { id: 'c', name: 'C', type: 'text' },
        ],
      ),
    ).toEqual({ a: 'Case title', b: 'Case body', c: 'Ready' });
  });

  it('reads other core keys from metadata first and then from source data', () => {
    const rule = { targetFieldId: 'target', source: { kind: 'core' as const, key: 'area' } };
    expect(resolveOne({ ...item, metadata: { area: 'Meta' } }, rule, text)).toEqual({
      target: 'Meta',
    });
    expect(resolveOne({ ...item, sourceData: { area: 'Source' } }, rule, text)).toEqual({
      target: 'Source',
    });
    expect(resolveOne(item, rule, text)).toEqual({});
  });

  it('skips core and custom sources without a key or provider', () => {
    expect(resolveOne(item, { targetFieldId: 'target', source: { kind: 'core' } }, text)).toEqual(
      {},
    );
    expect(
      resolveOne(item, { targetFieldId: 'target', source: { kind: 'custom', key: 'x' } }, text),
    ).toEqual({});
    expect(
      resolveOne(
        item,
        { targetFieldId: 'target', source: { kind: 'custom', providerId: 'jira' } },
        text,
      ),
    ).toEqual({});
  });

  it('reads custom fields from metadata, source data or nothing', () => {
    const rule = {
      targetFieldId: 'target',
      source: { kind: 'custom' as const, providerId: 'jira', key: 'severity' },
    };
    expect(
      resolveOne(
        { ...item, metadata: { customFields: { jira: { severity: 'High' } } } },
        rule,
        text,
      ),
    ).toEqual({ target: 'High' });
    expect(
      resolveOne(
        { ...item, sourceData: { customFields: { jira: { severity: 'Low' } } } },
        rule,
        text,
      ),
    ).toEqual({ target: 'Low' });
    expect(resolveOne(item, rule, text)).toEqual({});
  });
});

describe('resolveFieldMapping conversions', () => {
  const constant = (value: unknown, choices?: Record<string, string>): FieldMappingRule => ({
    targetFieldId: 'target',
    source: { kind: 'constant', value: value as never },
    ...(choices ? { choices } : {}),
  });

  it('converts multi selections through choices and destination options', () => {
    const multi: FieldDefinition = {
      id: 'target',
      name: 'Tags',
      type: 'multi_select',
      options: [
        { id: 'opt-ui', name: 'UI' },
        { id: 'opt-api', name: 'API' },
      ],
    };
    expect(
      resolveOne(item, constant(['Interface', 'opt-api'], { Interface: 'UI' }), multi),
    ).toEqual({ target: ['opt-ui', 'opt-api'] });
    expect(resolveOne(item, constant('API'), multi)).toEqual({ target: ['opt-api'] });
    expect(() => resolveOne(item, constant(['Database']), multi)).toThrowError(
      /Unknown option for Tags/,
    );
  });

  it('keeps multi selections as text when the destination has no options', () => {
    const free: FieldDefinition = { id: 'target', name: 'Labels', type: 'multi_select' };
    expect(resolveOne(item, constant([1, true, 'x'], { '1': 'one' }), free)).toEqual({
      target: ['one', 'true', 'x'],
    });
  });

  it('keeps single selections and iterations as text when the destination has no options', () => {
    expect(
      resolveOne(item, constant('Sprint 3'), { id: 'target', name: 'Sprint', type: 'iteration' }),
    ).toEqual({ target: 'Sprint 3' });
    expect(
      resolveOne(item, constant('Critical', { Critical: 'P1' }), {
        id: 'target',
        name: 'Priority',
        type: 'single_select',
        options: [],
      }),
    ).toEqual({ target: 'P1' });
  });

  it('rejects values that cannot be represented as text', () => {
    expect(() => resolveOne(item, constant({ nested: true }), text)).toThrowError(
      /Invalid value for Target/,
    );
    expect(() =>
      resolveOne(item, constant([{ nested: true }]), {
        id: 'target',
        name: 'Tags',
        type: 'multi_select',
      }),
    ).toThrowError(/Invalid value for Tags/);
  });

  it('converts numbers and rejects non-finite values', () => {
    const number: FieldDefinition = { id: 'target', name: 'Hours', type: 'number' };
    expect(resolveOne(item, constant(3), number)).toEqual({ target: 3 });
    expect(resolveOne(item, constant('4.5'), number)).toEqual({ target: 4.5 });
    expect(() => resolveOne(item, constant('many'), number)).toThrowError(
      /Invalid number for Hours/,
    );
  });

  it('converts booleans from booleans and boolean strings only', () => {
    const flag: FieldDefinition = { id: 'target', name: 'Automated', type: 'boolean' };
    expect(resolveOne(item, constant(false), flag)).toEqual({ target: false });
    expect(resolveOne(item, constant('true'), flag)).toEqual({ target: true });
    expect(resolveOne(item, constant('false'), flag)).toEqual({ target: false });
    expect(() => resolveOne(item, constant('yes'), flag)).toThrowError(
      /Invalid boolean for Automated/,
    );
  });

  it('validates dates and stringifies plain values', () => {
    const date: FieldDefinition = { id: 'target', name: 'Due', type: 'date' };
    expect(resolveOne(item, constant('2026-10-14'), date)).toEqual({ target: '2026-10-14' });
    expect(() => resolveOne(item, constant('not a date'), date)).toThrowError(
      /Invalid date for Due/,
    );
    expect(resolveOne(item, constant(7), text)).toEqual({ target: '7' });
  });

  it('rejects unavailable or read-only destination fields', () => {
    expect(() => resolveOne(item, constant('x'), { ...text, readOnly: true })).toThrowError(
      /Destination field target is unavailable or read-only/,
    );
  });
});

describe('PrismaFieldMappingStore', () => {
  const row = {
    id: 'mapping-1',
    workspaceId: 'ws',
    name: 'Azure',
    entityType: 'test_case',
    providerId: 'azure_devops',
    scope: '',
    itemType: '',
    rules: [{ targetFieldId: 'a', source: { kind: 'core', key: 'title' } }],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
  };
  const input = {
    name: 'Azure',
    entityType: 'test_case' as const,
    providerId: 'azure_devops',
    scope: '',
    itemType: '',
    rules: row.rules as FieldMappingRule[],
  };
  const fake = () => {
    const records = {
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue({ ...row, name: 'Renamed' }),
      create: vi.fn().mockResolvedValue(row),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = { fieldMappingTemplateRecord: records } as unknown as PrismaClient;
    return { records, store: new PrismaFieldMappingStore(prisma) };
  };

  it('lists and gets workspace templates', async () => {
    const { records, store } = fake();
    expect(await store.list('ws')).toEqual([{ ...row }]);
    expect(records.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws' },
      orderBy: { updatedAt: 'desc' },
    });
    expect(await store.get('ws', 'mapping-1')).toMatchObject({ id: 'mapping-1', rules: row.rules });
    expect(records.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 'ws', id: 'mapping-1' },
    });
    records.findFirst.mockResolvedValueOnce(null);
    expect(await store.get('ws', 'missing')).toBeNull();
  });

  it('creates new templates in the workspace and updates existing ones', async () => {
    const { records, store } = fake();
    expect(await store.save('ws', null, input)).toMatchObject({ id: 'mapping-1' });
    expect(records.create).toHaveBeenCalledWith({ data: { ...input, workspaceId: 'ws' } });
    expect(await store.save('ws', 'mapping-1', { ...input, name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
    });
    expect(records.update).toHaveBeenCalledWith({
      where: { id: 'mapping-1' },
      data: { ...input, name: 'Renamed' },
    });
  });

  it('refuses to update a template from another workspace', async () => {
    const { records, store } = fake();
    records.findFirst.mockResolvedValueOnce(null);
    await expect(store.save('other', 'mapping-1', input)).rejects.toMatchObject({
      code: 'FIELD_MAPPING_NOT_FOUND',
      statusCode: 404,
    });
    expect(records.update).not.toHaveBeenCalled();
  });

  it('reports whether a workspace template was deleted', async () => {
    const { records, store } = fake();
    expect(await store.delete('ws', 'mapping-1')).toBe(true);
    expect(records.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws', id: 'mapping-1' },
    });
    records.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.delete('ws', 'missing')).toBe(false);
  });
});

describe('field mapping router', () => {
  const body = {
    name: 'Cases',
    entityType: 'test_case',
    providerId: 'azure_devops',
    rules: [{ targetFieldId: 'Custom.Area', source: { kind: 'core', key: 'title' } }],
  };

  const build = (
    context: () => RequestContext | Promise<RequestContext>,
    store: FieldMappingStore = new InMemoryFieldMappingStore(),
  ) => {
    const app = express();
    app.use(express.json());
    app.use(createFieldMappingRouter(store, async () => context()));
    app.use(errorMiddleware);
    return app;
  };

  it('manages test case templates for the workspace', async () => {
    const app = build(() => ({ requestId: 'r', ownerId: 'ws', workspaceId: 'ws' }));
    const created = await request(app).post('/field-mappings').send(body);
    expect(created.status).toBe(201);
    expect(created.body.template).toMatchObject({ ...body, scope: '', itemType: '' });
    const id = created.body.template.id as string;
    const listed = await request(app).get('/field-mappings?entityType=test_case');
    expect(listed.body.templates).toHaveLength(1);
    const pbis = await request(app).get('/field-mappings?entityType=pbi');
    expect(pbis.body.templates).toEqual([]);
    const updated = await request(app)
      .put(`/field-mappings/${id}`)
      .send({ ...body, name: 'Renamed' });
    expect(updated.status).toBe(200);
    expect(updated.body.template.name).toBe('Renamed');
    expect((await request(app).delete(`/field-mappings/${id}`)).status).toBe(204);
  });

  it('returns 404 when updating a missing template', async () => {
    const app = build(() => ({ requestId: 'r', ownerId: 'ws', workspaceId: 'ws' }));
    const response = await request(app).put('/field-mappings/missing').send(body);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('FIELD_MAPPING_NOT_FOUND');
  });

  it('denies viewers from creating or changing test case templates', async () => {
    const store = new InMemoryFieldMappingStore();
    const existing = await store.save('ws', null, { ...body, scope: '', itemType: '' } as never);
    const app = build(
      () => ({ requestId: 'r', ownerId: 'ws', workspaceId: 'ws', memberRole: 'VIEWER' }),
      store,
    );
    const created = await request(app).post('/field-mappings').send(body);
    expect(created.status).toBe(403);
    expect(created.body.code).toBe('MODULE_PERMISSION_DENIED');
    const updated = await request(app).put(`/field-mappings/${existing.id}`).send(body);
    expect(updated.status).toBe(403);
    expect((await store.get('ws', existing.id))?.name).toBe('Cases');
  });

  it('requires a workspace in the request context', async () => {
    const app = build(() => ({ requestId: 'r', ownerId: 'user' }));
    const response = await request(app).get('/field-mappings?entityType=test_case');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('WORKSPACE_REQUIRED');
  });

  it('forwards context resolution failures', async () => {
    const app = build(() => Promise.reject(new Error('resolver down')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(app).get('/field-mappings?entityType=pbi');
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    vi.restoreAllMocks();
  });

  it('can rely on a context set by earlier middleware', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.context = { requestId: 'r', ownerId: 'ws', workspaceId: 'ws' };
      next();
    });
    app.use(createFieldMappingRouter(new InMemoryFieldMappingStore()));
    app.use(errorMiddleware);
    const created = await request(app).post('/field-mappings').send(body);
    expect(created.status).toBe(201);
    const listed = await request(app).get('/field-mappings?entityType=test_case&providerId=jira');
    expect(listed.body.templates).toEqual([]);
  });
});
