import { describe, expect, it } from 'vitest';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';

describe('DynamicProviderFactory', () => {
  it('resolves an enabled Azure Wiki writer with a stored credential', async () => {
    const service = new IntegrationsService(new InMemoryUserIntegrationStore());
    const factory = new DynamicProviderFactory(service);
    expect(await factory.resolveAzureDevOpsWikiProvider('owner')).toBeNull();
    await service.saveIntegration('owner', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'org' },
      secret: '',
    });
    expect(await factory.resolveAzureDevOpsWikiProvider('owner')).toBeNull();
    await service.saveIntegration('owner', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'org', project: 'project', wikiIdentifier: 'wiki-1' },
      secret: 'pat',
    });
    expect((await factory.resolveAzureDevOpsWikiProvider('owner'))?.name).toBe('Azure DevOps');
    await service.saveIntegration('owner', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'org' },
      secret: 'pat',
    });
    expect((await factory.resolveAzureDevOpsWikiProvider('owner'))?.name).toBe('Azure DevOps');
    await service.saveIntegration('owner', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { baseUrl: 'https://dev.azure.com/org/project' },
      secret: 'pat',
    });
    expect((await factory.resolveAzureDevOpsWikiProvider('owner'))?.name).toBe('Azure DevOps');
    await service.saveIntegration('owner', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: false,
      settings: { organization: 'org' },
      secret: 'pat',
    });
    expect(await factory.resolveAzureDevOpsWikiProvider('owner')).toBeNull();
  });
  it('resolves knowledge providers based on user configuration', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);
    const factory = new DynamicProviderFactory(service);

    // None configured
    expect(await factory.resolveKnowledgeProvider('owner-1')).toBeNull();

    // Azure DevOps Wiki
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'my-org' },
      secret: 'my-pat',
    });
    const azureProvider = await factory.resolveKnowledgeProvider('owner-1');
    expect(azureProvider?.name).toBe('Azure DevOps');

    // Azure DevOps Wiki with project
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'my-org', project: 'my-proj' },
      secret: 'my-pat',
    });
    const azureProviderWithProj = await factory.resolveKnowledgeProvider('owner-1');
    expect(azureProviderWithProj?.name).toBe('Azure DevOps');

    // GitHub Projects
    // GitHub Projects with organization and project fallback and no baseUrl
    await service.deleteIntegration('owner-1', 'KNOWLEDGE', 'azure_devops_wiki');
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'github_projects', {
      isEnabled: true,
      settings: { organization: 'gh-org', project: 'gh-repo' },
      secret: 'gh-pat',
    });
    const ghProvider = await factory.resolveKnowledgeProvider('owner-1');
    expect(ghProvider?.name).toBe('GitHub Projects & Wiki');

    // GitHub Projects with explicit owner, repo, and baseUrl
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'github_projects', {
      isEnabled: true,
      settings: { owner: 'gh-org', repo: 'gh-repo', baseUrl: 'https://api.github.com' },
      secret: 'gh-pat',
    });
    const ghProviderExplicit = await factory.resolveKnowledgeProvider('owner-1');
    expect(ghProviderExplicit?.name).toBe('GitHub Projects & Wiki');

    // Wiki.js
    await service.deleteIntegration('owner-1', 'KNOWLEDGE', 'github_projects');
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'wiki_js', {
      isEnabled: true,
      settings: { baseUrl: 'https://wiki.example.com' },
      secret: 'wiki-jwt',
    });
    const wikiProvider = await factory.resolveKnowledgeProvider('owner-1');
    expect(wikiProvider?.name).toBe('Wiki.js');

    // Unknown provider
    await service.deleteIntegration('owner-1', 'KNOWLEDGE', 'wiki_js');
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'unknown_wiki', {
      isEnabled: true,
      settings: {},
    });
    expect(await factory.resolveKnowledgeProvider('owner-1')).toBeNull();
  });

  it('resolves LLM providers based on user configuration', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);
    const factory = new DynamicProviderFactory(service);

    // None configured
    expect(await factory.resolveLlmProvider('owner-1')).toBeNull();

    // Gemini with explicit model
    await service.saveIntegration('owner-1', 'LLM', 'gemini', {
      isEnabled: true,
      settings: { model: 'gemini-1.5-pro' },
      secret: 'gemini-key',
    });
    const gemini = await factory.resolveLlmProvider('owner-1');
    expect(gemini?.provider).toBe('Gemini');

    // Gemini with default model
    await service.saveIntegration('owner-1', 'LLM', 'gemini', {
      isEnabled: true,
      settings: {},
      secret: 'gemini-key',
    });
    const geminiDefault = await factory.resolveLlmProvider('owner-1');
    expect(geminiDefault?.provider).toBe('Gemini');

    // Ollama with default baseUrl and model
    await service.deleteIntegration('owner-1', 'LLM', 'gemini');
    await service.saveIntegration('owner-1', 'LLM', 'ollama', {
      isEnabled: true,
      settings: {},
    });
    const ollama = await factory.resolveLlmProvider('owner-1');
    expect(ollama?.provider).toBe('Ollama');

    // Ollama with explicit baseUrl and model
    await service.saveIntegration('owner-1', 'LLM', 'ollama', {
      isEnabled: true,
      settings: { baseUrl: 'http://localhost:11434', model: 'llama3' },
    });
    const ollamaExplicit = await factory.resolveLlmProvider('owner-1');
    expect(ollamaExplicit?.provider).toBe('Ollama');

    // Unknown LLM
    await service.deleteIntegration('owner-1', 'LLM', 'ollama');
    await service.saveIntegration('owner-1', 'LLM', 'unknown_llm', {
      isEnabled: true,
      settings: {},
    });
    expect(await factory.resolveLlmProvider('owner-1')).toBeNull();
  });

  it('probes connectivity across all supported providers with success, failure, and error paths', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);
    const factory = new DynamicProviderFactory(service);

    const successFetcher = (async () => ({ ok: true })) as unknown as typeof fetch;
    const failFetcher = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const errorFetcher = (() => {
      throw new Error('Connection refused');
    }) as unknown as typeof fetch;

    // Azure DevOps (with and without secret)
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const inspectFetcher = (async (url: unknown, init: { headers?: Record<string, string> }) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    const azSuccess = await factory.testConnectivity(
      'azure_devops_wiki',
      'KNOWLEDGE',
      { organization: 'contoso', project: 'Payments' },
      'my-pat-token',
      inspectFetcher,
    );
    expect(azSuccess.ok).toBe(true);
    expect(capturedUrl).toBe(
      'https://dev.azure.com/contoso/Payments/_apis/wiki/wikis?api-version=7.0',
    );
    expect(capturedHeaders?.authorization).toBe(
      `Basic ${Buffer.from(':my-pat-token').toString('base64')}`,
    );

    // Custom baseUrl
    const azCustomBase = await factory.testConnectivity(
      'azure_devops_wiki',
      'KNOWLEDGE',
      { baseUrl: 'https://azure.internal/tfs/DefaultCollection' },
      'my-pat-token',
      inspectFetcher,
    );
    expect(azCustomBase.ok).toBe(true);
    expect(capturedUrl).toBe(
      'https://azure.internal/tfs/DefaultCollection/_apis/wiki/wikis?api-version=7.0',
    );

    // Already-formatted Basic/Bearer secret
    await factory.testConnectivity(
      'azure_devops_wiki',
      'KNOWLEDGE',
      { organization: 'test-org' },
      'Basic already-encoded',
      inspectFetcher,
    );
    expect(capturedHeaders?.authorization).toBe('Basic already-encoded');

    const azNoSecret = await factory.testConnectivity(
      'azure_devops_wiki',
      'KNOWLEDGE',
      { organization: 'test-org' },
      undefined,
      successFetcher,
    );
    expect(azNoSecret.ok).toBe(true);

    const fetcher401 = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const az401 = await factory.testConnectivity(
      'azure_devops_wiki',
      'KNOWLEDGE',
      { organization: 'test-org' },
      'pat',
      fetcher401,
    );
    expect(az401.ok).toBe(false);
    expect(az401.message).toContain('Falha na autenticação');

    const fetcher404 = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const az404 = await factory.testConnectivity(
      'azure_devops_wiki',
      'KNOWLEDGE',
      { organization: 'test-org' },
      'pat',
      fetcher404,
    );
    expect(az404.ok).toBe(false);
    expect(az404.message).toContain('não encontrado');

    const fetcher500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const az500 = await factory.testConnectivity(
      'azure_devops_wiki',
      'KNOWLEDGE',
      { organization: 'test-org' },
      'pat',
      fetcher500,
    );
    expect(az500.ok).toBe(false);
    expect(az500.message).toBe('Azure DevOps responded with status 500.');

    // GitHub Projects (with and without secret)
    const ghSuccess = await factory.testConnectivity(
      'github_projects',
      'PROJECT_MANAGEMENT',
      { owner: 'org', repo: 'repo' },
      'token',
      successFetcher,
    );
    expect(ghSuccess.ok).toBe(true);

    const ghNoSecret = await factory.testConnectivity(
      'github_projects',
      'PROJECT_MANAGEMENT',
      { owner: 'org', repo: 'repo' },
      undefined,
      successFetcher,
    );
    expect(ghNoSecret.ok).toBe(true);

    const ghFail = await factory.testConnectivity(
      'github_projects',
      'PROJECT_MANAGEMENT',
      { owner: 'org', repo: 'repo' },
      'token',
      failFetcher,
    );
    expect(ghFail.ok).toBe(false);

    // Wiki.js (with and without secret)
    const wikiSuccess = await factory.testConnectivity(
      'wiki_js',
      'KNOWLEDGE',
      { baseUrl: 'https://wiki.example.com' },
      'jwt',
      successFetcher,
    );
    expect(wikiSuccess.ok).toBe(true);

    const wikiNoSecret = await factory.testConnectivity(
      'wiki_js',
      'KNOWLEDGE',
      { baseUrl: 'https://wiki.example.com' },
      undefined,
      successFetcher,
    );
    expect(wikiNoSecret.ok).toBe(true);

    const wikiFail = await factory.testConnectivity(
      'wiki_js',
      'KNOWLEDGE',
      { baseUrl: 'https://wiki.example.com' },
      'jwt',
      failFetcher,
    );
    expect(wikiFail.ok).toBe(false);

    // Gemini (with and without secret)
    const gemSuccess = await factory.testConnectivity(
      'gemini',
      'LLM',
      { model: 'gemini-1.5-flash' },
      'key',
      successFetcher,
    );
    expect(gemSuccess.ok).toBe(true);

    const gemNoSecret = await factory.testConnectivity(
      'gemini',
      'LLM',
      {},
      undefined,
      successFetcher,
    );
    expect(gemNoSecret.ok).toBe(true);

    const gemFail = await factory.testConnectivity(
      'gemini',
      'LLM',
      { model: 'gemini-1.5-flash' },
      'key',
      failFetcher,
    );
    expect(gemFail.ok).toBe(false);

    // Ollama
    const olSuccess = await factory.testConnectivity(
      'ollama',
      'LLM',
      { baseUrl: 'http://localhost:11434' },
      undefined,
      successFetcher,
    );
    expect(olSuccess.ok).toBe(true);

    const olFail = await factory.testConnectivity(
      'ollama',
      'LLM',
      { baseUrl: 'http://localhost:11434' },
      undefined,
      failFetcher,
    );
    expect(olFail.ok).toBe(false);

    // Unknown provider
    const unk = await factory.testConnectivity('unknown', 'LLM', {}, undefined, successFetcher);
    expect(unk.ok).toBe(false);

    // Network error
    const netErr = await factory.testConnectivity('ollama', 'LLM', {}, undefined, errorFetcher);
    expect(netErr.ok).toBe(false);
    expect(netErr.message).toContain('Connection refused');

    // Non-Error exception
    const stringThrowFetcher = (() => {
      throw 'string error';
    }) as unknown as typeof fetch;
    const strErr = await factory.testConnectivity(
      'ollama',
      'LLM',
      {},
      undefined,
      stringThrowFetcher,
    );
    expect(strErr.ok).toBe(false);
    expect(strErr.message).toContain('Unknown network failure');
  });

  it('fetches Azure DevOps project members with team member aggregation, deduplication, and fallbacks', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);
    const factory = new DynamicProviderFactory(service);

    // 1. Not configured
    const unconfigured = await factory.getAzureDevOpsProjectMembers('owner-none');
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.members).toEqual([]);

    // 2. Configured without organization or project
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: '', project: '' },
    });
    const emptyProj = await factory.getAzureDevOpsProjectMembers('owner-1');
    expect(emptyProj.configured).toBe(true);
    expect(emptyProj.members).toEqual([]);

    // 3. Configured with project, but teams endpoint returns 401
    await service.saveIntegration('owner-1', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'my-org', project: 'my-proj' },
      secret: 'my-pat',
    });

    const unauthorizedFetcher = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      factory.getAzureDevOpsProjectMembers('owner-1', unauthorizedFetcher),
    ).rejects.toThrow('Falha ao buscar equipes do projeto "my-proj"');

    // 4. Successful teams and members fetch with multiple teams, deduping, and fallback
    const mockFetcher = (async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/_apis/projects/my-proj/teams?api-version=7.0')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              { id: 'team-1', name: 'Team Alpha' },
              { id: 'team-2', name: 'Team Beta' },
              { id: 'team-fail', name: 'Team Fail' },
            ],
          }),
        };
      }
      if (urlStr.includes('/teams/team-1/members')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                identity: {
                  id: 'usr-1',
                  displayName: 'Alice Developer',
                  uniqueName: 'alice@company.com',
                  imageUrl: 'https://avatar.com/alice.png',
                },
              },
              {
                identity: {
                  id: 'usr-2',
                  displayName: 'Bob Tester',
                  uniqueName: 'bob@company.com',
                },
              },
            ],
          }),
        };
      }
      if (urlStr.includes('/teams/team-2/members')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              // Duplicate of Alice
              {
                identity: {
                  id: 'usr-1',
                  displayName: 'Alice Developer',
                  uniqueName: 'alice@company.com',
                },
              },
              // Flat member without nested identity
              {
                id: 'usr-3',
                displayName: 'Charlie Product',
                uniqueName: 'charlie@company.com',
              },
            ],
          }),
        };
      }
      if (urlStr.includes('/classificationnodes/areas?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'my-proj',
            children: [{ name: 'Team A', children: [{ name: 'API' }] }],
          }),
        };
      }
      if (urlStr.includes('/workitemtypes/Test%20Case/states?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ value: [{ name: 'Design' }, { name: 'Ready' }] }),
        };
      }
      // team-fail returns 500
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      };
    }) as unknown as typeof fetch;

    const result = await factory.getAzureDevOpsProjectMembers('owner-1', mockFetcher);
    expect(result.configured).toBe(true);
    expect(result.organization).toBe('my-org');
    expect(result.project).toBe('my-proj');
    expect(result.members).toHaveLength(3);
    expect(result.members[0]).toEqual({
      id: 'usr-1',
      displayName: 'Alice Developer',
      email: 'alice@company.com',
      avatarUrl: 'https://avatar.com/alice.png',
    });
    expect(result.members[1]!.displayName).toBe('Bob Tester');
    expect(result.members[2]!.displayName).toBe('Charlie Product');

    const resultWithTestOptions = await factory.getAzureDevOpsProjectMembers(
      'owner-1',
      mockFetcher,
      undefined,
      true,
    );
    expect(resultWithTestOptions.areaPaths).toEqual([
      'my-proj',
      'my-proj\\Team A',
      'my-proj\\Team A\\API',
    ]);
    expect(resultWithTestOptions.states).toEqual(['Design', 'Ready']);

    // 5. Fallback to actorId when workspace owner integration is missing/disabled
    await service.saveIntegration('actor-user', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: {
        organization: 'actor-org',
        project: 'actor-proj',
        baseUrl: 'https://custom.azure.com/actor-org',
      },
      secret: 'Bearer custom-token',
    });

    const actorFetcher = (async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/_apis/projects/actor-proj/teams?api-version=7.0')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}), // tests missing value property branch
        };
      }
      if (urlStr.includes('/teams/actor-proj/members')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                identity: {
                  id: '',
                  displayName: '',
                  uniqueName: '',
                },
              },
              // Has displayName only (no id, no email)
              {
                identity: {
                  displayName: 'Only Name User',
                },
              },
              // Has id and email only (no displayName)
              {
                id: 'id-only',
                identity: {
                  uniqueName: 'noname@company.com',
                },
              },
              // Normal member
              {
                id: 'actor-mem-1',
                displayName: 'Actor Member',
                uniqueName: 'actor@company.com',
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const fallbackResult = await factory.getAzureDevOpsProjectMembers(
      'workspace-without-azure',
      actorFetcher,
      'actor-user',
    );
    expect(fallbackResult.configured).toBe(true);
    expect(fallbackResult.organization).toBe('actor-org');
    expect(fallbackResult.members).toHaveLength(3);
    expect(fallbackResult.members[0]!.displayName).toBe('Only Name User');
    expect(fallbackResult.members[0]!.id).toBe('Only Name User');
    expect(fallbackResult.members[1]!.displayName).toBe('Sem Nome');
    expect(fallbackResult.members[1]!.id).toBe('id-only');
    expect(fallbackResult.members[2]!.displayName).toBe('Actor Member');
  });
});
