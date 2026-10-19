import { validateExternalUrl } from '../../integrations/security.js';
import type { RequestContext } from '../../../shared/context.js';
import type { KnowledgeContentProvider, KnowledgePage } from '../application/knowledge-provider.js';
import { ApplicationError } from '../../../shared/errors.js';

interface WikiProviderOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
}

interface WikiResponse {
  readonly pages?: unknown;
}

interface AzureWiki {
  readonly id: string;
  readonly name?: string;
  readonly remoteUrl?: string;
}

interface AzureWikiPage {
  readonly id?: string | number;
  readonly path?: string;
  readonly content?: string;
  readonly remoteUrl?: string;
  readonly url?: string;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function wikiRequestError(stage: string, upstreamStatus: number): ApplicationError {
  const permissionDenied = upstreamStatus === 401 || upstreamStatus === 403;
  return new ApplicationError(
    permissionDenied ? 'AZURE_WIKI_PERMISSION_DENIED' : 'AZURE_WIKI_ERROR',
    permissionDenied
      ? 'O token do Azure DevOps não tem permissão de escrita na Wiki.'
      : `Falha no Azure DevOps durante ${stage} (HTTP ${upstreamStatus}).`,
    permissionDenied ? 403 : 502,
    [{ stage, upstreamStatus }],
  );
}

abstract class HttpWikiProvider implements KnowledgeContentProvider {
  public abstract readonly name: string;
  protected readonly baseUrl: URL;
  protected readonly token: string;
  protected readonly fetcher: typeof fetch;

  public constructor(options: WikiProviderOptions) {
    this.baseUrl = validateExternalUrl(options.baseUrl);
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
  }

  protected authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  public async listPages(_context: RequestContext): Promise<readonly KnowledgePage[]> {
    const response = await this.fetcher(this.endpoint(), {
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`${this.name} returned HTTP ${response.status}.`);
    }

    const body = (await response.json()) as WikiResponse;
    if (!Array.isArray(body.pages)) {
      throw new Error(`${this.name} returned an invalid pages response.`);
    }

    return body.pages.map((page) => this.toPage(page));
  }

  protected abstract endpoint(): URL;
  protected abstract toPage(value: unknown): KnowledgePage;

  public ownsSource(source: string): boolean {
    try {
      const candidate = new URL(source);
      const basePath = this.baseUrl.pathname.replace(/\/+$/, '');
      return candidate.origin === this.baseUrl.origin && candidate.pathname.startsWith(basePath);
    } catch {
      return false;
    }
  }
}

export class WikiJsProvider extends HttpWikiProvider {
  public readonly name = 'Wiki.js';

  protected endpoint(): URL {
    const baseStr = this.baseUrl.toString().replace(/\/+$/, '');
    return new URL(`${baseStr}/api/pages`);
  }

  protected toPage(value: unknown): KnowledgePage {
    if (!isPage(value)) {
      throw new Error('Wiki.js returned an invalid page.');
    }

    return {
      id: value.id,
      source: `wikijs:${this.baseUrl.host}`,
      content: value.content,
      updatedAt: value.updatedAt,
    };
  }
}

export class AzureDevOpsWikiProvider extends HttpWikiProvider {
  public readonly name = 'Azure DevOps';
  private readonly wikiIdentifier?: string;

  public constructor(options: WikiProviderOptions & { readonly wikiIdentifier?: string }) {
    super(options);
    this.wikiIdentifier = options.wikiIdentifier?.trim() || undefined;
  }

  public override ownsSource(source: string): boolean {
    if (source === `azure-devops:${this.baseUrl.host}`) return true;
    try {
      const candidate = new URL(source);
      if (candidate.origin !== this.baseUrl.origin) return false;
      const baseOrganization = this.baseUrl.pathname.split('/').filter(Boolean)[0];
      const candidateOrganization = candidate.pathname.split('/').filter(Boolean)[0];
      return Boolean(baseOrganization && candidateOrganization === baseOrganization);
    } catch {
      return false;
    }
  }

  private selectWiki(wikis: readonly AzureWiki[]): AzureWiki {
    const wiki = this.wikiIdentifier
      ? wikis.find((item) => item.id === this.wikiIdentifier || item.name === this.wikiIdentifier)
      : wikis.length === 1
        ? wikis[0]
        : undefined;
    if (!wiki) {
      throw new ApplicationError(
        'AZURE_WIKI_NOT_SELECTED',
        wikis.length === 0
          ? 'Nenhuma Wiki encontrada no projeto Azure DevOps.'
          : 'Configure o identificador da Wiki de destino na integração Azure DevOps.',
        400,
      );
    }
    return wiki;
  }

