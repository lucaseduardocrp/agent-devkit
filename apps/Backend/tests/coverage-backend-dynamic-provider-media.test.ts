import { describe, expect, it, vi } from 'vitest';
import type { IntegrationCategory, IntegrationDTO } from '../src/contracts/integrations.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';

interface Entry {
  category: IntegrationCategory;
  providerId: string;
  settings?: Record<string, unknown>;
  isEnabled?: boolean;
  secret?: string | null;
  hasSecret?: boolean;
}

function factory(entries: Entry[]) {
  const dto = (entry: Entry): IntegrationDTO => ({
    id: entry.providerId,
    category: entry.category,
    providerId: entry.providerId,
    isEnabled: entry.isEnabled ?? true,
    settings: entry.settings ?? {},
    hasSecret: entry.hasSecret ?? Boolean(entry.secret),
    updatedAt: new Date(0).toISOString(),
  });
  const service = {
    listIntegrations: () => Promise.resolve(entries.map(dto)),
    getDecryptedSecret: (_owner: string, _category: string, providerId: string) =>
      Promise.resolve(entries.find((entry) => entry.providerId === providerId)?.secret ?? null),
  } as unknown as IntegrationsService;
  return new DynamicProviderFactory(service);
}

const media = (entries: Entry[], url: string) =>
  factory(entries).resolveMediaAuthorization('owner', new URL(url));
const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

describe('DynamicProviderFactory.resolveMediaAuthorization', () => {
  it('signs Azure DevOps files of the configured organization', async () => {
    const azure: Entry = {
      category: 'PROJECT_MANAGEMENT',
      providerId: 'azure_devops',
      settings: { organization: 'Acme' },
      secret: ' pat ',
    };
    expect(await media([azure], 'https://dev.azure.com/acme/_apis/wit/attachments/1')).toEqual({
      authorization: basic(':pat'),
    });
    expect(await media([azure], 'https://acme.visualstudio.com/_apis/x')).toEqual({
      authorization: basic(':pat'),
    });
    expect(await media([azure], 'https://dev.azure.com/other/_apis/x')).toBeNull();
    const custom = { ...azure, settings: { baseUrl: 'https://tfs.example.test/tfs' } };
    expect(await media([custom], 'https://tfs.example.test/file')).toEqual({
      authorization: basic(':pat'),
    });
    expect(
      await media([{ ...azure, settings: { baseUrl: 'not a url' } }], 'https://x.test/'),
    ).toBeNull();
    expect(
      await media([{ ...azure, secret: 'Bearer abc' }], 'https://dev.azure.com/acme/f'),
    ).toEqual({ authorization: 'Bearer abc' });
  });

  it('signs Jira, GitHub, Trello and Wiki.js files for their own hosts only', async () => {
    const jira: Entry = {
      category: 'PROJECT_MANAGEMENT',
      providerId: 'jira',
      settings: { baseUrl: 'https://acme.atlassian.net', email: 'qa@acme.test' },
      secret: 'token',
    };
    expect(await media([jira], 'https://acme.atlassian.net/secure/attachment/1')).toEqual({
      authorization: basic('qa@acme.test:token'),
    });
    expect(await media([jira], 'https://evil.test/secure/attachment/1')).toBeNull();

    const github: Entry = {
      category: 'PROJECT_MANAGEMENT',
      providerId: 'github_projects',
      secret: 'gh',
    };
    for (const host of [
      'github.com',
      'raw.githubusercontent.com',
      'user-images.githubusercontent.com',
    ])
      expect(await media([github], `https://${host}/a.png`)).toEqual({
        authorization: 'Bearer gh',
      });
    expect(await media([github], 'https://example.test/a.png')).toBeNull();

    const trello: Entry = {
      category: 'PROJECT_MANAGEMENT',
      providerId: 'trello',
      settings: { apiKey: ' key ' },
      secret: 'tok',
    };
    expect(await media([trello], 'https://trello.com/1/cards/a.png')).toEqual({
      authorization: 'OAuth oauth_consumer_key="key", oauth_token="tok"',
    });
    expect(await media([trello], 'https://example.test/a.png')).toBeNull();

    const wiki: Entry = {
      category: 'KNOWLEDGE',
      providerId: 'wiki_js',
      settings: { baseUrl: 'https://wiki.acme.test' },
      secret: 'w',
    };
    expect(await media([wiki], 'https://wiki.acme.test/a.png')).toEqual({
      authorization: 'Bearer w',
    });
    expect(await media([wiki], 'https://other.test/a.png')).toBeNull();
  });

  it('has no integration for a URL without a path to read a segment from', async () => {
    const azure: Entry = {
      category: 'PROJECT_MANAGEMENT',
      providerId: 'azure_devops',
      settings: { organization: 'acme' },
      secret: 'pat',
    };
    expect(await media([azure], 'mailto:someone@acme.test')).toBeNull();
  });

  it('skips disabled integrations, missing secrets and unknown providers', async () => {
    const github: Entry = {
      category: 'PROJECT_MANAGEMENT',
      providerId: 'github_projects',
      secret: 'gh',
    };
    expect(await media([{ ...github, isEnabled: false }], 'https://github.com/a')).toBeNull();
    expect(await media([{ ...github, hasSecret: false }], 'https://github.com/a')).toBeNull();
    expect(await media([{ ...github, secret: '  ' }], 'https://github.com/a')).toBeNull();
    expect(
      await media([{ category: 'LLM', providerId: 'openai', secret: 'x' }], 'https://github.com/a'),
    ).toBeNull();
  });
});

describe('DynamicProviderFactory Telegram connectivity', () => {
  const probe = (secret: string | undefined, fetcher: typeof fetch) =>
    factory([]).testConnectivity('telegram', 'MESSAGING', {}, secret, fetcher);
  const reply = (body: unknown, status = 200) =>
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    ) as unknown as typeof fetch;

  it('rejects tokens that do not look like a BotFather token without calling Telegram', async () => {
    const fetcher = reply({});
    expect(await probe('not a token', fetcher)).toMatchObject({ ok: false });
    expect(await probe(undefined, fetcher)).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('names the bot when Telegram accepts the token, and reports rejections', async () => {
    expect(await probe('123:AAF-x', reply({ ok: true, result: { username: 'adk_bot' } }))).toEqual({
      ok: true,
      message: 'Connected to @adk_bot.',
    });
    expect(await probe('123:AAF-x', reply({ ok: true, result: {} }))).toMatchObject({
      message: 'Connected to @bot.',
    });
    expect(await probe('123:AAF-x', reply({ ok: false }, 401))).toEqual({
      ok: false,
      message: 'Telegram rejected the token (401).',
    });
    const html = vi.fn(() =>
      Promise.resolve(new Response('<html>', { status: 502 })),
    ) as unknown as typeof fetch;
    expect(await probe('123:AAF-x', html)).toMatchObject({
      message: 'Telegram rejected the token (502).',
    });
  });
});
