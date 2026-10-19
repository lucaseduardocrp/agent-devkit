import { describe, expect, it, vi } from 'vitest';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { InMemoryPbiStore } from '../src/modules/pbi/pbi-store.js';
import { PbiService } from '../src/modules/pbi/pbi-service.js';
import { createPbiProvider } from '../src/modules/pbi/providers.js';
import {
  fieldValues,
  matchState,
  matchUser,
  missingFields,
  normalize,
  selectField,
  stateCategory,
} from '../src/modules/pbi/push-contract.js';
import { ApplicationError, toErrorResponse } from '../src/shared/errors.js';

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
type Route = (url: string, init?: RequestInit) => Response | undefined;
function router(...routes: Route[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    for (const route of routes) {
      const result = route(url, init);
      if (result) return result;
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
async function integrations(providerId: string, settings: Record<string, unknown>) {
  const service = new IntegrationsService(new InMemoryUserIntegrationStore());
  await service.saveIntegration('ws', 'PROJECT_MANAGEMENT', providerId, {
    isEnabled: true,
    settings,
    secret: 'secret',
  });
  return service;
}
const ana = { name: 'Ana Souza', email: 'ana@example.com' };

describe('push contract helpers', () => {
  it('maps ADK states and people to provider values', () => {
    expect(normalize('  Em_Andamento ')).toBe('em andamento');
    expect(stateCategory('in_progress')).toBe('inProgress');
    expect(stateCategory('Sprint review')).toBeNull();
    const states = [
      { name: 'New', category: 'proposed' as const },
      { name: 'Committed', category: 'inProgress' as const },
      { name: 'Done', category: 'done' as const },
    ];
    expect(matchState('done', states)).toBe('Done');
    expect(matchState('Active', states)).toBe('Committed');
    expect(matchState('backlog', [{ name: 'To Do' }])).toBe('To Do');
    expect(matchState('Waiting', states)).toBeNull();
    expect(matchState('removed', states)).toBeNull();
    const users = [
      { value: 'u1', label: 'Bruno Lima', email: 'BRUNO@example.com' },
      { value: 'u2', label: 'Ána Souza' },
      { value: 'u3', label: 'Carla', login: 'carla' },
      { value: 'u4', label: 'Dani', email: 'dani@corp.io' },
    ];
    expect(matchUser(null, users)).toBeNull();
    expect(matchUser({ name: 'X', email: 'bruno@example.com' }, users)).toBe('u1');
    expect(matchUser({ name: 'ana souza', email: '' }, users)).toBe('u2');
    expect(matchUser({ name: 'Someone', email: 'carla@example.com' }, users)).toBe('u3');
    expect(matchUser({ name: 'Someone', email: 'dani@example.com' }, users)).toBe('u4');
    expect(matchUser({ name: '', email: '' }, users)).toBeNull();
  });

  it('keeps valid choices, flags unmapped values and lists missing fields', () => {
    const options = [{ value: 'a', label: 'A' }];
    const chosen = selectField({
      key: 'k',
      label: 'K',
      required: true,
      options,
      chosen: 'a',
      suggested: null,
      reloadOnChange: true,
      readOnly: true,
    });
    expect(chosen).toMatchObject({ value: 'a', status: 'resolved', reloadOnChange: true });
    const stale = selectField({
      key: 'k',
      label: 'K',
      required: true,
      options,
      chosen: 'gone',
      suggested: null,
      source: 'Ana',
    });
    expect(stale).toMatchObject({ value: '', status: 'unresolved', source: 'Ana' });
    const cleared = selectField({
      key: 'k',
      label: 'K',
      required: false,
      options,
      chosen: '',
      suggested: 'a',
      source: 'Ana',
    });
    expect(cleared).toMatchObject({ value: '', status: 'empty' });
    const custom = selectField({
      key: 'repo',
      label: 'Repo',
      required: true,
      options: [],
      chosen: 'acme/web',
      suggested: null,
      allowCustom: true,
    });
    expect(custom).toMatchObject({ value: 'acme/web', allowCustom: true });
    const invalid = { ...chosen, value: 'zzz' };
    expect(missingFields([chosen, stale, custom, invalid])).toEqual(['k', 'k']);
    expect(fieldValues([chosen, custom])).toEqual({ k: 'a', repo: 'acme/web' });
  });

  it('surfaces the provider error message instead of a generic one', async () => {
    const { fetcher } = router(
      (url) =>
        url.includes('/workitems/')
          ? response(
              { message: 'TF401320: Rule Error for field Iteration Path. Error code: Required.' },
              400,
            )
          : undefined,
      (url) =>
        url.includes('/lists') ? new Response('plain failure', { status: 500 }) : undefined,
    );
    const azure = createPbiProvider(
      { id: 'azure_devops', settings: { organization: 'org', project: 'proj' }, secret: 'pat' },
      fetcher,
    );
    const error = await azure
      .push({ kind: 'pbi', title: 'T', description: '', status: 'New' }, {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApplicationError);
    expect(toErrorResponse(error, 'req', 'en-US').message).toBe(
      'The board integration returned an error: HTTP 400 - TF401320: Rule Error for field Iteration Path. Error code: Required.',
    );
    const trello = createPbiProvider(
      { id: 'trello', settings: { apiKey: 'k', boardId: 'b' }, secret: 't' },
      fetcher,
    );
    await expect(trello.pull()).rejects.toMatchObject({
      messageParams: { detail: 'HTTP 500 - plain failure' },
    });
    expect(() => createPbiProvider({ id: 'jira', settings: {}, secret: 'x' }, fetcher)).toThrow(
      'Jira Cloud URL, email and project key are required.',
    );
    const missing = (() => {
      try {
        createPbiProvider({ id: 'trello', settings: {}, secret: '' }, fetcher);
      } catch (cause) {
        return cause;
      }
      return undefined;
    })();
    expect(toErrorResponse(missing, 'req', 'pt-BR').message).toBe(
      'A integração do board precisa ser configurada: Provider credential is missing.',
    );
  });
});

describe('Azure DevOps push contract', () => {
  const azureRoutes = (state: { created?: boolean }) =>
    router(
      (url) =>
        url.endsWith('/_apis/wit/workitemtypes?api-version=7.1')
          ? response({
              value: [
                {
                  name: 'Product Backlog Item',
                  states: [
                    { name: 'New', category: 'Proposed' },
                    { name: 'Committed', category: 'InProgress' },
                    { name: 'Done', category: 'Completed' },
                  ],
                },
                {
                  name: 'Task',
                  states: [
                    { name: 'To Do', category: 'Proposed' },
                    { name: 'In Progress', category: 'InProgress' },
                    { name: 'Done', category: 'Completed' },
                  ],
                },
                { name: 'Test Case', states: [] },
                { name: 'Old', isDisabled: true },
                { name: 'Impediment' },
              ],
            })
          : undefined,
      (url) =>
        url.includes('/classificationnodes/iterations')
          ? response({
              name: 'proj',
              children: [
                {
                  name: 'Sprint 1',
                  attributes: {
                    startDate: '2026-10-01T00:00:00Z',
                    finishDate: '2026-10-14T00:00:00Z',
                  },
                },
                { name: 'Sprint 2' },
              ],
            })
          : undefined,
      (url) =>
        url.includes('/classificationnodes/areas')
          ? response({ name: 'proj', children: [{ name: 'Web' }] })
          : undefined,
      (url) =>
        url.includes('/teamsettings/iterations')
          ? response({ values: [{ path: 'proj\\Sprint 1' }] })
          : undefined,
      (url) =>
        url.endsWith('/teams?api-version=7.1')
          ? response({ value: [{ id: 't1' }, { id: 't2' }] })
          : undefined,
      (url) =>
        url.includes('/teams/t1/members')
          ? response({
              value: [
                { identity: { displayName: 'Ana Souza', uniqueName: 'ana@example.com' } },
                { identity: { displayName: '', uniqueName: 'bot@example.com' } },
                { identity: {} },
              ],
            })
          : undefined,
      (url) =>
        url.includes('/teams/t2/members')
          ? response({
              value: [{ identity: { displayName: 'Ana S.', uniqueName: 'ANA@example.com' } }],
            })
          : undefined,
      (url, init) =>
        url.includes('/workitems/$Task') && init?.method === 'POST'
          ? ((state.created = true), response({ id: 77, fields: { 'System.State': 'To Do' } }))
          : undefined,
      (url, init) =>
        url.includes('/workitems/77?api-version') && init?.method === 'PATCH'
          ? response({ id: 77, fields: { 'System.State': 'In Progress' } })
          : undefined,
      (url) =>
        url.includes('/workitems/77?$expand=relations')
          ? response({
              relations: [
                {
                  rel: 'System.LinkTypes.Related',
                  url: 'https://dev.azure.com/org/_apis/wit/workItems/88',
                },
              ],
            })
          : undefined,
    );

  it('maps the ADK assignee and state, requires an iteration and creates the work item', async () => {
    const state: { created?: boolean } = {};
    const { fetcher, calls } = azureRoutes(state);
    const service = new PbiService(
      new InMemoryPbiStore(),
      await integrations('azure_devops', { organization: 'org', project: 'proj' }),
      fetcher,
    );
    const item = await service.create('ws', {
      kind: 'pbi',
      title: 'Teste 01 - Create',
      description: '<p>Teste</p>',
      status: 'Active',
      sourceData: { adkCardType: 'Task' },
    });
    const contract = await service.pushContract('ws', item.id, 'azure_devops', {}, ana);
    expect(contract.update).toBe(false);
    const byKey = Object.fromEntries(contract.fields.map((field) => [field.key, field]));
    expect(byKey.workItemType).toMatchObject({ value: 'Task', reloadOnChange: true });
    expect(byKey.workItemType!.options.map((option) => option.value)).toEqual([
      'Product Backlog Item',
      'Task',
      'Impediment',
    ]);
    expect(byKey.iterationPath).toMatchObject({ value: '', status: 'empty', required: true });
    expect(byKey.iterationPath!.options).toContainEqual({
      value: 'proj\\Sprint 1',
      label: 'proj\\Sprint 1',
      detail: '2026-10-01 → 2026-10-14 · current',
    });
    expect(byKey.areaPath).toMatchObject({ value: 'proj' });
    expect(byKey.assignee).toMatchObject({
      value: 'ana@example.com',
      status: 'resolved',
      required: true,
    });
    expect(byKey.assignee!.options).toHaveLength(2);
    expect(byKey.state).toMatchObject({ value: 'In Progress', source: 'Active' });

    await expect(
      service.push('ws', item.id, { providerId: 'azure_devops' }, ana),
    ).rejects.toMatchObject({
      code: 'PBI_PUSH_FIELDS',
      messageParams: { fields: 'iterationPath' },
    });
    expect(state.created).toBeUndefined();

    const relatedTarget = await service.create('ws', { kind: 'pbi', title: 'Related' });
    const store = (service as unknown as { store: InMemoryPbiStore }).store;
    await store.link('ws', relatedTarget.id, {
      providerId: 'azure_devops',
      externalId: '88',
      externalUrl: null,
      boardId: 'proj',
    });
    const blocker = await service.create('ws', { kind: 'pbi', title: 'Blocker' });
    await store.link('ws', blocker.id, {
      providerId: 'azure_devops',
      externalId: '99',
      externalUrl: null,
      boardId: 'proj',
    });
    const local = await service.create('ws', { kind: 'pbi', title: 'Local only' });
    await service.addRelations('ws', item.id, 'related', [relatedTarget.id, local.id]);
    await service.addRelations('ws', item.id, 'predecessor', [blocker.id]);

    const pushed = await service.push(
      'ws',
      item.id,
      { providerId: 'azure_devops', fields: { iterationPath: 'proj\\Sprint 2' } },
      ana,
    );
    expect(pushed.warnings).toEqual([]);
    expect(pushed.item).toMatchObject({
      status: 'In Progress',
      sourceData: {
        type: 'Task',
        iterationPath: 'proj\\Sprint 2',
        areaPath: 'proj',
        assignedTo: 'ana@example.com',
      },
    });
    expect(pushed.item.links[0]).toMatchObject({
      externalId: '77',
      externalUrl: 'https://dev.azure.com/org/proj/_workitems/edit/77',
    });
    const create = calls.find((call) => call.url.includes('/workitems/$Task'))!;
    expect(create.body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Teste 01 - Create' },
      { op: 'add', path: '/fields/System.Description', value: '<p>Teste</p>' },
      { op: 'add', path: '/fields/System.IterationPath', value: 'proj\\Sprint 2' },
      { op: 'add', path: '/fields/System.AreaPath', value: 'proj' },
      { op: 'add', path: '/fields/System.AssignedTo', value: 'ana@example.com' },
    ]);
    const patches = calls.filter((call) => call.method === 'PATCH');
    expect(patches[0]!.body).toEqual([
      { op: 'add', path: '/fields/System.State', value: 'In Progress' },
    ]);
    // Only the missing dependency link is added; the related link to 88 already exists.
    expect(patches[1]!.body).toEqual([
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Dependency-Reverse',
          url: 'https://dev.azure.com/org/_apis/wit/workItems/99',
        },
      },
    ]);

    const updateContract = await service.pushContract('ws', item.id, 'azure_devops', {
      workItemType: 'Product Backlog Item',
    });
    expect(updateContract.update).toBe(true);
    expect(updateContract.fields[0]).toMatchObject({ value: 'Task', readOnly: true });
    expect(updateContract.fields.find((field) => field.key === 'iterationPath')?.value).toBe(
      'proj\\Sprint 2',
    );
  });

  it('updates a linked work item in one patch, adds parents and reports link failures', async () => {
    const { fetcher, calls } = router(
      (url, init) =>
        url.includes('/workitems/500?api-version') && init?.method === 'PATCH'
          ? response({ id: 500, fields: { 'System.State': 'Done' } })
          : undefined,
      (url, init) =>
        url.includes('/workitems/$Product%20Backlog%20Item') && init?.method === 'POST'
          ? response({ id: 501 })
          : undefined,
      (url) =>
        url.includes('?$expand=relations') ? new Response('denied', { status: 403 }) : undefined,
    );
    const provider = createPbiProvider(
      { id: 'azure_devops', settings: { organization: 'org', project: 'proj' }, secret: 'pat' },
      fetcher,
    );
    const updated = await provider.push(
      { kind: 'card', title: 'T', description: 'D', status: 'New', sourceData: { type: 'Bug' } },
      { externalId: '500', fields: { state: 'Done', assignee: '' } },
    );
    expect(updated).toMatchObject({ status: 'Done', sourceData: { type: 'Bug' } });
    expect(calls[0]!.body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/System.Description', value: 'D' },
      { op: 'add', path: '/fields/System.State', value: 'Done' },
    ]);
    const created = await provider.push(
      { kind: 'pbi', title: 'Child', description: '', status: 'New' },
      { parentExternalId: '500' },
    );
    expect(created).toMatchObject({ externalId: '501', status: 'New', parentExternalId: '500' });
    expect(calls[1]!.body).toContainEqual({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: 'https://dev.azure.com/org/_apis/wit/workItems/500',
      },
    });
    await provider.syncLinks!('501', []);
    await expect(
      provider.syncLinks!('501', [{ type: 'related', externalId: '1' }]),
    ).rejects.toMatchObject({ code: 'PBI_PROVIDER_ERROR' });

    const service = new PbiService(
      new InMemoryPbiStore(),
      await integrations('azure_devops', { organization: 'org', project: 'proj' }),
      router(
        (url) =>
          url.endsWith('/workitemtypes?api-version=7.1')
            ? response({ value: [{ name: 'Product Backlog Item', states: [{ name: 'New' }] }] })
            : undefined,
        (url) => (url.includes('/classificationnodes/') ? response({ name: 'proj' }) : undefined),
        (url) =>
          url.includes('/teamsettings/') ? new Response('nope', { status: 500 }) : undefined,
        (url) => (url.endsWith('/teams?api-version=7.1') ? response({}) : undefined),
        (_url, init) =>
          init?.method === 'POST' || init?.method === 'PATCH'
            ? response({ id: 9, fields: { 'System.State': 'New' } })
            : undefined,
        (url) =>
          url.includes('?$expand=relations') ? new Response('denied', { status: 403 }) : undefined,
      ).fetcher,
    );
    const item = await service.create('ws', { kind: 'pbi', title: 'Plain', status: 'New' });
    const pushed = await service.push('ws', item.id, {
      providerId: 'azure_devops',
      issueType: 'Product Backlog Item',
      fields: { iterationPath: 'proj' },
    });
    expect(pushed.warnings).toEqual([]);
    const other = await service.create('ws', { kind: 'pbi', title: 'Other' });
    await (service as unknown as { store: InMemoryPbiStore }).store.link('ws', other.id, {
      providerId: 'azure_devops',
      externalId: '10',
      externalUrl: null,
      boardId: null,
    });
    await service.addRelations('ws', item.id, 'duplicate', [other.id]);
    const again = await service.push('ws', item.id, {
      providerId: 'azure_devops',
      fields: { iterationPath: 'proj', state: 'New' },
    });
    expect(again.warnings).toEqual(['Links were not published: HTTP 403 - denied']);
  });
});

