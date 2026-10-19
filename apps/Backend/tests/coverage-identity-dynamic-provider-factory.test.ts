import { describe, expect, it, vi } from 'vitest';
import type { IntegrationCategory, IntegrationDTO } from '../src/contracts/integrations.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import type { SupportedLocale } from '../src/shared/i18n.js';

interface Entry {
  readonly owner?: string;
  readonly category: IntegrationCategory;
  readonly providerId: string;
  readonly settings?: Record<string, unknown>;
  readonly isEnabled?: boolean;
  readonly secret?: string | null;
  readonly hasSecret?: boolean;
}

/** In-memory stand-in for IntegrationsService with full control over secrets. */
function fakeService(entries: readonly Entry[]): IntegrationsService {
  const dto = (entry: Entry): IntegrationDTO => ({
    id: `${entry.providerId}-id`,
    category: entry.category,
    providerId: entry.providerId,
    isEnabled: entry.isEnabled ?? true,
    settings: entry.settings ?? {},
    hasSecret: entry.hasSecret ?? Boolean(entry.secret),
    updatedAt: new Date(0).toISOString(),
  });
  const find = (owner: string, category: string, providerId: string) =>
    entries.find(
      (entry) =>
        (entry.owner ?? 'owner') === owner &&
        entry.category === category &&
        entry.providerId === providerId,
    );
  return {
    listIntegrations: (owner: string) =>
      Promise.resolve(entries.filter((entry) => (entry.owner ?? 'owner') === owner).map(dto)),
    getIntegration: (owner: string, category: string, providerId: string) => {
      const entry = find(owner, category, providerId);
      return Promise.resolve(entry ? dto(entry) : null);
    },
    getDecryptedSecret: (owner: string, category: string, providerId: string) =>
      Promise.resolve(find(owner, category, providerId)?.secret ?? null),
  } as unknown as IntegrationsService;
}

