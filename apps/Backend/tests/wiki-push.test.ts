import { describe, expect, it, vi } from 'vitest';
import { AzureDevOpsWikiProvider } from '../src/modules/knowledge/adapters/wiki-providers.js';

const page = { id: 'doc-123', content: '# Note\n\nBody' };
const pagePath = '/adk-doc-123';

function mockResponse(body: unknown, status = 200, etag?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(etag ? { etag } : {}),
    json: async () => body,
  } as Response;
}

function verifiedPage(overrides: Record<string, unknown> = {}): Response {
  return mockResponse({
    id: 51,
    path: pagePath,
    content: page.content,
    remoteUrl: 'https://dev.azure.com/org/project/_wiki/wikis/wiki',
    ...overrides,
  });
}

describe('Azure Wiki push', () => {
  it('creates a page and confirms its ID, path, and content with a remote read', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/_apis/wiki/wikis?')) return mockResponse({ value: [{ id: 'wiki-1' }] });
      expect(url).toContain('path=%2Fadk-doc-123');
      if (init?.method === 'PUT') {
        expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
        expect(JSON.parse(String(init.body))).toEqual({ content: page.content });
        return mockResponse({}, 201);
      }
      expect(url).toContain('includeContent=true');
      return verifiedPage();
    });
    const provider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat',
      fetcher,
    });
    expect(provider.ownsSource('https://dev.azure.com/org/proj/_wiki/wikis/wiki')).toBe(true);
    expect(provider.ownsSource('https://dev.azure.com/other/project/_wiki/wikis/wiki')).toBe(false);
    expect(provider.ownsSource('not-a-url')).toBe(false);
    await expect(provider.pushPage(page)).resolves.toMatchObject({
      id: '51',
      content: page.content,
      source: expect.stringContaining('pagePath=%2Fadk-doc-123'),
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('updates an existing page with ETag and verifies the resulting content', async () => {
    let pageRead = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/_apis/wiki/wikis?'))
        return mockResponse({
          value: [
            { id: 'one' },
            { id: 'two', name: 'target', remoteUrl: 'https://dev.azure.com/wiki/two' },
          ],
        });
      expect(url).toContain('/wikis/two/pages?');
      if (init?.method === 'PUT') {
        if ((init.headers as Record<string, string>)['If-Match']) {
          expect(init.headers).toMatchObject({ 'If-Match': '"revision-1"' });
          return mockResponse({});
        }
        return mockResponse({}, 500);
      }
      pageRead += 1;
      return pageRead === 1
        ? mockResponse({ id: 51, path: pagePath, content: 'Old' }, 200, '"revision-1"')
        : verifiedPage({ remoteUrl: undefined });
    });
    const provider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat',
      wikiIdentifier: 'target',
      fetcher,
    });
    await expect(provider.pushPage(page)).resolves.toMatchObject({
      id: '51',
      source: expect.stringContaining('pagePath=%2Fadk-doc-123'),
    });
  });

  it('accepts a failed write only when a subsequent read confirms the exact content', async () => {
    let pageRead = 0;
    const provider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/org/proj',
      token: 'pat',
      fetcher: async (input, init) => {
        if (String(input).includes('/_apis/wiki/wikis?'))
          return mockResponse({ value: [{ id: 'wiki' }] });
        if (init?.method === 'PUT') return mockResponse({}, 500);
        pageRead += 1;
        return verifiedPage({
          content: pageRead === 1 ? page.content.replaceAll('\n', '\r\n') : page.content,
        });
      },
    });
    await expect(provider.pushPage(page)).resolves.toMatchObject({ id: '51' });
  });

  it('rejects missing or ambiguous Wikis and upstream list failures before writing', async () => {
    const make = (fetcher: typeof fetch, wikiIdentifier?: string) =>
      new AzureDevOpsWikiProvider({
        baseUrl: 'https://dev.azure.com/org/proj',
        token: 'pat',
        wikiIdentifier,
        fetcher,
      });
    await expect(make(async () => mockResponse({}, 503)).pushPage(page)).rejects.toMatchObject({
      code: 'AZURE_WIKI_ERROR',
      statusCode: 502,
    });
    await expect(make(async () => mockResponse({}, 401)).pushPage(page)).rejects.toMatchObject({
      code: 'AZURE_WIKI_PERMISSION_DENIED',
      statusCode: 403,
    });
    await expect(
      make(async () => mockResponse({ value: [] })).pushPage(page),
    ).rejects.toMatchObject({ code: 'AZURE_WIKI_NOT_SELECTED' });
    await expect(make(async () => mockResponse({})).pushPage(page)).rejects.toMatchObject({
      code: 'AZURE_WIKI_NOT_SELECTED',
    });
    await expect(
      make(async () => mockResponse({ value: [{ id: 'a' }, { id: 'b' }] })).pushPage(page),
    ).rejects.toMatchObject({ code: 'AZURE_WIKI_NOT_SELECTED' });
    await expect(
      make(async () => mockResponse({ value: [{ id: 'a' }] }), 'missing').pushPage(page),
    ).rejects.toMatchObject({ code: 'AZURE_WIKI_NOT_SELECTED' });
  });

  it('keeps Azure failure stages and optimistic concurrency errors typed', async () => {
    const make = (createResponse: Response, getResponse?: Response, updateResponse?: Response) => {
      let pageRead = 0;
      return new AzureDevOpsWikiProvider({
        baseUrl: 'https://dev.azure.com/org/proj',
        token: 'pat',
        fetcher: async (input, init) => {
          if (String(input).includes('/_apis/wiki/wikis?'))
            return mockResponse({ value: [{ id: 'wiki' }] });
          if (init?.method === 'PUT')
            return (init.headers as Record<string, string>)['If-Match']
              ? updateResponse!
              : createResponse;
          pageRead += 1;
          return pageRead === 1 && !createResponse.ok ? getResponse! : verifiedPage();
        },
      });
    };
    await expect(
      make(mockResponse({}, 400), mockResponse({}, 404)).pushPage(page),
    ).rejects.toMatchObject({
      code: 'AZURE_WIKI_ERROR',
      details: [{ stage: 'create-page', upstreamStatus: 400 }],
    });
    await expect(make(mockResponse({}, 403)).pushPage(page)).rejects.toMatchObject({
      code: 'AZURE_WIKI_PERMISSION_DENIED',
      statusCode: 403,
    });
    await expect(
      make(mockResponse({}, 409), mockResponse({}, 503)).pushPage(page),
    ).rejects.toMatchObject({
      code: 'AZURE_WIKI_ERROR',
      details: [{ stage: 'read-page', upstreamStatus: 503 }],
    });
    const invalidExistingPage = mockResponse({});
    invalidExistingPage.json = async () => {
      throw new SyntaxError('invalid existing page JSON');
    };
    await expect(
      make(mockResponse({}, 500), invalidExistingPage).pushPage(page),
    ).rejects.toMatchObject({
      code: 'AZURE_WIKI_VERIFICATION_FAILED',
      details: [{ stage: 'read-page' }],
    });
    await expect(
      make(mockResponse({}, 500), mockResponse({}, 200)).pushPage(page),
    ).rejects.toMatchObject({ code: 'AZURE_WIKI_CONFLICT' });
    const existing = mockResponse({ id: 51, path: pagePath, content: 'Old' }, 200, '"etag"');
    await expect(
      make(mockResponse({}, 409), existing, mockResponse({}, 412)).pushPage(page),
    ).rejects.toMatchObject({ code: 'AZURE_WIKI_CONFLICT' });
    await expect(
      make(mockResponse({}, 409), existing, mockResponse({}, 503)).pushPage(page),
    ).rejects.toMatchObject({
      code: 'AZURE_WIKI_ERROR',
      details: [{ stage: 'update-page', upstreamStatus: 503 }],
    });
    await expect(
      make(mockResponse({}, 412), existing, mockResponse({})).pushPage(page),
    ).resolves.toMatchObject({ id: '51' });
    await expect(make(mockResponse({})).pushPage(page)).resolves.toMatchObject({ id: '51' });
  });

  it('rejects unverifiable Azure responses without a false success', async () => {
    const make = (verification: Response) =>
      new AzureDevOpsWikiProvider({
        baseUrl: 'https://dev.azure.com/org/proj',
        token: 'pat',
        fetcher: async (input) =>
          String(input).includes('/_apis/wiki/wikis?')
            ? mockResponse({ value: [{ id: 'wiki' }] })
            : String(input).includes('includeContent=true')
              ? verification
              : mockResponse({}, 201),
      });
    await expect(make(mockResponse({}, 503)).pushPage(page)).rejects.toMatchObject({
      code: 'AZURE_WIKI_ERROR',
      details: [{ stage: 'verify-page', upstreamStatus: 503 }],
    });
    const invalidJson = mockResponse({});
    invalidJson.json = async () => {
      throw new SyntaxError('invalid JSON');
    };
    await expect(make(invalidJson).pushPage(page)).rejects.toMatchObject({
      code: 'AZURE_WIKI_VERIFICATION_FAILED',
    });
    for (const body of [
      { path: pagePath, content: page.content },
      { id: 51, path: '/wrong', content: page.content },
      { id: 51, path: pagePath },
      { id: 51, path: pagePath, content: 'different' },
    ]) {
      await expect(make(mockResponse(body)).pushPage(page)).rejects.toMatchObject({
        code: 'AZURE_WIKI_VERIFICATION_FAILED',
      });
    }
  });

  it('uses Wiki and base URLs as safe source fallbacks after verification', async () => {
    const make = (wiki: Record<string, unknown>, verification: Record<string, unknown>) =>
      new AzureDevOpsWikiProvider({
        baseUrl: 'https://dev.azure.com/org/proj',
        token: 'pat',
        fetcher: async (input) =>
          String(input).includes('/_apis/wiki/wikis?')
            ? mockResponse({ value: [wiki] })
            : String(input).includes('includeContent=true')
              ? verifiedPage(verification)
              : mockResponse({}, 201),
      });
    await expect(
      make(
        { id: 'wiki', remoteUrl: 'https://dev.azure.com/org/proj/_wiki/wikis/wiki' },
        { remoteUrl: undefined },
      ).pushPage(page),
    ).resolves.toMatchObject({ source: expect.stringContaining('/_wiki/wikis/wiki?pagePath=') });
    await expect(
      make({ id: 'wiki' }, { remoteUrl: undefined }).pushPage(page),
    ).resolves.toMatchObject({ source: expect.stringContaining('/org/proj?pagePath=') });
  });
});