describe('Jira push contract', () => {
  it('maps issue type, assignee and status, then transitions the new issue', async () => {
    const { fetcher, calls } = router(
      (url) =>
        url.includes('/createmeta/KEY/issuetypes')
          ? response({ issueTypes: [{ name: 'Story' }, { name: 'Task' }, { name: 'Epic' }] })
          : undefined,
      (url) =>
        url.includes('/project/KEY/statuses')
          ? response([
              {
                name: 'Story',
                statuses: [
                  { name: 'To Do', statusCategory: { key: 'new' } },
                  { name: 'Doing', statusCategory: { key: 'indeterminate' } },
                  { name: 'Shipped', statusCategory: { key: 'done' } },
                  { name: 'Odd' },
                ],
              },
            ])
          : undefined,
      (url) =>
        url.includes('/user/assignable/search')
          ? response([
              { accountId: 'acc-1', displayName: 'Ana Souza', emailAddress: 'ana@example.com' },
              { accountId: 'acc-2', displayName: 'Bruno' },
            ])
          : undefined,
      (url, init) =>
        url.endsWith('/rest/api/3/issue') && init?.method === 'POST'
          ? response({ id: '10', key: 'KEY-1' })
          : undefined,
      (url) =>
        url.includes('/issue/KEY-1?fields=status')
          ? response({ fields: { status: { name: 'To Do' } } })
          : undefined,
      (url, init) =>
        url.includes('/issue/KEY-1/transitions') && init?.method === 'POST'
          ? new Response(null, { status: 204 })
          : undefined,
      (url) =>
        url.includes('/issue/KEY-1/transitions')
          ? response({ transitions: [{ id: '31', to: { name: 'Shipped' } }] })
          : undefined,
    );
    const service = new PbiService(
      new InMemoryPbiStore(),
      await integrations('jira', {
        baseUrl: 'https://acme.atlassian.net',
        projectKey: 'KEY',
        email: 'bot@acme.com',
      }),
      fetcher,
    );
    const item = await service.create('ws', { kind: 'pbi', title: 'Story', status: 'Done' });
    const contract = await service.pushContract('ws', item.id, 'jira', {}, ana);
    expect(contract.fields.map((field) => [field.key, field.value])).toEqual([
      ['issueType', 'Story'],
      ['assignee', 'acc-1'],
      ['status', 'Shipped'],
    ]);
    const pushed = await service.push('ws', item.id, { providerId: 'jira' }, ana);
    expect(pushed.item.status).toBe('Shipped');
    expect(calls.find((call) => call.url.endsWith('/rest/api/3/issue'))!.body).toMatchObject({
      fields: { issuetype: { name: 'Story' }, assignee: { accountId: 'acc-1' } },
    });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { transition: { id: '31' } } });
  });

  it('updates linked issues and explains missing workflow transitions', async () => {
    let status = 'Doing';
    const { fetcher } = router(
      (url, init) =>
        url.endsWith('/issue/20') && init?.method === 'PUT'
          ? new Response(null, { status: 204 })
          : undefined,
      (url) =>
        url.includes('/issue/20?fields=key') ? response({ id: '20', key: 'K-2' }) : undefined,
      (url) =>
        url.includes('/issue/K-2?fields=status')
          ? response({ fields: { status: { name: status } } })
          : undefined,
      (url) =>
        url.includes('/issue/K-2/transitions')
          ? response({ transitions: [{ id: '1' }] })
          : undefined,
      (url, init) =>
        url.endsWith('/issue/21') && init?.method === 'PUT'
          ? response({ errors: { summary: 'too long' } }, 400)
          : undefined,
    );
    const jira = createPbiProvider(
      {
        id: 'jira',
        settings: { baseUrl: 'https://acme.atlassian.net', projectKey: 'K', email: 'e@x.io' },
        secret: 't',
      },
      fetcher,
    );
    const item = { kind: 'card' as const, title: 'T', description: '', status: 'New' };
    await expect(
      jira.push(item, { externalId: '20', fields: { status: 'Doing' } }),
    ).resolves.toMatchObject({
      status: 'Doing',
      sourceData: { key: 'K-2', type: 'Task' },
    });
    status = 'To Do';
    await expect(
      jira.push(item, { externalId: '20', fields: { status: 'Doing' } }),
    ).rejects.toThrow('Jira has no workflow transition to "Doing" for this issue.');
    await expect(jira.push(item, { externalId: '21' })).rejects.toMatchObject({
      messageParams: { detail: 'HTTP 400 - summary: too long' },
    });
    const failing = createPbiProvider(
      {
        id: 'jira',
        settings: { baseUrl: 'https://acme.atlassian.net', projectKey: 'K', email: 'e@x.io' },
        secret: 't',
      },
      router(
        (url) => (url.includes('fields=key') ? response({ id: '22', key: 'K-3' }) : undefined),
        (_url, init) => (init?.method === 'PUT' ? new Response(null, { status: 204 }) : undefined),
        (url) =>
          url.includes('?fields=status')
            ? response({ fields: { status: { name: 'A' } } })
            : undefined,
        (url, init) =>
          url.includes('/transitions') && init?.method === 'POST'
            ? response({ errorMessages: ['Not allowed'] }, 400)
            : undefined,
        (url) =>
          url.includes('/transitions')
            ? response({ transitions: [{ id: '5', to: { name: 'B' } }] })
            : undefined,
        (url) =>
          url.includes('/createmeta/') ? response({ values: [{ name: 'Task' }] }) : undefined,
        (url) => (url.includes('/statuses') ? response([]) : undefined),
        (url) => (url.includes('/assignable/') ? response([]) : undefined),
      ).fetcher,
    );
    await expect(
      failing.push(item, { externalId: '22', fields: { status: 'B' } }),
    ).rejects.toMatchObject({
      messageParams: { detail: 'HTTP 400 - Not allowed' },
    });
    const update = await failing.pushContract({
      item: { ...item, sourceData: { type: 'Task' } },
      values: {},
      assignee: null,
      externalId: '22',
    });
    expect(update.map((field) => [field.key, field.value, field.required])).toEqual([
      ['issueType', 'Task', true],
      ['assignee', '', false],
      ['status', '', true],
    ]);
  });
});

