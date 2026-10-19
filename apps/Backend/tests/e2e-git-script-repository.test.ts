import { describe, expect, it, vi } from 'vitest';
import { GitScriptRepository } from '../src/modules/e2e/adapters/git-script-repository.js';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import type { E2eRepositoryRef } from '../src/modules/e2e/domain/e2e.js';

type Route = (url: string, init: RequestInit) => Response | undefined;

function setup(
  routes: Route[],
  options: {
    integrations?: {
      providerId: string;
      isEnabled?: boolean;
      settings?: Record<string, unknown>;
    }[];
    secrets?: Record<string, string | null>;
  } = {},
) {
  const calls: { url: string; method: string; body?: unknown; headers: Record<string, string> }[] =
    [];
  const fetcher = vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return Promise.resolve(response);
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  const integrations = {
    listIntegrations: vi.fn().mockResolvedValue(
      (
        options.integrations ?? [
          { providerId: 'github_projects', settings: {} },
          {
            providerId: 'azure_devops_wiki',
            settings: {
              organization: 'org',
              project: 'Finance',
              baseUrl: 'https://dev.azure.com/org/Finance/',
            },
          },
        ]
      ).map((item) => ({
        category: 'KNOWLEDGE',
        isEnabled: true,
        settings: {},
        ...item,
      })),
    ),
    getDecryptedSecret: vi.fn((_ws: string, _category: string, providerId: string) =>
      Promise.resolve(options.secrets ? (options.secrets[providerId] ?? null) : 'tok'),
    ),
  } as unknown as IntegrationsService;
  return { repo: new GitScriptRepository(integrations, fetcher as typeof fetch), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const github: E2eRepositoryRef = {
  provider: 'github',
  id: '42',
  name: 'acme/demo-app',
  branch: 'main',
  path: 'tests/e2e',
};
const azure: E2eRepositoryRef = {
  provider: 'azure_devops',
  id: 'guid-1',
  name: 'Finance/app',
  branch: 'develop',
  path: 'tests/e2e',
};
const AZ = 'https://dev.azure.com/org';

describe('GitScriptRepository – GitHub', () => {
  it('lists every repository page and the branches with the default first', async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      full_name: `acme/repo-${String(index).padStart(3, '0')}`,
    }));
    const { repo, calls } = setup([
      (url) =>
        url.includes('/user/repos') && url.includes('page=1&')
          ? json(page1)
          : url.includes('/user/repos') && url.includes('page=2&')
            ? json([
                {
                  id: 42,
                  full_name: 'acme/demo-app',
                  default_branch: 'trunk',
                  html_url: 'https://github.com/acme/demo-app',
                },
              ])
            : undefined,
      (url) => (url.endsWith('/_apis/git/repositories?api-version=7.1') ? json({}) : undefined),
      (url) =>
        url === 'https://api.github.com/repositories/42'
          ? json({ full_name: 'acme/demo-app', default_branch: 'trunk' })
          : undefined,
      (url) =>
        url.includes('/repos/acme/demo-app/branches')
          ? json([{ name: 'feature' }, { name: 'trunk' }, { name: 'alpha' }])
          : undefined,
    ]);
    const { repositories, warnings } = await repo.listRepositories('ws');
    expect(repositories).toHaveLength(101);
    expect(repositories.find((item) => item.id === '42')).toEqual({
      id: '42',
      provider: 'github',
      name: 'acme/demo-app',
      defaultBranch: 'trunk',
      webUrl: 'https://github.com/acme/demo-app',
    });
    expect(repositories.find((item) => item.id === '1')?.defaultBranch).toBe('main');
    expect(warnings).toEqual([]);
    expect(calls[0]?.headers['authorization']).toBe('Bearer tok');
    expect(await repo.listBranches('ws', 'github', '42')).toEqual([
      { name: 'trunk', isDefault: true },
      { name: 'alpha', isDefault: false },
      { name: 'feature', isDefault: false },
    ]);
  });

  it('pages branches and falls back to main as default', async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ name: `b${index}` }));
    const { repo } = setup([
      (url) =>
        url.endsWith('/repositories/42') ? json({ full_name: 'acme/demo-app' }) : undefined,
      (url) => (url.includes('branches?per_page=100&page=1') ? json(many) : undefined),
      (url) =>
        url.includes('branches?per_page=100&page=2') ? json([{ name: 'main' }]) : undefined,
    ]);
    const branches = await repo.listBranches('ws', 'github', '42');
    expect(branches).toHaveLength(101);
    expect(branches[0]).toEqual({ name: 'main', isDefault: true });
  });

  it('lists, reads and writes spec files', async () => {
    const { repo, calls } = setup([
      (url) =>
        url.includes('/git/trees/main')
          ? json({
              tree: [
                { path: 'tests/e2e/a.spec.ts', type: 'blob' },
                { path: 'tests/e2e', type: 'tree' },
                { path: 'tests/e2e-other/b.spec.ts', type: 'blob' },
                { path: 'README.md', type: 'blob' },
              ],
            })
          : undefined,
      (url, init) =>
        url.includes('/contents/tests/e2e/a.spec.ts') && !init.method
          ? json({
              sha: 'abc',
              content: Buffer.from('hello')
                .toString('base64')
                .replace(/(.{2})/, '$1\n'),
            })
          : undefined,
      (_url, init) => (init.method === 'PUT' ? json({}, 201) : undefined),
    ]);
    expect(await repo.listFiles('ws', github)).toEqual(['tests/e2e/a.spec.ts']);
    expect(await repo.listFiles('ws', { ...github, path: '' })).toHaveLength(3);
    expect(await repo.readFile('ws', github, 'tests/e2e/a.spec.ts')).toBe('hello');
    expect(await repo.readFile('ws', github, 'tests/e2e/missing.spec.ts')).toBeNull();

    await repo.writeFile('ws', github, 'tests/e2e/a.spec.ts', 'v2', 'update a');
    await repo.writeFile('ws', github, 'tests/e2e/new spec.ts', 'v1', 'add');
    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/demo-app/contents/tests/e2e/a.spec.ts',
      body: {
        message: 'update a',
        branch: 'main',
        sha: 'abc',
        content: Buffer.from('v2').toString('base64'),
      },
    });
    expect(puts[0]?.headers['content-type']).toBe('application/json');
    expect(puts[1]?.url).toContain('/contents/tests/e2e/new%20spec.ts');
    expect(puts[1]?.body).not.toHaveProperty('sha');
  });

  it('handles empty repositories, missing content and API failures', async () => {
    const { repo } = setup([
      (url) => (url.includes('/git/trees/') ? new Response('', { status: 409 }) : undefined),
      (url) => (url.includes('/contents/empty') ? json({}) : undefined),
      (_url, init) => (init.method === 'PUT' ? new Response('', { status: 403 }) : undefined),
      (url) => (url.includes('/contents/boom') ? new Response('', { status: 500 }) : undefined),
    ]);
    expect(await repo.listFiles('ws', github)).toEqual([]);
    expect(await repo.readFile('ws', github, 'empty')).toBe('');
    await expect(repo.readFile('ws', github, 'boom')).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_ERROR',
      technicalMessage: 'GitHub answered HTTP 500 while reading boom.',
    });
    await expect(repo.writeFile('ws', github, 'x.spec.ts', 'c', 'm')).rejects.toMatchObject({
      technicalMessage: expect.stringContaining('Check that the token can read and write'),
    });
    const missingTree = setup([]);
    expect(await missingTree.repo.listFiles('ws', github)).toEqual([]);
    const brokenTree = setup([
      (url) => (url.includes('/git/trees/') ? new Response('', { status: 401 }) : undefined),
    ]);
    await expect(brokenTree.repo.listFiles('ws', github)).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_ERROR',
    });
    const emptyTree = setup([(url) => (url.includes('/git/trees/') ? json({}) : undefined)]);
    expect(await emptyTree.repo.listFiles('ws', github)).toEqual([]);
  });

  it('builds browser links for github.com and GitHub Enterprise', async () => {
    expect(await setup([]).repo.fileUrl('ws', github, 'tests/e2e/a b.spec.ts')).toBe(
      'https://github.com/acme/demo-app/blob/main/tests/e2e/a%20b.spec.ts',
    );
    const enterprise = setup([], {
      integrations: [
        { providerId: 'github_projects', settings: { baseUrl: 'https://git.corp/api/v3/' } },
      ],
      secrets: { github_projects: 'token abc' },
    });
    expect(await enterprise.repo.fileUrl('ws', github, 'x.ts')).toBe(
      'https://git.corp/acme/demo-app/blob/main/x.ts',
    );
  });
});

