import { ApplicationError } from '../../../shared/errors.js';
import type { IntegrationsService } from '../../integrations/application/integrations-service.js';
import type { E2eRepositoryProvider, E2eRepositoryRef } from '../domain/e2e.js';
import type {
  E2eBranch,
  E2eRepository,
  E2eRepositoryWarning,
  E2eScriptRepository,
} from '../application/script-repository.js';

interface Connection {
  readonly provider: E2eRepositoryProvider;
  /** GitHub API root, or the Azure DevOps organization URL. */
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
}

const PROVIDER_IDS: Record<E2eRepositoryProvider, string> = {
  github: 'github_projects',
  azure_devops: 'azure_devops_wiki',
};
const LABELS: Record<E2eRepositoryProvider, string> = {
  github: 'GitHub',
  azure_devops: 'Azure DevOps',
};
const MAX_PAGES = 10;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const encodePath = (value: string): string => value.split('/').map(encodeURIComponent).join('/');
const branchName = (value: string | undefined): string =>
  value?.replace(/^refs\/heads\//, '') || 'main';

class MissingConnection extends Error {
  constructor(public readonly code: E2eRepositoryWarning['code']) {
    super(code);
  }
}

/** GitHub and Azure DevOps access for E2E specs, reusing the workspace integrations. */
export class GitScriptRepository implements E2eScriptRepository {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listRepositories(workspaceId: string) {
    const repositories: E2eRepository[] = [];
    const warnings: E2eRepositoryWarning[] = [];
    for (const provider of ['github', 'azure_devops'] as const) {
      let connection: Connection;
      try {
        connection = await this.connect(workspaceId, provider);
      } catch (error) {
        if (error instanceof MissingConnection && error.code !== 'NOT_CONFIGURED')
          warnings.push({ provider, code: error.code });
        continue;
      }
      try {
        repositories.push(
          ...(provider === 'github'
            ? await this.listGitHubRepositories(connection)
            : await this.listAzureRepositories(connection)),
        );
      } catch {
        warnings.push({ provider, code: 'PROVIDER_UNAVAILABLE' });
      }
    }
    return {
      repositories: repositories.sort((a, b) =>
        `${a.provider}:${a.name}`.localeCompare(`${b.provider}:${b.name}`),
      ),
      warnings,
    };
  }

  async listBranches(
    workspaceId: string,
    provider: E2eRepositoryProvider,
    repositoryId: string,
  ): Promise<readonly E2eBranch[]> {
    const connection = await this.requireConnection(workspaceId, provider);
    if (provider === 'github') {
      const repository = await this.json<{ full_name: string; default_branch?: string }>(
        connection,
        `${connection.baseUrl}/repositories/${encodeURIComponent(repositoryId)}`,
        'reading the repository',
      );
      const names: string[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await this.json<{ name: string }[]>(
          connection,
          `${connection.baseUrl}/repos/${repository.full_name}/branches?per_page=100&page=${page}`,
          'listing branches',
        );
        names.push(...batch.map((item) => item.name));
        if (batch.length < 100) break;
      }
      const defaultBranch = repository.default_branch ?? 'main';
      return sortBranches(names, defaultBranch);
    }
    const repositoryUrl = `${connection.baseUrl}/_apis/git/repositories/${encodeURIComponent(repositoryId)}`;
    const repository = await this.json<{ defaultBranch?: string }>(
      connection,
      `${repositoryUrl}?api-version=7.1`,
      'reading the repository',
    );
    const refs = await this.json<{ value?: { name: string }[] }>(
      connection,
      `${repositoryUrl}/refs?filter=heads/&api-version=7.1`,
      'listing branches',
    );
    return sortBranches(
      (refs.value ?? []).map((ref) => branchName(ref.name)),
      branchName(repository.defaultBranch),
    );
  }

  async listFiles(workspaceId: string, ref: E2eRepositoryRef): Promise<readonly string[]> {
    const connection = await this.requireConnection(workspaceId, ref.provider);
    const inFolder = (path: string) => !ref.path || path.startsWith(`${ref.path}/`);
    if (ref.provider === 'github') {
      const response = await this.request(
        connection,
        `${connection.baseUrl}/repos/${ref.name}/git/trees/${encodeURIComponent(ref.branch)}?recursive=1`,
      );
      if (response.status === 404 || response.status === 409) return [];
      this.ensureOk(connection, response, 'listing files');
      const body = (await response.json()) as { tree?: { path: string; type: string }[] };
      return (body.tree ?? [])
        .filter((item) => item.type === 'blob' && inFolder(item.path))
        .map((item) => item.path);
    }
    const response = await this.request(
      connection,
      `${this.azureRepositoryUrl(connection, ref)}/items?scopePath=/${encodePath(ref.path)}&recursionLevel=Full&${azureVersion(ref)}&api-version=7.1`,
    );
    if (response.status === 404) return [];
    this.ensureOk(connection, response, 'listing files');
    const body = (await response.json()) as {
      value?: { path: string; isFolder?: boolean; gitObjectType?: string }[];
    };
    return (body.value ?? [])
      .filter((item) => !item.isFolder && item.gitObjectType !== 'tree')
      .map((item) => item.path.replace(/^\//, ''))
      .filter(inFolder);
  }

  async readFile(
    workspaceId: string,
    ref: E2eRepositoryRef,
    filePath: string,
  ): Promise<string | null> {
    const connection = await this.requireConnection(workspaceId, ref.provider);
    if (ref.provider === 'github') {
      const response = await this.request(
        connection,
        `${connection.baseUrl}/repos/${ref.name}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref.branch)}`,
      );
      if (response.status === 404) return null;
      this.ensureOk(connection, response, `reading ${filePath}`);
      const body = (await response.json()) as { content?: string };
      return Buffer.from((body.content ?? '').replace(/\s/g, ''), 'base64').toString('utf8');
    }
    const response = await this.request(
      connection,
      `${this.azureRepositoryUrl(connection, ref)}/items?path=/${encodePath(filePath)}&includeContent=true&${azureVersion(ref)}&$format=json&api-version=7.1`,
    );
    if (response.status === 404) return null;
    this.ensureOk(connection, response, `reading ${filePath}`);
    // Azure DevOps may answer with the raw file even when JSON was requested.
    const raw = await response.text();
    try {
      const body = JSON.parse(raw) as { content?: unknown };
      return typeof body.content === 'string' ? body.content : raw;
    } catch {
      return raw;
    }
  }

  async writeFile(
    workspaceId: string,
    ref: E2eRepositoryRef,
    filePath: string,
    content: string,
    message: string,
  ): Promise<void> {
    const connection = await this.requireConnection(workspaceId, ref.provider);
    if (ref.provider === 'github') {
      const endpoint = `${connection.baseUrl}/repos/${ref.name}/contents/${encodePath(filePath)}`;
      const current = await this.request(
        connection,
        `${endpoint}?ref=${encodeURIComponent(ref.branch)}`,
      );
      const sha = current.ok ? ((await current.json()) as { sha?: string }).sha : undefined;
      const response = await this.request(connection, endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          message,
          branch: ref.branch,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
      this.ensureOk(connection, response, `pushing ${filePath}`);
      return;
    }
    const repositoryUrl = this.azureRepositoryUrl(connection, ref);
    const refs = await this.json<{ value?: { name: string; objectId: string }[] }>(
      connection,
      `${repositoryUrl}/refs?filter=heads/${encodeURIComponent(ref.branch)}&api-version=7.1`,
      'reading the branch',
    );
    const head = refs.value?.find((item) => item.name === `refs/heads/${ref.branch}`);
    if (!head)
      throw new ApplicationError(
        'E2E_REPOSITORY_ERROR',
        `Branch "${ref.branch}" was not found in Azure DevOps.`,
        404,
      );
    const exists = (await this.readFile(workspaceId, ref, filePath)) !== null;
    const response = await this.request(connection, `${repositoryUrl}/pushes?api-version=7.1`, {
      method: 'POST',
      body: JSON.stringify({
        refUpdates: [{ name: `refs/heads/${ref.branch}`, oldObjectId: head.objectId }],
        commits: [
          {
            comment: message,
            changes: [
              {
                changeType: exists ? 'edit' : 'add',
                item: { path: `/${filePath}` },
                newContent: { content, contentType: 'rawtext' },
              },
            ],
          },
        ],
      }),
    });
    this.ensureOk(connection, response, `pushing ${filePath}`);
  }

  async fileUrl(
    workspaceId: string,
    ref: E2eRepositoryRef,
    filePath: string,
  ): Promise<string | null> {
    let connection: Connection;
    try {
      connection = await this.connect(workspaceId, ref.provider);
    } catch {
      return null;
    }
    if (ref.provider === 'github') {
      const web = connection.baseUrl
        .replace('://api.github.com', '://github.com')
        .replace(/\/api\/v3$/, '');
      return `${web}/${ref.name}/blob/${encodePath(ref.branch)}/${encodePath(filePath)}`;
    }
    const slash = ref.name.indexOf('/');
    const project = ref.name.slice(0, Math.max(slash, 0));
    const repository = ref.name.slice(slash + 1);
    return `${connection.baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}?path=/${encodePath(filePath)}&version=GB${encodeURIComponent(ref.branch)}`;
  }

  private async listGitHubRepositories(connection: Connection): Promise<E2eRepository[]> {
    const result: E2eRepository[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await this.json<
        { id: number; full_name: string; default_branch?: string; html_url?: string }[]
      >(
        connection,
        `${connection.baseUrl}/user/repos?per_page=100&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`,
        'listing repositories',
      );
      result.push(
        ...batch.map((item) => ({
          id: String(item.id),
          provider: 'github' as const,
          name: item.full_name,
          defaultBranch: item.default_branch || 'main',
          ...(item.html_url ? { webUrl: item.html_url } : {}),
        })),
      );
      if (batch.length < 100) break;
    }
    return result;
  }

  private async listAzureRepositories(connection: Connection): Promise<E2eRepository[]> {
    const body = await this.json<{
      value?: {
        id: string;
        name: string;
        defaultBranch?: string;
        webUrl?: string;
        project?: { name?: string };
      }[];
    }>(
      connection,
      `${connection.baseUrl}/_apis/git/repositories?api-version=7.1`,
      'listing repositories',
    );
    return (body.value ?? []).map((item) => ({
      id: item.id,
      provider: 'azure_devops' as const,
      name: `${item.project?.name ?? ''}/${item.name}`,
      defaultBranch: branchName(item.defaultBranch),
      ...(item.webUrl ? { webUrl: item.webUrl } : {}),
    }));
  }

  private azureRepositoryUrl(connection: Connection, ref: E2eRepositoryRef): string {
    return `${connection.baseUrl}/_apis/git/repositories/${encodeURIComponent(ref.id)}`;
  }

  private async requireConnection(
    workspaceId: string,
    provider: E2eRepositoryProvider,
  ): Promise<Connection> {
    try {
      return await this.connect(workspaceId, provider);
    } catch {
      throw new ApplicationError(
        'E2E_REPOSITORY_NOT_CONFIGURED',
        `${LABELS[provider]} integration is not configured.`,
        409,
      );
    }
  }

  private async connect(workspaceId: string, provider: E2eRepositoryProvider): Promise<Connection> {
    const providerId = PROVIDER_IDS[provider];
    const integration = (await this.integrations.listIntegrations(workspaceId)).find(
      (item) => item.providerId === providerId && item.isEnabled,
    );
    if (!integration) throw new MissingConnection('NOT_CONFIGURED');
    const secret = await this.integrations.getDecryptedSecret(
      workspaceId,
      integration.category,
      providerId,
    );
    if (!secret) throw new MissingConnection('CREDENTIALS_MISSING');
    if (provider === 'github')
      return {
        provider,
        baseUrl: (text(integration.settings['baseUrl']) || 'https://api.github.com').replace(
          /\/+$/,
          '',
        ),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: /^(Bearer|token) /.test(secret) ? secret : `Bearer ${secret}`,
          'user-agent': 'adk',
        },
      };
    const organization = text(integration.settings['organization']);
    const project = text(integration.settings['project']);
    const configured = text(integration.settings['baseUrl']).replace(/\/+$/, '');
    // The integration may store a project URL; repositories are listed organization-wide.
    const baseUrl =
      project && configured.toLowerCase().endsWith(`/${project.toLowerCase()}`)
        ? configured.slice(0, -project.length - 1)
        : configured || (organization ? `https://dev.azure.com/${organization}` : '');
    if (!baseUrl) throw new MissingConnection('NOT_CONFIGURED');
    return {
      provider,
      baseUrl,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: /^(Basic|Bearer) /.test(secret)
          ? secret
          : `Basic ${Buffer.from(`:${secret}`).toString('base64')}`,
      },
    };
  }

  private request(connection: Connection, url: string, init: RequestInit = {}) {
    return this.fetcher(url, {
      ...init,
      headers: {
        ...connection.headers,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  }

  private async json<T>(connection: Connection, url: string, action: string): Promise<T> {
    const response = await this.request(connection, url);
    this.ensureOk(connection, response, action);
    return (await response.json()) as T;
  }

  private ensureOk(connection: Connection, response: Response, action: string): void {
    if (response.ok) return;
    const label = LABELS[connection.provider];
    const hint =
      response.status === 401 || response.status === 403
        ? ' Check that the token can read and write the repository.'
        : '';
    throw new ApplicationError(
      'E2E_REPOSITORY_ERROR',
      `${label} answered HTTP ${response.status} while ${action}.${hint}`,
      502,
    );
  }
}

function azureVersion(ref: E2eRepositoryRef): string {
  return `versionDescriptor.version=${encodeURIComponent(ref.branch)}&versionDescriptor.versionType=branch`;
}

function sortBranches(names: readonly string[], defaultBranch: string): E2eBranch[] {
  return [...new Set(names)]
    .sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)))
    .map((name) => ({ name, isDefault: name === defaultBranch }));
}
