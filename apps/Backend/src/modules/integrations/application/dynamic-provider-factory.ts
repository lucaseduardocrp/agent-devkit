import type { IntegrationCategory } from '../../../contracts/integrations.js';
import type { LlmPort } from '../../agents/application/agent-ports.js';
import { GeminiLlmProvider } from '../../agents/adapters/gemini-llm.js';
import { OllamaLlmProvider } from '../../agents/adapters/ollama-llm.js';
import {
  AnthropicLlmProvider,
  GroqLlmProvider,
  OpenAiLlmProvider,
} from '../../agents/adapters/cloud-llm.js';
import type { KnowledgeContentProvider } from '../../knowledge/application/knowledge-provider.js';
import {
  AzureDevOpsWikiProvider,
  WikiJsProvider,
} from '../../knowledge/adapters/wiki-providers.js';
import { GitHubProjectsProvider } from '../../knowledge/adapters/github-projects-provider.js';
import type { IntegrationsService } from './integrations-service.js';
import type { TestSuiteDestinationProvider } from '../../testplans/application/publish-test-suite.js';
import { AzureTestSuitePublisher } from '../../testplans/adapters/azure-test-suite-publisher.js';
import { createPbiProvider, type PbiProvider } from '../../pbi/providers.js';

import { ApplicationError } from '../../../shared/errors.js';
import { translateContent, type SupportedLocale } from '../../../shared/i18n.js';

export interface ConnectivityProbeResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface AzureDevOpsProjectMember {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly avatarUrl?: string;
}

export interface AzureDevOpsProjectMembersResult {
  readonly areaPaths?: readonly string[];
  readonly states?: readonly string[];
  readonly configured: boolean;
  readonly organization: string | null;
  readonly project: string | null;
  readonly members: readonly AzureDevOpsProjectMember[];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export class DynamicProviderFactory {
  public constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly defaultFetcher: typeof fetch = fetch,
  ) {}

  public async listBrainPushProviders(ownerId: string) {
    const names: Record<string, string> = {
      azure_devops_wiki: 'Azure DevOps Wiki',
      github_projects: 'GitHub Projects',
      trello: 'Trello',
      jira: 'Jira',
    };
    const integrations = await this.integrationsService.listIntegrations(ownerId);
    const available = new Map<
      string,
      { providerId: string; name: string; settings: Record<string, unknown> }
    >();
    for (const integration of integrations) {
      if (!integration.isEnabled || !integration.hasSecret || !names[integration.providerId])
        continue;
      available.set(integration.providerId, {
        providerId: integration.providerId,
        name: names[integration.providerId]!,
        settings: integration.settings,
      });
    }
    return [...available.values()];
  }

  public async resolveBrainBoardPushProvider(
    ownerId: string,
    providerId: string,
  ): Promise<PbiProvider | null> {
    if (!['github_projects', 'trello', 'jira'].includes(providerId)) return null;
    const integration = (await this.integrationsService.listIntegrations(ownerId)).find(
      (entry) => entry.providerId === providerId && entry.isEnabled && entry.hasSecret,
    );
    if (!integration) return null;
    const secret = await this.integrationsService.getDecryptedSecret(
      ownerId,
      integration.category,
      providerId,
    );
    return createPbiProvider(
      { id: providerId, settings: integration.settings, secret: secret ?? '' },
      this.defaultFetcher,
    );
  }

  public async listTestSuiteProviders(
    ownerId: string,
  ): Promise<readonly { id: string; name: string; configured: boolean }[]> {
    return [
      {
        id: 'azure_devops',
        name: 'Azure DevOps',
        configured: Boolean(await this.resolveTestSuitePublisher(ownerId, 'azure_devops')),
      },
    ];
  }