function factoryFor(entries: readonly Entry[], fetcher?: typeof fetch) {
  return new DynamicProviderFactory(fakeService(entries), fetcher);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function respond(status: number) {
  return vi.fn(() => Promise.resolve(new Response(null, { status }))) as unknown as typeof fetch & {
    mock: { calls: unknown[][] };
  };
}

describe('DynamicProviderFactory push providers', () => {
  it('lists enabled board/wiki push providers that have credentials', async () => {
    const factory = factoryFor([
      { category: 'KNOWLEDGE', providerId: 'azure_devops_wiki', secret: 'pat' },
      { category: 'PROJECT_MANAGEMENT', providerId: 'trello', secret: 's' },
      { category: 'PROJECT_MANAGEMENT', providerId: 'jira', isEnabled: false, secret: 's' },
      { category: 'PROJECT_MANAGEMENT', providerId: 'github_projects' },
      { category: 'LLM', providerId: 'openai', secret: 'k' },
    ]);
    expect(await factory.listBrainPushProviders('owner')).toEqual([
      { providerId: 'azure_devops_wiki', name: 'Azure DevOps Wiki', settings: {} },
      { providerId: 'trello', name: 'Trello', settings: {} },
    ]);
  });

  it('resolves board push providers only for supported, configured integrations', async () => {
    const factory = factoryFor([
      {
        category: 'PROJECT_MANAGEMENT',
        providerId: 'trello',
        secret: 'token',
        settings: { apiKey: 'key', boardId: 'board' },
      },
      {
        category: 'PROJECT_MANAGEMENT',
        providerId: 'jira',
        hasSecret: true,
        secret: null,
        settings: {},
      },
    ]);
    expect(await factory.resolveBrainBoardPushProvider('owner', 'azure_devops_wiki')).toBeNull();
    expect(await factory.resolveBrainBoardPushProvider('owner', 'github_projects')).toBeNull();
    expect(await factory.resolveBrainBoardPushProvider('owner', 'trello')).not.toBeNull();
    await expect(factory.resolveBrainBoardPushProvider('owner', 'jira')).rejects.toThrow(
      'Provider credential is missing.',
    );
  });
});

describe('DynamicProviderFactory test suite publisher', () => {
  const wiki = (settings: Record<string, unknown>, extra: Partial<Entry> = {}): Entry => ({
    category: 'KNOWLEDGE',
    providerId: 'azure_devops_wiki',
    secret: 'pat',
    settings,
    ...extra,
  });

  it('returns null unless Azure DevOps is fully configured', async () => {
    expect(await factoryFor([]).resolveTestSuitePublisher('owner', 'testrail')).toBeNull();
    expect(await factoryFor([]).resolveTestSuitePublisher('owner')).toBeNull();
    expect(
      await factoryFor([
        wiki({ organization: 'o', project: 'p' }, { isEnabled: false }),
      ]).resolveTestSuitePublisher('owner'),
    ).toBeNull();
    expect(
      await factoryFor([
        wiki({ organization: 'o', project: 'p' }, { secret: '  ' }),
      ]).resolveTestSuitePublisher('owner'),
    ).toBeNull();
    expect(
      await factoryFor([
        wiki({ organization: 'o', project: 'p' }, { secret: null }),
      ]).resolveTestSuitePublisher('owner'),
    ).toBeNull();
    expect(
      await factoryFor([wiki({ organization: 'o' })]).resolveTestSuitePublisher('owner'),
    ).toBeNull();
    expect(
      await factoryFor([wiki({ project: 'p' })]).resolveTestSuitePublisher('owner'),
    ).toBeNull();
    expect(await factoryFor([]).listTestSuiteProviders('owner')).toEqual([
      { id: 'azure_devops', name: 'Azure DevOps', configured: false },
    ]);
  });

  it('derives the organization base URL from settings', async () => {
    const plans = (fetcher: ReturnType<typeof vi.fn>) => String(fetcher.mock.calls[0]![0]);
    const ok = () => vi.fn(() => Promise.resolve(json({ value: [] })));

    const defaultFetcher = ok();
    const defaultBase = await factoryFor(
      [wiki({ organization: 'my org', project: 'Proj' })],
      defaultFetcher as unknown as typeof fetch,
    ).resolveTestSuitePublisher('owner');
    await defaultBase!.listPlans();
    expect(plans(defaultFetcher)).toContain('https://dev.azure.com/my%20org/Proj/');

    const projectFetcher = ok();
    const withProject = await factoryFor(
      [wiki({ organization: 'o', project: 'Proj', baseUrl: 'https://ado.test/o/proj//' })],
      projectFetcher as unknown as typeof fetch,
    ).resolveTestSuitePublisher('owner');
    await withProject!.listPlans();
    expect(plans(projectFetcher)).toContain('https://ado.test/o/Proj/');

    const orgFetcher = ok();
    const orgOnly = await factoryFor(
      [wiki({ organization: 'o', project: 'Proj', baseUrl: 'https://ado.test/o' })],
      orgFetcher as unknown as typeof fetch,
    ).resolveTestSuitePublisher('owner');
    await orgOnly!.listPlans();
    expect(plans(orgFetcher)).toContain('https://ado.test/o/Proj/');

    expect(
      await factoryFor([wiki({ organization: 'o', project: 'p' })]).listTestSuiteProviders('owner'),
    ).toEqual([{ id: 'azure_devops', name: 'Azure DevOps', configured: true }]);
  });

  it('resolves the Azure wiki provider with an explicit wiki identifier and fetcher', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const factory = factoryFor([wiki({ organization: 'o', wikiIdentifier: 'w' })]);
    expect((await factory.resolveAzureDevOpsWikiProvider('owner', fetcher, ' custom '))?.name).toBe(
      'Azure DevOps',
    );
    expect((await factory.resolveAzureDevOpsWikiProvider('owner', fetcher, '  '))?.name).toBe(
      'Azure DevOps',
    );
    expect(
      await factoryFor([
        wiki({ organization: 'o' }, { secret: null }),
      ]).resolveAzureDevOpsWikiProvider('owner'),
    ).toBeNull();
  });
});