  private async listWikis(base: string): Promise<readonly AzureWiki[]> {
    const response = await this.fetcher(new URL(`${base}/_apis/wiki/wikis?api-version=7.1`), {
      headers: this.authHeaders(),
    });
    if (!response.ok) throw wikiRequestError('list-wikis', response.status);
    const data = (await response.json()) as { value?: AzureWiki[] };
    return Array.isArray(data.value) ? data.value : [];
  }

  private async verifyPage(
    pageUrl: URL,
    wiki: AzureWiki,
    expected: { readonly path: string; readonly content: string },
  ): Promise<KnowledgePage> {
    const verificationUrl = new URL(pageUrl);
    verificationUrl.searchParams.set('includeContent', 'true');
    const response = await this.fetcher(verificationUrl, {
      headers: { ...this.authHeaders(), accept: 'application/json' },
    });
    if (!response.ok) throw wikiRequestError('verify-page', response.status);
    let result: AzureWikiPage;
    try {
      result = (await response.json()) as AzureWikiPage;
    } catch {
      throw new ApplicationError(
        'AZURE_WIKI_VERIFICATION_FAILED',
        'O Azure DevOps não retornou dados válidos para confirmar a publicação.',
        502,
        [{ stage: 'verify-page' }],
      );
    }
    const normalizeContent = (content: string) => content.replaceAll('\r\n', '\n');
    if (
      result.id === undefined ||
      result.path !== expected.path ||
      typeof result.content !== 'string' ||
      normalizeContent(result.content) !== normalizeContent(expected.content)
    ) {
      throw new ApplicationError(
        'AZURE_WIKI_VERIFICATION_FAILED',
        'O conteúdo salvo no Azure DevOps não corresponde ao documento enviado.',
        502,
        [{ stage: 'verify-page', expectedPath: expected.path, actualPath: result.path }],
      );
    }
    const source = new URL(result.remoteUrl ?? wiki.remoteUrl ?? this.baseUrl);
    source.searchParams.set('pagePath', expected.path);
    return {
      id: String(result.id),
      source: source.toString(),
      content: result.content,
      updatedAt: new Date().toISOString(),
    };
  }

