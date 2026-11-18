import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';

function client(replies: { status?: number; json?: unknown }[]) {
  const queue = [...replies];
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const spec = queue.length > 1 ? queue.shift()! : queue[0]!;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => spec.json,
      text: async () => '',
    } as Response;
  });
  return { api: new ApiClient({ baseUrl: 'http://api', fetcher }), calls };
}

describe('ApiClient synced endpoints', () => {
  it('reads one saved test plan and fails on an error answer', async () => {
    const ok = client([{ json: { id: 'p 1' } }]);
    expect(await ok.api.getSavedTestPlan('p 1')).toEqual({ id: 'p 1' });
    expect(ok.calls[0]!.url).toBe('http://api/TestPlan/p%201');
    await expect(
      client([{ status: 404, json: { message: 'gone' } }]).api.getSavedTestPlan('x'),
    ).rejects.toThrow('gone');
  });

  it('generates the tests of a run with and without input', async () => {
    const { api, calls } = client([{ json: {} }]);
    await api.generateE2eTests('c1');
    await api.generateE2eTests('c1', { prd: 'doc', savedCases: { planId: 'p' } });
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', 'http://api/e2e/creations/c1/generate', {}],
      ['POST', 'http://api/e2e/creations/c1/generate', { prd: 'doc', savedCases: { planId: 'p' } }],
    ]);
  });

  it('explores a run, sending only the options that were given', async () => {
    const { api, calls } = client([{ json: { exploration: { id: 'e' } } }]);
    expect(await api.exploreE2eCreation('c1')).toEqual({ id: 'e' });
    await api.exploreE2eCreation('c1', {
      description: 'd',
      context: [{ kind: 'pbi', id: '1' }],
      agentId: 'a',
    });
    await api.exploreE2eCreation('c1', { context: [] });
    expect(calls.map((call) => call.body)).toEqual([
      {},
      { description: 'd', context: [{ kind: 'pbi', id: '1' }], agentId: 'a' },
      {},
    ]);
  });

  it('links saved cases to a test and to a run', async () => {
    const { api, calls } = client([{ json: { test: { id: 't' }, result: { linked: 1 } } }]);
    expect(await api.linkE2eTestSavedCase('t', null)).toEqual({ id: 't' });
    expect(await api.linkE2eSavedCases('c1', { suiteId: 's' })).toEqual({ linked: 1 });
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['PUT', 'http://api/e2e/tests/t/saved-case', { savedCase: null }],
      ['POST', 'http://api/e2e/creations/c1/saved-cases', { suiteId: 's' }],
    ]);
  });

  it('manages the accounts of a provider CLI and reports failures', async () => {
    const ok = client([{ json: { profiles: [{ name: 'a' }] } }, { json: { name: 'b' } }, {}]);
    expect(await ok.api.getLlmCliProfiles('claude')).toEqual([{ name: 'a' }]);
    expect(await ok.api.createLlmCliProfile('claude', 'b')).toEqual({ name: 'b' });
    await ok.api.deleteLlmCliProfile('claude', 'b x');
    expect(ok.calls[2]!.url).toBe('http://api/integrations/llm/claude/profiles/b%20x');
    const failing = client([{ status: 500, json: { message: 'boom' } }]).api;
    await expect(failing.getLlmCliProfiles('claude')).rejects.toThrow('boom');
    await expect(failing.createLlmCliProfile('claude', 'b')).rejects.toThrow('boom');
    await expect(failing.deleteLlmCliProfile('claude', 'b')).rejects.toThrow('boom');
  });
});