  public async resolveTestSuitePublisher(
    ownerId: string,
    providerId = 'azure_devops',
  ): Promise<TestSuiteDestinationProvider | null> {
    if (providerId !== 'azure_devops') return null;
    const integration = await this.integrationsService.getIntegration(
      ownerId,
      'KNOWLEDGE',
      'azure_devops_wiki',
    );
    if (!integration?.isEnabled) return null;
    const token = await this.integrationsService.getDecryptedSecret(
      ownerId,
      'KNOWLEDGE',
      'azure_devops_wiki',
    );
    const organization = asString(integration.settings.organization).trim();
    const project = asString(integration.settings.project).trim();
    if (!token?.trim() || !organization || !project) return null;
    const configuredBase = asString(integration.settings.baseUrl).trim().replace(/\/+$/, '');
    const baseUrl = configuredBase || `https://dev.azure.com/${encodeURIComponent(organization)}`;
    const projectSuffix = `/${encodeURIComponent(project)}`;
    const organizationBase = baseUrl.toLowerCase().endsWith(projectSuffix.toLowerCase())
      ? baseUrl.slice(0, -projectSuffix.length)
      : baseUrl;
    return new AzureTestSuitePublisher(organizationBase, project, token, this.defaultFetcher);
  }

  public async resolveAzureDevOpsWikiProvider(
    ownerId: string,
    fetcher: typeof fetch = this.defaultFetcher,
    wikiIdentifier?: string,
  ): Promise<AzureDevOpsWikiProvider | null> {
    const integrations = await this.integrationsService.listIntegrations(ownerId);
    const config = integrations.find(
      (item) =>
        item.category === 'KNOWLEDGE' && item.providerId === 'azure_devops_wiki' && item.isEnabled,
    );
    if (!config) return null;
    const secret = await this.integrationsService.getDecryptedSecret(
      ownerId,
      'KNOWLEDGE',
      'azure_devops_wiki',
    );
    if (!secret?.trim()) return null;
    const organization = asString(config.settings.organization).trim();
    const project = asString(config.settings.project).trim();
    const baseUrl =
      asString(config.settings.baseUrl).trim() ||
      (project
        ? `https://dev.azure.com/${organization}/${project}`
        : `https://dev.azure.com/${organization}`);
    return new AzureDevOpsWikiProvider({
      baseUrl,
      token: secret,
      wikiIdentifier: wikiIdentifier?.trim() || asString(config.settings.wikiIdentifier),
      fetcher,
    });
  }

  public async resolveKnowledgeProvider(
    ownerId: string,
    fetcher: typeof fetch = this.defaultFetcher,
  ): Promise<KnowledgeContentProvider | null> {
    const integrations = await this.integrationsService.listIntegrations(ownerId);
    const knowledgeConfig = integrations.find(
      (item) => item.category === 'KNOWLEDGE' && item.isEnabled,
    );

    if (!knowledgeConfig) {
      return null;
    }

    const secret =
      (await this.integrationsService.getDecryptedSecret(
        ownerId,
        'KNOWLEDGE',
        knowledgeConfig.providerId,
      )) ?? '';

    switch (knowledgeConfig.providerId) {
      case 'azure_devops_wiki': {
        const organization = asString(knowledgeConfig.settings.organization).trim();
        const project = asString(knowledgeConfig.settings.project).trim();
        let baseUrl = asString(knowledgeConfig.settings.baseUrl).trim();
        if (!baseUrl) {
          baseUrl = project
            ? `https://dev.azure.com/${organization}/${project}`
            : `https://dev.azure.com/${organization}`;
        }
        return new AzureDevOpsWikiProvider({
          baseUrl,
          token: secret,
          wikiIdentifier: asString(knowledgeConfig.settings.wikiIdentifier),
          fetcher,
        });
      }
      case 'github_projects': {
        const owner =
          asString(knowledgeConfig.settings.owner) ||
          asString(knowledgeConfig.settings.organization);
        const repo =
          asString(knowledgeConfig.settings.repo) || asString(knowledgeConfig.settings.project);
        const baseUrl = asString(knowledgeConfig.settings.baseUrl) || undefined;
        return new GitHubProjectsProvider({ owner, repo, token: secret, baseUrl, fetcher });
      }
      case 'wiki_js': {
        const baseUrl = asString(knowledgeConfig.settings.baseUrl, 'http://localhost:3000');
        return new WikiJsProvider({ baseUrl, token: secret, fetcher });
      }
      default:
        return null;
    }
  }