describe('GitScriptRepository – Azure DevOps', () => {
  it('lists organization repositories and branches', async () => {
    const { repo, calls } = setup(
      [
        (url) =>
          url === `${AZ}/_apis/git/repositories?api-version=7.1`
            ? json({
                value: [
                  {
                    id: 'guid-1',
                    name: 'app',
                    defaultBranch: 'refs/heads/develop',
                    project: { name: 'Finance' },
                    webUrl: `${AZ}/Finance/_git/app`,
                  },
                  { id: 'guid-2', name: 'orphan' },
                ],
              })
            : undefined,
        (url) =>
          url === `${AZ}/_apis/git/repositories/guid-1?api-version=7.1`
            ? json({ defaultBranch: 'refs/heads/develop' })
            : undefined,
        (url) =>
          url.includes('/refs?filter=heads/&')
            ? json({ value: [{ name: 'refs/heads/main' }, { name: 'refs/heads/develop' }] })
            : undefined,
      ],
      { integrations: [{ providerId: 'azure_devops_wiki', settings: { organization: 'org' } }] },
    );
    const { repositories } = await repo.listRepositories('ws');
    expect(repositories).toEqual([
      {
        id: 'guid-2',
        provider: 'azure_devops',
        name: '/orphan',
        defaultBranch: 'main',
      },
      {
        id: 'guid-1',
        provider: 'azure_devops',
        name: 'Finance/app',
        defaultBranch: 'develop',
        webUrl: `${AZ}/Finance/_git/app`,
      },
    ]);
    expect(calls[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from(':tok').toString('base64')}`,
    );
    expect(await repo.listBranches('ws', 'azure_devops', 'guid-1')).toEqual([
      { name: 'develop', isDefault: true },
      { name: 'main', isDefault: false },
    ]);
    const bare = setup([
      (url) => (url.includes('/refs?') ? json({}) : url.includes('guid-1?') ? json({}) : undefined),
    ]);
    expect(await bare.repo.listBranches('ws', 'azure_devops', 'guid-1')).toEqual([]);
  });

  it('lists, reads and pushes files on the chosen branch', async () => {
    const { repo, calls } = setup([
      (url) =>
        url.includes('/items?scopePath=')
          ? json({
              value: [
                { path: '/tests/e2e', isFolder: true },
                { path: '/tests/e2e/a.spec.ts', gitObjectType: 'blob' },
                { path: '/tests/e2e/sub', gitObjectType: 'tree' },
              ],
            })
          : undefined,
      (url) =>
        url.includes('path=/tests/e2e/a.spec.ts&includeContent')
          ? json({ content: 'A' })
          : undefined,
      (url) =>
        url.includes('path=/tests/e2e/raw.spec.ts&includeContent')
          ? new Response('<!-- raw -->')
          : undefined,
      (url) =>
        url.includes('path=/tests/e2e/meta.spec.ts&includeContent') ? json({ id: 1 }) : undefined,
      (url) =>
        url.includes('/refs?filter=heads/develop')
          ? json({
              value: [
                { name: 'refs/heads/develop-old', objectId: 'x' },
                { name: 'refs/heads/develop', objectId: 'head-1' },
              ],
            })
          : undefined,
      (_url, init) => (init.method === 'POST' ? json({}, 201) : undefined),
    ]);
    expect(await repo.listFiles('ws', azure)).toEqual(['tests/e2e/a.spec.ts']);
    expect(calls[0]?.url).toBe(
      `${AZ}/_apis/git/repositories/guid-1/items?scopePath=/tests/e2e&recursionLevel=Full&versionDescriptor.version=develop&versionDescriptor.versionType=branch&api-version=7.1`,
    );
    expect(await repo.readFile('ws', azure, 'tests/e2e/a.spec.ts')).toBe('A');
    expect(await repo.readFile('ws', azure, 'tests/e2e/raw.spec.ts')).toBe('<!-- raw -->');
    expect(await repo.readFile('ws', azure, 'tests/e2e/meta.spec.ts')).toBe('{"id":1}');
    expect(await repo.readFile('ws', azure, 'tests/e2e/none.spec.ts')).toBeNull();

    await repo.writeFile('ws', azure, 'tests/e2e/a.spec.ts', 'v2', 'update');
    await repo.writeFile('ws', azure, 'tests/e2e/new.spec.ts', 'v1', 'add');
    const pushes = calls.filter((call) => call.method === 'POST');
    expect(pushes[0]?.url).toBe(`${AZ}/_apis/git/repositories/guid-1/pushes?api-version=7.1`);
    expect(pushes[0]?.body).toEqual({
      refUpdates: [{ name: 'refs/heads/develop', oldObjectId: 'head-1' }],
      commits: [
        {
          comment: 'update',
          changes: [
            {
              changeType: 'edit',
              item: { path: '/tests/e2e/a.spec.ts' },
              newContent: { content: 'v2', contentType: 'rawtext' },
            },
          ],
        },
      ],
    });
    expect(
      (pushes[1]?.body as { commits: { changes: { changeType: string }[] }[] }).commits[0]
        ?.changes[0]?.changeType,
    ).toBe('add');
  });

  it('reports missing branches, empty folders and links to files', async () => {
    const { repo } = setup([
      (url) => (url.includes('/refs?filter=heads/develop') ? json({}) : undefined),
      (url) => (url.includes('/items?scopePath=') ? json({}) : undefined),
    ]);
    await expect(repo.writeFile('ws', azure, 'a.spec.ts', 'c', 'm')).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_ERROR',
      statusCode: 404,
    });
    expect(await repo.listFiles('ws', { ...azure, path: '' })).toEqual([]);
    expect(await setup([]).repo.listFiles('ws', azure)).toEqual([]);
    const broken = setup([
      (url) => (url.includes('/items?scopePath=') ? new Response('', { status: 500 }) : undefined),
    ]);
    await expect(broken.repo.listFiles('ws', azure)).rejects.toMatchObject({
      technicalMessage: 'Azure DevOps answered HTTP 500 while listing files.',
    });
    expect(await repo.fileUrl('ws', azure, 'tests/e2e/a.spec.ts')).toBe(
      `${AZ}/Finance/_git/app?path=/tests/e2e/a.spec.ts&version=GBdevelop`,
    );
    expect(await repo.fileUrl('ws', { ...azure, name: 'odd' }, 'a.ts')).toBe(
      `${AZ}//_git/odd?path=/a.ts&version=GBdevelop`,
    );
  });
});

