import { describe, expect, it, vi } from 'vitest';
import type { IntegrationCategory } from '../src/contracts/integrations.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { AzureTestManagementProvider } from '../src/modules/test-management/adapters/azure-test-management.js';
import {
  IntegrationTestManagementResolver,
  TEST_MANAGEMENT_INTEGRATIONS,
  azureOrganizationUrl,
} from '../src/modules/test-management/adapters/integration-test-management-resolver.js';
import { TestRailTestManagementProvider } from '../src/modules/test-management/adapters/testrail-test-management.js';
import { XrayTestManagementProvider } from '../src/modules/test-management/adapters/xray-test-management.js';
import type { TestManagementProviderId } from '../src/modules/test-management/domain/test-run.js';

const WORKSPACE = 'workspace-1';

function setup() {
  const service = new IntegrationsService(new InMemoryUserIntegrationStore());
  const fetcher = vi.fn<typeof fetch>(async () => new Response('[]', { status: 200 }));
  const resolver = new IntegrationTestManagementResolver(service, fetcher);
  const save = (
    category: IntegrationCategory,
    providerId: string,
    settings: Record<string, unknown>,
    secret?: string,
    isEnabled = true,
  ) =>
    service.saveIntegration(WORKSPACE, category, providerId, {
      isEnabled,
      settings,
      ...(secret === undefined ? {} : { secret }),
    });
  return { service, fetcher, resolver, save };
}

function requested(fetcher: ReturnType<typeof setup>['fetcher']) {
  const [input, init] = fetcher.mock.calls.at(-1)!;
  return {
    url: String(input),
    authorization: (init?.headers as Record<string, string>).authorization,
  };
}