describe('DynamicProviderFactory knowledge and LLM providers', () => {
  it('resolves GitHub, Wiki.js and unknown knowledge providers', async () => {
    const github = (settings: Record<string, unknown>, secret: string | null = 'gh') =>
      factoryFor([{ category: 'KNOWLEDGE', providerId: 'github_projects', settings, secret }]);
    expect(
      (
        await github({
          owner: 'o',
          repo: 'r',
          baseUrl: 'https://gh.test',
        }).resolveKnowledgeProvider('owner')
      )?.name,
    ).toBe('GitHub Projects & Wiki');
    expect(
      (await github({ organization: 'o', project: 'r' }, null).resolveKnowledgeProvider('owner'))
        ?.name,
    ).toBe('GitHub Projects & Wiki');

    const wikiJs = factoryFor([{ category: 'KNOWLEDGE', providerId: 'wiki_js' }]);
    expect((await wikiJs.resolveKnowledgeProvider('owner'))?.name).toBe('Wiki.js');
    const wikiJsCustom = factoryFor([
      { category: 'KNOWLEDGE', providerId: 'wiki_js', settings: { baseUrl: 'https://w.test' } },
    ]);
    expect((await wikiJsCustom.resolveKnowledgeProvider('owner'))?.name).toBe('Wiki.js');

    expect(
      await factoryFor([
        { category: 'KNOWLEDGE', providerId: 'confluence' },
      ]).resolveKnowledgeProvider('owner'),
    ).toBeNull();
    expect(
      (
        await factoryFor([
          {
            category: 'KNOWLEDGE',
            providerId: 'azure_devops_wiki',
            settings: { baseUrl: ' https://ado.test/o ' },
          },
        ]).resolveKnowledgeProvider('owner')
      )?.name,
    ).toBe('Azure DevOps');
    expect(await factoryFor([]).resolveKnowledgeProvider('owner')).toBeNull();
    for (const settings of [{ organization: 'o' }, { organization: 'o', project: 'p' }]) {
      expect(
        (
          await factoryFor([
            { category: 'KNOWLEDGE', providerId: 'azure_devops_wiki', settings },
          ]).resolveKnowledgeProvider('owner')
        )?.name,
      ).toBe('Azure DevOps');
    }
    expect(
      (
        await factoryFor([
          {
            category: 'KNOWLEDGE',
            providerId: 'azure_devops_wiki',
            settings: { baseUrl: 'https://ado.test/o2' },
          },
        ]).resolveKnowledgeProvider('owner')
      )?.name,
    ).toBe('Azure DevOps');
  });

  it('resolves each LLM provider and honors provider and model overrides', async () => {
    const factory = factoryFor([
      { category: 'LLM', providerId: 'gemini', secret: 'g' },
      { category: 'LLM', providerId: 'openai', secret: 'o', settings: { model: 'gpt' } },
      { category: 'LLM', providerId: 'claude', secret: 'c', settings: { model: 'm' } },
      { category: 'LLM', providerId: 'anthropic', secret: 'a', settings: { model: 'm' } },
      { category: 'LLM', providerId: 'groq', secret: 'q', settings: { model: 'llama' } },
      { category: 'LLM', providerId: 'ollama', settings: { baseUrl: 'http://o.test' } },
      { category: 'LLM', providerId: 'mistral', secret: 'x' },
    ]);
    expect(await factoryFor([]).resolveLlmProvider('owner')).toBeNull();
    expect(await factory.resolveLlmProvider('owner')).not.toBeNull();
    expect(
      await factory.resolveLlmProvider('owner', 'gemini', undefined, 'gemini-pro'),
    ).not.toBeNull();
    for (const id of ['openai', ' Claude ', 'anthropic', 'groq']) {
      expect(await factory.resolveLlmProvider('owner', id)).not.toBeNull();
    }
    expect(await factory.resolveLlmProvider('owner', 'ollama')).not.toBeNull();
    expect(
      await factoryFor([{ category: 'LLM', providerId: 'ollama' }]).resolveLlmProvider('owner'),
    ).not.toBeNull();
    expect(await factory.resolveLlmProvider('owner', 'mistral')).toBeNull();
    expect(await factory.resolveLlmProvider('owner', 'unknown')).toBeNull();
  });
});

