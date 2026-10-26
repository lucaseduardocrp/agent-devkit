import { describe, expect, it, vi } from 'vitest';
import { createPbiProvider, type PbiProvider } from '../src/modules/pbi/providers.js';
import type { PushContext, PushField } from '../src/modules/pbi/push-contract.js';

type Body = Record<string, unknown>;
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
const context = (overrides: Partial<PushContext> = {}): PushContext => ({
  item: { kind: 'pbi', title: 'T', status: 'New', sourceData: {} },
  values: {},
  assignee: null,
  ...overrides,
});
const byKey = (fields: PushField[]): Record<string, PushField> =>
  Object.fromEntries(fields.map((field) => [field.key, field]));

describe('provider errors', () => {
  it('reports only the HTTP status when the error body is empty', async () => {
    const { fetcher } = fakeFetch([['iterations?', new Response('', { status: 503 })]]);
    const provider = createPbiProvider(
      { id: 'azure_devops', settings: { organization: 'org', project: 'P' }, secret: 'pat' },
      fetcher,
    );
    await expect(provider.currentIteration!()).rejects.toMatchObject({
      code: 'PBI_PROVIDER_ERROR',
      messageParams: { detail: 'HTTP 503' },
    });
  });
});

describe('Azure DevOps provider (custom fields)', () => {
  function azure(routes: [string, unknown][]): { provider: PbiProvider; calls: Call[] } {
    const { fetcher, calls } = fakeFetch(routes);
    return {
      provider: createPbiProvider(
        { id: 'azure_devops', settings: { organization: 'org', project: 'P' }, secret: 'pat' },
        fetcher,
      ),
      calls,
    };
  }
  const customFields = {
    'System.Title': 'Title',
    'System.State': 'Active',
    'System.WorkItemType': 'Product Backlog Item',
    'Microsoft.VSTS.TCM.Steps': '<steps/>',
    'Custom.Score': 5,
    'Custom.Flag': true,
    'Custom.Text': 'note',
    'Custom.Empty': null,
    'Custom.Person': { displayName: 'Ann' },
  };
  const mirrored = {
    'Custom.Score': 5,
    'Custom.Flag': true,
    'Custom.Text': 'note',
    'Custom.Empty': null,
  };

  it('lists the editable fields of a work item type with their catalog details', async () => {
    const { provider, calls } = azure([
      [
        '/workitemtypes/Bug/fields?',
        {
          value: [
            { name: 'Title', referenceName: 'System.Title', alwaysRequired: true },
            { name: 'Steps', referenceName: 'Microsoft.VSTS.TCM.Steps' },
            {
              name: 'Severity',
              referenceName: 'Custom.Severity',
              alwaysRequired: true,
              allowedValues: ['1 - Critical', '2 - High'],
            },
            { name: 'Points', referenceName: 'Custom.Points', allowedValues: [] },
            { name: 'Blocked', referenceName: 'Custom.Blocked' },
            { name: 'Due', referenceName: 'Custom.Due' },
            { name: 'Notes', referenceName: 'Custom.Notes' },
          ],
        },
      ],
      [
        '/_apis/wit/fields?',
        {
          value: [
            { referenceName: 'Custom.Points', type: 'double', readOnly: true },
            { referenceName: 'Custom.Blocked', type: 'boolean' },
            { referenceName: 'Custom.Due', type: 'dateTime' },
            { referenceName: 'Custom.Severity', type: 'string' },
          ],
        },
      ],
    ]);
    expect(await provider.listFields!('', 'Bug')).toEqual([
      {
        id: 'Custom.Severity',
        name: 'Severity',
        type: 'single_select',
        required: true,
        readOnly: false,
        options: [
          { id: '1 - Critical', name: '1 - Critical' },
          { id: '2 - High', name: '2 - High' },
        ],
      },
      { id: 'Custom.Points', name: 'Points', type: 'number', required: false, readOnly: true },
      { id: 'Custom.Blocked', name: 'Blocked', type: 'boolean', required: false, readOnly: false },
      { id: 'Custom.Due', name: 'Due', type: 'date', required: false, readOnly: false },
      { id: 'Custom.Notes', name: 'Notes', type: 'text', required: false, readOnly: false },
    ]);
    expect(calls[1]!.url).toBe('https://dev.azure.com/org/_apis/wit/fields?api-version=7.1');
  });

  it('defaults to the Test Case type and tolerates empty responses', async () => {
    const { provider, calls } = azure([
      ['/workitemtypes/', {}],
      ['/_apis/wit/fields?', {}],
    ]);
    expect(await provider.listFields!()).toEqual([]);
    expect(calls[0]!.url).toContain(
      '/_apis/wit/workitemtypes/Test%20Case/fields?$expand=allowedValues&api-version=7.1',
    );
  });

  it('mirrors scalar custom fields when pulling work items', async () => {
    const { provider } = azure([
      ['iterations?', { values: [] }],
      [
        '/wiql?',
        (_url: string, body: Body) =>
          String(body.query).includes('WorkItemLinks')
            ? { workItemRelations: [] }
            : { workItems: [{ id: 7 }] },
      ],
      ['/workitemsbatch?', { value: [{ id: 7, url: 'u', fields: customFields }] }],
    ]);
    const [item] = await provider.pull();
    expect(item!.sourceData.customFields).toEqual({ azure_devops: mirrored });
    expect(item!.parentExternalId).toBeNull();
  });

  it('skips malformed child links and keeps rows Azure returned unasked', async () => {
    const { provider, calls } = azure([
      ['/workitemsbatch?', { value: [{ id: 99, fields: customFields }] }],
      [
        '/workitems/1?',
        {
          relations: [
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://x/workItems/' },
            { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://x/workItems/2' },
          ],
        },
      ],
    ]);
    const items = await provider.pullChildren!('1');
    expect(items).toEqual([
      expect.objectContaining({
        externalId: '99',
        parentExternalId: null,
        sourceData: expect.objectContaining({ customFields: { azure_devops: mirrored } }),
      }),
    ]);
    expect(calls.filter((call) => call.url.includes('workitemsbatch'))).toHaveLength(1);
    expect(calls[1]!.body).toMatchObject({ ids: [2] });
  });

  it('ignores a malformed only child link without querying the batch endpoint', async () => {
    const { provider, calls } = azure([
      [
        '/workitems/1?',
        { relations: [{ rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://x/' }] },
      ],
    ]);
    expect(await provider.pullChildren!('1')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('builds a contract without type, area or member matches', async () => {
    const { provider } = azure([
      ['/members?', {}],
      ['/teams?', { value: [{ id: 't1' }] }],
      ['/workitemtypes?', { value: [{ name: 'Product Backlog Item' }] }],
      ['classificationnodes/iterations', { name: 'P' }],
      ['classificationnodes/areas', {}],
      ['iterations?', { values: [] }],
    ]);
    const fields = byKey(
      await provider.pushContract(
        context({
          externalId: '5',
          item: { kind: 'pbi', title: 'T', status: 'New', sourceData: {} },
        }),
      ),
    );
    expect(fields.workItemType).toMatchObject({ value: '', readOnly: true });
    expect(fields.areaPath).toMatchObject({ value: '' });
    expect(fields.assignee).toMatchObject({ options: [], value: '' });
  });

  it('writes mapped custom fields into the work item patch', async () => {
    const { provider, calls } = azure([['/workitems/', { id: 8, fields: {} }]]);
    const remote = await provider.push(
      { kind: 'pbi', title: 'T', description: 'D', status: 'New' },
      { customFields: { 'Custom.Score': 3, 'Custom.Tags': ['a', 'b'] } },
    );
    expect(remote.externalId).toBe('8');
    expect(calls[0]!.body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/System.Description', value: 'D' },
      { op: 'add', path: '/fields/Custom.Score', value: 3 },
      { op: 'add', path: '/fields/Custom.Tags', value: ['a', 'b'] },
    ]);
  });
});

describe('Trello provider', () => {
  const settings = { apiKey: 'key', boardId: 'board1' };
  function trello(routes: [string, unknown][]) {
    const { fetcher, calls } = fakeFetch(routes);
    return {
      provider: createPbiProvider({ id: 'trello', settings, secret: 'tok' }, fetcher),
      calls,
    };
  }

  it('requires the API key and board', () => {
    expect(() =>
      createPbiProvider({ id: 'trello', settings: { apiKey: 'key' }, secret: 'tok' }),
    ).toThrow('Trello API key and board ID are required.');
    expect(() =>
      createPbiProvider({ id: 'trello', settings: { boardId: 'b' }, secret: 'tok' }),
    ).toThrow('Trello API key and board ID are required.');
  });

  it('lists custom fields of the configured or selected board', async () => {
    const { provider, calls } = trello([
      [
        '/customFields?',
        [
          { id: 'n', name: 'Points', type: 'number' },
          { id: 'c', name: 'Done', type: 'checkbox' },
          { id: 'd', name: 'Due', type: 'date' },
          { id: 't', name: 'Notes', type: 'text' },
          {
            id: 'l',
            name: 'Size',
            type: 'list',
            options: [{ id: 'o1', value: { text: 'Small' } }, { id: 'o2' }],
          },
          { id: 'e', name: 'Empty', type: 'list' },
        ],
      ],
    ]);
    expect(await provider.listFields!()).toEqual([
      { id: 'n', name: 'Points', type: 'number' },
      { id: 'c', name: 'Done', type: 'boolean' },
      { id: 'd', name: 'Due', type: 'date' },
      { id: 't', name: 'Notes', type: 'text' },
      {
        id: 'l',
        name: 'Size',
        type: 'single_select',
        options: [
          { id: 'o1', name: 'Small' },
          { id: 'o2', name: 'o2' },
        ],
      },
      { id: 'e', name: 'Empty', type: 'single_select', options: [] },
    ]);
    await provider.listFields!('other');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.trello.com/1/boards/board1/customFields?key=key&token=tok',
      'https://api.trello.com/1/boards/other/customFields?key=key&token=tok',
    ]);
  });

  it('pulls lists as PBIs and cards with their custom field values', async () => {
    const { provider } = trello([
      ['/lists?', [{ id: 'L1', name: 'Todo', pos: 1, closed: false }]],
      [
        '/cards?',
        [
          {
            id: 'C1',
            idList: 'L1',
            name: 'Card',
            desc: 'Body',
            pos: 2,
            url: 'https://trello.test/c/C1',
            closed: false,
            customFieldItems: [
              { idCustomField: 'select', idValue: 'opt' },
              { idCustomField: 'text', value: { text: 'hello' } },
              { idCustomField: 'date', value: { date: '2026-01-01' } },
              { idCustomField: 'number', value: { number: '4.5' } },
              { idCustomField: 'yes', value: { checked: 'true' } },
              { idCustomField: 'no', value: { checked: 'false' } },
              { idCustomField: 'blank', value: {} },
              { idCustomField: 'none' },
            ],
          },
          {
            id: 'C2',
            idList: 'L1',
            name: 'Plain',
            desc: '',
            pos: 3,
            url: 'u2',
            closed: false,
          },
        ],
      ],
    ]);
    const [list, card, plain] = await provider.pull();
    expect(list).toMatchObject({ externalId: 'L1', kind: 'pbi', title: 'Todo', boardId: 'board1' });
    expect(card).toMatchObject({
      externalId: 'C1',
      parentExternalId: 'L1',
      kind: 'card',
      externalUrl: 'https://trello.test/c/C1',
    });
    expect(card!.sourceData.customFields).toEqual({
      trello: {
        select: 'opt',
        text: 'hello',
        date: '2026-01-01',
        number: 4.5,
        yes: true,
        no: false,
        blank: null,
        none: null,
      },
    });
    expect(plain!.sourceData.customFields).toEqual({ trello: {} });
  });

  it('labels members without a full name by their username', async () => {
    const { provider } = trello([
      ['/members/me/boards', [{ id: 'board1', name: 'Board' }]],
      ['/lists?', [{ id: 'L1', name: 'New' }]],
      [
        '/members?',
        [
          { id: 'u1', username: 'ana' },
          { id: 'u2', username: 'bea', fullName: 'Bea Lima' },
        ],
      ],
    ]);
    const fields = byKey(
      await provider.pushContract(
        context({ item: { kind: 'card', title: 'T', status: 'New', sourceData: {} } }),
      ),
    );
    expect(fields.member!.options).toEqual([
      { value: 'u1', label: 'ana', detail: '@ana' },
      { value: 'u2', label: 'Bea Lima', detail: '@bea' },
    ]);
    expect(fields.list).toMatchObject({ value: 'L1' });
  });

  it('creates a list on the board chosen in the contract', async () => {
    const { provider, calls } = trello([['/lists?', { id: 'L1' }]]);
    const remote = await provider.push(
      { kind: 'pbi', title: 'Sprint', description: '', status: 'New' },
      { fields: { board: 'board2' } },
    );
    expect(remote).toMatchObject({ externalId: 'L1', boardId: 'board2' });
    expect(calls).toEqual([
      {
        url: 'https://api.trello.com/1/lists?key=key&token=tok',
        method: 'POST',
        body: { name: 'Sprint', idBoard: 'board2' },
      },
    ]);
  });

  it('rejects custom fields on lists and renames linked lists in place', async () => {
    const { provider, calls } = trello([['/lists/', { id: 'L9' }]]);
    const item = { kind: 'pbi' as const, title: 'Renamed', description: '', status: 'New' };
    await expect(provider.push(item, { customFields: { n: 1 } })).rejects.toThrow(
      'Trello custom fields can only be set on cards, not lists.',
    );
    expect(await provider.push(item, { externalId: 'L9', customFields: {} })).toMatchObject({
      externalId: 'L9',
      kind: 'pbi',
      boardId: 'board1',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.trello.com/1/lists/L9?key=key&token=tok',
        method: 'PUT',
        body: { name: 'Renamed', idBoard: 'board1' },
      },
    ]);
  });

  it('writes each custom field of a card with the value shape of its type', async () => {
    const { provider, calls } = trello([
      ['/customField/', {}],
      ['/cards', { id: 'C1', url: 'https://trello.test/c/C1' }],
    ]);
    const item = { kind: 'card' as const, title: 'Card', description: 'D', status: 'New' };
    await provider.push(item, {
      listId: 'L1',
      customFields: { s: 'opt', n: 3, b: true, d: '2026-02-01', t: 'note', u: 'raw' },
      fieldDefinitions: [
        { id: 's', name: 'S', type: 'single_select' },
        { id: 'n', name: 'N', type: 'number' },
        { id: 'b', name: 'B', type: 'boolean' },
        { id: 'd', name: 'D', type: 'date' },
        { id: 't', name: 'T', type: 'text' },
      ],
    });
    expect(calls.slice(1).map((call) => [call.url.split('?')[0], call.body])).toEqual([
      ['https://api.trello.com/1/cards/C1/customField/s/item', { idValue: 'opt' }],
      ['https://api.trello.com/1/cards/C1/customField/n/item', { value: { number: '3' } }],
      ['https://api.trello.com/1/cards/C1/customField/b/item', { value: { checked: 'true' } }],
      ['https://api.trello.com/1/cards/C1/customField/d/item', { value: { date: '2026-02-01' } }],
      ['https://api.trello.com/1/cards/C1/customField/t/item', { value: { text: 'note' } }],
      ['https://api.trello.com/1/cards/C1/customField/u/item', { value: { text: 'raw' } }],
    ]);
    calls.length = 0;
    expect(await provider.push(item, { listId: 'L1' })).toMatchObject({ externalId: 'C1' });
    expect(calls).toHaveLength(1);
  });
});

describe('Jira provider', () => {
  const settings = { baseUrl: 'https://acme.atlassian.net/', projectKey: 'KEY', email: 'a@b.c' };
  function jira(routes: [string, unknown][]) {
    const { fetcher, calls } = fakeFetch(routes);
    return { provider: createPbiProvider({ id: 'jira', settings, secret: 'tok' }, fetcher), calls };
  }

  it('lists only custom fields with their mapped types', async () => {
    const { provider, calls } = jira([
      [
        '/rest/api/3/field',
        [
          { id: 'summary', name: 'Summary', schema: { type: 'string' } },
          { id: 'customfield_1', name: 'Labels', custom: true, schema: { type: 'array' } },
          { id: 'customfield_2', name: 'Points', custom: true, schema: { type: 'number' } },
          { id: 'customfield_3', name: 'Team', custom: true, schema: { type: 'option' } },
          { id: 'customfield_4', name: 'Raw', custom: true },
        ],
      ],
    ]);
    expect(await provider.listFields!()).toEqual([
      { id: 'customfield_1', name: 'Labels', type: 'multi_select' },
      { id: 'customfield_2', name: 'Points', type: 'number' },
      { id: 'customfield_3', name: 'Team', type: 'single_select' },
      { id: 'customfield_4', name: 'Raw', type: 'text' },
    ]);
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/field');
  });

  it('pulls every page, flattening rich descriptions and custom values', async () => {
    const { provider, calls } = jira([
      [
        '/search/jql',
        (_url: string, body: Body) =>
          body.nextPageToken
            ? {
                issues: [
                  {
                    id: '2',
                    key: 'KEY-2',
                    fields: { summary: 'Child', parent: { id: '1' }, description: 42 },
                  },
                ],
              }
            : {
                nextPageToken: 'page-2',
                issues: [
                  {
                    id: '1',
                    key: 'KEY-1',
                    fields: {
                      summary: 'Epic',
                      status: { name: 'In Progress' },
                      issuetype: { name: 'Epic' },
                      description: {
                        type: 'doc',
                        content: [
                          {
                            type: 'heading',
                            content: [{ type: 'text', text: 'Goal' }],
                          },
                          {
                            type: 'paragraph',
                            content: [
                              { type: 'text', text: 'Line 1' },
                              { type: 'hardBreak' },
                              { type: 'text' },
                              null,
                            ],
                          },
                          {
                            type: 'bulletList',
                            content: [
                              { type: 'listItem', content: [{ type: 'text', text: 'one' }] },
                            ],
                          },
                          { content: 'raw' },
                        ],
                      },
                      customfield_null: null,
                      customfield_text: 'x',
                      customfield_number: 2,
                      customfield_bool: false,
                      customfield_list: ['a', 'b'],
                      customfield_mixed: ['a', { nested: true }],
                      customfield_option: { id: '10', value: 'High' },
                      customfield_user: { accountId: 'acc-1' },
                      customfield_value: { value: 'Blue' },
                      customfield_numeric: { value: 3 },
                      customfield_other: { name: 'nothing' },
                      environment: 'ignored',
                    },
                  },
                ],
              },
      ],
    ]);
    const [epic, child] = await provider.pull();
    expect(epic).toMatchObject({
      externalId: '1',
      parentExternalId: null,
      kind: 'pbi',
      title: 'Epic',
      status: 'In Progress',
      description: 'Goal\nLine 1\n\none\nraw',
      externalUrl: 'https://acme.atlassian.net/browse/KEY-1',
      sourceData: { key: 'KEY-1', type: 'Epic' },
    });
    expect(epic!.sourceData.customFields).toEqual({
      jira: {
        customfield_null: null,
        customfield_text: 'x',
        customfield_number: 2,
        customfield_bool: false,
        customfield_list: ['a', 'b'],
        customfield_option: '10',
        customfield_user: 'acc-1',
        customfield_value: 'Blue',
        customfield_numeric: '3',
      },
    });
    expect(child).toMatchObject({
      externalId: '2',
      parentExternalId: '1',
      kind: 'card',
      status: 'backlog',
      description: '',
      position: 1,
    });
    expect(calls.map((call) => (call.body as Body).nextPageToken)).toEqual([undefined, 'page-2']);
  });

  const metadata = (meta: unknown): [string, unknown][] => [
    ['/issuetypes', meta],
    ['/statuses', [{ name: 'Task', statuses: [{ name: 'To Do' }] }]],
    ['/user/assignable/search', []],
  ];

  it('reads issue types from the paginated metadata shape and suggests card types', async () => {
    const { provider } = jira(metadata({ values: [{ name: 'Story' }, { name: 'Task' }] }));
    const fields = byKey(
      await provider.pushContract(
        context({ item: { kind: 'card', title: 'T', status: 'To Do', sourceData: {} } }),
      ),
    );
    expect(fields.issueType).toMatchObject({ value: 'Task' });
    expect(fields.status).toMatchObject({ value: 'To Do' });
  });

  it('leaves the type empty when Jira lists none and the linked type is unknown', async () => {
    const { provider } = jira(metadata({}));
    const fields = byKey(
      await provider.pushContract(
        context({
          externalId: '1',
          item: { kind: 'pbi', title: 'T', status: 'New', sourceData: { type: 'Gone' } },
        }),
      ),
    );
    expect(fields.issueType).toMatchObject({ value: '', options: [], readOnly: true });
    expect(fields.status).toMatchObject({ options: [] });
  });

  it('creates child issues without a status move and maps custom field shapes', async () => {
    const { provider, calls } = jira([['/rest/api/3/issue', { id: '20', key: 'KEY-20' }]]);
    const remote = await provider.push(
      { kind: 'card', title: 'Child', description: '', status: 'Backlog' },
      {
        parentExternalId: '1',
        customFields: { s: 'opt', m: ['a', 'b'], one: 'x', n: 5, raw: 'r' },
        fieldDefinitions: [
          { id: 's', name: 'S', type: 'single_select' },
          { id: 'm', name: 'M', type: 'multi_select' },
          { id: 'one', name: 'One', type: 'multi_select' },
          { id: 'n', name: 'N', type: 'number' },
        ],
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      fields: {
        project: { key: 'KEY' },
        summary: 'Child',
        issuetype: { name: 'Task' },
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child' }] }],
        },
        s: { id: 'opt' },
        m: [{ id: 'a' }, { id: 'b' }],
        one: 'x',
        n: 5,
        raw: 'r',
        parent: { id: '1' },
      },
    });
    expect(remote).toMatchObject({
      externalId: '20',
      parentExternalId: '1',
      status: 'Backlog',
      sourceData: { key: 'KEY-20', type: 'Task' },
    });
  });

  it('creates top-level PBIs as epics', async () => {
    const { provider, calls } = jira([['/rest/api/3/issue', { id: '21', key: 'KEY-21' }]]);
    const remote = await provider.push(
      { kind: 'pbi', title: 'Epic', description: 'Why', status: 'New' },
      {},
    );
    expect((calls[0]!.body as { fields: Body }).fields).not.toHaveProperty('parent');
    expect(remote).toMatchObject({ parentExternalId: null, sourceData: { type: 'Epic' } });
  });
});

describe('GitHub Projects provider', () => {
  type Resolver = (query: string, variables: Record<string, unknown>) => unknown;
  function github(resolve: Resolver, settings: Record<string, unknown> = {}) {
    const { fetcher, calls } = fakeFetch([
      [
        'api.github.com/graphql',
        (_url: string, body: Body) =>
          resolve(
            String(body.query).replace(/\s+/g, ''),
            body.variables as Record<string, unknown>,
          ) ?? { errors: [{ message: 'Unexpected query' }] },
      ],
    ]);
    return {
      provider: createPbiProvider(
        {
          id: 'github_projects',
          settings: { owner: 'acme', projectNumber: '3', ...settings },
          secret: 't',
        },
        fetcher,
      ),
      calls,
    };
  }
  const queries = (calls: Call[]) =>
    calls.map((call) => String((call.body as Body).query).replace(/\s+/g, ''));
  const project = (field: unknown = { id: 'F1', options: [{ id: 'o1', name: 'Todo' }] }) => ({
    data: {
      user: { projectsV2: { nodes: [{ id: 'P1', number: 3, title: 'Roadmap', field }] } },
      organization: null,
    },
  });

  it('requires an owner and a positive integer project number', () => {
    for (const settings of [
      { projectNumber: '3' },
      { owner: 'acme', projectNumber: '0' },
      { owner: 'acme', projectNumber: '1.5' },
    ])
      expect(() => createPbiProvider({ id: 'github_projects', settings, secret: 't' })).toThrow(
        'GitHub owner and project number are required.',
      );
  });

  it('reports the NOT_FOUND message when GitHub returns no data', async () => {
    const { provider } = github(() => ({
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a User' }],
    }));
    await expect(provider.pull()).rejects.toMatchObject({
      messageParams: { detail: 'Could not resolve to a User' },
    });
  });

  it('rejects a project that neither the user nor the organization has', async () => {
    const { provider } = github(() => ({ data: { user: null, organization: null } }));
    await expect(provider.pull()).rejects.toMatchObject({
      code: 'PBI_PROVIDER_CONFIG',
      statusCode: 404,
      message: 'GitHub project was not found.',
    });
  });

  it('lists project fields with types and options', async () => {
    const { provider, calls } = github((query) =>
      query.includes('fields(first:100)')
        ? {
            data: {
              user: {
                projectV2: {
                  fields: {
                    nodes: [
                      { id: 'F0', name: '', dataType: 'TEXT' },
                      {
                        id: 'F1',
                        name: 'Sprint',
                        dataType: 'ITERATION',
                        configuration: { iterations: [{ id: 'i1', title: 'Sprint 1' }] },
                      },
                      {
                        id: 'F2',
                        name: 'Status',
                        dataType: 'SINGLE_SELECT',
                        options: [{ id: 'o1', name: 'Todo' }],
                      },
                      {
                        id: 'F3',
                        name: 'Labels',
                        dataType: 'MULTI_SELECT',
                        multiSelectOptions: [{ id: 'm1', name: 'Bug' }],
                      },
                      { id: 'F4', name: 'Estimate', dataType: 'NUMBER', configuration: {} },
                      { id: 'F5', name: 'Due', dataType: 'DATE' },
                    ],
                  },
                },
              },
              organization: null,
            },
          }
        : undefined,
    );
    expect(await provider.listFields!()).toEqual([
      {
        id: 'F1',
        name: 'Sprint',
        type: 'iteration',
        options: [{ id: 'i1', name: 'Sprint 1' }],
      },
      { id: 'F2', name: 'Status', type: 'single_select', options: [{ id: 'o1', name: 'Todo' }] },
      { id: 'F3', name: 'Labels', type: 'multi_select', options: [{ id: 'm1', name: 'Bug' }] },
      { id: 'F4', name: 'Estimate', type: 'number' },
      { id: 'F5', name: 'Due', type: 'date' },
    ]);
    expect((calls[0]!.body as { variables: Body }).variables).toEqual({ owner: 'acme', number: 3 });
  });

  it('rejects invalid project numbers and returns no fields for unknown projects', async () => {
    const { provider, calls } = github(() => ({ data: { user: null, organization: null } }));
    await expect(provider.listFields!('abc')).rejects.toThrow('GitHub project number is invalid.');
    await expect(provider.listFields!('-2')).rejects.toThrow('GitHub project number is invalid.');
    expect(calls).toHaveLength(0);
    expect(await provider.listFields!('5')).toEqual([]);
  });

  it('pulls every page of project items and sub-issues', async () => {
    const item = (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({
      id,
      content,
      ...extra,
    });
    const { provider, calls } = github((query, variables) => {
      if (query.includes('node(id:$id)'))
        return variables.after === 'sub-2'
          ? { data: { node: null } }
          : {
              data: {
                node: {
                  subIssues: {
                    nodes: [{ id: 'S2', title: 'Sub 2', body: 'b', url: 'https://gh/s2' }],
                    pageInfo: { hasNextPage: true, endCursor: 'sub-2' },
                  },
                },
              },
            };
      if (variables.after === 'items-2')
        return {
          data: {
            user: null,
            organization: {
              projectV2: {
                id: 'PRJ',
                items: {
                  nodes: [
                    item('N3', {
                      __typename: 'DraftIssue',
                      id: 'D1',
                      title: 'Draft',
                      subIssues: {
                        // Already read under I1: it keeps its first parent.
                        nodes: [{ id: 'S2', title: 'Sub 2 again' }],
                        pageInfo: { hasNextPage: true, endCursor: null },
                      },
                    }),
                  ],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          },
        };
      return {
        data: {
          user: {
            projectV2: {
              id: 'PRJ',
              items: {
                nodes: [
                  item('N0', null),
                  item(
                    'N1',
                    {
                      __typename: 'Issue',
                      id: 'I1',
                      title: 'Parent',
                      body: 'Body',
                      url: 'https://gh/i1',
                      subIssues: {
                        nodes: [{ id: 'S1', title: 'Sub 1' }],
                        pageInfo: { hasNextPage: true, endCursor: 'sub-1' },
                      },
                    },
                    {
                      statusField: { name: 'Todo' },
                      iterationField: { title: 'Sprint 1' },
                      fieldValues: {
                        nodes: [
                          { field: { id: 'text' }, text: 'note' },
                          { field: { id: 'number' }, number: 2 },
                          { field: { id: 'date' }, date: '2026-01-01' },
                          { field: { id: 'single' }, optionId: 'o1' },
                          { field: { id: 'multi' }, options: [{ id: 'm1' }, { id: 'm2' }] },
                          { field: { id: 'iteration' }, iterationId: 'it1' },
                          { field: { id: 'empty' } },
                          { field: {} },
                          {},
                        ],
                      },
                    },
                  ),
                  item(
                    'N2',
                    { __typename: 'Issue', id: 'S1', title: 'Sub 1', parent: { id: 'I1' } },
                    { statusField: null },
                  ),
                ],
                pageInfo: { hasNextPage: true, endCursor: 'items-2' },
              },
            },
          },
          organization: null,
        },
      };
    });
    const items = await provider.pull();
    expect(items.map((entry) => [entry.externalId, entry.parentExternalId, entry.kind])).toEqual([
      ['I1', null, 'pbi'],
      ['S1', 'I1', 'card'],
      ['S2', 'I1', 'card'],
      ['D1', null, 'pbi'],
    ]);
    const [parent, sub1, sub2, draft] = items;
    expect(parent).toMatchObject({
      status: 'Todo',
      description: 'Body',
      externalUrl: 'https://gh/i1',
      boardId: 'PRJ',
      sourceData: {
        projectItemId: 'N1',
        githubContentType: 'Issue',
        iterationPath: 'Sprint 1',
        customFields: {
          github_projects: {
            text: 'note',
            number: 2,
            date: '2026-01-01',
            single: 'o1',
            multi: ['m1', 'm2'],
            iteration: 'it1',
            empty: null,
          },
        },
      },
    });
    // The project row of a sub-issue replaces the placeholder created from its parent.
    expect(sub1).toMatchObject({
      status: 'backlog',
      description: '',
      externalUrl: null,
      sourceData: { projectItemId: 'N2', customFields: { github_projects: {} } },
    });
    expect(sub2).toMatchObject({ description: 'b', externalUrl: 'https://gh/s2', sourceData: {} });
    expect(draft).toMatchObject({ title: 'Draft', description: '', externalUrl: null });
    expect(draft!.sourceData).toMatchObject({ githubContentType: 'DraftIssue' });
    expect(queries(calls).filter((query) => query.includes('node(id:$id)'))).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  it('builds a contract when GitHub knows no repositories, project or users', async () => {
    const { provider } = github(
      (query) => {
        if (query.includes('projectsV2(first:50)'))
          return {
            data: {
              user: null,
              organization: {
                projectsV2: {
                  nodes: [
                    {
                      id: 'P9',
                      number: 9,
                      title: 'Other',
                      field: { id: 'F9', options: [{ id: 'x', name: 'Weird' }] },
                    },
                  ],
                },
              },
            },
          };
        if (query.includes('repositoryOwner')) return { data: { repositoryOwner: null } };
        if (query.includes('assignableUsers')) return { data: { repository: null } };
        return undefined;
      },
      { repo: 'acme/web' },
    );
    const fields = byKey(
      await provider.pushContract(
        context({
          values: { project: '9' },
          item: { kind: 'pbi', title: 'T', status: 'New', sourceData: {} },
          assignee: { name: 'Ana', email: 'ana@example.com' },
        }),
      ),
    );
    expect(fields.repository).toMatchObject({ value: 'acme/web', options: [] });
    expect(fields.project).toMatchObject({ value: '9' });
    expect(fields.status).toMatchObject({ value: '', options: [{ value: 'x', label: 'Weird' }] });
    expect(fields.assignee).toMatchObject({ value: '', options: [], required: true });
  });

  it('skips assignees for a malformed repository path', async () => {
    const { provider, calls } = github((query) => {
      if (query.includes('projectsV2(first:50)')) return { data: { user: {}, organization: {} } };
      if (query.includes('repositoryOwner')) return { data: { repositoryOwner: {} } };
      return undefined;
    });
    const fields = await provider.pushContract(context({ values: { repository: 'acme//web' } }));
    expect(fields.map((field) => field.key)).toEqual(['repository', 'project']);
    expect(byKey(fields).project).toMatchObject({ value: '', options: [] });
    expect(queries(calls).some((query) => query.includes('assignableUsers'))).toBe(false);
  });

  describe('push', () => {
    function pushing(field?: unknown) {
      return github((query) => {
        if (query.includes('projectsV2(first:50)')) return project(field);
        if (query.includes('repository(owner:$owner,name:$repo)'))
          return { data: { repository: { id: 'R1' } } };
        if (query.includes('createIssue'))
          return { data: { createIssue: { issue: { id: 'I1', url: 'https://gh/i1' } } } };
        if (query.includes('addProjectV2ItemById'))
          return { data: { addProjectV2ItemById: { item: { id: 'PI1' } } } };
        if (query.includes('updateProjectV2ItemFieldValue'))
          return { data: { updateProjectV2ItemFieldValue: {} } };
        if (query.includes('updateProjectV2DraftIssue'))
          return { data: { updateProjectV2DraftIssue: {} } };
        if (query.includes('updateIssue'))
          return { data: { updateIssue: { issue: { id: 'I1', url: 'https://gh/i1' } } } };
        return undefined;
      });
    }
    const item = { kind: 'pbi' as const, title: 'T', description: 'D', status: 'New' };
    const fieldInputs = (calls: Call[]) =>
      calls
        .map((call) => call.body as { query: string; variables: { input?: Body } })
        .filter((body) => body.query.includes('UpdateProjectV2ItemFieldValueInput'))
        .map((body) => [body.variables.input!.fieldId, body.variables.input!.value]);

    it('sets each custom field with the value shape of its type', async () => {
      const { provider, calls } = pushing();
      const remote = await provider.push(item, {
        fields: { repository: 'acme/web' },
        customFields: {
          n: 3,
          d: '2026-01-01',
          s: 'o1',
          m: ['m1'],
          i: 'it1',
          t: 'note',
        },
        fieldDefinitions: [
          { id: 'n', name: 'N', type: 'number' },
          { id: 'd', name: 'D', type: 'date' },
          { id: 's', name: 'S', type: 'single_select' },
          { id: 'm', name: 'M', type: 'multi_select' },
          { id: 'i', name: 'I', type: 'iteration' },
          { id: 't', name: 'T', type: 'text' },
        ],
      });
      expect(fieldInputs(calls)).toEqual([
        ['n', { number: 3 }],
        ['d', { date: '2026-01-01' }],
        ['s', { singleSelectOptionId: 'o1' }],
        ['m', { multiSelectOptionIds: ['m1'] }],
        ['i', { iterationId: 'it1' }],
        ['t', { text: 'note' }],
      ]);
      // No status was chosen, so the status field is never touched.
      expect(queries(calls).some((query) => query.includes('singleSelectOptionId:$option'))).toBe(
        false,
      );
      expect(remote).toMatchObject({ externalId: 'I1', status: 'New', boardId: 'P1' });
    });

    it('rejects boolean and unknown custom fields', async () => {
      const { provider } = pushing();
      await expect(
        provider.push(item, {
          fields: { repository: 'acme/web' },
          customFields: { b: true },
          fieldDefinitions: [{ id: 'b', name: 'B', type: 'boolean' }],
        }),
      ).rejects.toThrow('Unsupported GitHub Project field: b');
      await expect(
        provider.push(item, { fields: { repository: 'acme/web' }, customFields: { x: 'y' } }),
      ).rejects.toThrow('Unsupported GitHub Project field: x');
    });

    it('skips the status update when the project has no status field', async () => {
      const { provider, calls } = pushing(null);
      const remote = await provider.push(item, {
        fields: { repository: 'acme/web', status: 'o1' },
      });
      expect(fieldInputs(calls)).toEqual([]);
      expect(queries(calls).some((query) => query.includes('singleSelectOptionId:$option'))).toBe(
        false,
      );
      expect(remote.status).toBe('New');
    });

    it('requires a project item before mapping fields of a draft issue', async () => {
      const { provider, calls } = pushing();
      await expect(
        provider.push(
          { ...item, sourceData: { githubContentType: 'DraftIssue' } },
          { externalId: 'D1', fields: { status: 'o1' } },
        ),
      ).rejects.toThrow(
        'The draft issue has no GitHub Project item. Pull the project before mapping its fields.',
      );
      expect(queries(calls).some((query) => query.includes('updateProjectV2DraftIssue'))).toBe(
        false,
      );
    });

    it('updates a draft issue with its assignee', async () => {
      const { provider, calls } = pushing();
      const remote = await provider.push(
        { ...item, sourceData: { githubContentType: 'DraftIssue', projectItemId: 'PI7' } },
        { externalId: 'D1', boardId: 'B', fields: { assignee: 'U1' } },
      );
      const draft = calls.find((call) =>
        String((call.body as Body).query).includes('updateProjectV2DraftIssue'),
      );
      expect((draft!.body as { variables: Body }).variables).toEqual({
        input: { draftIssueId: 'D1', title: 'T', body: 'D', assigneeIds: ['U1'] },
      });
      expect(remote).toMatchObject({
        externalUrl: null,
        boardId: 'B',
        status: 'New',
        sourceData: { projectItemId: 'PI7', githubContentType: 'DraftIssue' },
      });
    });

    it('updates an issue outside the project without touching project fields', async () => {
      const { provider, calls } = pushing();
      const remote = await provider.push(
        { ...item, status: 'Doing', sourceData: {} },
        { externalId: 'I1', fields: { assignee: 'U2' } },
      );
      const update = calls.find((call) =>
        String((call.body as Body).query).includes('UpdateIssueInput'),
      );
      expect((update!.body as { variables: Body }).variables).toEqual({
        input: { id: 'I1', title: 'T', body: 'D', assigneeIds: ['U2'] },
      });
      expect(queries(calls).some((query) => query.includes('addProjectV2ItemById'))).toBe(false);
      expect(remote).toMatchObject({
        status: 'Doing',
        externalUrl: 'https://gh/i1',
        sourceData: { projectItemId: '', githubContentType: 'Issue' },
      });
    });
  });
});
