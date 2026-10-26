import { describe, expect, it, vi } from 'vitest';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { InMemoryPbiStore } from '../src/modules/pbi/pbi-store.js';
import { PbiService } from '../src/modules/pbi/pbi-service.js';
import { createPbiProvider } from '../src/modules/pbi/providers.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import { fakeRunAgents } from './helpers/fake-run-agents.js';
import { EntityAuditLog } from '../src/modules/audit/entity-audit.js';
import type { AuditEvent, AuditPersistence, AuditUnit } from '../src/modules/audit/audit.js';

const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('PBI board synchronization', () => {
  it('writes Trello card custom fields with the provider value format', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null });
      if (url.includes('/boards/board/customFields?'))
        return response([
          {
            id: 'classification',
            name: 'Classification',
            type: 'list',
            options: [{ id: 'urgent', value: { text: 'Urgent' } }],
          },
          { id: 'estimate', name: 'Estimate', type: 'number' },
        ]);
      if (url.includes('/cards?'))
        return response({ id: 'card-1', url: 'https://trello.com/c/card-1' });
      return response({});
    }) as unknown as typeof fetch;
    const provider = createPbiProvider(
      { id: 'trello', settings: { apiKey: 'key', boardId: 'board' }, secret: 'token' },
      fetcher,
    );
    const definitions = await provider.listFields?.('board');
    expect(definitions?.[0]?.options).toEqual([{ id: 'urgent', name: 'Urgent' }]);
    const card = await new InMemoryPbiStore().create('ws', { kind: 'card', title: 'Task' });
    await provider.push(card, {
      fields: { list: 'list-1' },
      customFields: { classification: 'urgent', estimate: 2.5 },
      fieldDefinitions: definitions,
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: expect.stringContaining('/customField/classification/item?'),
          body: { idValue: 'urgent' },
        }),
        expect.objectContaining({
          url: expect.stringContaining('/customField/estimate/item?'),
          body: { value: { number: '2.5' } },
        }),
      ]),
    );
  });

  it('syncs Azure child cards and their descendants when a PBI is opened', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'azure_devops', {
      isEnabled: true,
      settings: { organization: 'org', project: 'project' },
      secret: 'azure-pat',
    });
    const store = new InMemoryPbiStore();
    const parent = await store.create('ws', { kind: 'pbi', title: 'PBI' });
    await store.link('ws', parent.id, {
      providerId: 'azure_devops',
      externalId: '46873',
      externalUrl: null,
      boardId: 'project',
    });
    const childIds = [47266, 47267, 50270, 46874, 49674];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/workitems/46873?'))
        return response({
          relations: childIds.map((id) => ({
            rel: 'System.LinkTypes.Hierarchy-Forward',
            url: `https://dev.azure.com/org/_apis/wit/workItems/${id}`,
          })),
        });
      if (url.includes('/workitemsbatch')) {
        const { ids } = JSON.parse(String(init?.body)) as { ids: number[] };
        return response({
          value: ids.map((id) => ({
            id,
            fields: {
              'System.Title': `Task ${id}`,
              'System.WorkItemType': 'Task',
            },
            relations:
              id === 47266
                ? [
                    {
                      rel: 'System.LinkTypes.Hierarchy-Forward',
                      url: 'https://dev.azure.com/org/_apis/wit/workItems/60000',
                    },
                  ]
                : [],
          })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const events: AuditEvent[] = [];
    const persistence: AuditPersistence = {
      run: (_workspaceId, work) =>
        work({
          append: (batch) => {
            events.push(...batch);
            return Promise.resolve();
          },
        } as AuditUnit),
      list: () => Promise.resolve({ items: [], total: 0 }),
    };
    const service = new PbiService(store, integrations, fetcher, new EntityAuditLog(persistence));
    const first = await service.syncChildren('ws', parent.id);
    expect(events).toHaveLength(6);
    expect(events.every((event) => event.action === 'create' && event.entityType === 'pbi')).toBe(
      true,
    );
    expect(first.filter((item) => item.parentId === parent.id)).toHaveLength(5);
    const task = first.find((item) => item.title === 'Task 47266')!;
    expect(first.find((item) => item.title === 'Task 60000')?.parentId).toBe(task.id);
    const second = await service.syncChildren('ws', parent.id);
    expect(second).toHaveLength(7);
    // Unchanged items are not recorded again on later syncs.
    expect(events).toHaveLength(6);
    expect(second.find((item) => item.title === 'Task 47266')?.id).toBe(task.id);
  });
  it('loads every page of Azure comments for the linked item', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'azure_devops', {
      isEnabled: true,
      settings: { organization: 'org', project: 'project' },
      secret: 'azure-pat',
    });
    const store = new InMemoryPbiStore();
    const item = await store.create('ws', { kind: 'pbi', title: 'Azure PBI' });
    const local = await store.create('ws', { kind: 'pbi', title: 'Local PBI' });
    await store.link('ws', item.id, {
      providerId: 'azure_devops',
      externalId: '42',
      externalUrl: null,
      boardId: 'project',
    });
    const fetcher = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toContain('/workItems/42/comments');
      expect(parsed.searchParams.get('$expand')).toBe('renderedText');
      return response(
        parsed.searchParams.has('continuationToken')
          ? {
              comments: [
                {
                  commentId: 2,
                  text: 'Second comment',
                  createdDate: '2026-09-30T12:00:00Z',
                  createdBy: { displayName: 'Sam' },
                },
              ],
            }
          : {
              comments: [
                {
                  commentId: 1,
                  text: 'First comment',
                  renderedText: '<p><strong>@Alex</strong> &gt; approved</p>',
                  createdDate: '2026-09-30T11:00:00Z',
                  createdBy: { displayName: 'Alex' },
                },
              ],
              continuationToken: 'next',
            },
      );
    }) as unknown as typeof fetch;
    const service = new PbiService(store, integrations, fetcher);
    expect(await service.comments('ws', local.id)).toEqual([]);
    expect(await service.comments('ws', item.id)).toEqual([
      {
        id: '1',
        body: '<p><strong>@Alex</strong> &gt; approved</p>',
        author: 'Alex',
        createdAt: '2026-09-30T11:00:00Z',
      },
      { id: '2', body: 'Second comment', author: 'Sam', createdAt: '2026-09-30T12:00:00Z' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('pulls Azure and Trello into one idempotent hierarchy', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'azure_devops', {
      isEnabled: true,
      settings: { organization: 'org', project: 'project' },
      secret: 'azure-pat',
    });
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'trello', {
      isEnabled: true,
      settings: { apiKey: 'key', boardId: 'board' },
      secret: 'trello-token',
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/_apis/wit/wiql'))
        return response({
          workItems: String(init?.body).includes('ORDER BY [System.Id] DESC')
            ? [{ id: 2 }]
            : [{ id: 1 }, { id: 2 }],
        });
      if (url.includes('/_apis/wit/workitemsbatch'))
        return response({
          value: [
            {
              id: 1,
              fields: {
                'System.Title': 'Azure PBI',
                'System.WorkItemType': 'Product Backlog Item',
                'System.State': 'New',
              },
            },
            {
              id: 2,
              fields: {
                'System.Title': 'Azure task',
                'System.WorkItemType': 'Task',
                'System.State': 'Done',
              },
              relations: [
                {
                  rel: 'System.LinkTypes.Hierarchy-Reverse',
                  url: 'https://dev.azure.com/org/_apis/wit/workItems/1',
                },
              ],
            },
          ],
        });
      if (url.includes('/lists?')) return response([{ id: 'list', name: 'Trello list', pos: 1 }]);
      if (url.includes('/cards?'))
        return response([
          {
            id: 'card',
            idList: 'list',
            name: 'Trello card',
            desc: 'details',
            pos: 2,
            url: 'https://trello.com/c/card',
          },
        ]);
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const service = new PbiService(new InMemoryPbiStore(), integrations, fetcher);
    const first = await service.pull('ws');
    expect(first.results).toEqual([
      { providerId: 'azure_devops', imported: 2 },
      { providerId: 'trello', imported: 2 },
    ]);
    expect(first.items).toHaveLength(4);
    const azure = first.items.find((item) => item.title === 'Azure PBI')!;
    const trello = first.items.find((item) => item.title === 'Trello list')!;
    expect(first.items.find((item) => item.title === 'Azure task')?.parentId).toBe(azure.id);
    expect(first.items.find((item) => item.title === 'Trello card')?.parentId).toBe(trello.id);
    await service.update('ws', azure.id, {
      sourceData: { adkPriority: '1', adkAgentId: 'agent-1' },
    });
    const second = await service.pull('ws');
    expect(second.items).toHaveLength(4);
    expect(second.items.find((item) => item.title === 'Azure PBI')?.id).toBe(azure.id);
    expect(second.items.find((item) => item.id === azure.id)?.sourceData).toMatchObject({
      adkPriority: '1',
      adkAgentId: 'agent-1',
    });
    expect(await service.list('other-ws')).toEqual([]);
  });

  it('restores Azure tasks under their PBI from the Parent field on a later pull', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'azure_devops', {
      isEnabled: true,
      settings: { organization: 'org', project: 'project' },
      secret: 'azure-pat',
    });
    const store = new InMemoryPbiStore();
    const oldTask = await store.create('ws', { kind: 'pbi', title: 'Azure task' });
    await store.link('ws', oldTask.id, {
      providerId: 'azure_devops',
      externalId: '2',
      externalUrl: null,
      boardId: 'project',
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/_apis/wit/wiql'))
        return response({
          workItems: String(init?.body).includes('ORDER BY [System.Id] DESC')
            ? [{ id: 2 }]
            : [{ id: 1 }, { id: 2 }],
        });
      if (url.includes('/_apis/wit/workitemsbatch')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ $expand: 'relations' });
        return response({
          value: [
            {
              id: 1,
              fields: {
                'System.Title': 'Azure PBI',
                'System.WorkItemType': 'Product Backlog Item',
              },
            },
            {
              id: 2,
              fields: {
                'System.Title': 'Azure task',
                'System.WorkItemType': 'Task',
                'System.Parent': 1,
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const result = await new PbiService(store, integrations, fetcher).pull('ws');
    const pbi = result.items.find((item) => item.title === 'Azure PBI')!;
    const task = result.items.find((item) => item.id === oldTask.id)!;
    expect(task).toMatchObject({ kind: 'card', parentId: pbi.id });
  });

  it('imports current iteration and child links when batch items omit parent relations', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'azure_devops', {
      isEnabled: true,
      settings: { organization: 'org', project: 'project' },
      secret: 'azure-pat',
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/teamsettings/iterations')) {
        expect(new URL(url).pathname).toBe('/org/project/_apis/work/teamsettings/iterations');
        return response({ values: [{ path: 'project\\Sprint 190' }] });
      }
      if (url.includes('/_apis/wit/wiql')) {
        const query = JSON.parse(String(init?.body)).query as string;
        if (query.includes('FROM WorkItemLinks'))
          return response({
            workItemRelations: [
              { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 1 }, target: { id: 2 } },
              { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 1 }, target: { id: 3 } },
              { rel: 'System.LinkTypes.Related', source: { id: 1 }, target: { id: 3 } },
            ],
          });
        return response({
          workItems: query.includes('ORDER BY [System.Id] DESC')
            ? [{ id: 3 }]
            : [{ id: 1 }, { id: 2 }, { id: 3 }],
        });
      }
      if (url.includes('/_apis/wit/workitemsbatch'))
        return response({
          value: [
            {
              id: 1,
              fields: {
                'System.Title': 'PBI',
                'System.WorkItemType': 'Product Backlog Item',
                'System.IterationPath': 'project\\Sprint 190',
              },
            },
            {
              id: 2,
              fields: {
                'System.Title': 'Task',
                'System.WorkItemType': 'Task',
                'System.IterationPath': 'project\\Sprint 191',
              },
            },
            {
              id: 3,
              fields: {
                'System.Title': 'Bug',
                'System.WorkItemType': 'Bug',
                'System.IterationPath': 'project\\Sprint 190',
              },
            },
          ],
        });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const service = new PbiService(new InMemoryPbiStore(), integrations, fetcher);
    expect(await service.currentIteration('ws')).toBe('project\\Sprint 190');
    const result = await service.pull('ws');
    const pbi = result.items.find((item) => item.title === 'PBI')!;
    expect(pbi.sourceData.currentIteration).toBe(true);
    expect(pbi.sourceData.relatedExternalIds).toEqual(['3']);
    expect(result.items.find((item) => item.title === 'Task')).toMatchObject({
      kind: 'card',
      parentId: pbi.id,
    });
    expect(result.items.find((item) => item.title === 'Bug')).toMatchObject({
      kind: 'card',
      parentId: pbi.id,
    });
  });

  it('splits Azure WIQL ranges when the query exceeds the 20,000-item limit', async () => {
    const queries: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/_apis/wit/wiql')) {
        const query = JSON.parse(String(init?.body)).query as string;
        queries.push(query);
        if (query.includes('ORDER BY [System.Id] DESC'))
          return response({ workItems: [{ id: 4 }] });
        if (query.includes('[System.Id] > 0 AND [System.Id] <= 4'))
          return new Response(JSON.stringify({ message: 'VS402337: query limit exceeded' }), {
            status: 400,
          });
        if (query.includes('[System.Id] > 0 AND [System.Id] <= 2'))
          return response({ workItems: [{ id: 1 }, { id: 2 }] });
        if (query.includes('[System.Id] > 2 AND [System.Id] <= 4'))
          return response({ workItems: [{ id: 3 }, { id: 4 }] });
      }
      if (url.includes('/_apis/wit/workitemsbatch')) {
        const { ids } = JSON.parse(String(init?.body)) as { ids: number[] };
        return response({
          value: ids.map((id) => ({
            id,
            fields: { 'System.Title': `Item ${id}`, 'System.WorkItemType': 'Task' },
          })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const provider = createPbiProvider(
      { id: 'azure_devops', settings: { organization: 'org', project: 'project' }, secret: 'pat' },
      fetcher,
    );
    const items = await provider.pull();
    expect(items.map((item) => item.externalId)).toEqual(['1', '2', '3', '4']);
    expect(queries).toHaveLength(4);
  });

  it('splits Azure WIQL responses at 20,000 items to avoid silent truncation', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/_apis/wit/wiql')) {
        const query = JSON.parse(String(init?.body)).query as string;
        if (query.includes('ORDER BY [System.Id] DESC'))
          return response({ workItems: [{ id: 20001 }] });
        if (query.includes('[System.Id] > 0 AND [System.Id] <= 20001'))
          return response({
            workItems: Array.from({ length: 20000 }, (_, index) => ({ id: index + 1 })),
          });
        if (query.includes('[System.Id] > 0 AND [System.Id] <= 10000'))
          return response({ workItems: [{ id: 1 }] });
        if (query.includes('[System.Id] > 10000 AND [System.Id] <= 20001'))
          return response({ workItems: [{ id: 20001 }] });
      }
      if (url.includes('/_apis/wit/workitemsbatch')) {
        const { ids } = JSON.parse(String(init?.body)) as { ids: number[] };
        return response({
          value: ids.map((id) => ({
            id,
            fields: { 'System.Title': `Item ${id}`, 'System.WorkItemType': 'Task' },
          })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const provider = createPbiProvider(
      { id: 'azure_devops', settings: { organization: 'org', project: 'project' }, secret: 'pat' },
      fetcher,
    );
    const items = await provider.pull();
    expect(items.map((item) => item.externalId)).toEqual(['1', '20001']);
  });

  it('pushes a local PBI and its card to the selected Trello board', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'trello', {
      isEnabled: true,
      settings: { apiKey: 'key', boardId: 'board' },
      secret: 'token',
    });
    const lists = [{ id: 'list-0', name: 'Doing' }];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/members/me/boards?'))
        return response([
          { id: 'board', name: 'Main' },
          { id: 'other', name: 'Other' },
        ]);
      if (url.includes('/boards/board/lists?')) return response(lists);
      if (url.includes('/boards/board/members?'))
        return response([{ id: 'member-1', fullName: 'Ana Souza', username: 'ana' }]);
      if (url.includes('/lists?') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({ idBoard: 'board' });
        lists.push({ id: 'list-1', name: 'Feature' });
        return response({ id: 'list-1' });
      }
      if (url.includes('/cards?') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          idList: 'list-1',
          name: 'Task',
          idMembers: ['member-1'],
        });
        return response({ id: 'card-1', url: 'https://trello.com/c/card-1' });
      }
      if (url.includes('/cards/card-1?') && init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          name: 'Updated task',
          idList: 'list-0',
        });
        return response({ id: 'card-1', url: 'https://trello.com/c/card-1' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const service = new PbiService(new InMemoryPbiStore(), integrations, fetcher);
    const root = await service.create('ws', { kind: 'pbi', title: 'Feature' });
    const card = await service.create('ws', { kind: 'card', title: 'Task', parentId: root.id });
    const ana = { name: 'Ana Souza', email: 'ana@example.com' };
    // The parent list does not exist yet and "backlog" matches no list, so the list is unresolved.
    const before = await service.pushContract('ws', card.id, 'trello', {}, ana);
    expect(before.fields.find((field) => field.key === 'list')).toMatchObject({
      value: '',
      status: 'unresolved',
      source: 'backlog',
      required: true,
    });
    expect(before.fields.find((field) => field.key === 'member')).toMatchObject({
      value: 'member-1',
      status: 'resolved',
    });
    await expect(service.push('ws', card.id, { providerId: 'trello' }, ana)).rejects.toMatchObject({
      code: 'PBI_PUSH_FIELDS',
      details: [{ field: 'list' }],
    });
    const pushedRoot = await service.push('ws', root.id, { providerId: 'trello' });
    expect(pushedRoot.item.links[0]?.externalId).toBe('list-1');
    const contract = await service.pushContract('ws', card.id, 'trello', {}, ana);
    expect(contract.fields.find((field) => field.key === 'list')?.value).toBe('list-1');
    const pushedCard = await service.push('ws', card.id, { providerId: 'trello' }, ana);
    expect(pushedCard.item.links[0]?.externalId).toBe('card-1');
    expect(pushedCard.warnings).toEqual([]);
    await service.update('ws', card.id, { title: 'Updated task' });
    const updated = await service.push('ws', card.id, {
      providerId: 'trello',
      fields: { list: 'list-0' },
    });
    expect(updated.item.links).toHaveLength(1);
    expect(updated.item.links[0]?.externalId).toBe('card-1');
  });

  it('pulls Jira hierarchy and converts structured descriptions into agent-readable text', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'jira', {
      isEnabled: true,
      settings: {
        baseUrl: 'https://example.atlassian.net',
        projectKey: 'ADK',
        email: 'user@example.com',
      },
      secret: 'jira-token',
    });
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe('https://example.atlassian.net/rest/api/3/search/jql');
      return response({
        issues: [
          {
            id: '100',
            key: 'ADK-1',
            fields: {
              summary: 'Epic',
              status: { name: 'To Do' },
              issuetype: { name: 'Epic' },
              description: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'Customer goal' }] },
                ],
              },
            },
          },
          {
            id: '101',
            key: 'ADK-2',
            fields: {
              summary: 'Task',
              parent: { id: '100' },
              status: { name: 'In Progress' },
              issuetype: { name: 'Task' },
              description: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'Acceptance rule' }] },
                ],
              },
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const service = new PbiService(new InMemoryPbiStore(), integrations, fetcher);
    const result = await service.pull('ws');
    expect(result.results).toEqual([{ providerId: 'jira', imported: 2 }]);
    const epic = result.items.find((item) => item.title === 'Epic')!;
    const task = result.items.find((item) => item.title === 'Task')!;
    expect(task.parentId).toBe(epic.id);
    expect(task.description).toBe('Acceptance rule\n');
    expect(task.status).toBe('In Progress');
  });

  it('pulls GitHub Project status, iteration and subissues', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'github_projects', {
      isEnabled: true,
      settings: { owner: 'team', projectNumber: '5', repo: 'app' },
      secret: 'github-token',
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.github.com/graphql');
      expect(JSON.parse(String(init?.body)).query).toContain('fieldValueByName(name:"Status")');
      return response({
        data: {
          user: null,
          organization: {
            projectV2: {
              id: 'project',
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'project-item',
                    statusField: { name: 'In progress' },
                    iterationField: { title: 'Sprint 190' },
                    content: {
                      id: 'issue-1',
                      title: 'Feature',
                      body: 'Goal',
                      url: 'https://github.com/team/app/issues/1',
                      subIssues: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                          {
                            id: 'issue-2',
                            title: 'Task',
                            body: 'Rule',
                            url: 'https://github.com/team/app/issues/2',
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }) as unknown as typeof fetch;
    const service = new PbiService(new InMemoryPbiStore(), integrations, fetcher);
    const result = await service.pull('ws');
    expect(result.results).toEqual([{ providerId: 'github_projects', imported: 2 }]);
    const parent = result.items.find((item) => item.title === 'Feature')!;
    expect(parent.status).toBe('In progress');
    expect(parent.sourceData.iterationPath).toBe('Sprint 190');
    expect(result.items.find((item) => item.title === 'Task')?.parentId).toBe(parent.id);
  });

  it('injects current PBI and card content into an assigned agent run', async () => {
    const pbiStore = new InMemoryPbiStore();
    const pbi = await pbiStore.create('ws', {
      kind: 'pbi',
      title: 'Feature',
      description: 'Initial goal',
    });
    const card = await pbiStore.create('ws', {
      kind: 'card',
      title: 'Task',
      description: 'Current acceptance rule',
      parentId: pbi.id,
    });
    const issues = new InMemoryIssueStore();
    const issue = await issues.create('ws', 'user', {
      title: 'Implement feature',
      pbiItemId: pbi.id,
      assigneeAgentId: 'agent',
    });
    await pbiStore.update('ws', card.id, { description: 'Updated acceptance rule' });
    const agents = fakeRunAgents(vi.fn().mockResolvedValue({ result: 'Done', provider: 'test' }), {
      agent: { id: 'agent', name: 'Agent' },
    });
    const runs = new RunService(new InMemoryRunStore(), issues, agents, pbiStore);
    const run = await runs.create(issue.id, {
      requestId: 'pbi-test',
      workspaceId: 'ws',
      ownerId: 'ws',
      actorId: 'user',
    });
    expect(run.prompt).toContain('Feature: Initial goal');
    expect(run.prompt).toContain('Task: Updated acceptance rule');
  });
});
