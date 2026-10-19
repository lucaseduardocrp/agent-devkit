import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';

describe('PBI ApiClient', () => {
  it('reads push contracts, pushes with fields and manages links', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/push-contract'))
        return new Response(JSON.stringify({ contract: { providerId: 'jira', fields: [] } }));
      if (url.endsWith('/push'))
        return new Response(JSON.stringify({ item: { id: 'a' }, warnings: ['w'] }));
      if (url.includes('/relations'))
        return new Response(
          JSON.stringify({ relations: [{ type: init?.method ?? 'GET', origin: 'adk' }] }),
        );
      return new Response('{}', { status: 404 });
    });
    const api = new ApiClient({ fetcher, token: 'session', workspaceId: 'ws' });
    await expect(api.getPbiPushContract('a b', 'jira', { issueType: 'Task' })).resolves.toEqual({
      providerId: 'jira',
      fields: [],
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      providerId: 'jira',
      values: { issueType: 'Task' },
    });
    expect(String(fetcher.mock.calls[0]![0])).toContain('/pbi/items/a%20b/push-contract');
    await api.getPbiPushContract('a', 'trello');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      providerId: 'trello',
      values: {},
    });
    await expect(
      api.pushPbiItem('a', { providerId: 'jira', fields: { status: 'Done' } }),
    ).resolves.toEqual({ item: { id: 'a' }, warnings: ['w'] });
    await expect(api.getPbiRelations('a')).resolves.toEqual([{ type: 'GET', origin: 'adk' }]);
    await expect(api.addPbiRelations('a', 'related', ['b'])).resolves.toEqual([
      { type: 'POST', origin: 'adk' },
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[4]![1]!.body))).toEqual({
      type: 'related',
      targetIds: ['b'],
    });
    await expect(api.removePbiRelation('a', 'duplicate_of', 'b/c')).resolves.toEqual([
      { type: 'DELETE', origin: 'adk' },
    ]);
    expect(String(fetcher.mock.calls[5]![0])).toContain(
      '/pbi/items/a/relations/duplicate_of/b%2Fc',
    );
  });
});