  public async resolveLlmProvider(
    ownerId: string,
    providerId?: string,
    fetcher: typeof fetch = this.defaultFetcher,
    modelOverride?: string,
  ): Promise<LlmPort | null> {
    const integrations = await this.integrationsService.listIntegrations(ownerId);
    const llmConfig = integrations.find(
      (item) =>
        item.category === 'LLM' &&
        item.isEnabled &&
        (!providerId || item.providerId === providerId.trim().toLowerCase()),
    );

    if (!llmConfig) {
      return null;
    }

    const secret =
      (await this.integrationsService.getDecryptedSecret(ownerId, 'LLM', llmConfig.providerId)) ??
      '';
    const model = modelOverride?.trim() || asString(llmConfig.settings.model).trim();

    switch (llmConfig.providerId) {
      case 'gemini': {
        return new GeminiLlmProvider({ apiKey: secret, model: model || undefined, fetcher });
      }
      case 'openai':
        return new OpenAiLlmProvider({ apiKey: secret, model, fetcher });
      case 'claude':
      case 'anthropic':
        return new AnthropicLlmProvider({ apiKey: secret, model, fetcher });
      case 'groq':
        return new GroqLlmProvider({ apiKey: secret, model, fetcher });
      case 'ollama': {
        const baseUrl = asString(llmConfig.settings.baseUrl) || undefined;
        return new OllamaLlmProvider({ baseUrl, model: model || undefined, fetcher });
      }
      default:
        return null;
    }
  }

