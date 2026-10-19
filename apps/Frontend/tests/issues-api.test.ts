import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';

describe('issues ApiClient', () => {
  it('exposes run and cost operations with workspace credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer session',
        'x-workspace-id': 'workspace-a',
      });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.includes('/runs?')) return new Response(JSON.stringify({ runs: [{ id: 'run-1' }] }));
      if (url.endsWith('/costs')) return new Response(JSON.stringify({ monthSpendMicros: 100 }));
      if (url.endsWith('/costs/budget'))
        return new Response(JSON.stringify({ monthlyBudgetMicros: 1_000_000 }));
      if (url.endsWith('/costs/rates'))
        return new Response(JSON.stringify({ rate: { provider: 'openai', model: 'test' } }));
      return new Response(JSON.stringify({ run: { id: 'run-1' } }));
    });
    const api = new ApiClient({ fetcher, token: 'session', workspaceId: 'workspace-a' });
    await expect(api.startIssueRun('issue-1')).resolves.toMatchObject({ id: 'run-1' });
    await expect(api.getAgentRuns('issue-1')).resolves.toMatchObject([{ id: 'run-1' }]);
    await expect(api.cancelAgentRun('run-1')).resolves.toMatchObject({ id: 'run-1' });
    await expect(api.getCosts()).resolves.toMatchObject({ monthSpendMicros: 100 });
    await expect(api.setMonthlyBudget(1_000_000)).resolves.toMatchObject({
      monthlyBudgetMicros: 1_000_000,
    });
    await expect(
      api.setCostRate({
        provider: 'openai',
        model: 'test',
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
      }),
    ).resolves.toMatchObject({ model: 'test' });
    await expect(api.deleteCostRate('openai', 'test')).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
  it('sends workspace and auth context on issue and inbox requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer session',
        'x-workspace-id': 'workspace-a',
      });
      if (url.endsWith('/issues') && init?.method === 'POST')
        return new Response(JSON.stringify({ issue: { id: 'issue-1', title: 'Ship' } }), {
          status: 201,
        });
      if (url.endsWith('/inbox/issue-1'))
        return new Response(JSON.stringify({ state: { issueId: 'issue-1' } }));
      if (url.endsWith('/dashboard')) return new Response(JSON.stringify({ totalIssues: 1 }));
      return new Response(JSON.stringify({ issues: [] }));
    });
    const api = new ApiClient({ fetcher, token: 'session', workspaceId: 'workspace-a' });
    await expect(api.createIssue({ title: 'Ship' })).resolves.toMatchObject({ id: 'issue-1' });
    await api.updateInboxItem('issue-1', { read: true });
    await expect(api.getDashboard()).resolves.toMatchObject({ totalIssues: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
