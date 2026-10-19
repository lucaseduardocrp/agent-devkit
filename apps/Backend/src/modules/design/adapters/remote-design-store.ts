import { ApplicationError } from '../../../shared/errors.js';
import type { IntegrationsService } from '../../integrations/application/integrations-service.js';
import type {
  DesignMessage,
  DesignProject,
  DesignSystem,
  DesignRemoteStore,
  DesignRepositoryProvider,
} from '../application/design-service.js';

const root = 'design-prototypes';
const systemsRoot = 'design-systems';
const contextLimit = 50_000;
interface Config {
  provider: DesignRepositoryProvider;
  token: string;
  owner?: string;
  organization?: string;
  project?: string;
  repo: string;
  baseUrl: string;
  branch: string;
}
interface RemoteFile {
  path: string;
  content: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export class RemoteDesignStore implements DesignRemoteStore {
  public constructor(
    private readonly integrations: IntegrationsService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async configuredProviders(workspaceId: string) {
    const integrations = await this.integrations.listIntegrations(workspaceId);
    const providers: DesignRepositoryProvider[] = [];
    if (
      integrations.some(
        (item) =>
          item.providerId === 'github_projects' &&
          item.isEnabled &&
          text(item.settings.owner || item.settings.organization) &&
          text(item.settings.repo || item.settings.repository),
      )
    ) {
      providers.push('github');
    }
    if (
      integrations.some(
        (item) =>
          item.providerId === 'azure_devops_wiki' &&
          item.isEnabled &&
          text(item.settings.organization) &&
          text(item.settings.project) &&
          text(item.settings.repository || item.settings.repo),
      )
    ) {
      providers.push('azure');
    }
    return providers;
  }

  public async list(workspaceId: string, provider: DesignRepositoryProvider) {
    const config = await this.config(workspaceId, provider);
    const paths = await this.listPaths(config, root);
    const projectIds = new Set(
      paths.flatMap((path) => {
        const match = new RegExp(`^${root}/([^/]+)/`).exec(path);
        return match ? [match[1]!] : [];
      }),
    );
    const projects = await Promise.all([...projectIds].map((id) => this.readProject(config, id)));
    return projects
      .filter((project): project is DesignProject => Boolean(project))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async find(workspaceId: string, provider: DesignRepositoryProvider, id: string) {
    return this.readProject(await this.config(workspaceId, provider), id);
  }

  public async save(workspaceId: string, project: DesignProject) {
    const config = await this.config(workspaceId, project.provider);
    const base = `${root}/${project.id}`;
    const contextPaths = (await this.listPaths(config, `${base}/.design`))
      .filter((path) => /context-\d+\.md$/.test(path))
      .sort();
    const previous = await this.readProject(config, project.id);
    const newMessages = project.messages.slice(previous?.messages.length ?? 0);
    const writes: RemoteFile[] = project.files.map((file) => ({
      path: `${base}/${file.name}`,
      content: file.content,
    }));
    let contextPath = contextPaths.at(-1) ?? `${base}/.design/context-001.md`;
    let context = (await this.read(config, contextPath)) ?? '# Contexto do protótipo\n';
    let contextNumber = contextPaths.length || 1;
    const rotateContext = () => {
      writes.push({ path: contextPath, content: context });
      contextNumber += 1;
      contextPath = `${base}/.design/context-${String(contextNumber).padStart(3, '0')}.md`;
      context = '# Continuação do contexto do protótipo\n';
    };
    for (const message of newMessages) {
      let remaining = message.content;
      let continuation = false;
      while (remaining.length > 0) {
        const heading = `\n## ${message.role === 'user' ? 'Usuário' : 'Agente'}${continuation ? ' (continuação)' : ''} · ${message.createdAt}\n\n`;
        if (context.length + heading.length + 1 >= contextLimit) rotateContext();
        const available = contextLimit - context.length - heading.length - 1;
        const part = remaining.slice(0, available);
        context += `${heading}${part}\n`;
        remaining = remaining.slice(part.length);
        if (remaining.length > 0) rotateContext();
        continuation = true;
      }
    }
    writes.push({ path: contextPath, content: context });
    writes.push({
      path: `${base}/.design/project.json`,
      content: JSON.stringify(
        { title: project.title, agentId: project.agentId, updatedAt: project.updatedAt },
        null,
        2,
      ),
    });
    await this.write(config, writes, `design: update ${project.title}`);
    return project;
  }

  public async delete(workspaceId: string, provider: DesignRepositoryProvider, id: string) {
    const config = await this.config(workspaceId, provider);
    const paths = await this.listPaths(config, `${root}/${id}`);
    if (!paths.length) return false;
    await this.remove(config, paths, `design: delete ${id}`);
    return true;
  }

  public async listDesignSystems(workspaceId: string, provider: DesignRepositoryProvider) {
    const config = await this.config(workspaceId, provider);
    const paths = (await this.listPaths(config, systemsRoot)).filter((path) =>
      path.endsWith('.html'),
    );
    const systems = await Promise.all(
      paths.map(async (path) => {
        const content = (await this.read(config, path)) ?? '';
        const name = content.match(/^<!--\s*name:\s*(.*?)\s*-->/)?.[1];
        return {
          id: path.slice(systemsRoot.length + 1, -5),
          name:
            name?.trim() ||
            path
              .split('/')
              .at(-1)!
              .replace(/\.html$/, ''),
          content: content.replace(/^<!--\s*name:.*?-->\s*/, ''),
          updatedAt: '',
        };
      }),
    );
    return systems.sort((a, b) => a.name.localeCompare(b.name));
  }

  public async saveDesignSystem(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    system: DesignSystem,
  ) {
    const config = await this.config(workspaceId, provider);
    await this.write(
      config,
      [
        {
          path: `${systemsRoot}/${system.id}.html`,
          content: `<!-- name: ${system.name.replace(/-->/g, '')} -->\n${system.content}\n`,
        },
      ],
      `design: update system ${system.name}`,
    );
    return system;
  }

  public async deleteDesignSystem(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    id: string,
  ) {
    const config = await this.config(workspaceId, provider);
    const path = `${systemsRoot}/${id}.html`;
    if (!(await this.read(config, path))) return false;
    await this.remove(config, [path], `design: delete system ${id}`);
    return true;
  }

  private async readProject(config: Config, id: string): Promise<DesignProject | null> {
    const base = `${root}/${id}`;
    const paths = await this.listPaths(config, base);
    const metadata = await this.read(config, `${base}/.design/project.json`);
    let info: { title: string; agentId: string; updatedAt: string } | null = null;
    if (metadata) {
      try {
        const parsed = JSON.parse(metadata) as Partial<{
          title: string;
          agentId: string;
          updatedAt: string;
        }>;
        if (typeof parsed.title === 'string') {
          info = {
            title: parsed.title,
            agentId: typeof parsed.agentId === 'string' ? parsed.agentId : '',
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
          };
        }
      } catch {
        // Existing repository folders can predate Design metadata.
      }
    }
    const codePaths = paths.filter((path) => !path.includes('/.design/'));
    if (!info && codePaths.length === 0) return null;
    const contextPaths = paths.filter((path) => /\/\.design\/context-\d+\.md$/.test(path)).sort();
    const files = await Promise.all(
      codePaths.map(async (path) => ({
        name: path.slice(base.length + 1),
        language: path.split('.').pop()!.toLowerCase(),
        content: (await this.read(config, path)) ?? '',
      })),
    );
    const messages = (
      await Promise.all(contextPaths.map((path) => this.read(config, path)))
    ).flatMap((content) => this.parseContext(content ?? ''));
    return {
      id,
      provider: config.provider,
      title: info?.title || id,
      agentId: info?.agentId || '',
      updatedAt: info?.updatedAt || '',
      files,
      messages,
    };
  }

  private parseContext(content: string): DesignMessage[] {
    return [
      ...content.matchAll(
        /## (Usuário|Agente)(?: \(continuação\))? · ([^\n]+)\n\n([\s\S]*?)(?=\n## |$)/g,
      ),
    ].map((match) => ({
      role: match[1] === 'Usuário' ? 'user' : 'assistant',
      createdAt: match[2]!,
      content: match[3]!.trim(),
    }));
  }

  private async config(workspaceId: string, provider: DesignRepositoryProvider): Promise<Config> {
    const integrations = await this.integrations.listIntegrations(workspaceId);
    const providerId = provider === 'github' ? 'github_projects' : 'azure_devops_wiki';
    const integration = integrations.find(
      (item) => item.providerId === providerId && item.isEnabled,
    );
    const token = await this.integrations.getDecryptedSecret(
      workspaceId,
      integration?.category ?? 'KNOWLEDGE',
      providerId,
    );
    if (!integration || !token) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_NOT_CONFIGURED',
        `Configure a integração ${provider === 'github' ? 'GitHub' : 'Azure DevOps'} antes de usar o Design.`,
        409,
      );
    }
    const repo = text(integration.settings.repo) || text(integration.settings.repository);
    if (!repo) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_NOT_CONFIGURED',
        'Informe o repositório na configuração da integração.',
        409,
      );
    }
    if (provider === 'github') {
      const owner = text(integration.settings.owner) || text(integration.settings.organization);
      if (!owner) {
        throw new ApplicationError(
          'DESIGN_REPOSITORY_NOT_CONFIGURED',
          'Informe o proprietario do repositorio na configuracao do GitHub.',
          409,
        );
      }
      return {
        provider,
        token,
        owner,
        repo,
        baseUrl: text(integration.settings.baseUrl) || 'https://api.github.com',
        branch: text(integration.settings.branch) || 'main',
      };
    }
    const organization = text(integration.settings.organization);
    const project = text(integration.settings.project);
    if (!organization || !project) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_NOT_CONFIGURED',
        'Informe a organizacao e o projeto na configuracao do Azure DevOps.',
        409,
      );
    }
    const configuredBaseUrl = text(integration.settings.baseUrl).replace(/\/+$/, '');
    const projectSuffix = `/${project}`;
    const baseUrl = configuredBaseUrl.toLowerCase().endsWith(projectSuffix.toLowerCase())
      ? configuredBaseUrl.slice(0, -projectSuffix.length)
      : configuredBaseUrl;
    return {
      provider,
      token,
      organization,
      project,
      repo,
      baseUrl: baseUrl || `https://dev.azure.com/${organization}`,
      branch: text(integration.settings.branch) || 'main',
    };
  }

  private headers(config: Config): Record<string, string> {
    return config.provider === 'github'
      ? {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${config.token}`,
          'user-agent': 'adk',
        }
      : {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`:${config.token}`).toString('base64')}`,
          'content-type': 'application/json',
        };
  }

  private async listPaths(config: Config, path: string): Promise<string[]> {
    const url =
      config.provider === 'github'
        ? `${config.baseUrl}/repos/${config.owner}/${config.repo}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`
        : `${config.baseUrl}/${encodeURIComponent(config.project!)}/_apis/git/repositories/${encodeURIComponent(config.repo)}/items?scopePath=/${encodePath(path)}&recursionLevel=Full&includeContentMetadata=true&versionDescriptor.version=${encodeURIComponent(config.branch)}&versionDescriptor.versionType=branch&$format=json&api-version=7.1`;
    const response = await this.fetcher(url, { headers: this.headers(config) });
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_ERROR',
        `${config.provider === 'github' ? 'GitHub' : 'Azure DevOps'} respondeu HTTP ${response.status}.`,
        502,
      );
    }
    if (config.provider === 'github') {
      const body = (await response.json()) as { tree?: { path: string; type: string }[] };
      return (body.tree ?? [])
        .filter(
          (item) =>
            item.type === 'blob' && (item.path === path || item.path.startsWith(`${path}/`)),
        )
        .map((item) => item.path);
    }
    const rawBody = await response.text();
    type AzureGitItem = { path: string; isFolder?: boolean; gitObjectType?: string };
    let body: { value?: AzureGitItem[] } | AzureGitItem[];
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_ERROR',
        'O Azure DevOps retornou uma resposta inválida ao listar o repositório.',
        502,
      );
    }
    const items = Array.isArray(body) ? body : (body.value ?? []);
    return items
      .filter((item) => !item.isFolder && item.gitObjectType !== 'tree')
      .map((item) => item.path.replace(/^\//, ''));
  }

  private async read(config: Config, path: string): Promise<string | null> {
    const url =
      config.provider === 'github'
        ? `${config.baseUrl}/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`
        : `${config.baseUrl}/${encodeURIComponent(config.project!)}/_apis/git/repositories/${encodeURIComponent(config.repo)}/items?path=/${encodePath(path)}&includeContent=true&versionDescriptor.version=${encodeURIComponent(config.branch)}&versionDescriptor.versionType=branch&$format=json&api-version=7.1`;
    const response = await this.fetcher(url, { headers: this.headers(config) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_ERROR',
        `Repositório respondeu HTTP ${response.status}.`,
        502,
      );
    }
    if (config.provider === 'github') {
      const body = (await response.json()) as { content: string };
      return Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
    }
    // Azure DevOps may return a raw file body for a Git Item even when
    // includeContent=true is present. JSON parsing that response breaks for
    // HTML Design Systems (which start with `<!-- name: ... -->`).
    const rawBody = await response.text();
    try {
      const body = JSON.parse(rawBody) as { content?: unknown };
      return typeof body.content === 'string' ? body.content : rawBody;
    } catch {
      return rawBody;
    }
  }

  private async write(config: Config, files: readonly RemoteFile[], message: string) {
    if (config.provider === 'github') {
      for (const file of files) await this.writeGitHubFile(config, file, message);
      return;
    }
    const existing = new Set([
      ...(await this.listPaths(config, root)),
      ...(await this.listPaths(config, systemsRoot)),
    ]);
    await this.azureCommit(
      config,
      files.map((file) => ({
        changeType: existing.has(file.path) ? 'edit' : 'add',
        path: file.path,
        content: file.content,
      })),
      message,
    );
  }

  private async writeGitHubFile(config: Config, file: RemoteFile, message: string) {
    const endpoint = `${config.baseUrl}/repos/${config.owner}/${config.repo}/contents/${encodePath(file.path)}`;
    const current = await this.fetcher(`${endpoint}?ref=${encodeURIComponent(config.branch)}`, {
      headers: this.headers(config),
    });
    const sha = current.ok ? ((await current.json()) as { sha: string }).sha : undefined;
    const response = await this.fetcher(endpoint, {
      method: 'PUT',
      headers: { ...this.headers(config), 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        branch: config.branch,
        content: Buffer.from(file.content).toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!response.ok) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_ERROR',
        `Falha ao gravar ${file.path} no GitHub.`,
        502,
      );
    }
  }

  private async remove(config: Config, paths: readonly string[], message: string) {
    if (config.provider === 'github') {
      for (const path of paths) {
        const endpoint = `${config.baseUrl}/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}`;
        const current = await this.fetcher(`${endpoint}?ref=${encodeURIComponent(config.branch)}`, {
          headers: this.headers(config),
        });
        if (!current.ok) continue;
        const { sha } = (await current.json()) as { sha: string };
        const response = await this.fetcher(endpoint, {
          method: 'DELETE',
          headers: { ...this.headers(config), 'content-type': 'application/json' },
          body: JSON.stringify({ message, branch: config.branch, sha }),
        });
        if (!response.ok) {
          throw new ApplicationError('DESIGN_REPOSITORY_ERROR', `Falha ao excluir ${path}.`, 502);
        }
      }
      return;
    }
    await this.azureCommit(
      config,
      paths.map((path) => ({ changeType: 'delete', path, content: '' })),
      message,
    );
  }

  private async azureCommit(
    config: Config,
    changes: readonly { changeType: string; path: string; content: string }[],
    message: string,
  ) {
    const repositoryUrl = `${config.baseUrl}/${encodeURIComponent(config.project!)}/_apis/git/repositories/${encodeURIComponent(config.repo)}`;
    const refs = await this.fetcher(
      `${repositoryUrl}/refs?filter=heads/${encodeURIComponent(config.branch)}&api-version=7.1`,
      { headers: this.headers(config) },
    );
    if (!refs.ok) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_ERROR',
        'Não foi possível ler a branch do Azure DevOps.',
        502,
      );
    }
    const refsBody = (await refs.json()) as { value?: { objectId: string }[] };
    const oldObjectId = refsBody.value?.[0]?.objectId;
    if (!oldObjectId) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_ERROR',
        'Branch não encontrada no Azure DevOps.',
        404,
      );
    }
    const response = await this.fetcher(`${repositoryUrl}/pushes?api-version=7.1`, {
      method: 'POST',
      headers: this.headers(config),
      body: JSON.stringify({
        refUpdates: [{ name: `refs/heads/${config.branch}`, oldObjectId }],
        commits: [
          {
            comment: message,
            changes: changes.map((change) => ({
              changeType: change.changeType,
              item: { path: `/${change.path}` },
              ...(change.changeType === 'delete'
                ? {}
                : { newContent: { content: change.content, contentType: 'rawtext' } }),
            })),
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_ERROR',
        `Falha ao gravar no Azure DevOps (HTTP ${response.status}).`,
        502,
      );
    }
  }
}