describe('GitHub Projects push contract', () => {
  const projects = {
    data: {
      user: null,
      organization: {
        projectsV2: {
          nodes: [
            {
              id: 'P1',
              number: 3,
              title: 'Roadmap',
              field: {
                id: 'F1',
                options: [
                  { id: 'o-todo', name: 'Todo' },
                  { id: 'o-doing', name: 'In Progress' },
                  { id: 'o-done', name: 'Done' },
                ],
              },
            },
            { id: 'P2', number: 4, title: 'Empty', field: null },
          ],
        },
      },
    },
    errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a User' }],
  };
  const github = () =>
    router((_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const query = body.query.replace(/\s+/g, '');
      if (query.includes('projectsV2(first:50)')) return response(projects);
      if (query.includes('fields(first:100)'))
        return response({
          data: {
            user: null,
            organization: {
              projectV2: { fields: { nodes: [{ id: 'F2', name: 'Notes', dataType: 'TEXT' }] } },
            },
          },
        });
      if (query.includes('repositoryOwner'))
        return response({
          data: { repositoryOwner: { repositories: { nodes: [{ nameWithOwner: 'acme/web' }] } } },
        });
      if (query.includes('assignableUsers'))
        return response({
          data: {
            repository: {
              assignableUsers: {
                nodes: [
                  { id: 'U1', login: 'ana', name: 'Ana Souza', email: null },
                  { id: 'U2', login: 'bot', name: null, email: 'bot@acme.io' },
                ],
              },
            },
          },
        });
      if (query.includes('repository(owner:$owner,name:$repo)'))
        return response({
          data: { repository: body.variables.repo === 'web' ? { id: 'R1' } : null },
        });
      if (query.includes('createIssue'))
        return response({ data: { createIssue: { issue: { id: 'I1', url: 'https://gh/i/1' } } } });
      if (query.includes('addSubIssue')) return response({ data: { addSubIssue: {} } });
      if (query.includes('addProjectV2ItemById'))
        return response({ data: { addProjectV2ItemById: { item: { id: 'PI1' } } } });
      if (query.includes('updateProjectV2ItemFieldValue'))
        return response({ data: { updateProjectV2ItemFieldValue: {} } });
      if (query.includes('updateProjectV2DraftIssue'))
        return response({ data: { updateProjectV2DraftIssue: { draftIssue: { id: 'D1' } } } });
      if (query.includes('updateIssue'))
        return response({ data: { updateIssue: { issue: { id: 'I1', url: 'https://gh/i/1' } } } });
      return response({ errors: [{ message: `Bad query ${query.slice(0, 80)}` }] });
    });

  it('asks for repository path and project, maps status and assignee, and publishes', async () => {
    const { fetcher, calls } = github();
    const service = new PbiService(
      new InMemoryPbiStore(),
      await integrations('github_projects', { owner: 'acme', projectNumber: '3' }),
      fetcher,
    );
    const item = await service.create('ws', { kind: 'pbi', title: 'Ship', status: 'Active' });
    const contract = await service.pushContract('ws', item.id, 'github_projects', {}, ana);
    expect(contract.fields.map((field) => [field.key, field.value, field.status])).toEqual([
      ['repository', '', 'empty'],
      ['project', '3', 'resolved'],
      ['status', 'o-doing', 'resolved'],
    ]);
    const withRepo = await service.pushContract(
      'ws',
      item.id,
      'github_projects',
      { repository: 'acme/web', project: '4' },
      ana,
    );
    expect(withRepo.fields.map((field) => [field.key, field.value])).toEqual([
      ['repository', 'acme/web'],
      ['project', '4'],
      ['assignee', 'U1'],
    ]);
    await expect(
      service.push('ws', item.id, { providerId: 'github_projects' }, ana),
    ).rejects.toMatchObject({ code: 'PBI_PUSH_FIELDS' });
    const pushed = await service.push(
      'ws',
      item.id,
      { providerId: 'github_projects', fields: { repository: 'acme/web' } },
      ana,
    );
    expect(pushed.item).toMatchObject({
      status: 'In Progress',
      sourceData: { projectItemId: 'PI1' },
    });
    const create = calls.find((call) =>
      (call.body as { query: string }).query.includes('createIssue'),
    )!;
    expect((create.body as { variables: unknown }).variables).toEqual({
      input: { repositoryId: 'R1', title: 'Ship', body: '', assigneeIds: ['U1'] },
    });
    expect(
      calls.some((call) =>
        (call.body as { query: string }).query.includes('updateProjectV2ItemFieldValue'),
      ),
    ).toBe(true);

    const card = await service.create('ws', { kind: 'card', title: 'Sub', parentId: item.id });
    await service.push('ws', card.id, {
      providerId: 'github_projects',
      fields: { repository: 'web', status: 'o-todo' },
    });
    expect(
      calls.some((call) => (call.body as { query: string }).query.includes('addSubIssue')),
    ).toBe(true);

    const again = await service.push('ws', item.id, {
      providerId: 'github_projects',
      fields: { status: 'o-done' },
    });
    expect(again.item.status).toBe('Done');
    const update = await service.pushContract('ws', item.id, 'github_projects');
    expect(update.fields[0]).toMatchObject({ key: 'repository', readOnly: true, required: false });
  });

  it('updates a GitHub Project draft issue and its mapped project field', async () => {
    const { fetcher, calls } = github();
    const provider = createPbiProvider(
      { id: 'github_projects', settings: { owner: 'acme', projectNumber: '3' }, secret: 't' },
      fetcher,
    );
    const result = await provider.push(
      {
        kind: 'card',
        title: 'Draft',
        description: 'Details',
        status: 'Todo',
        sourceData: { projectItemId: 'PI1', githubContentType: 'DraftIssue' },
      },
      {
        externalId: 'D1',
        fields: { status: 'o-done' },
        customFields: { F2: 'Text' },
        fieldDefinitions: [{ id: 'F2', name: 'Notes', type: 'text' }],
      },
    );
    expect(result).toMatchObject({
      externalId: 'D1',
      status: 'Done',
      sourceData: { projectItemId: 'PI1', githubContentType: 'DraftIssue' },
    });
    expect(
      calls.some((call) =>
        (call.body as { query: string }).query.includes('updateProjectV2DraftIssue'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => (call.body as { query: string }).query.includes('updateIssue(')),
    ).toBe(false);
    expect(
      calls.some((call) =>
        (call.body as { query: string }).query.includes('updateProjectV2ItemFieldValue'),
      ),
    ).toBe(true);
  });

  it('loads custom fields from the selected GitHub Project', async () => {
    const { fetcher, calls } = github();
    const provider = createPbiProvider(
      { id: 'github_projects', settings: { owner: 'acme', projectNumber: '3' }, secret: 't' },
      fetcher,
    );
    expect(await provider.listFields?.('4')).toEqual([{ id: 'F2', name: 'Notes', type: 'text' }]);
    const catalog = calls.find((call) =>
      (call.body as { query: string }).query.includes('fields(first: 100)'),
    );
    expect((catalog?.body as { variables: { number: number } }).variables.number).toBe(4);
  });

  it('rejects unknown projects or repositories and real GraphQL errors', async () => {
    const { fetcher } = github();
    const provider = createPbiProvider(
      {
        id: 'github_projects',
        settings: { owner: 'acme', projectNumber: '3', repo: 'web' },
        secret: 't',
      },
      fetcher,
    );
    const item = { kind: 'pbi' as const, title: 'T', description: '', status: 'New' };
    await expect(provider.push(item, { fields: { project: '9' } })).rejects.toThrow(
      'GitHub project was not found.',
    );
    await expect(provider.push(item, { fields: { repository: 'acme/api' } })).rejects.toThrow(
      'GitHub repository was not found.',
    );
    const linked = await provider.push(
      { ...item, sourceData: {} },
      { externalId: 'I1', fields: { status: 'o-done' } },
    );
    expect(linked).toMatchObject({
      status: 'Done',
      boardId: 'P1',
      sourceData: { projectItemId: 'PI1' },
    });
    const noRepo = createPbiProvider(
      { id: 'github_projects', settings: { owner: 'acme', projectNumber: '3' }, secret: 't' },
      fetcher,
    );
    await expect(noRepo.push(item, {})).rejects.toThrow(
      'Configure a repository for GitHub Projects push.',
    );
    const contract = await provider.pushContract({
      item: { ...item, sourceData: {} },
      values: {},
      assignee: null,
    });
    expect(contract[0]).toMatchObject({ key: 'repository', value: 'acme/web' });
    const broken = createPbiProvider(
      { id: 'github_projects', settings: { owner: 'acme', projectNumber: '3' }, secret: 't' },
      router(() => response({ errors: [{ message: 'Bad credentials' }] })).fetcher,
    );
    await expect(broken.pull()).rejects.toMatchObject({
      messageParams: { detail: 'Bad credentials' },
    });
    const empty = createPbiProvider(
      { id: 'github_projects', settings: { owner: 'acme', projectNumber: '3' }, secret: 't' },
      router(() => response({})).fetcher,
    );
    await expect(empty.pull()).rejects.toThrow('GitHub GraphQL failed.');
  });
});

describe('Trello push contract', () => {
  it('only asks for the board when publishing a PBI as a list', async () => {
    const { fetcher } = router((url) =>
      url.includes('/members/me/boards') ? response([{ id: 'x', name: 'X' }]) : undefined,
    );
    const trello = createPbiProvider(
      { id: 'trello', settings: { apiKey: 'k', boardId: 'b' }, secret: 't' },
      fetcher,
    );
    const fields = await trello.pushContract({
      item: { kind: 'card', title: 'T', status: 'New', sourceData: {} },
      values: {},
      assignee: null,
    });
    expect(fields).toEqual([
      expect.objectContaining({ key: 'board', value: '', status: 'empty', required: true }),
    ]);
    await expect(
      trello.push({ kind: 'card', title: 'T', description: '', status: 'New' }, {}),
    ).rejects.toThrow('Select a Trello list or push the parent PBI first.');
  });
});
