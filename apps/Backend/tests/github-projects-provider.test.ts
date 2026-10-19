import { describe, expect, it } from 'vitest';
import { GitHubProjectsProvider } from '../src/modules/knowledge/adapters/github-projects-provider.js';

describe('GitHubProjectsProvider', () => {
  it('instantiates with default options and fetcher', () => {
    const provider = new GitHubProjectsProvider({ owner: 'org', repo: 'repo' });
    expect(provider.name).toBe('GitHub Projects & Wiki');
  });

  it('fetches and maps repository issues to knowledge pages', async () => {
    const mockFetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/repos/my-org/my-repo/issues');
      return {
        ok: true,
        json: async () => [
          {
            id: 101,
            title: 'Authentication Epic',
            body: 'Detailed description of auth.',
            updated_at: '2026-09-11T12:00:00Z',
          },
          {
            id: 102,
            title: 'Empty Body Issue',
          },
        ],
      } as Response;
    };

    const provider = new GitHubProjectsProvider({
      owner: 'my-org',
      repo: 'my-repo',
      token: 'ghp_secretToken',
      fetcher: mockFetcher,
    });

    expect(provider.name).toBe('GitHub Projects & Wiki');

    const pages = await provider.listPages({ requestId: 'r1' });
    expect(pages).toHaveLength(2);
    expect(pages[0]?.id).toBe('101');
    expect(pages[0]?.source).toBe('github:my-org/my-repo');
    expect(pages[0]?.content).toContain('Detailed description of auth.');
    expect(pages[1]?.content).toContain('# Empty Body Issue');
  });

  it('throws when GitHub API returns HTTP error', async () => {
    const mockFetcher = async () =>
      ({
        ok: false,
        status: 401,
      }) as Response;

    const provider = new GitHubProjectsProvider({
      owner: 'my-org',
      repo: 'my-repo',
      fetcher: mockFetcher,
    });

    await expect(provider.listPages({ requestId: 'r1' })).rejects.toThrow(
      'GitHub provider returned HTTP 401',
    );
  });

  it('throws when GitHub API returns non-array response', async () => {
    const mockFetcher = async () =>
      ({
        ok: true,
        json: async () => ({ message: 'Not found' }),
      }) as Response;

    const provider = new GitHubProjectsProvider({
      owner: 'my-org',
      repo: 'my-repo',
      fetcher: mockFetcher,
    });

    await expect(provider.listPages({ requestId: 'r1' })).rejects.toThrow(
      'GitHub provider returned an invalid response',
    );
  });
});