describe('GitScriptRepository – connections', () => {
  it('reports credential and availability problems as warnings', async () => {
    const { repo } = setup(
      [(url) => (url.includes('/user/repos') ? new Response('', { status: 401 }) : undefined)],
      {
        integrations: [
          { providerId: 'github_projects' },
          { providerId: 'azure_devops_wiki', settings: { organization: 'org' } },
        ],
        secrets: { github_projects: 'tok', azure_devops_wiki: null },
      },
    );
    expect(await repo.listRepositories('ws')).toEqual({
      repositories: [],
      warnings: [
        { provider: 'github', code: 'PROVIDER_UNAVAILABLE' },
        { provider: 'azure_devops', code: 'CREDENTIALS_MISSING' },
      ],
    });
    await expect(repo.listBranches('ws', 'azure_devops', 'x')).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_NOT_CONFIGURED',
    });
    expect(await repo.fileUrl('ws', azure, 'a.ts')).toBeNull();
  });

  it('ignores disabled or incomplete integrations and keeps explicit auth schemes', async () => {
    const none = setup([], {
      integrations: [
        { providerId: 'github_projects', isEnabled: false },
        { providerId: 'azure_devops_wiki', settings: {} },
      ],
    });
    expect(await none.repo.listRepositories('ws')).toEqual({ repositories: [], warnings: [] });

    const custom = setup(
      [(url) => (url.includes('/_apis/git/repositories?') ? json({}) : undefined)],
      {
        integrations: [
          {
            providerId: 'azure_devops_wiki',
            settings: { project: 'Finance', baseUrl: 'https://tfs.corp/collection' },
          },
        ],
        secrets: { azure_devops_wiki: 'Bearer aad' },
      },
    );
    await custom.repo.listRepositories('ws');
    expect(custom.calls[0]).toMatchObject({
      url: 'https://tfs.corp/collection/_apis/git/repositories?api-version=7.1',
      headers: { authorization: 'Bearer aad' },
    });
  });
});