describe('DynamicProviderFactory.testConnectivity', () => {
  const locales: readonly (SupportedLocale | undefined)[] = [undefined, 'en-US'];

  async function probe(
    providerId: string,
    settings: Record<string, unknown>,
    secret: string | undefined,
    fetcher: typeof fetch,
    locale?: SupportedLocale,
  ) {
    return factoryFor([]).testConnectivity(providerId, 'LLM', settings, secret, fetcher, locale);
  }

  it('validates required board credentials and reports board responses', async () => {
    const never = respond(200);
    expect(await probe('azure_devops', { organization: 'o' }, 'pat', never)).toMatchObject({
      ok: false,
      message: 'Organization, project and PAT are required.',
    });
    expect(await probe('trello', { boardId: 'b' }, 'tok', never)).toMatchObject({ ok: false });
    expect(
      await probe(
        'jira',
        { baseUrl: 'http://x.atlassian.net', projectKey: 'K', email: 'e' },
        's',
        never,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('Jira Cloud URL') });
    expect(
      await probe(
        'jira',
        { baseUrl: 'https://jira.example.com', projectKey: 'K', email: 'e' },
        's',
        never,
      ),
    ).toMatchObject({ ok: false });
    expect(never).not.toHaveBeenCalled();

    const azureOk = respond(200);
    expect(
      await probe('azure_devops', { organization: 'o', project: 'p' }, 'pat', azureOk),
    ).toEqual({ ok: true, message: 'Azure Boards connection verified.' });
    expect(String(azureOk.mock.calls[0]![0])).toContain('/o/_apis/projects/p?api-version=7.1');
    expect(
      await probe('azure_devops', { organization: 'o', project: 'p' }, 'pat', respond(401)),
    ).toEqual({ ok: false, message: 'Azure Boards returned 401.' });

    expect(await probe('trello', { boardId: 'b', apiKey: 'k' }, 'tok', respond(200))).toEqual({
      ok: true,
      message: 'Trello board connection verified.',
    });
    expect(await probe('trello', { boardId: 'b', apiKey: 'k' }, 'tok', respond(404))).toEqual({
      ok: false,
      message: 'Trello returned 404.',
    });

    const jira = { baseUrl: 'https://team.atlassian.net/', projectKey: 'K', email: 'e@x.y' };
    const jiraOk = respond(200);
    expect(await probe('jira', jira, 'tok', jiraOk)).toEqual({
      ok: true,
      message: 'Jira project connection verified.',
    });
    expect(jiraOk.mock.calls[0]![0]).toBe('https://team.atlassian.net/rest/api/3/project/K');
    expect(await probe('jira', jira, 'tok', respond(403))).toEqual({
      ok: false,
      message: 'Jira returned 403.',
    });
  });

  it('builds Azure DevOps wiki probes and interprets each status', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const record = (status: number) =>
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return Promise.resolve(new Response(null, { status }));
      }) as unknown as typeof fetch;

    for (const locale of locales) {
      expect(
        await probe(
          'azure_devops_wiki',
          { organization: 'o', project: 'p' },
          'pat',
          record(200),
          locale,
        ),
      ).toEqual({
        ok: true,
        message: locale ? 'Azure DevOps connection verified.' : 'Azure DevOps connection verified.',
      });
      expect(
        (await probe('azure_devops_wiki', { organization: 'o' }, undefined, record(500), locale))
          .message,
      ).toBe('Azure DevOps responded with status 500.');
    }
    expect(calls[0]!.url).toBe('https://dev.azure.com/o/p/_apis/wiki/wikis?api-version=7.0');
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
    expect(calls[1]!.url).toBe('https://dev.azure.com/o/_apis/wiki/wikis?api-version=7.0');
    expect(calls[1]!.headers.authorization).toBeUndefined();

    await probe(
      'azure_devops_wiki',
      { baseUrl: 'https://ado.test/o//' },
      'Bearer abc',
      record(200),
    );
    expect(calls.at(-1)).toEqual({
      url: 'https://ado.test/o/_apis/wiki/wikis?api-version=7.0',
      headers: { accept: 'application/json', authorization: 'Bearer abc' },
    });
    await probe('azure_devops_wiki', { organization: 'o' }, 'Basic xyz', record(200));
    expect(calls.at(-1)!.headers.authorization).toBe('Basic xyz');

    for (const status of [203, 401]) {
      expect(
        (await probe('azure_devops_wiki', { organization: 'o' }, 'pat', record(status))).message,
      ).toContain('Falha na autenticação');
    }
    expect(
      (await probe('azure_devops_wiki', { organization: 'o' }, 'pat', record(404))).message,
    ).toContain('status 404');
  });

  it('probes knowledge and LLM endpoints in both default and localized messages', async () => {
    for (const locale of locales) {
      const github = respond(200);
      expect(await probe('github_projects', {}, 'tok', github, locale)).toMatchObject({ ok: true });
      expect(github.mock.calls[0]![0]).toBe('https://api.github.com/user');
      expect(
        (
          await probe(
            'github_projects',
            { baseUrl: 'https://gh.test/' },
            undefined,
            respond(401),
            locale,
          )
        ).message,
      ).toBe('GitHub responded with status 401.');

      expect((await probe('wiki_js', {}, 'tok', respond(200), locale)).message).toBe(
        'Wiki.js connection verified.',
      );
      expect(
        (await probe('wiki_js', { baseUrl: 'https://w.test' }, undefined, respond(500), locale))
          .message,
      ).toBe('Wiki.js responded with status 500.');

      const gemini = respond(200);
      expect((await probe('gemini', {}, undefined, gemini, locale)).message).toBe(
        'Gemini API connection verified.',
      );
      expect(String(gemini.mock.calls[0]![0])).toContain(
        'models/gemini-1.5-flash:generateContent?key=',
      );
      expect((await probe('gemini', { model: 'x' }, 'k', respond(400), locale)).message).toBe(
        'Gemini API responded with status 400.',
      );

      for (const id of ['openai', 'groq', 'claude', 'anthropic']) {
        expect((await probe(id, { model: '' }, 'k', respond(200), locale)).message).toBe(
          'API key and model are required.',
        );
      }
      expect((await probe('openai', { model: 'gpt' }, ' k ', respond(200), locale)).ok).toBe(true);
      expect((await probe('groq', { model: 'llama' }, 'k', respond(200), locale)).ok).toBe(true);
      expect((await probe('openai', { model: 'gpt' }, 'k', respond(401), locale)).message).toEqual(
        expect.stringContaining('401'),
      );
      expect((await probe('groq', { model: 'l' }, 'k', respond(429), locale)).ok).toBe(false);
      expect((await probe('claude', { model: 'm' }, 'k', respond(200), locale)).message).toBe(
        'Claude API connection verified.',
      );
      expect((await probe('anthropic', { model: 'm' }, 'k', respond(401), locale)).message).toBe(
        'Claude API responded with status 401.',
      );

      const ollama = respond(200);
      expect((await probe('ollama', {}, undefined, ollama, locale)).ok).toBe(true);
      expect(ollama.mock.calls[0]![0]).toBe('http://localhost:11434/api/tags');
      expect(
        (await probe('ollama', { baseUrl: 'http://o.test/' }, undefined, respond(503), locale))
          .message,
      ).toBe('Ollama responded with status 503.');

      expect((await probe('mystery', {}, undefined, respond(200), locale)).message).toMatch(
        /mystery/,
      );
    }
    expect((await probe('openai', { model: 'gpt' }, 'k', respond(200))).message).toBe(
      'OpenAI API connection verified.',
    );
    expect((await probe('groq', { model: 'l' }, 'k', respond(200))).message).toBe(
      'Groq API connection verified.',
    );
    expect((await probe('ollama', {}, undefined, respond(200))).message).toBe(
      'Ollama local/remote connection verified.',
    );
    expect((await probe('mystery', {}, undefined, respond(200))).message).toBe(
      "Unknown provider 'mystery'.",
    );
  });

  it('turns thrown errors into failed probes', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const weird = vi.fn(() => Promise.reject('boom')) as unknown as typeof fetch;
    for (const locale of locales) {
      expect((await probe('ollama', {}, undefined, failing, locale)).message).toContain('offline');
      expect((await probe('ollama', {}, undefined, weird, locale)).message).toContain(
        'Unknown network failure.',
      );
    }
    expect((await probe('ollama', {}, undefined, failing)).message).toBe(
      'Connection probe failed: offline',
    );
    // An unparsable Jira URL throws inside the probe.
    expect(
      (await probe('jira', { baseUrl: 'https://', projectKey: 'K', email: 'e' }, 's', failing)).ok,
    ).toBe(false);
  });
});

