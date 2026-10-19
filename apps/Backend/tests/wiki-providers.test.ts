import { describe, expect, it } from 'vitest';
import {
  AzureDevOpsWikiProvider,
  WikiJsProvider,
} from '../src/modules/knowledge/adapters/wiki-providers.js';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('Wiki providers', () => {
  it('maps Wiki.js pages', async () => {
    const provider = new WikiJsProvider({
      baseUrl: 'https://wiki.example.com',
      token: 'token',
      fetcher: async (input: FetchInput, init: FetchInit) => {
        expect(String(input)).toContain('/api/pages');
        expect(init?.headers).toMatchObject({ authorization: 'Bearer token' });
        return response({ pages: [{ id: '1', content: 'content', updatedAt: 'now' }] });
      },
    });
    await expect(provider.listPages({ requestId: 'request-1' })).resolves.toEqual([
      { id: '1', source: 'wikijs:wiki.example.com', content: 'content', updatedAt: 'now' },
    ]);
    expect(provider.ownsSource('https://wiki.example.com/docs/one')).toBe(true);
    expect(provider.ownsSource('https://other.example.com/docs/one')).toBe(false);
    expect(provider.ownsSource('wikijs:wiki.example.com')).toBe(false);
    expect(provider.ownsSource('not a url')).toBe(false);
  });

  it('maps Azure DevOps pages', async () => {
    const provider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/example',
      token: 'token',
      fetcher: async (input: FetchInput, init: FetchInit) => {
        expect(String(input)).toContain('/_apis/wiki/pages');
        expect(init?.headers).toMatchObject({
          authorization: `Basic ${Buffer.from(':token').toString('base64')}`,
        });
        return response({ pages: [{ id: '1', content: 'content', updatedAt: 'now' }] });
      },
    });

    expect(provider.ownsSource('azure-devops:dev.azure.com')).toBe(true);
    expect(
      provider.ownsSource('https://dev.azure.com/example/legacy/_wiki?pagePath=%2FLegacy'),
    ).toBe(true);
    expect(provider.ownsSource('https://dev.azure.com/example/proj/_wiki')).toBe(true);
    expect(provider.ownsSource('https://example.com/wiki?pagePath=%2FOther')).toBe(false);
    expect(provider.ownsSource('not-an-azure-source')).toBe(false);
    await expect(provider.listPages({ requestId: 'request-1' })).resolves.toHaveLength(1);

    const providerWithBasic = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/example',
      token: 'Basic already-encoded',
      fetcher: async (_input: FetchInput, init: FetchInit) => {
        expect(init?.headers).toMatchObject({ authorization: 'Basic already-encoded' });
        return response({ pages: [] });
      },
    });
    await expect(providerWithBasic.listPages({ requestId: 'request-1' })).resolves.toEqual([]);

    const providerEmptyToken = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/example',
      token: '   ',
      fetcher: async (_input: FetchInput, init: FetchInit) => {
        expect(init?.headers).toEqual({});
        return response({ pages: [] });
      },
    });
    await expect(providerEmptyToken.listPages({ requestId: 'request-1' })).resolves.toEqual([]);
  });

  it('rejects provider failures and malformed pages', async () => {
    const defaultProvider = new WikiJsProvider({
      baseUrl: 'https://wiki.example.com',
      token: 'token',
    });
    expect(defaultProvider.name).toBe('Wiki.js');

    const failed = new WikiJsProvider({
      baseUrl: 'https://wiki.example.com',
      token: 'token',
      fetcher: async () => response({}, false, 503),
    });
    await expect(failed.listPages({ requestId: 'request-1' })).rejects.toThrow('HTTP 503');

    const malformed = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/example',
      token: 'token',
      fetcher: async () => response({ pages: [{}] }),
    });
    await expect(malformed.listPages({ requestId: 'request-1' })).rejects.toThrow('invalid page');

    const nullPage = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/example',
      token: 'token',
      fetcher: async () => response({ pages: [null] }),
    });
    await expect(nullPage.listPages({ requestId: 'request-1' })).rejects.toThrow('invalid page');

    const malformedWikiJs = new WikiJsProvider({
      baseUrl: 'https://wiki.example.com',
      token: 'token',
      fetcher: async () => response({ pages: [{}] }),
    });
    await expect(malformedWikiJs.listPages({ requestId: 'request-1' })).rejects.toThrow(
      'invalid page',
    );

    const invalidList = new WikiJsProvider({
      baseUrl: 'https://wiki.example.com',
      token: 'token',
      fetcher: async () => response({ pages: 'invalid' }),
    });
    await expect(invalidList.listPages({ requestId: 'request-1' })).rejects.toThrow(
      'invalid pages response',
    );
  });

  it('traverses Azure DevOps Wiki REST tree and pages', async () => {
    const provider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat-123',
      fetcher: async (input: FetchInput) => {
        const url = String(input);
        if (url.includes('/_apis/wiki/pages?api-version=7.0')) {
          // Endpoint fallback
          return response({}, false, 404);
        }
        if (url.endsWith('/_apis/wiki/wikis?api-version=7.0')) {
          return response({ value: [{ id: 'w-1', name: 'w-1' }] });
        }
        if (url.includes('/pages?path=/&recursionLevel=full')) {
          return response({
            path: '/',
            subPages: [
              {
                path: '/doc1',
                subPages: [{ path: '/doc2' }, null, 'invalid-node'],
              },
              { path: '/' },
            ],
          });
        }
        if (url.includes('path=%2Fdoc1')) {
          return response({
            id: 101,
            path: '/doc1',
            content: 'Doc 1 content',
            remoteUrl: 'https://remote.test/doc1',
          });
        }
        if (url.includes('path=%2Fdoc2')) {
          return response({
            path: '/doc2',
            content: 'Doc 2 content',
            url: 'https://url.test/doc2',
          });
        }
        return response({}, false, 500);
      },
    });

    const pages = await provider.listPages({ requestId: 'req-1' });
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      id: '101',
      source: 'https://remote.test/doc1?pagePath=%2Fdoc1',
      content: 'Doc 1 content',
    });
    expect(pages[1]).toMatchObject({
      id: '/doc2',
      source: 'https://url.test/doc2?pagePath=%2Fdoc2',
      content: 'Doc 2 content',
    });
  });

  it('synchronizes only the explicitly configured Azure Wiki', async () => {
    const provider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat-123',
      wikiIdentifier: 'target-wiki',
      fetcher: async (input: FetchInput) => {
        const url = String(input);
        if (url.includes('/_apis/wiki/pages?api-version=7.0')) return response({}, false, 404);
        if (url.endsWith('/_apis/wiki/wikis?api-version=7.0')) {
          return response({
            value: [
              { id: 'ignored-wiki', name: 'ignored' },
              { id: 'selected-wiki', name: 'target-wiki' },
            ],
          });
        }
        expect(url).not.toContain('ignored-wiki');
        if (url.includes('/selected-wiki/pages?path=/&recursionLevel=full')) {
          return response({ path: '/', subPages: [{ path: '/selected' }] });
        }
        if (url.includes('path=%2Fselected')) {
          return response({ id: 7, path: '/selected', content: 'Selected' });
        }
        return response({}, false, 500);
      },
    });

    await expect(provider.listPages({ requestId: 'selected-wiki' })).resolves.toMatchObject([
      { id: '7', content: 'Selected' },
    ]);
  });

  it('handles empty wikis, failed wikis request, and failed tree/page requests', async () => {
    const emptyProvider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat-123',
      fetcher: async (input: FetchInput) => {
        const url = String(input);
        if (url.includes('/_apis/wiki/pages?api-version=7.0')) return response({}, false, 404);
        return response({});
      },
    });
    await expect(emptyProvider.listPages({ requestId: 'req-2' })).resolves.toEqual([]);

    const fallbackSourceProvider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat-123',
      fetcher: async (input: FetchInput) => {
        const url = String(input);
        if (url.includes('/_apis/wiki/pages?api-version=7.0')) return response({}, false, 404);
        if (url.endsWith('/_apis/wiki/wikis?api-version=7.0')) {
          return response({ value: [{ id: 'w-fallback' }] });
        }
        if (url.includes('/pages?path=/&recursionLevel=full')) {
          return response({ path: '/', subPages: [{ path: '/fallback-doc' }] });
        }
        if (url.includes('path=%2Ffallback-doc')) {
          return response({ content: 'content without urls' });
        }
        return response({});
      },
    });
    const fallbackPages = await fallbackSourceProvider.listPages({ requestId: 'req-fallback' });
    expect(fallbackPages).toHaveLength(1);
    expect(fallbackPages[0]?.source).toBe(
      'https://dev.azure.com/org/proj?pagePath=%2Ffallback-doc',
    );

    const failedWikis = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat-123',
      fetcher: async (input: FetchInput) => {
        const url = String(input);
        if (url.includes('/_apis/wiki/pages?api-version=7.0')) return response({}, false, 404);
        return response({}, false, 502);
      },
    });
    await expect(failedWikis.listPages({ requestId: 'req-3' })).rejects.toThrow('HTTP 502');

    const skippedProvider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat-123',
      fetcher: async (input: FetchInput) => {
        const url = String(input);
        if (url.includes('/_apis/wiki/pages?api-version=7.0')) return response({}, false, 404);
        if (url.endsWith('/_apis/wiki/wikis?api-version=7.0')) {
          return response({ value: [{ id: 'w-fail' }, { id: 'w-partial' }] });
        }
        if (url.includes('/w-fail/')) {
          return response({}, false, 500); // treeRes fails
        }
        if (url.includes('/pages?path=/&recursionLevel=full')) {
          return response({
            path: '/',
            subPages: [{ path: '/fail-page' }, { path: '/no-content' }],
          });
        }
        if (url.includes('path=%2Ffail-page')) {
          return response({}, false, 500); // pageRes fails
        }
        if (url.includes('path=%2Fno-content')) {
          return response({ path: '/no-content', content: null }); // no content
        }
        return response({});
      },
    });
    await expect(skippedProvider.listPages({ requestId: 'req-4' })).resolves.toEqual([]);
  });
});
