import type { IntegrationCategory } from '../../../contracts/integrations.js';
import type { LlmPort } from '../../agents/application/agent-ports.js';
import { MeteredLlm, type LlmUsageRecorder } from '../../agents/application/metered-llm.js';
import { GeminiLlmProvider } from '../../agents/adapters/gemini-llm.js';
import { OllamaLlmProvider } from '../../agents/adapters/ollama-llm.js';
import {
  bridgeEndpoint,
  llmAuthMode,
  llmCliTransport,
  mcpAccessOf,
} from '../../agents/adapters/cli-llm/cli-config.js';
import { CliLlmProvider, cliAccount, detectCli } from '../../agents/adapters/cli-llm/cli-llm.js';
import {
  fetchBridgeClis,
  RemoteCliLlmProvider,
} from '../../agents/adapters/cli-llm/remote-cli-llm.js';
import { cliProfilePath } from '../../agents/adapters/cli-llm/cli-profiles.js';
import { cliForProvider, type CliId } from '../../agents/adapters/cli-llm/cli-specs.js';
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

/** The login folder of the account an integration picked (by name); none for the default login. */
function cliConfigDirOf(
  cli: CliId,
  settings: Record<string, unknown>,
  workspaceId: string,
): string | undefined {
  const profile = asString(settings.cliProfile).trim();
  return profile ? cliProfilePath(workspaceId, cli, profile) : undefined;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export class DynamicProviderFactory {
  private usageRecorder: LlmUsageRecorder | undefined;

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

  /**
   * Credentials for a file hosted by one of the workspace's integrations (images in Azure
   * DevOps work items and wikis, Jira and Trello attachments...), so the ADK can show it
   * without copying it. Returns null when no enabled integration owns the URL.
   */
  public async resolveMediaAuthorization(
    ownerId: string,
    url: URL,
  ): Promise<Record<string, string> | null> {
    const host = url.hostname.toLowerCase();
    const firstSegment = decodeURIComponent(url.pathname.split('/')[1] ?? '').toLowerCase();
    const sameHost = (value: unknown) => {
      try {
        return new URL(asString(value)).hostname.toLowerCase() === host;
      } catch {
        return false;
      }
    };
    const bearerOrBasic = (token: string, user = '') =>
      /^(Basic|Bearer) /.test(token)
        ? token
        : `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
    for (const integration of await this.integrationsService.listIntegrations(ownerId)) {
      if (!integration.isEnabled || !integration.hasSecret) continue;
      const settings = integration.settings;
      let header: (secret: string) => string;
      switch (integration.providerId) {
        case 'azure_devops':
        case 'azure_devops_wiki': {
          const organization = asString(settings.organization).trim().toLowerCase();
          const owns =
            (organization &&
              ((host === 'dev.azure.com' && firstSegment === organization) ||
                host === `${organization}.visualstudio.com`)) ||
            sameHost(settings.baseUrl);
          if (!owns) continue;
          header = (secret) => bearerOrBasic(secret.trim());
          break;
        }
        case 'jira':
          if (!sameHost(settings.baseUrl)) continue;
          header = (secret) => bearerOrBasic(secret.trim(), asString(settings.email).trim());
          break;
        case 'github_projects':
          if (
            !['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(host) &&
            !host.endsWith('.githubusercontent.com')
          )
            continue;
          header = (secret) => `Bearer ${secret.trim()}`;
          break;
        case 'trello':
          if (host !== 'trello.com' && host !== 'api.trello.com') continue;
          header = (secret) =>
            `OAuth oauth_consumer_key="${asString(settings.apiKey).trim()}", oauth_token="${secret.trim()}"`;
          break;
        case 'wiki_js':
          if (!sameHost(settings.baseUrl)) continue;
          header = (secret) => `Bearer ${secret.trim()}`;
          break;
        default:
          continue;
      }
      const secret = await this.integrationsService.getDecryptedSecret(
        ownerId,
        integration.category,
        integration.providerId,
      );
      if (secret?.trim()) return { authorization: header(secret) };
    }
    return null;
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

  /** Where metered LLM usage is written. Without one, models answer unmetered. */
  public setUsageRecorder(recorder: LlmUsageRecorder | undefined): void {
    this.usageRecorder = recorder;
  }

  /**
   * Wraps a model so every call it answers counts in the dashboard (API key and CLI alike).
   * `ownerId` is the workspace that owns the integration.
   */
  public meter(
    llm: LlmPort,
    ownerId: string,
    options: { tool: string; source?: 'api' | 'cli'; actorId?: string | null; model?: string },
  ): LlmPort {
    if (!this.usageRecorder) return llm;
    return new MeteredLlm(llm, this.usageRecorder, {
      workspaceId: ownerId,
      actorId: options.actorId ?? null,
      tool: options.tool,
      source: options.source ?? 'api',
      ...(options.model ? { model: options.model } : {}),
    });
  }

  /**
   * `meter: false` is for a caller that records the tokens itself (issue runs keep them per run);
   * every other caller is metered under `meter.tool`, `llm` when it names none.
   */
  public async resolveLlmProvider(
    ownerId: string,
    providerId?: string,
    fetcher: typeof fetch = this.defaultFetcher,
    modelOverride?: string,
    meter: false | { tool: string; actorId?: string | null } = { tool: 'llm' },
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
    const metered = (llm: LlmPort, source: 'api' | 'cli', model: string): LlmPort =>
      meter ? this.meter(llm, ownerId, { ...meter, source, model }) : llm;

    // "AI CLI" mode: same agents, same prompts, but the tokens come from the provider's CLI.
    if (llmAuthMode(llmConfig.settings) === 'cli') {
      // Only the Bridge needs the stored token: a local CLI keeps its own login.
      const secret =
        llmCliTransport() === 'bridge'
          ? ((await this.integrationsService.getDecryptedSecret(
              ownerId,
              'LLM',
              llmConfig.providerId,
            )) ?? undefined)
          : undefined;
      return metered(
        this.createCliLlm(llmConfig.providerId, llmConfig.settings, { ownerId, secret }),
        'cli',
        asString(llmConfig.settings.cliModel).trim(),
      );
    }

    const secret =
      (await this.integrationsService.getDecryptedSecret(ownerId, 'LLM', llmConfig.providerId)) ??
      '';
    const model = modelOverride?.trim() || asString(llmConfig.settings.model).trim();

    switch (llmConfig.providerId) {
      case 'gemini': {
        return metered(
          new GeminiLlmProvider({ apiKey: secret, model: model || undefined, fetcher }),
          'api',
          model,
        );
      }
      case 'openai':
        return metered(new OpenAiLlmProvider({ apiKey: secret, model, fetcher }), 'api', model);
      case 'claude':
      case 'anthropic':
        return metered(new AnthropicLlmProvider({ apiKey: secret, model, fetcher }), 'api', model);
      case 'groq':
        return metered(new GroqLlmProvider({ apiKey: secret, model, fetcher }), 'api', model);
      case 'ollama': {
        const baseUrl = asString(llmConfig.settings.baseUrl) || undefined;
        return metered(
          new OllamaLlmProvider({ baseUrl, model: model || undefined, fetcher }),
          'api',
          model,
        );
      }
      default:
        return null;
    }
  }

  /**
   * The provider CLI that stands in for an LLM integration's API key: the one on this machine, or
   * the one in the Bridge, signed in with this workspace's own token.
   */
  public createCliLlm(
    providerId: string,
    settings: Record<string, unknown>,
    workspace: { readonly ownerId: string; readonly secret?: string | undefined },
  ): CliLlmProvider | RemoteCliLlmProvider {
    const cli = cliForProvider(providerId);
    if (!cli) {
      throw new ApplicationError(
        'LLM_CLI_UNSUPPORTED',
        `${providerId} has no provider CLI. Use an API key instead.`,
        400,
      );
    }
    const transport = llmCliTransport();
    if (!transport) {
      throw new ApplicationError(
        'LLM_CLI_DISABLED',
        'Provider CLIs are disabled on this server. Set ADK_LLM_CLI=true where the API runs, or configure the Bridge.',
        403,
      );
    }
    const model = asString(settings.cliModel).trim();
    // The ADK's tools are on unless the integration turns them off or limits them to reading.
    const mcpAccess = mcpAccessOf(settings);
    const configDir = cliConfigDirOf(cli, settings, workspace.ownerId);
    try {
      return transport === 'bridge'
        ? new RemoteCliLlmProvider({
            cli,
            bridge: bridgeEndpoint()!,
            workspaceId: workspace.ownerId,
            credential: workspace.secret,
            model,
            ...(mcpAccess ? { mcpAccess } : {}),
            fetcher: this.defaultFetcher,
          })
        : new CliLlmProvider({
            cli,
            model,
            // Which login of this machine the CLI uses; the Bridge keeps its own, per workspace.
            ...(configDir ? { configDir } : {}),
            ...(mcpAccess ? { mcpAccess } : {}),
          });
    } catch (error) {
      // The constructors only throw a CliLlmError, for a model id or a login folder that is not plain.
      const field = /folder/i.test((error as Error).message) ? 'cliConfigDir' : 'cliModel';
      throw new ApplicationError(
        field === 'cliConfigDir' ? 'LLM_CLI_INVALID_CONFIG_DIR' : 'LLM_CLI_INVALID_MODEL',
        (error as Error).message,
        400,
        [{ field }],
      );
    }
  }

  private async testCliConnectivity(
    providerId: string,
    settings: Record<string, unknown>,
    workspace: { readonly ownerId: string; readonly secret?: string | undefined },
  ): Promise<ConnectivityProbeResult> {
    const llm = this.createCliLlm(providerId, settings, workspace);
    const id = cliForProvider(providerId)!;
    const bridged = llmCliTransport() === 'bridge';
    try {
      const status = bridged
        ? (await fetchBridgeClis(bridgeEndpoint()!, workspace.ownerId, this.defaultFetcher)).find(
            (candidate) => candidate.id === id,
          )
        : await detectCli(id);
      if (!status?.installed) {
        return {
          ok: false,
          message: `The ${id} CLI is not installed ${bridged ? 'in the Bridge container' : 'on the machine that runs the API'}.`,
        };
      }
      // The account first: it shows which login is used even when the round trip then fails
      // (no credit, for one). The Bridge signs in per workspace, so there is no local account.
      const account = bridged
        ? null
        : await cliAccount(id, cliConfigDirOf(id, settings, workspace.ownerId)).catch(() => null);
      const accountNote = account ? ` Account: ${account}.` : '';
      try {
        // A real round trip: it proves the CLI is signed in, which `--version` cannot.
        const response = await llm.complete({ prompt: 'Reply with the single word OK.' });
        return {
          ok: response.text.trim().length > 0,
          message: `${status.label} CLI ${status.version ?? ''} answered.${accountNote}`.replace(
            /\s+/g,
            ' ',
          ),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The CLI failed.';
        return { ok: false, message: `${reason}${accountNote}` };
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The CLI failed.' };
    }
  }

  public async testConnectivity(
    providerId: string,
    _category: IntegrationCategory,
    settings: Record<string, unknown>,
    secret?: string,
    fetcher: typeof fetch = this.defaultFetcher,
    locale?: SupportedLocale,
    /** The workspace being tested: a CLI run by the Bridge is signed in per workspace. */
    ownerId?: string,
  ): Promise<ConnectivityProbeResult> {
    const localized = (
      key: Parameters<typeof translateContent>[0],
      params: Record<string, string | number>,
    ) => (locale ? translateContent(key, locale, params) : undefined);
    try {
      if (_category === 'LLM' && llmAuthMode(settings) === 'cli') {
        return await this.testCliConnectivity(providerId, settings, {
          ownerId: ownerId as string,
          secret,
        });
      }
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
        case 'telegram': {
          const token = secret?.trim() ?? '';
          // BotFather tokens look like 123456789:AAF...; anything else must not reach the URL.
          if (!/^\d+:[\w-]+$/.test(token))
            return { ok: false, message: 'Paste the bot token BotFather gave you.' };
          const res = await fetcher(`https://api.telegram.org/bot${token}/getMe`);
          const body = (await res.json().catch(() => null)) as {
            ok?: boolean;
            result?: { username?: string };
          } | null;
          return body?.ok
            ? { ok: true, message: `Connected to @${body.result?.username ?? 'bot'}.` }
            : { ok: false, message: `Telegram rejected the token (${res.status}).` };
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
          // Groq model ids are namespaced (e.g. openai/gpt-oss-120b); keep the slashes.
          const modelPath = model.split('/').map(encodeURIComponent).join('/');
          const res = await fetcher(`${baseUrl}/models/${modelPath}`, {
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