describe('IntegrationTestManagementResolver', () => {
  it('maps each platform to the integration that backs it', () => {
    expect(TEST_MANAGEMENT_INTEGRATIONS).toEqual({
      azure_devops: { category: 'KNOWLEDGE', providerId: 'azure_devops_wiki' },
      testrail: { category: 'PROJECT_MANAGEMENT', providerId: 'testrail' },
      xray: { category: 'PROJECT_MANAGEMENT', providerId: 'xray' },
    });
  });

  it('lists every platform as not configured with its capabilities', async () => {
    const { resolver, fetcher } = setup();
    const summaries = await resolver.listTestManagementProviders(WORKSPACE);
    expect(summaries).toEqual([
      {
        id: 'azure_devops',
        name: 'Azure DevOps Test Plans',
        configured: false,
        capabilities: expect.objectContaining({ planLabel: 'Test Plan', suiteRequired: true }),
      },
      {
        id: 'testrail',
        name: 'TestRail',
        configured: false,
        capabilities: expect.objectContaining({ planLabel: 'Project', suiteRequired: false }),
      },
      {
        id: 'xray',
        name: 'Xray Cloud',
        configured: false,
        capabilities: expect.objectContaining({ suiteLabel: null, caseIdLabel: 'Test key' }),
      },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('flags the configured platforms', async () => {
    const { resolver, save } = setup();
    await save(
      'PROJECT_MANAGEMENT',
      'testrail',
      {
        baseUrl: 'https://acme.testrail.io',
        username: 'qa@acme.com',
      },
      'api-key',
    );
    const summaries = await resolver.listTestManagementProviders(WORKSPACE);
    expect(summaries.map(({ id, configured }) => ({ id, configured }))).toEqual([
      { id: 'azure_devops', configured: false },
      { id: 'testrail', configured: true },
      { id: 'xray', configured: false },
    ]);
  });

  it('builds Azure Test Plans from the Azure DevOps connection', async () => {
    const { resolver, fetcher, save } = setup();
    await save(
      'KNOWLEDGE',
      'azure_devops_wiki',
      { organization: ' contoso ', project: 'My Project' },
      '  my-pat  ',
    );
    const azure = await resolver.resolveTestManagementProvider(WORKSPACE, 'azure_devops');
    expect(azure).toBeInstanceOf(AzureTestManagementProvider);
    await azure!.listPlans();
    expect(requested(fetcher)).toEqual({
      url: 'https://dev.azure.com/contoso/My%20Project/_apis/testplan/plans?api-version=7.1',
      authorization: `Basic ${Buffer.from(':my-pat').toString('base64')}`,
    });
  });

  it('uses the configured Azure base URL, with or without the project', async () => {
    const { resolver, fetcher, save } = setup();
    const urlFor = async (baseUrl: string) => {
      await save(
        'KNOWLEDGE',
        'azure_devops_wiki',
        { organization: 'contoso', project: 'My Project', baseUrl },
        'pat',
      );
      const azure = await resolver.resolveTestManagementProvider(WORKSPACE, 'azure_devops');
      await azure!.listPlans();
      return requested(fetcher).url;
    };
    await expect(urlFor('https://tfs.acme.com/Collection/my%20project/')).resolves.toBe(
      'https://tfs.acme.com/Collection/My%20Project/_apis/testplan/plans?api-version=7.1',
    );
    await expect(urlFor('https://tfs.acme.com/Collection')).resolves.toBe(
      'https://tfs.acme.com/Collection/My%20Project/_apis/testplan/plans?api-version=7.1',
    );
  });

  it('builds TestRail from its integration', async () => {
    const { resolver, fetcher, save } = setup();
    await save(
      'PROJECT_MANAGEMENT',
      'testrail',
      { baseUrl: 'https://acme.testrail.io/', username: ' qa@acme.com ' },
      'api-key',
    );
    const testrail = await resolver.resolveTestManagementProvider(WORKSPACE, 'testrail');
    expect(testrail).toBeInstanceOf(TestRailTestManagementProvider);
    await testrail!.listPlans();
    const call = requested(fetcher);
    expect(call.url.startsWith('https://acme.testrail.io/index.php?/api/v2/get_projects')).toBe(
      true,
    );
    expect(call.authorization).toBe(
      `Basic ${Buffer.from('qa@acme.com:api-key').toString('base64')}`,
    );
  });

  it('builds Xray from its integration, with optional URLs', async () => {
    const { resolver, save } = setup();
    await save('PROJECT_MANAGEMENT', 'xray', { clientId: 'client', projectKey: 'qa' }, 'secret');
    const plain = await resolver.resolveTestManagementProvider(WORKSPACE, 'xray');
    expect(plain).toBeInstanceOf(XrayTestManagementProvider);
    expect(plain).toMatchObject({
      baseUrl: 'https://xray.cloud.getxray.app',
      jiraBaseUrl: null,
      projectKey: 'QA',
    });

    await save(
      'PROJECT_MANAGEMENT',
      'xray',
      {
        clientId: 'client',
        projectKey: 'QA',
        baseUrl: 'https://eu.xray.cloud.getxray.app/',
        jiraBaseUrl: ' https://acme.atlassian.net ',
      },
      'secret',
    );
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'xray')).resolves.toMatchObject({
      baseUrl: 'https://eu.xray.cloud.getxray.app',
      jiraBaseUrl: 'https://acme.atlassian.net',
    });
  });

  it('answers null for missing, disabled or secretless integrations', async () => {
    const { resolver, save } = setup();
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'testrail')).resolves.toBeNull();

    const settings = { baseUrl: 'https://acme.testrail.io', username: 'qa@acme.com' };
    await save('PROJECT_MANAGEMENT', 'testrail', settings, 'api-key', false);
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'testrail')).resolves.toBeNull();

    await save('PROJECT_MANAGEMENT', 'testrail', settings, '   ');
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'testrail')).resolves.toBeNull();
  });

  it('answers null for incomplete or rejected settings', async () => {
    const { resolver, save } = setup();
    await save('PROJECT_MANAGEMENT', 'testrail', { baseUrl: 'https://acme.testrail.io' }, 'k');
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'testrail')).resolves.toBeNull();

    await save('PROJECT_MANAGEMENT', 'testrail', { baseUrl: 42, username: 'qa' }, 'k');
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'testrail')).resolves.toBeNull();

    await save('PROJECT_MANAGEMENT', 'xray', { projectKey: 'QA' }, 's');
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'xray')).resolves.toBeNull();

    await save('PROJECT_MANAGEMENT', 'xray', { clientId: 'client', projectKey: '1bad' }, 's');
    await expect(resolver.resolveTestManagementProvider(WORKSPACE, 'xray')).resolves.toBeNull();

    await save('KNOWLEDGE', 'azure_devops_wiki', { organization: 'contoso' }, 'pat');
    await expect(
      resolver.resolveTestManagementProvider(WORKSPACE, 'azure_devops'),
    ).resolves.toBeNull();

    await save('KNOWLEDGE', 'azure_devops_wiki', { project: 'Web' }, 'pat');
    await expect(
      resolver.resolveTestManagementProvider(WORKSPACE, 'azure_devops'),
    ).resolves.toBeNull();
  });

  it('answers null for an unknown platform', async () => {
    const { resolver } = setup();
    await expect(
      resolver.resolveTestManagementProvider(WORKSPACE, 'qtest' as TestManagementProviderId),
    ).resolves.toBeNull();
  });

  it('uses the global fetch by default', () => {
    const resolver = new IntegrationTestManagementResolver(
      new IntegrationsService(new InMemoryUserIntegrationStore()),
    );
    expect(resolver).toBeInstanceOf(IntegrationTestManagementResolver);
  });
});

describe('azureOrganizationUrl', () => {
  it('defaults to dev.azure.com for the organization', () => {
    expect(azureOrganizationUrl('', 'my org', 'Web')).toBe('https://dev.azure.com/my%20org');
    expect(azureOrganizationUrl('///', 'contoso', 'Web')).toBe('https://dev.azure.com/contoso');
  });

  it('strips a trailing project from the configured URL', () => {
    expect(azureOrganizationUrl('https://dev.azure.com/contoso/Web/', 'contoso', 'Web')).toBe(
      'https://dev.azure.com/contoso',
    );
    expect(
      azureOrganizationUrl('https://dev.azure.com/contoso/my%20web', 'contoso', 'My Web'),
    ).toBe('https://dev.azure.com/contoso');
    expect(azureOrganizationUrl('https://dev.azure.com/contoso//', 'contoso', 'Web')).toBe(
      'https://dev.azure.com/contoso',
    );
  });
});