  public async testConnectivity(
    providerId: string,
    _category: IntegrationCategory,
    settings: Record<string, unknown>,
    secret?: string,
    fetcher: typeof fetch = this.defaultFetcher,
    locale?: SupportedLocale,
  ): Promise<ConnectivityProbeResult> {
    const localized = (
      key: Parameters<typeof translateContent>[0],
      params: Record<string, string | number>,
    ) => (locale ? translateContent(key, locale, params) : undefined);
    try {
      switch (providerId) {
        case 'azure_devops': {
          const organization = asString(settings.organization).trim();
          const project = asString(settings.project).trim();
          if (!organization || !project || !secret?.trim())
            return { ok: false, message: 'Organization, project and PAT are required.' };
          const url = `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`;
          const res = await fetcher(url, {
            headers: { authorization: `Basic ${Buffer.from(`:${secret}`).toString('base64')}` },
          });
          return {
            ok: res.ok,
            message: res.ok
              ? 'Azure Boards connection verified.'
              : `Azure Boards returned ${res.status}.`,
          };
        }
        case 'trello': {
          const boardId = asString(settings.boardId).trim();
          const key = asString(settings.apiKey).trim();
          if (!boardId || !key || !secret?.trim())
            return { ok: false, message: 'API key, token and board ID are required.' };
          const res = await fetcher(
            `https://api.trello.com/1/boards/${encodeURIComponent(boardId)}?key=${encodeURIComponent(key)}&token=${encodeURIComponent(secret)}`,
          );
          return {
            ok: res.ok,
            message: res.ok
              ? 'Trello board connection verified.'
              : `Trello returned ${res.status}.`,
          };
        }
        case 'jira': {
          const baseUrl = asString(settings.baseUrl).trim().replace(/\/$/, '');
          const projectKey = asString(settings.projectKey).trim();
          const email = asString(settings.email).trim();
          if (
            !baseUrl.startsWith('https://') ||
            !new URL(baseUrl).hostname.endsWith('.atlassian.net') ||
            !projectKey ||
            !email ||
            !secret?.trim()
          )
            return {
              ok: false,
              message: 'Jira Cloud URL, email, project key and API token are required.',
            };
          const res = await fetcher(
            `${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`,
            {
              headers: {
                authorization: `Basic ${Buffer.from(`${email}:${secret}`).toString('base64')}`,
              },
            },
          );
          return {
            ok: res.ok,
            message: res.ok ? 'Jira project connection verified.' : `Jira returned ${res.status}.`,
          };
        }
        case 'azure_devops_wiki': {
          const organization = asString(settings.organization).trim();
          const project = asString(settings.project).trim();
          const baseUrl = asString(settings.baseUrl).trim();

          let url: string;
          if (!baseUrl) {
            url = project
              ? `https://dev.azure.com/${organization}/${project}/_apis/wiki/wikis?api-version=7.0`
              : `https://dev.azure.com/${organization}/_apis/wiki/wikis?api-version=7.0`;
          } else {
            const cleanBase = baseUrl.replace(/\/+$/, '');
            url = `${cleanBase}/_apis/wiki/wikis?api-version=7.0`;
          }

          const headers: Record<string, string> = {
            accept: 'application/json',
          };
          if (secret?.trim()) {
            const s = secret.trim();
            headers['authorization'] =
              s.startsWith('Basic ') || s.startsWith('Bearer ')
                ? s
                : `Basic ${Buffer.from(`:${s}`).toString('base64')}`;
          }

          const res = await fetcher(url, { headers });
          if (res.ok && res.status !== 203) {
            return {
              ok: true,
              message:
                localized('integrationVerified', { provider: 'Azure DevOps' }) ??
                'Azure DevOps connection verified.',
            };
          }
          if (res.status === 401 || res.status === 203) {
            return {
              ok: false,
              message:
                'Falha na autenticação do Azure DevOps. Verifique se o Personal Access Token (PAT) possui permissões de leitura.',
            };
          }
          if (res.status === 404) {
            return {
              ok: false,
              message:
                'Organização ou projeto não encontrado no Azure DevOps (status 404). Verifique se o nome da organização e do projeto estão corretos.',
            };
          }
          return {
            ok: false,
            message:
              localized('integrationHttpFailure', {
                provider: 'Azure DevOps',
                status: res.status,
              }) ?? `Azure DevOps responded with status ${res.status}.`,
          };
        }
        case 'github_projects': {
          const baseUrl = (asString(settings.baseUrl) || 'https://api.github.com').replace(
            /\/+$/,
            '',
          );
          const res = await fetcher(`${baseUrl}/user`, {
            headers: {
              accept: 'application/vnd.github.v3+json',
              'user-agent': 'adk',
              ...(secret ? { authorization: `token ${secret}` } : {}),
            },
          });
          return res.ok
            ? {
                ok: true,
                message:
                  localized('integrationVerified', { provider: 'GitHub' }) ??
                  'GitHub connection verified.',
              }
            : {
                ok: false,
                message:
                  localized('integrationHttpFailure', { provider: 'GitHub', status: res.status }) ??
                  `GitHub responded with status ${res.status}.`,
              };
        }
        case 'wiki_js': {
          const baseUrl = asString(settings.baseUrl, 'http://localhost:3000');
          const res = await fetcher(new URL('/api/pages', baseUrl), {
            headers: secret ? { authorization: `Bearer ${secret}` } : {},
          });
          return res.ok
            ? {
                ok: true,
                message:
                  localized('integrationVerified', { provider: 'Wiki.js' }) ??
                  'Wiki.js connection verified.',
              }
            : {
                ok: false,
                message:
                  localized('integrationHttpFailure', {
                    provider: 'Wiki.js',
                    status: res.status,
                  }) ?? `Wiki.js responded with status ${res.status}.`,
              };
        }
        case 'gemini': {
          const model = asString(settings.model, 'gemini-1.5-flash');
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${secret ?? ''}`;
          const res = await fetcher(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'Ping' }] }] }),
          });
          return res.ok
            ? {
                ok: true,
                message:
                  localized('integrationVerified', { provider: 'Gemini API' }) ??
                  'Gemini API connection verified.',
              }
            : {
                ok: false,
                message:
                  localized('integrationHttpFailure', {
                    provider: 'Gemini API',
                    status: res.status,
                  }) ?? `Gemini API responded with status ${res.status}.`,
              };
        }
        case 'openai':
        case 'groq': {
          const model = asString(settings.model).trim();
          if (!model || !secret?.trim())
            return {
              ok: false,
              message:
                localized('integrationCredentialsRequired', {}) ??
                'API key and model are required.',
            };
          const baseUrl =
            providerId === 'openai'
              ? 'https://api.openai.com/v1'
              : 'https://api.groq.com/openai/v1';
          const res = await fetcher(`${baseUrl}/models/${encodeURIComponent(model)}`, {
            headers: { authorization: `Bearer ${secret.trim()}` },
          });
          return res.ok
            ? {
                ok: true,
                message:
                  localized('integrationVerified', {
                    provider: providerId === 'openai' ? 'OpenAI API' : 'Groq API',
                  }) ?? `${providerId === 'openai' ? 'OpenAI' : 'Groq'} API connection verified.`,
              }
            : {
                ok: false,
                message:
                  localized('integrationHttpFailure', {
                    provider: providerId,
                    status: res.status,
                  }) ?? `${providerId} API responded with status ${res.status}.`,
              };
        }
        case 'claude':
        case 'anthropic': {
          const model = asString(settings.model).trim();
          if (!model || !secret?.trim())
            return {
              ok: false,
              message:
                localized('integrationCredentialsRequired', {}) ??
                'API key and model are required.',
            };
          const res = await fetcher('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': secret.trim(),
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'Ping' }],
            }),
          });
          return res.ok
            ? {
                ok: true,
                message:
                  localized('integrationVerified', { provider: 'Claude API' }) ??
                  'Claude API connection verified.',
              }
            : {
                ok: false,
                message:
                  localized('integrationHttpFailure', {
                    provider: 'Claude API',
                    status: res.status,
                  }) ?? `Claude API responded with status ${res.status}.`,
              };
        }
        case 'ollama': {
          const baseUrl = (asString(settings.baseUrl) || 'http://localhost:11434').replace(
            /\/+$/,
            '',
          );
          const res = await fetcher(`${baseUrl}/api/tags`);
          return res.ok
            ? {
                ok: true,
                message:
                  localized('integrationVerified', { provider: 'Ollama' }) ??
                  'Ollama local/remote connection verified.',
              }
            : {
                ok: false,
                message:
                  localized('integrationHttpFailure', { provider: 'Ollama', status: res.status }) ??
                  `Ollama responded with status ${res.status}.`,
              };
        }
        default:
          return {
            ok: false,
            message:
              localized('unknownProvider', { provider: providerId }) ??
              `Unknown provider '${providerId}'.`,
          };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown network failure.';
      return {
        ok: false,
        message: localized('probeFailed', { reason: msg }) ?? `Connection probe failed: ${msg}`,
      };
    }
  }

  public async getAzureDevOpsProjectMembers(
    ownerId: string,
    fetcher: typeof fetch = this.defaultFetcher,
    actorId?: string,
    includeTestOptions = false,
  ): Promise<AzureDevOpsProjectMembersResult> {
    let integration = await this.integrationsService.getIntegration(
      ownerId,
      'KNOWLEDGE',
      'azure_devops_wiki',
    );
    let resolvedOwner = ownerId;

    if ((!integration || !integration.isEnabled) && actorId && actorId !== ownerId) {
      const fallback = await this.integrationsService.getIntegration(
        actorId,
        'KNOWLEDGE',
        'azure_devops_wiki',
      );
      if (fallback && fallback.isEnabled) {
        integration = fallback;
        resolvedOwner = actorId;
      }
    }

    if (!integration || !integration.isEnabled) {
      return {
        configured: false,
        organization: null,
        project: null,
        members: [],
      };
    }

    const organization = asString(integration.settings.organization).trim();
    const project = asString(integration.settings.project).trim();
    const baseUrl = asString(integration.settings.baseUrl).trim();
    const secret =
      (await this.integrationsService.getDecryptedSecret(
        resolvedOwner,
        'KNOWLEDGE',
        'azure_devops_wiki',
      )) ?? '';

    if (!organization || !project) {
      return {
        configured: true,
        organization: organization || null,
        project: project || null,
        members: [],
      };
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (secret.trim()) {
      const s = secret.trim();
      headers['authorization'] =
        s.startsWith('Basic ') || s.startsWith('Bearer ')
          ? s
          : `Basic ${Buffer.from(`:${s}`).toString('base64')}`;
    }

    const cleanBase = baseUrl
      ? baseUrl.replace(/\/+$/, '')
      : `https://dev.azure.com/${encodeURIComponent(organization)}`;

    const teamsUrl = `${cleanBase}/_apis/projects/${encodeURIComponent(project)}/teams?api-version=7.0`;
    const teamsRes = await fetcher(teamsUrl, { headers });

    if (!teamsRes.ok || teamsRes.status === 203) {
      throw new ApplicationError(
        'BAD_GATEWAY',
        `Falha ao buscar equipes do projeto "${project}" no Azure DevOps (status ${teamsRes.status}).`,
        502,
      );
    }

    const teamsData = (await teamsRes.json()) as {
      value?: Array<{ id: string; name?: string }>;
    };
    const teams = Array.isArray(teamsData?.value) ? teamsData.value : [];
    const teamIds = teams.length > 0 ? teams.map((t) => t.id) : [project];

    const membersMap = new Map<string, AzureDevOpsProjectMember>();

    for (const teamId of teamIds) {
      const membersUrl = `${cleanBase}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(teamId)}/members?api-version=7.0`;
      const membersRes = await fetcher(membersUrl, { headers });
      if (!membersRes.ok) {
        continue;
      }

      const membersData = (await membersRes.json()) as {
        value?: Array<{
          identity?: {
            id?: string;
            displayName?: string;
            uniqueName?: string;
            imageUrl?: string;
          };
          id?: string;
          displayName?: string;
          uniqueName?: string;
        }>;
      };

      if (Array.isArray(membersData?.value)) {
        for (const item of membersData.value) {
          const id = item.identity?.id?.trim() || item.id?.trim() || '';
          const rawName = item.identity?.displayName?.trim() || item.displayName?.trim() || '';
          const email = item.identity?.uniqueName?.trim() || item.uniqueName?.trim() || '';
          const avatarUrl = item.identity?.imageUrl;

          if (!id && !email && !rawName) {
            continue;
          }

          const displayName = rawName || 'Sem Nome';
          const key = id || email || displayName;
          if (!membersMap.has(key)) {
            membersMap.set(key, {
              id: id || key,
              displayName,
              email,
              avatarUrl,
            });
          }
        }
      }
    }

    const options: { areaPaths?: string[]; states?: string[] } = {};
    if (includeTestOptions) {
      const projectUrl = `${cleanBase}/${encodeURIComponent(project)}/_apis/wit`;
      const read = async (path: string): Promise<unknown> => {
        const response = await fetcher(`${projectUrl}/${path}`, { headers });
        if (!response.ok || response.status === 203) {
          throw new ApplicationError(
            'BAD_GATEWAY',
            'Falha ao carregar áreas e estados do Azure DevOps.',
            502,
          );
        }
        return (await response.json()) as unknown;
      };
      interface AreaNode {
        name: string;
        children?: AreaNode[];
      }
      const [rootResponse, statesResponse] = await Promise.all([
        read('classificationnodes/areas?$depth=100&api-version=7.1'),
        read('workitemtypes/Test%20Case/states?api-version=7.1'),
      ]);
      const root = rootResponse as AreaNode;
      const states = statesResponse as { value: { name: string }[] };
      const paths: string[] = [];
      const visit = (node: AreaNode, parent: string) => {
        const path = parent ? `${parent}\\${node.name}` : node.name;
        paths.push(path);
        for (const child of node.children ?? []) visit(child, path);
      };
      visit(root, '');
      options.areaPaths = [...new Set(paths)];
      options.states = [...new Set(states.value.map((state) => state.name))];
    }
    return {
      configured: true,
      organization,
      project,
      members: Array.from(membersMap.values()),
      ...options,
    };
  }
}
