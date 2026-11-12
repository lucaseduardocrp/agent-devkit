import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HttpHubCatalog } from '../src/modules/hub/adapters/http-hub-catalog.js';
import type { HubIndex } from '../src/modules/hub/domain/hub-index.js';

const COMMIT = 'c'.repeat(40);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const index = {
  schemaVersion: 1,
  repository: 'acme/hub',
  commit: COMMIT,
  generatedAt: 'now',
  categories: { agents: [], skills: [] },
  agents: [],
  skills: [],
  plugins: [],
  removed: [],
} as unknown as HubIndex;

const ok = (body: string) => Promise.resolve(new Response(body));

describe('HttpHubCatalog (edges)', () => {
  it('sends the GitHub token when looking for the newest hub commit', async () => {
    const fetcher = vi.fn((input: string | URL | Request) =>
      String(input).includes('api.github.com') ? ok(COMMIT) : ok(JSON.stringify(index)),
    );
    await new HttpHubCatalog({ fetch: fetcher, githubToken: 'ghp_x' }).index();
    expect((fetcher.mock.calls[0] as unknown[])[1]).toMatchObject({
      headers: { authorization: 'Bearer ghp_x' },
    });
  });

  it('reports an index it cannot read and a failure of the network', async () => {
    const unreadable = new HttpHubCatalog({
      indexUrl: 'https://mirror.test/index.json',
      fetch: vi.fn(() => ok('{"schemaVersion":9}')),
    });
    await expect(unreadable.index()).rejects.toMatchObject({
      code: 'HUB_UNAVAILABLE',
      message: expect.stringContaining('is not an index this ADK can read'),
    });
    const odd = new HttpHubCatalog({
      indexUrl: 'https://mirror.test/index.json',
      fetch: vi.fn(() => Promise.reject('offline')),
    });
    await expect(odd.index()).rejects.toMatchObject({
      message: expect.stringContaining('offline'),
    });
  });

  it('uses the global fetch when none is given', async () => {
    const stub = vi.fn(() => ok(JSON.stringify(index)));
    vi.stubGlobal('fetch', stub);
    try {
      await new HttpHubCatalog({ indexUrl: 'https://mirror.test/index.json' }).index();
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a skill that has no SKILL.md', async () => {
    const catalog = new HttpHubCatalog({ fetch: vi.fn() });
    await expect(
      catalog.skillFile(index, { path: 'skills/x', files: [] } as never),
    ).rejects.toMatchObject({ code: 'HUB_FILE_MISMATCH', statusCode: 502 });
  });

  it('maps missing, failing and oversized files to their own errors', async () => {
    const entry = (sha: string) =>
      ({ path: 'agents/a', files: [{ path: 'AGENT.md', sha256: sha }] }) as never;
    const answer = (response: () => Response) =>
      new HttpHubCatalog({ fetch: vi.fn(() => Promise.resolve(response())) });
    await expect(
      answer(() => new Response('', { status: 404 })).agentFile(index, entry('x')),
    ).rejects.toMatchObject({ code: 'HUB_AGENT_NOT_FOUND', statusCode: 404 });
    await expect(
      answer(() => new Response('', { status: 500 })).agentFile(index, entry('x')),
    ).rejects.toMatchObject({ code: 'HUB_UNAVAILABLE', message: expect.stringContaining('500') });
    await expect(
      answer(() => new Response('x'.repeat(256 * 1024 + 1))).agentFile(index, entry('x')),
    ).rejects.toMatchObject({
      code: 'HUB_FILE_MISMATCH',
      message: expect.stringContaining('larger'),
    });
    const text = 'Be careful.';
    await expect(
      answer(() => new Response(text)).agentFile(index, entry(sha256(text))),
    ).resolves.toBe(text);
  });
});
