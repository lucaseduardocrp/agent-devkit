import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryFieldMappingStore } from '../src/modules/field-mapping/field-mapping.js';

describe('field mapping routes', () => {
  it('saves templates per workspace and supports preview metadata updates', async () => {
    const app = createApp({
      requestContextResolver: async () => ({
        requestId: 'mapping',
        ownerId: 'ws-1',
        workspaceId: 'ws-1',
      }),
    });
    const input = {
      name: 'Azure to Trello',
      entityType: 'pbi',
      providerId: 'trello',
      scope: 'board-1',
      itemType: '',
      rules: [
        {
          targetFieldId: 'classification',
          source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.Classification' },
          choices: { Critical: 'urgent' },
        },
      ],
    };
    const created = await request(app).post('/field-mappings').send(input);
    expect(created.status).toBe(201);
    expect(created.body.template).toMatchObject(input);
    const id = created.body.template.id as string;
    const listed = await request(app).get('/field-mappings?entityType=pbi&providerId=trello');
    expect(listed.body.templates).toHaveLength(1);
    expect((await request(app).get('/field-mappings')).status).toBe(400);
    const updated = await request(app)
      .put(`/field-mappings/${id}`)
      .send({ ...input, name: 'Revised' });
    expect(updated.body.template.name).toBe('Revised');
    expect((await request(app).delete(`/field-mappings/${id}`)).status).toBe(204);
    expect((await request(app).get('/field-mappings?entityType=pbi')).body.templates).toEqual([]);
  });

  it('does not expose another workspace template', async () => {
    const store = new InMemoryFieldMappingStore();
    const shared = createApp({
      requestContextResolver: async () => ({
        requestId: 'mapping',
        ownerId: 'ws-1',
        workspaceId: 'ws-1',
      }),
      fieldMappingStore: store,
    });
    const created = await request(shared).post('/field-mappings').send({
      name: 'Private',
      entityType: 'pbi',
      providerId: 'jira',
      rules: [],
    });
    const foreign = createApp({
      requestContextResolver: async () => ({
        requestId: 'mapping',
        ownerId: 'ws-2',
        workspaceId: 'ws-2',
      }),
      fieldMappingStore: store,
    });
    expect((await request(foreign).get('/field-mappings?entityType=pbi')).body.templates).toEqual(
      [],
    );
    expect(
      (await request(foreign).delete(`/field-mappings/${created.body.template.id as string}`))
        .status,
    ).toBe(404);
  });
});
