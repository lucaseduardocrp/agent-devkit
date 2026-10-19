import { describe, expect, it, vi } from 'vitest';
import { createPbiProvider, type PbiProvider } from '../src/modules/pbi/providers.js';
import type { PushContext } from '../src/modules/pbi/push-contract.js';

type Body = Record<string, unknown> & { query?: string; ids?: number[] };
type Handler = (url: string, body: Body) => unknown;
interface Call {
  url: string;
  method: string;
  body: unknown;
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A fake fetch that answers the first route whose pattern is contained in the URL. */
function fakeFetch(routes: [string, unknown][]) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = (init.body ? JSON.parse(String(init.body)) : {}) as Body;
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? body : undefined });
    const route = routes.find(([pattern]) => url.includes(pattern));
    if (!route) throw new Error(`Unexpected request ${url}`);
    const result =
      typeof route[1] === 'function' ? await (route[1] as Handler)(url, body) : route[1];
    return result instanceof Response ? result : json(result);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}
function azure(routes: [string, unknown][]): { provider: PbiProvider; calls: Call[] } {
  const { fetcher, calls } = fakeFetch(routes);
  return {
    provider: createPbiProvider(
      { id: 'azure_devops', settings: { organization: 'org', project: "Pro'ject" }, secret: 'pat' },
      fetcher,
    ),
    calls,
  };
}
const workItem = (id: number | string) => `https://dev.azure.com/org/_apis/wit/workItems/${id}`;
const tooBusy = () =>
  json({ message: 'VS402337: The number of work items returned exceeds the size limit.' }, 400);
const range = (query: string) => {
  const match = /> (\d+) AND \[(?:Source\]\.\[)?System\.Id\] <= (\d+)/.exec(query)!;
  return `${match[1]}-${match[2]}`;
};

describe('createPbiProvider configuration', () => {
  it('rejects missing credentials, settings and unknown providers', () => {
    expect(() => createPbiProvider({ id: 'azure_devops', settings: {}, secret: '' })).toThrow(
      'Provider credential is missing.',
    );
    expect(() =>
      createPbiProvider({ id: 'azure_devops', settings: { organization: 'o' }, secret: 's' }),
    ).toThrow('Azure organization and project are required.');
    expect(() =>
      createPbiProvider({
        id: 'azure_devops',
        settings: { organization: 3, project: 'p' },
        secret: 's',
      }),
    ).toThrow('Azure organization and project are required.');
    expect(() => createPbiProvider({ id: 'monday', settings: {}, secret: 's' })).toThrow(
      'Unsupported board provider: monday',
    );
  });
});

