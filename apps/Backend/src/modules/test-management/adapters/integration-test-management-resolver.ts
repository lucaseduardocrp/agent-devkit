import type { IntegrationDTO } from '../../../contracts/integrations.js';
import type { IntegrationsService } from '../../integrations/application/integrations-service.js';
import type {
  TestManagementProvider,
  TestManagementProviderSummary,
  TestManagementResolver,
} from '../application/test-management-provider.js';
import { TEST_MANAGEMENT_PROVIDERS, type TestManagementProviderId } from '../domain/test-run.js';
import { AzureTestManagementProvider } from './azure-test-management.js';
import { TestRailTestManagementProvider } from './testrail-test-management.js';
import { XrayTestManagementProvider } from './xray-test-management.js';

/**
 * Integration that backs each platform. Azure Test Plans reuses the Azure DevOps connection
 * (organization, project and PAT) already used for wikis, boards and repositories.
 */
export const TEST_MANAGEMENT_INTEGRATIONS: Record<
  TestManagementProviderId,
  { readonly category: IntegrationDTO['category']; readonly providerId: string }
> = {
  azure_devops: { category: 'KNOWLEDGE', providerId: 'azure_devops_wiki' },
  testrail: { category: 'PROJECT_MANAGEMENT', providerId: 'testrail' },
  xray: { category: 'PROJECT_MANAGEMENT', providerId: 'xray' },
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Builds platform adapters from the workspace integrations; null when one is incomplete. */
export class IntegrationTestManagementResolver implements TestManagementResolver {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listTestManagementProviders(
    workspaceId: string,
  ): Promise<readonly TestManagementProviderSummary[]> {
    const summaries: TestManagementProviderSummary[] = [];
    for (const id of TEST_MANAGEMENT_PROVIDERS) {
      const provider = await this.resolveTestManagementProvider(workspaceId, id);
      const sample = provider ?? this.create(id, {}, '');
      summaries.push({
        id,
        name: sample.name,
        configured: Boolean(provider),
        capabilities: sample.capabilities,
      });
    }
    return summaries;
  }

  async resolveTestManagementProvider(
    workspaceId: string,
    providerId: TestManagementProviderId,
  ): Promise<TestManagementProvider | null> {
    const source = TEST_MANAGEMENT_INTEGRATIONS[providerId];
    if (!source) return null;
    const integration = await this.integrations.getIntegration(
      workspaceId,
      source.category,
      source.providerId,
    );
    if (!integration?.isEnabled) return null;
    const secret =
      (await this.integrations.getDecryptedSecret(
        workspaceId,
        source.category,
        source.providerId,
      )) ?? '';
    if (!secret.trim()) return null;
    try {
      return this.create(providerId, integration.settings, secret.trim(), true);
    } catch {
      // Settings that an adapter rejects (e.g. an invalid project key) mean "not configured".
      return null;
    }
  }

  private create(
    id: TestManagementProviderId,
    settings: Record<string, unknown>,
    secret: string,
    strict = false,
  ): TestManagementProvider {
    const require = (value: string): string => {
      if (strict && !value) throw new Error('Incomplete test management settings.');
      return value;
    };
    if (id === 'testrail')
      return new TestRailTestManagementProvider({
        baseUrl: require(text(settings['baseUrl'])) || 'https://example.testrail.io',
        username: require(text(settings['username'])),
        apiKey: secret,
        fetcher: this.fetcher,
      });
    if (id === 'xray')
      return new XrayTestManagementProvider({
        clientId: require(text(settings['clientId'])),
        clientSecret: secret,
        projectKey: require(text(settings['projectKey'])) || 'QA',
        ...(text(settings['baseUrl']) ? { baseUrl: text(settings['baseUrl']) } : {}),
        ...(text(settings['jiraBaseUrl']) ? { jiraBaseUrl: text(settings['jiraBaseUrl']) } : {}),
        fetcher: this.fetcher,
      });
    const organization = require(text(settings['organization']));
    const project = require(text(settings['project']));
    return new AzureTestManagementProvider({
      organizationUrl: azureOrganizationUrl(text(settings['baseUrl']), organization, project),
      project: project || 'project',
      token: secret,
      fetcher: this.fetcher,
    });
  }
}

/** The stored base URL may point at the organization or at the project itself. */
export function azureOrganizationUrl(baseUrl: string, organization: string, project: string) {
  const configured = baseUrl.replace(/\/+$/, '');
  if (!configured) return `https://dev.azure.com/${encodeURIComponent(organization)}`;
  const suffix = `/${encodeURIComponent(project)}`;
  return configured.toLowerCase().endsWith(suffix.toLowerCase())
    ? configured.slice(0, -suffix.length)
    : configured;
}