  public async pushPage(page: {
    readonly id: string;
    readonly content: string;
    readonly path?: string;
  }): Promise<KnowledgePage> {
    const base = this.baseUrl.toString().replace(/\/+$/, '');
    const wikis = await this.listWikis(base);
    const wiki = this.selectWiki(wikis);

    const path = page.path ?? `/adk-${page.id}`;
    const pageUrl = new URL(`${base}/_apis/wiki/wikis/${encodeURIComponent(wiki.id)}/pages`);
    pageUrl.searchParams.set('path', path);
    pageUrl.searchParams.set('api-version', '7.1');
    const create = await this.fetcher(pageUrl, {
      method: 'PUT',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ content: page.content }),
    });
    if (create.ok) {
      return this.verifyPage(pageUrl, wiki, { path, content: page.content });
    }
    if (create.status === 401 || create.status === 403) {
      throw wikiRequestError('create-page', create.status);
    }
    const existingUrl = new URL(pageUrl);
    existingUrl.searchParams.set('includeContent', 'true');
    const existing = await this.fetcher(existingUrl, {
      headers: { ...this.authHeaders(), accept: 'application/json' },
    });
    if (!existing.ok) {
      throw existing.status === 404
        ? wikiRequestError('create-page', create.status)
        : wikiRequestError('read-page', existing.status);
    }
    let existingPage: AzureWikiPage;
    try {
      existingPage = (await existing.json()) as AzureWikiPage;
    } catch {
      throw new ApplicationError(
        'AZURE_WIKI_VERIFICATION_FAILED',
        'O Azure DevOps não retornou dados válidos para a página existente.',
        502,
        [{ stage: 'read-page' }],
      );
    }
    const normalizeContent = (content: string) => content.replaceAll('\r\n', '\n');
    if (
      existingPage.path === path &&
      typeof existingPage.content === 'string' &&
      normalizeContent(existingPage.content) === normalizeContent(page.content)
    ) {
      return this.verifyPage(pageUrl, wiki, { path, content: page.content });
    }
    const etag = existing.headers.get('etag');
    if (!etag) {
      throw new ApplicationError(
        'AZURE_WIKI_CONFLICT',
        'A página existente não retornou ETag; o push foi cancelado para evitar sobrescrita.',
        409,
      );
    }
    const response = await this.fetcher(pageUrl, {
      method: 'PUT',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
        'If-Match': etag,
      },
      body: JSON.stringify({ content: page.content }),
    });
    if (!response.ok) {
      if (response.status === 409 || response.status === 412) {
        throw new ApplicationError(
          'AZURE_WIKI_CONFLICT',
          'A página foi alterada no Azure DevOps. Revise o conteúdo antes de tentar novamente.',
          409,
          [{ stage: 'update-page', upstreamStatus: response.status }],
        );
      }
      throw wikiRequestError('update-page', response.status);
    }
    return this.verifyPage(pageUrl, wiki, { path, content: page.content });
  }

  protected override authHeaders(): Record<string, string> {
    if (!this.token.trim()) return {};
    const t = this.token.trim();
    if (t.startsWith('Basic ') || t.startsWith('Bearer ')) {
      return { authorization: t };
    }
    return { authorization: `Basic ${Buffer.from(`:${t}`).toString('base64')}` };
  }

  protected endpoint(): URL {
    const baseStr = this.baseUrl.toString().replace(/\/+$/, '');
    return new URL(`${baseStr}/_apis/wiki/pages?api-version=7.0`);
  }

  public override async listPages(_context: RequestContext): Promise<readonly KnowledgePage[]> {
    const baseStr = this.baseUrl.toString().replace(/\/+$/, '');
    try {
      const mockRes = await this.fetcher(this.endpoint(), { headers: this.authHeaders() });
      if (mockRes.ok) {
        const body = (await mockRes.json()) as WikiResponse;
        if (Array.isArray(body.pages)) {
          return body.pages.map((page) => this.toPage(page));
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('invalid page')) {
        throw error;
      }
    }

    const wikisUrl = new URL(`${baseStr}/_apis/wiki/wikis?api-version=7.0`);
    const wikisRes = await this.fetcher(wikisUrl, { headers: this.authHeaders() });
    if (!wikisRes.ok) {
      throw new Error(`${this.name} returned HTTP ${wikisRes.status}.`);
    }

    const wikisData = (await wikisRes.json()) as { value?: Array<{ id: string; name?: string }> };
    const availableWikis = Array.isArray(wikisData?.value) ? wikisData.value : [];
    if (availableWikis.length === 0) {
      return [];
    }
    const wikis = this.wikiIdentifier ? [this.selectWiki(availableWikis)] : availableWikis;

    const pages: KnowledgePage[] = [];

    for (const wiki of wikis) {
      const treeUrl = new URL(
        `${baseStr}/_apis/wiki/wikis/${encodeURIComponent(wiki.id)}/pages?path=/&recursionLevel=full&api-version=7.0`,
      );
      const treeRes = await this.fetcher(treeUrl, { headers: this.authHeaders() });
      if (!treeRes.ok) continue;

      const tree = (await treeRes.json()) as { path?: string; subPages?: unknown[] };
      const pagePaths: string[] = [];
      const traverse = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const n = node as { path?: string; subPages?: unknown[] };
        if (typeof n.path === 'string' && n.path !== '/') {
          pagePaths.push(n.path);
        }
        if (Array.isArray(n.subPages)) {
          for (const sub of n.subPages) {
            traverse(sub);
          }
        }
      };
      traverse(tree);

      const wikiPages = await mapWithConcurrency(pagePaths, 8, async (pagePath) => {
        const pageUrl = new URL(
          `${baseStr}/_apis/wiki/wikis/${encodeURIComponent(wiki.id)}/pages?path=${encodeURIComponent(pagePath)}&includeContent=true&api-version=7.0`,
        );
        const pageRes = await this.fetcher(pageUrl, { headers: this.authHeaders() });
        if (!pageRes.ok) return null;

        const pageData = (await pageRes.json()) as {
          id?: number | string;
          path?: string;
          content?: string;
          remoteUrl?: string;
          url?: string;
        };

        if (typeof pageData.content === 'string') {
          const sourceUrl = new URL(pageData.remoteUrl ?? pageData.url ?? baseStr);
          sourceUrl.searchParams.set('pagePath', pageData.path ?? pagePath);
          return {
            id: String(pageData.id ?? pagePath),
            source: sourceUrl.toString(),
            content: pageData.content,
            updatedAt: new Date().toISOString(),
          } satisfies KnowledgePage;
        }
        return null;
      });
      pages.push(...wikiPages.filter((page): page is KnowledgePage => page !== null));
    }

    return pages;
  }

  protected toPage(value: unknown): KnowledgePage {
    if (!isPage(value)) {
      throw new Error('Azure DevOps returned an invalid page.');
    }

    return {
      id: value.id,
      source: `azure-devops:${this.baseUrl.host}`,
      content: value.content,
      updatedAt: value.updatedAt,
    };
  }
}

function isPage(value: unknown): value is { id: string; content: string; updatedAt: string } {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  return (
    typeof page.id === 'string' &&
    typeof page.content === 'string' &&
    typeof page.updatedAt === 'string'
  );
}