describe('Azure DevOps provider', () => {
  it('reads the current iteration, or null when Azure has none', async () => {
    expect(
      await azure([['iterations?', { values: [{ path: 'P\\Sprint 1' }] }]]).provider
        .currentIteration!(),
    ).toBe('P\\Sprint 1');
    expect(await azure([['iterations?', {}]]).provider.currentIteration!()).toBeNull();
    expect(
      await azure([['iterations?', { values: [{}] }]]).provider.currentIteration!(),
    ).toBeNull();
  });

  it('pages comments, skipping deleted ones and filling defaults', async () => {
    const { provider, calls } = azure([
      [
        '/comments?',
        (url: string) =>
          url.includes('continuationToken=next')
            ? {
                comments: [{ id: 3, text: 'plain', createdDate: '2026-01-02' }],
                continuationToken: null,
              }
            : {
                comments: [
                  {
                    commentId: 1,
                    renderedText: '<p>hi</p>',
                    createdDate: '2026-01-01',
                    createdBy: { displayName: 'Ann' },
                  },
                  { commentId: 2, isDeleted: true, createdDate: '2026-01-01' },
                  { commentId: 4, createdDate: '2026-01-03' },
                ],
                continuationToken: 'next',
              },
      ],
    ]);
    expect(await provider.comments!('7')).toEqual([
      { id: '1', body: '<p>hi</p>', author: 'Ann', createdAt: '2026-01-01' },
      { id: '4', body: '', author: 'Azure DevOps', createdAt: '2026-01-03' },
      { id: '3', body: 'plain', author: 'Azure DevOps', createdAt: '2026-01-02' },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('stops when Azure repeats a comment page token', async () => {
    const { provider } = azure([['/comments?', { comments: [], continuationToken: 'same' }]]);
    await expect(provider.comments!('7')).rejects.toMatchObject({
      code: 'PBI_PROVIDER_ERROR',
      message: 'Repeated comment page token.',
    });
  });

  it('pulls work items in split ranges with hierarchy, related and typed links', async () => {
    const rows: Record<number, unknown> = {
      1: {
        id: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.Title': 'Epic work',
          'System.Description': '<p>Desc</p>',
          'System.State': 'Active',
          'System.IterationPath': 'P\\Sprint 1',
          'System.AreaPath': 'P',
          'System.Tags': 'a; b',
          'System.AssignedTo': { uniqueName: 'ann@example.test' },
        },
        relations: [
          { rel: 'System.LinkTypes.Hierarchy-Forward', url: workItem(2) },
          { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${workItem('')}` },
          { rel: 'System.LinkTypes.Related', url: workItem(3) },
          { rel: 'System.LinkTypes.Related', url: workItem(1) },
          { rel: 'System.LinkTypes.Related', url: workItem('') },
          { rel: 'System.LinkTypes.Dependency-Forward', url: workItem(4) },
          { rel: 'System.LinkTypes.Dependency-Forward', url: workItem(3) },
          { rel: 'Microsoft.VSTS.Common.TestedBy-Forward', url: workItem('') },
          { rel: 'AttachedFile', url: 'https://files/x' },
        ],
      },
      2: {
        id: 2,
        fields: { 'System.WorkItemType': 'Task', 'System.Title': 'Do it', 'System.Parent': 1 },
      },
      3: {
        id: 3,
        fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'Broken', 'System.State': 'New' },
        relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: workItem(1) }],
      },
      4: { id: 4, fields: { 'System.WorkItemType': 'Test Case', 'System.Title': 'Check' } },
    };
    const extras = [
      { id: 5, fields: { 'System.WorkItemType': 'User Story', 'System.Title': ' Excluir ' } },
      {
        id: 7,
        fields: {
          'System.WorkItemType': 'User Story',
          'System.Title': 'Story',
          'System.Parent': 'abc',
          'System.IterationPath': 'P\\Sprint 0',
        },
      },
      {
        id: 8,
        fields: {
          'System.Title': 'Orphan',
          'System.Parent': { id: 1 },
          'System.AssignedTo': { displayName: 'No unique name' },
        },
      },
    ];
    const busyItems = new Set(['0-4']);
    const busyLinks = new Set(['0-4']);
    const { provider, calls } = azure([
      ['iterations?', { values: [{ path: 'P\\Sprint 1' }] }],
      ['$top=1', { workItems: [{ id: 4 }] }],
      [
        '/wiql?',
        (_url: string, body: Body) => {
          const key = range(body.query!);
          if (body.query!.includes('FROM WorkItemLinks')) {
            if (busyLinks.delete(key)) return tooBusy();
            if (key === '0-2') return {};
            if (key === '2-4') return { workItemRelations: Array(20000).fill({}) };
            if (key === '2-3')
              return {
                workItemRelations: [
                  { target: { id: 1 } },
                  { source: { id: 1 }, target: { id: 8 } },
                  { source: { id: 7 }, target: { id: 3 }, rel: 'System.LinkTypes.Related' },
                ],
              };
            return {
              workItemRelations: [
                {
                  source: { id: 3 },
                  target: { id: 7 },
                  rel: 'System.LinkTypes.Dependency-Forward',
                },
              ],
            };
          }
          if (busyItems.delete(key)) return tooBusy();
          if (key === '0-2') return { workItems: [{ id: 1 }, { id: 2 }] };
          if (key === '2-4') return { workItems: Array(20000).fill({ id: 3 }) };
          if (key === '2-3') return { workItems: [{ id: 3 }] };
          return { workItems: [{ id: 4 }] };
        },
      ],
      [
        '/workitemsbatch',
        (_url: string, body: Body) => ({
          value: [...body.ids!.map((id) => rows[id]), ...(body.ids!.includes(4) ? extras : [])],
        }),
      ],
    ]);
    const items = await provider.pull();
    const byId = Object.fromEntries(items.map((item) => [item.externalId, item]));
    expect(Object.keys(byId).sort()).toEqual(['1', '2', '3', '7', '8']);
    expect(byId['1']).toMatchObject({
      parentExternalId: null,
      kind: 'pbi',
      status: 'Active',
      externalUrl: "https://dev.azure.com/org/Pro'ject/_workitems/edit/1",
      boardId: "Pro'ject",
      sourceData: {
        type: 'Product Backlog Item',
        currentIteration: true,
        assignedTo: 'ann@example.test',
        relatedExternalIds: ['3'],
        externalLinks: [
          { type: 'successor', externalId: '4' },
          { type: 'successor', externalId: '3' },
        ],
      },
    });
    expect(byId['2']).toMatchObject({ parentExternalId: '1', kind: 'card', status: 'backlog' });
    expect(byId['3']).toMatchObject({
      parentExternalId: '1',
      kind: 'card',
      sourceData: { relatedExternalIds: ['1', '7'] },
    });
    expect(byId['3']!.sourceData).not.toHaveProperty('externalLinks');
    expect(byId['7']).toMatchObject({ parentExternalId: 'abc', kind: 'pbi' });
    expect(byId['7']!.sourceData).not.toHaveProperty('currentIteration');
    expect(byId['8']).toMatchObject({ parentExternalId: '1', title: 'Orphan' });
    expect(byId['8']!.sourceData).not.toHaveProperty('assignedTo');
    const wiql = calls.filter((call) => call.url.includes('/wiql?'));
    expect((wiql[0]!.body as Body).query).toContain("'Pro''ject'");
  });

  it('pulls nothing for an empty project and ignores iteration lookup failures', async () => {
    const { provider, calls } = azure([
      ['iterations?', json({ message: 'down' }, 500)],
      ['$top=1', { workItems: [] }],
    ]);
    expect(await provider.pull()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('skips the link query when only cards were pulled', async () => {
    const { provider, calls } = azure([
      ['iterations?', {}],
      ['$top=1', { workItems: [{ id: 1 }] }],
      ['/wiql?', { workItems: [{ id: 1 }] }],
      [
        '/workitemsbatch',
        { value: [{ id: 1, fields: { 'System.WorkItemType': 'Task', 'System.Title': 'T' } }] },
      ],
    ]);
    expect(await provider.pull()).toEqual([
      expect.objectContaining({ externalId: '1', kind: 'card', sourceData: expect.any(Object) }),
    ]);
    expect(calls.filter((call) => call.url.includes('/wiql?'))).toHaveLength(2);
  });

  describe('rethrows range failures that splitting cannot fix', () => {
    const cases: [string, () => unknown, string | RegExp][] = [
      ['unrelated provider errors', () => json({ message: 'TF401019 denied' }, 403), /TF401019/],
      ['network errors', () => Promise.reject(new TypeError('socket hang up')), 'socket hang up'],
      ['a single id range that is still too large', tooBusy, /VS402337/],
    ];
    it.each(cases)('work item query: %s', async (_name, failure, message) => {
      const { provider } = azure([
        ['iterations?', {}],
        ['$top=1', { workItems: [{ id: 1 }] }],
        ['/wiql?', failure],
      ]);
      await expect(provider.pull()).rejects.toThrow(message);
    });
    it.each(cases)('link query: %s', async (_name, failure, message) => {
      const { provider } = azure([
        ['iterations?', {}],
        ['$top=1', { workItems: [{ id: 1 }] }],
        [
          '/wiql?',
          (_url: string, body: Body) =>
            body.query!.includes('WorkItemLinks') ? failure() : { workItems: [{ id: 1 }] },
        ],
        ['/workitemsbatch', { value: [{ id: 1, fields: { 'System.Title': 'PBI' } }] }],
      ]);
      await expect(provider.pull()).rejects.toThrow(message);
    });
  });

  it('pulls the descendants of an item breadth first without revisiting items', async () => {
    const { provider, calls } = azure([
      [
        '/workitems/10?',
        {
          relations: [
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: workItem(11) },
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: workItem(11) },
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: workItem(10) },
            { rel: 'System.LinkTypes.Related', url: workItem(99) },
          ],
        },
      ],
      [
        '/workitemsbatch',
        (_url: string, body: Body) => ({
          value: body.ids!.includes(11)
            ? [
                {
                  id: 11,
                  fields: { 'System.Title': 'Child', 'System.State': 'Done' },
                  relations: [
                    { rel: 'System.LinkTypes.Hierarchy-Forward', url: workItem(12) },
                    { rel: 'System.LinkTypes.Hierarchy-Forward', url: workItem(10) },
                    { rel: 'System.LinkTypes.Related', url: workItem(99) },
                  ],
                },
                { id: 13, fields: { 'System.Title': 'excluir' } },
              ]
            : [
                { id: 12, fields: { 'System.Title': 'Grandchild' } },
                { id: 14, fields: { 'System.WorkItemType': 'Test Case', 'System.Title': 'TC' } },
              ],
        }),
      ],
    ]);
    const items = await provider.pullChildren!('10');
    expect(items).toEqual([
      expect.objectContaining({
        externalId: '11',
        parentExternalId: '10',
        kind: 'card',
        status: 'Done',
        sourceData: expect.objectContaining({ relatedExternalIds: ['99'] }),
      }),
      expect.objectContaining({
        externalId: '12',
        parentExternalId: '11',
        status: 'backlog',
        sourceData: expect.objectContaining({ relatedExternalIds: [] }),
      }),
    ]);
    expect(calls.filter((call) => call.url.includes('workitemsbatch'))).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ ids: [11], errorPolicy: 'Omit' });
  });

  it('returns no descendants for an item without relations', async () => {
    const { provider } = azure([['/workitems/10?', {}]]);
    expect(await provider.pullChildren!('10')).toEqual([]);
  });

  describe('push contract', () => {
    const metadata = (overrides: Record<string, unknown> = {}): [string, unknown][] => [
      [
        '/members?',
        overrides.members ?? {
          value: [
            { identity: { displayName: 'Bea', uniqueName: 'bea@example.test' } },
            { identity: { uniqueName: ' ann@example.test ' } },
            { identity: { displayName: 'Nobody' } },
            {},
          ],
        },
      ],
      ['/teams?', overrides.teams ?? { value: [{ id: 't1' }, { id: 't2' }] }],
      [
        '/workitemtypes?',
        {
          value: [
            {
              name: 'Product Backlog Item',
              states: [
                { name: 'New', category: 'Proposed' },
                { name: 'Committed', category: 'InProgress' },
                { name: 'Shipped', category: 'Completed' },
                { name: 'Odd' },
              ],
            },
            { name: 'Task' },
            { name: 'Bug', isDisabled: true },
            { name: 'Test Case' },
          ],
        },
      ],
      [
        'classificationnodes/iterations',
        {
          name: 'P',
          children: [
            {
              name: 'Sprint 1',
              attributes: { startDate: '2026-01-01T00:00:00Z', finishDate: '2026-01-14T00:00:00Z' },
            },
            { name: 'Sprint 2', attributes: { startDate: '2026-01-15T00:00:00Z' } },
          ],
        },
      ],
      ['classificationnodes/areas', overrides.areas ?? { name: 'P', children: [{ name: 'Web' }] }],
      ['iterations?', overrides.current ?? { values: [{ path: 'P\\Sprint 1' }] }],
    ];
    const context = (overrides: Partial<PushContext> = {}): PushContext => ({
      item: { kind: 'pbi', title: 'T', status: 'In progress', sourceData: {} },
      values: {},
      assignee: { name: 'Ann', email: 'ann@example.test' },
      ...overrides,
    });

    it('suggests types, paths, assignee and state for a new item', async () => {
      const { provider } = azure(metadata());
      const fields = await provider.pushContract(
        context({
          item: {
            kind: 'pbi',
            title: 'T',
            status: 'In progress',
            sourceData: { iterationPath: 'P\\Sprint 2', areaPath: 'P\\Web' },
          },
        }),
      );
      const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
      expect(byKey.workItemType).toMatchObject({
        value: 'Product Backlog Item',
        options: [
          { value: 'Product Backlog Item', label: 'Product Backlog Item' },
          { value: 'Task', label: 'Task' },
        ],
        reloadOnChange: true,
      });
      expect(byKey.workItemType).not.toHaveProperty('readOnly');
      expect(byKey.iterationPath!.options).toEqual([
        { value: 'P', label: 'P', detail: '' },
        { value: 'P\\Sprint 1', label: 'P\\Sprint 1', detail: '2026-01-01 → 2026-01-14 · current' },
        { value: 'P\\Sprint 2', label: 'P\\Sprint 2', detail: '' },
      ]);
      expect(byKey.iterationPath!.value).toBe('P\\Sprint 2');
      expect(byKey.areaPath!.value).toBe('P\\Web');
      expect(byKey.assignee).toMatchObject({
        required: true,
        value: 'ann@example.test',
        source: 'Ann <ann@example.test>',
        options: [
          { value: 'ann@example.test', label: 'ann@example.test', detail: 'ann@example.test' },
          { value: 'bea@example.test', label: 'Bea', detail: 'bea@example.test' },
        ],
      });
      expect(byKey.state).toMatchObject({ value: 'Committed', source: 'In progress' });
    });

    it('keeps the linked type read-only and falls back to defaults on updates', async () => {
      const { provider } = azure(
        metadata({ teams: {}, current: json({}, 500), areas: { name: 'P' } }),
      );
      const fields = await provider.pushContract(
        context({
          externalId: '5',
          item: { kind: 'card', title: 'T', status: 'x', sourceData: { type: 'Task' } },
          values: { workItemType: 'Product Backlog Item' },
          assignee: { name: 'Zed', email: '' },
        }),
      );
      const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
      expect(byKey.workItemType).toMatchObject({ value: 'Task', readOnly: true });
      expect(byKey.iterationPath).toMatchObject({ value: '' });
      expect(
        byKey.iterationPath!.options.every((option) => !option.detail?.includes('current')),
      ).toBe(true);
      expect(byKey.areaPath!.value).toBe('P');
      expect(byKey.assignee).toMatchObject({ value: '', source: 'Zed', options: [] });
      expect(byKey.state).toMatchObject({ value: '', options: [] });
    });

    it('suggests a card type and leaves paths empty without matches', async () => {
      const { provider } = azure(metadata({ areas: { name: 'P' } }));
      const fields = await provider.pushContract(
        context({
          item: { kind: 'card', title: 'T', status: 'x', sourceData: { adkCardType: 'Nope' } },
          assignee: null,
        }),
      );
      const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
      expect(byKey.workItemType!.value).toBe('Task');
      expect(byKey.assignee).toMatchObject({ required: false, value: '' });
      expect(byKey.assignee).not.toHaveProperty('source');
    });

    it('returns an empty area suggestion when Azure has no area nodes', async () => {
      const { provider } = azure(metadata({ areas: json({ message: 'no areas' }, 500) }));
      await expect(provider.pushContract(context())).rejects.toThrow('HTTP 500 - no areas');
    });
  });

  describe('push', () => {
    const row = (id: number, state?: string) => ({
      id,
      ...(state ? { fields: { 'System.State': state } } : {}),
    });

    it('creates a work item under its parent and moves it to the chosen state', async () => {
      const { provider, calls } = azure([
        ['$Product%20Backlog%20Item?', row(30, 'New')],
        ['/workitems/30?', row(30, 'Committed')],
      ]);
      const result = await provider.push(
        { kind: 'pbi', title: 'T', description: 'D', status: 'todo' },
        {
          parentExternalId: '9',
          fields: {
            workItemType: 'Product Backlog Item',
            iterationPath: 'P\\Sprint 1',
            areaPath: 'P',
            assignee: 'ann@example.test',
            state: 'Committed',
          },
        },
      );
      expect(result).toMatchObject({
        externalId: '30',
        parentExternalId: '9',
        status: 'Committed',
        sourceData: {
          type: 'Product Backlog Item',
          iterationPath: 'P\\Sprint 1',
          areaPath: 'P',
          assignedTo: 'ann@example.test',
        },
      });
      expect(calls[0]!.method).toBe('POST');
      expect(calls[0]!.body).toEqual([
        { op: 'add', path: '/fields/System.Title', value: 'T' },
        { op: 'add', path: '/fields/System.Description', value: 'D' },
        { op: 'add', path: '/fields/System.IterationPath', value: 'P\\Sprint 1' },
        { op: 'add', path: '/fields/System.AreaPath', value: 'P' },
        { op: 'add', path: '/fields/System.AssignedTo', value: 'ann@example.test' },
        {
          op: 'add',
          path: '/relations/-',
          value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: workItem(9) },
        },
      ]);
      expect(calls[1]).toMatchObject({
        method: 'PATCH',
        body: [{ op: 'add', path: '/fields/System.State', value: 'Committed' }],
      });
    });

    it('skips the state move when the new item already has it', async () => {
      const { provider, calls } = azure([['$Task?', row(31, 'To Do')]]);
      const result = await provider.push(
        { kind: 'card', title: 'T', description: '', status: 'todo' },
        { fields: { state: 'To Do' } },
      );
      expect(result).toMatchObject({ status: 'To Do', sourceData: { type: 'Task' } });
      expect(calls).toHaveLength(1);
    });

    it('picks the type from options, source data or the kind', async () => {
      const { provider, calls } = azure([
        ['$Bug?', row(1)],
        ['$Feature?', row(2)],
        ['$Product%20Backlog%20Item?', row(3)],
      ]);
      const pushed = await provider.push(
        { kind: 'card', title: 'T', description: '', status: 'todo' },
        { issueType: 'Bug' },
      );
      expect(pushed.status).toBe('todo');
      await provider.push(
        {
          kind: 'card',
          title: 'T',
          description: '',
          status: 'todo',
          sourceData: { type: 'Feature' },
        },
        {},
      );
      await provider.push({ kind: 'pbi', title: 'T', description: '', status: 'todo' }, {});
      expect(calls.map((call) => call.url)).toEqual([
        expect.stringContaining('$Bug?'),
        expect.stringContaining('$Feature?'),
        expect.stringContaining('$Product%20Backlog%20Item?'),
      ]);
    });

    it('updates a linked work item in place, including its state', async () => {
      const { provider, calls } = azure([['/workitems/77?', row(77)]]);
      const result = await provider.push(
        { kind: 'pbi', title: 'T', description: '', status: 'todo' },
        { externalId: '77', parentExternalId: '9', fields: { state: 'Done' } },
      );
      expect(result).toMatchObject({ externalId: '77', status: 'Done' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe('PATCH');
      expect(calls[0]!.body).toContainEqual({
        op: 'add',
        path: '/fields/System.State',
        value: 'Done',
      });
      expect(JSON.stringify(calls[0]!.body)).not.toContain('Hierarchy-Reverse');
    });
  });

  describe('syncLinks', () => {
    it('does nothing without links', async () => {
      const { provider, calls } = azure([]);
      await provider.syncLinks!('5', []);
      expect(calls).toHaveLength(0);
    });

    it('adds only missing, distinct links', async () => {
      const { provider, calls } = azure([
        [
          '$expand=relations',
          { relations: [{ rel: 'System.LinkTypes.Related', url: workItem(6) }] },
        ],
        ['/workitems/5?', {}],
      ]);
      await provider.syncLinks!('5', [
        { type: 'related', externalId: '6' },
        { type: 'successor', externalId: '7' },
        { type: 'successor', externalId: '7' },
      ]);
      expect(calls[1]).toMatchObject({
        method: 'PATCH',
        body: [
          {
            op: 'add',
            path: '/relations/-',
            value: { rel: 'System.LinkTypes.Dependency-Forward', url: workItem(7) },
          },
        ],
      });
    });

    it('skips the update when every link already exists or the item has no relations', async () => {
      const existing = azure([
        [
          '$expand=relations',
          { relations: [{ rel: 'System.LinkTypes.Related', url: workItem(6) }] },
        ],
      ]);
      await existing.provider.syncLinks!('5', [{ type: 'related', externalId: '6' }]);
      expect(existing.calls).toHaveLength(1);
      const bare = azure([
        ['$expand=relations', {}],
        ['/workitems/5?', {}],
      ]);
      await bare.provider.syncLinks!('5', [{ type: 'tests', externalId: '8' }]);
      expect(bare.calls).toHaveLength(2);
    });
  });
});