describe('DynamicProviderFactory.getAzureDevOpsProjectMembers', () => {
  const wiki = (owner: string, settings: Record<string, unknown>, extra: Partial<Entry> = {}) => ({
    owner,
    category: 'KNOWLEDGE' as IntegrationCategory,
    providerId: 'azure_devops_wiki',
    secret: 'pat',
    settings,
    ...extra,
  });

  it('reports unconfigured integrations and falls back to the actor', async () => {
    expect(await factoryFor([]).getAzureDevOpsProjectMembers('owner')).toEqual({
      configured: false,
      organization: null,
      project: null,
      members: [],
    });
    expect(
      await factoryFor([wiki('owner', {}, { isEnabled: false })]).getAzureDevOpsProjectMembers(
        'owner',
        undefined,
        'owner',
      ),
    ).toMatchObject({ configured: false });
    expect(
      await factoryFor([wiki('actor', {}, { isEnabled: false })]).getAzureDevOpsProjectMembers(
        'owner',
        undefined,
        'actor',
      ),
    ).toMatchObject({ configured: false });
    expect(
      await factoryFor([wiki('actor', { organization: 'org' })]).getAzureDevOpsProjectMembers(
        'owner',
        undefined,
        'actor',
      ),
    ).toEqual({ configured: true, organization: 'org', project: null, members: [] });
    expect(
      await factoryFor([
        wiki('owner', { project: 'p' }, { secret: null }),
      ]).getAzureDevOpsProjectMembers('owner'),
    ).toEqual({ configured: true, organization: null, project: 'p', members: [] });
  });

  it('collects unique members across teams', async () => {
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    const fetcher = vi.fn((url: string, init: RequestInit) => {
      urls.push(url);
      headers.push(init.headers as Record<string, string>);
      if (url.includes('/teams?'))
        return Promise.resolve(
          json({ value: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }] }),
        );
      if (url.includes('/teams/t1/'))
        return Promise.resolve(
          json({
            value: [
              {
                identity: {
                  id: ' u1 ',
                  displayName: ' Ana ',
                  uniqueName: 'ana@x.y',
                  imageUrl: 'https://img/ana',
                },
              },
              { id: 'u2', displayName: 'Bob', uniqueName: 'bob@x.y' },
              { uniqueName: 'nameless@x.y' },
              {},
            ],
          }),
        );
      if (url.includes('/teams/t2/'))
        return Promise.resolve(
          json({
            value: [{ identity: { id: 'u1', displayName: 'Dup' } }, { displayName: 'Only Name' }],
          }),
        );
      if (url.includes('/teams/t3/')) return Promise.resolve(json(null));
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as unknown as typeof fetch;

    const result = await factoryFor([
      wiki('owner', { organization: 'my org', project: 'Proj' }),
    ]).getAzureDevOpsProjectMembers('owner', fetcher);
    expect(result).toEqual({
      configured: true,
      organization: 'my org',
      project: 'Proj',
      members: [
        { id: 'u1', displayName: 'Ana', email: 'ana@x.y', avatarUrl: 'https://img/ana' },
        { id: 'u2', displayName: 'Bob', email: 'bob@x.y', avatarUrl: undefined },
        {
          id: 'nameless@x.y',
          displayName: 'Sem Nome',
          email: 'nameless@x.y',
          avatarUrl: undefined,
        },
        { id: 'Only Name', displayName: 'Only Name', email: '', avatarUrl: undefined },
      ],
    });
    expect(urls[0]).toBe(
      'https://dev.azure.com/my%20org/_apis/projects/Proj/teams?api-version=7.0',
    );
    expect(headers[0]!.authorization).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
  });

  it('uses the project as team when none are listed and honors token formats', async () => {
    for (const [secret, expected] of [
      ['Bearer t', 'Bearer t'],
      ['Basic b', 'Basic b'],
      ['', undefined],
    ] as const) {
      const urls: string[] = [];
      let auth: string | undefined;
      const fetcher = vi.fn((url: string, init: RequestInit) => {
        urls.push(url);
        auth = (init.headers as Record<string, string>).authorization;
        return Promise.resolve(url.includes('/teams?') ? json({}) : json({}));
      }) as unknown as typeof fetch;
      const result = await factoryFor([
        wiki(
          'owner',
          { organization: 'o', project: 'P', baseUrl: 'https://ado.test/o/' },
          { secret },
        ),
      ]).getAzureDevOpsProjectMembers('owner', fetcher);
      expect(result.members).toEqual([]);
      expect(urls[1]).toBe('https://ado.test/o/_apis/projects/P/teams/P/members?api-version=7.0');
      expect(auth).toBe(expected);
    }
  });

  it('fails when the teams request is rejected', async () => {
    for (const status of [500, 203]) {
      await expect(
        factoryFor([
          wiki('owner', { organization: 'o', project: 'P' }),
        ]).getAzureDevOpsProjectMembers('owner', respond(status)),
      ).rejects.toMatchObject({ code: 'BAD_GATEWAY', statusCode: 502 });
    }
  });

  it('loads area paths and test case states on request', async () => {
    const fetcher = vi.fn((url: string) => {
      if (url.includes('/teams?')) return Promise.resolve(json({ value: [] }));
      if (url.includes('/members')) return Promise.resolve(json({ value: [] }));
      if (url.includes('classificationnodes'))
        return Promise.resolve(
          json({
            name: 'Proj',
            children: [{ name: 'Web', children: [{ name: 'Login' }] }, { name: 'Api' }],
          }),
        );
      return Promise.resolve(
        json({ value: [{ name: 'Design' }, { name: 'Ready' }, { name: 'Design' }] }),
      );
    }) as unknown as typeof fetch;
    const result = await factoryFor([
      wiki('owner', { organization: 'o', project: 'Proj' }),
    ]).getAzureDevOpsProjectMembers('owner', fetcher, undefined, true);
    expect(result.areaPaths).toEqual(['Proj', 'Proj\\Web', 'Proj\\Web\\Login', 'Proj\\Api']);
    expect(result.states).toEqual(['Design', 'Ready']);

    for (const status of [500, 203]) {
      const failing = vi.fn((url: string) =>
        Promise.resolve(
          url.includes('/_apis/wit/') ? new Response(null, { status }) : json({ value: [] }),
        ),
      ) as unknown as typeof fetch;
      await expect(
        factoryFor([
          wiki('owner', { organization: 'o', project: 'Proj' }),
        ]).getAzureDevOpsProjectMembers('owner', failing, undefined, true),
      ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    }
  });
});
