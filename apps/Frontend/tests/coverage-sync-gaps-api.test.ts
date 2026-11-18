import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';

function setup(json: unknown = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return { ok: true, status: 200, headers: new Headers(), json: async () => json } as Response;
  });
  return { client: new ApiClient({ baseUrl: 'http://api', fetcher, token: 't' }), calls };
}

describe('ApiClient development repositories', () => {
  it('lists the repositories of the connected Git providers', async () => {
    const { client, calls } = setup({ repositories: [{ id: 'r1', provider: 'github' }] });
    expect(await client.getDevelopmentRepositories()).toEqual([{ id: 'r1', provider: 'github' }]);
    expect(calls[0]!.url).toBe('http://api/development/repositories');
  });

  it('lists the branches of a repository', async () => {
    const { client, calls } = setup({ branches: [{ name: 'main' }] });
    expect(await client.getDevelopmentBranches('github', 'acme/shop')).toEqual([{ name: 'main' }]);
    expect(calls[0]!.url).toBe(
      'http://api/development/repositories/branches?provider=github&repositoryId=acme%2Fshop',
    );
  });
});

describe('ApiClient headers the caller already set', () => {
  it('does not overwrite the locale, language or workspace of the caller', async () => {
    const { client, calls } = setup();
    const send = (
      client as unknown as {
        fetchWithAuth: (url: string, init: RequestInit) => Promise<Response>;
      }
    ).fetchWithAuth.bind(client);
    await send('http://api/x', {
      headers: { 'x-locale': 'fr-FR', 'Accept-Language': 'fr', authorization: 'Bearer own' },
    });
    expect(calls[0]!.headers).toMatchObject({
      'x-locale': 'fr-FR',
      'Accept-Language': 'fr',
      authorization: 'Bearer own',
    });
  });
});
