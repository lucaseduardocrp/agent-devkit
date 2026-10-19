import { describe, expect, it, vi } from 'vitest';
import { RemoteDesignStore } from '../src/modules/design/adapters/remote-design-store.js';
import type { DesignProject } from '../src/modules/design/application/design-service.js';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';

interface Integration {
  providerId: string;
  isEnabled: boolean;
  category?: string;
  settings: Record<string, unknown>;
}

const secretLookups = vi.fn();

function integrations(items: Integration[], token: string | null = 'secret') {
  return {
    listIntegrations: vi.fn().mockResolvedValue(items),
    getDecryptedSecret: secretLookups.mockResolvedValue(token),
  } as unknown as IntegrationsService;
}

const github = (
  settings: Record<string, unknown> = { owner: 'acme', repo: 'ui' },
): Integration => ({
  providerId: 'github_projects',
  isEnabled: true,
  category: 'PROJECT_MANAGEMENT',
  settings,
});
const azure = (
  settings: Record<string, unknown> = {
    organization: 'acme',
    project: 'Work',
    repository: 'proto',
  },
): Integration => ({ providerId: 'azure_devops_wiki', isEnabled: true, settings });

type Override = (url: string, init?: RequestInit) => Response | undefined;

/** In-memory GitHub contents API. */
function githubServer(files: Record<string, string> = {}, override?: Override) {
  const repo = new Map(Object.entries(files));
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.includes('/git/trees/')) {
      return Response.json({
        tree: [
          { path: 'design-prototypes', type: 'tree' },
          ...[...repo.keys()].map((path) => ({ path, type: 'blob' })),
        ],
      });
    }
    const path = decodeURIComponent(url.split('/contents/')[1]!.split('?')[0]!);
    if (method === 'PUT') {
      const body = calls.at(-1)!.body!;
      repo.set(path, Buffer.from(String(body.content), 'base64').toString('utf8'));
      return new Response('{}', { status: 201 });
    }
    if (method === 'DELETE') {
      repo.delete(path);
      return new Response('{}', { status: 200 });
    }
    const content = repo.get(path);
    if (content === undefined) return new Response('', { status: 404 });
    return Response.json({
      sha: `sha-${path}`,
      content: Buffer.from(content)
        .toString('base64')
        .replace(/(.{4})/g, '$1\n'),
    });
  }) as unknown as typeof fetch;
  return { repo, calls, fetcher };
}

/** In-memory Azure DevOps Git items API. */
function azureServer(files: Record<string, string> = {}, override?: Override) {
  const repo = new Map(Object.entries(files));
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.includes('/refs?')) return Response.json({ value: [{ objectId: 'abc' }] });
    if (url.includes('/pushes?')) {
      const commits = calls.at(-1)!.body!.commits as {
        changes: { changeType: string; item: { path: string }; newContent?: { content: string } }[];
      }[];
      for (const change of commits[0]!.changes) {
        const path = change.item.path.slice(1);
        if (change.changeType === 'delete') repo.delete(path);
        else repo.set(path, change.newContent!.content);
      }
      return new Response('{}', { status: 201 });
    }
    const query = new URL(url).searchParams;
    const scope = query.get('scopePath');
    if (scope) {
      const prefix = scope.slice(1);
      const matches = [...repo.keys()].filter(
        (path) => path === prefix || path.startsWith(`${prefix}/`),
      );
      if (!matches.length) return new Response('', { status: 404 });
      return Response.json({
        value: [
          { path: `/${prefix}`, isFolder: true },
          ...matches.map((path) => ({ path: `/${path}`, gitObjectType: 'blob' })),
        ],
      });
    }
    const path = query.get('path')!.slice(1);
    const content = repo.get(path);
    if (content === undefined) return new Response('', { status: 404 });
    return Response.json({ content });
  }) as unknown as typeof fetch;
  return { repo, calls, fetcher };
}

const project = (overrides: Partial<DesignProject> = {}): DesignProject => ({
  id: 'card-1',
  provider: 'github',
  title: 'Card',
  agentId: 'agent',
  updatedAt: '2026-02-01',
  files: [{ name: 'index.html', language: 'html', content: '<main>Card</main>' }],
  messages: [],
  ...overrides,
});

describe('RemoteDesignStore configuration', () => {
  it('detects providers using alternative setting names and ignores incomplete ones', async () => {
    const store = new RemoteDesignStore(
      integrations([
        github({ organization: 'acme', repository: 'ui' }),
        azure({ organization: 'acme', project: 'Work', repo: 'proto' }),
      ]),
      vi.fn(),
    );
    expect(await store.configuredProviders('ws')).toEqual(['github', 'azure']);

    const incomplete = new RemoteDesignStore(
      integrations([
        { ...github(), isEnabled: false },
        github({ owner: 'acme' }),
        github({ repo: 'ui' }),
        azure({ organization: 'acme', repository: 'proto' }),
        azure({ project: 'Work', repository: 'proto' }),
        azure({ organization: 'acme', project: 'Work' }),
        { ...azure(), isEnabled: false },
      ]),
      vi.fn(),
    );
    expect(await incomplete.configuredProviders('ws')).toEqual([]);
  });

  it('requires an enabled integration with a secret', async () => {
    const missing = integrations([]);
    await expect(
      new RemoteDesignStore(missing, vi.fn()).list('ws', 'github'),
    ).rejects.toMatchObject({
      code: 'DESIGN_REPOSITORY_NOT_CONFIGURED',
      message: expect.stringContaining('GitHub'),
    });
    expect(secretLookups).toHaveBeenLastCalledWith('ws', 'KNOWLEDGE', 'github_projects');
    await expect(
      new RemoteDesignStore(integrations([azure()], null), vi.fn()).list('ws', 'azure'),
    ).rejects.toMatchObject({ message: expect.stringContaining('Azure DevOps') });
  });

  it('requires a repository, a GitHub owner and an Azure organization and project', async () => {
    const run = (item: Integration, provider: 'github' | 'azure') =>
      new RemoteDesignStore(integrations([item]), vi.fn()).list('ws', provider);
    await expect(run(github({ owner: 'acme' }), 'github')).rejects.toMatchObject({
      message: 'Informe o repositório na configuração da integração.',
    });
    await expect(run(github({ repo: 'ui', owner: ' ' }), 'github')).rejects.toMatchObject({
      message: expect.stringContaining('proprietario'),
    });
    await expect(run(azure({ project: 'Work', repo: 'proto' }), 'azure')).rejects.toMatchObject({
      message: expect.stringContaining('organizacao'),
    });
    await expect(
      run(azure({ organization: 'acme', repository: 'proto' }), 'azure'),
    ).rejects.toMatchObject({ message: expect.stringContaining('organizacao') });
  });

  it('uses custom GitHub base URL, branch and organization with bearer auth', async () => {
    const server = githubServer();
    const store = new RemoteDesignStore(
      integrations([
        github({
          organization: 'org',
          repository: 'ui',
          baseUrl: 'https://ghe/api',
          branch: 'dev',
        }),
      ]),
      server.fetcher,
    );
    await expect(store.list('ws', 'github')).resolves.toEqual([]);
    expect(server.calls[0]!.url).toBe('https://ghe/api/repos/org/ui/git/trees/dev?recursive=1');
    const init = vi.mocked(server.fetcher).mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe('Bearer secret');
  });

  it('strips a trailing project from the Azure base URL and uses basic auth', async () => {
    const server = azureServer();
    const store = new RemoteDesignStore(
      integrations([
        azure({
          organization: 'acme',
          project: 'Work',
          repository: 'proto',
          baseUrl: 'https://tfs.local/acme/work//',
          branch: 'release',
        }),
      ]),
      server.fetcher,
    );
    await expect(store.list('ws', 'azure')).resolves.toEqual([]);
    expect(server.calls[0]!.url).toMatch(
      /^https:\/\/tfs\.local\/acme\/Work\/_apis\/git\/repositories\/proto\/items\?scopePath=\/design-prototypes&.*version=release/,
    );
    const init = vi.mocked(server.fetcher).mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from(':secret').toString('base64')}`);

    const other = azureServer();
    await new RemoteDesignStore(
      integrations([azure({ ...azure().settings, baseUrl: 'https://tfs.local/acme' })]),
      other.fetcher,
    ).list('ws', 'azure');
    expect(other.calls[0]!.url).toMatch(/^https:\/\/tfs\.local\/acme\/Work\//);

    const fallback = azureServer();
    await new RemoteDesignStore(integrations([azure()]), fallback.fetcher).list('ws', 'azure');
    expect(fallback.calls[0]!.url).toMatch(/^https:\/\/dev\.azure\.com\/acme\/Work\//);
  });
});

describe('RemoteDesignStore projects on GitHub', () => {
  it('lists projects sorted by update time and skips empty folders', async () => {
    const server = githubServer({
      'design-prototypes/old/.design/project.json': JSON.stringify({
        title: 'Old',
        agentId: 1,
        updatedAt: 2,
      }),
      'design-prototypes/old/app.JSX': 'export {}',
      'design-prototypes/new/.design/project.json': JSON.stringify({
        title: 'New',
        agentId: 'agent',
        updatedAt: '2026-03-01',
      }),
      'design-prototypes/new/.design/context-001.md':
        '# Contexto\n\n## Usuário · 2026-03-01\n\nCrie\n\n## Agente · 2026-03-01\n\nFeito\n',
      'design-prototypes/new/.design/context-002.md':
        '# Continuação\n\n## Agente (continuação) · 2026-03-01\n\nMais\n',
      'design-prototypes/ghost/.design/context-001.md': '# Contexto\n',
      'design-prototypes/broken/.design/project.json': '{not json',
      'design-prototypes/broken/index.html': '<main />',
      'design-prototypes/untitled/.design/project.json': JSON.stringify({ agentId: 'a' }),
      'design-prototypes/untitled/index.html': '',
      'design-prototypes/readme.md': 'not a project folder',
      'readme.md': 'ignored',
    });
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    const projects = await store.list('ws', 'github');
    expect(projects.map((item) => item.id)).toEqual(['new', 'old', 'broken', 'untitled']);
    const [created, old, broken] = projects;
    expect(created).toMatchObject({
      title: 'New',
      agentId: 'agent',
      provider: 'github',
      files: [],
      messages: [
        { role: 'user', content: 'Crie', createdAt: '2026-03-01' },
        { role: 'assistant', content: 'Feito', createdAt: '2026-03-01' },
        { role: 'assistant', content: 'Mais', createdAt: '2026-03-01' },
      ],
    });
    expect(old).toMatchObject({
      title: 'Old',
      agentId: '',
      updatedAt: '',
      files: [{ name: 'app.JSX', language: 'jsx', content: 'export {}' }],
    });
    expect(broken).toMatchObject({ title: 'broken', agentId: '' });
  });

  it('keeps listed files whose content can no longer be read as empty', async () => {
    const server = githubServer(
      {
        'design-prototypes/card-1/index.html': '<main />',
        'design-prototypes/card-1/.design/context-001.md': '## Usuário · now\n\nHi\n',
      },
      (url) => (url.includes('/contents/') ? new Response('', { status: 404 }) : undefined),
    );
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    await expect(store.find('ws', 'github', 'card-1')).resolves.toMatchObject({
      title: 'card-1',
      files: [{ name: 'index.html', language: 'html', content: '' }],
      messages: [],
    });
  });

  it('treats a missing branch as an empty repository and reports other errors', async () => {
    const missing = githubServer({}, (url) =>
      url.includes('/git/trees/') ? new Response('', { status: 404 }) : undefined,
    );
    const store = new RemoteDesignStore(integrations([github()]), missing.fetcher);
    await expect(store.list('ws', 'github')).resolves.toEqual([]);
    await expect(store.find('ws', 'github', 'nothing')).resolves.toBeNull();

    const emptyTree = githubServer({}, (url) =>
      url.includes('/git/trees/') ? Response.json({}) : undefined,
    );
    await expect(
      new RemoteDesignStore(integrations([github()]), emptyTree.fetcher).list('ws', 'github'),
    ).resolves.toEqual([]);

    const failing = githubServer({}, () => new Response('', { status: 500 }));
    await expect(
      new RemoteDesignStore(integrations([github()]), failing.fetcher).list('ws', 'github'),
    ).rejects.toMatchObject({
      code: 'DESIGN_REPOSITORY_ERROR',
      message: 'GitHub respondeu HTTP 500.',
    });

    const readFailure = githubServer({ 'design-prototypes/a/index.html': 'x' }, (url) =>
      url.includes('/contents/') ? new Response('', { status: 403 }) : undefined,
    );
    await expect(
      new RemoteDesignStore(integrations([github()]), readFailure.fetcher).find(
        'ws',
        'github',
        'a',
      ),
    ).rejects.toMatchObject({ message: 'Repositório respondeu HTTP 403.' });
  });

  it('saves a new project, creating the first context file and updating existing files', async () => {
    const server = githubServer({ 'design-prototypes/card-1/index.html': '<old />' });
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    await store.save(
      'ws',
      project({
        messages: [
          { role: 'user', content: 'Crie um card', createdAt: '2026-02-01' },
          { role: 'assistant', content: 'Pronto', createdAt: '2026-02-01' },
        ],
      }),
    );
    const puts = server.calls.filter((call) => call.method === 'PUT');
    expect(puts.find((call) => call.url.endsWith('index.html'))!.body).toMatchObject({
      sha: 'sha-design-prototypes/card-1/index.html',
      branch: 'main',
      message: 'design: update Card',
    });
    expect(puts.find((call) => call.url.endsWith('project.json'))!.body).not.toHaveProperty('sha');
    expect(server.repo.get('design-prototypes/card-1/.design/context-001.md')).toBe(
      '# Contexto do protótipo\n\n## Usuário · 2026-02-01\n\nCrie um card\n\n## Agente · 2026-02-01\n\nPronto\n',
    );
    await expect(store.find('ws', 'github', 'card-1')).resolves.toMatchObject({
      title: 'Card',
      files: [{ name: 'index.html', content: '<main>Card</main>' }],
      messages: [{ content: 'Crie um card' }, { content: 'Pronto' }],
    });
  });

  it('appends only new messages and rotates a nearly full context file', async () => {
    const full = `# Contexto do protótipo\n\n## Usuário · 2026-01-01\n\n${'a'.repeat(49_950)}\n`;
    const server = githubServer({
      'design-prototypes/card-1/.design/project.json': JSON.stringify({ title: 'Card' }),
      'design-prototypes/card-1/.design/context-001.md': full,
    });
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    await store.save(
      'ws',
      project({
        messages: [
          { role: 'user', content: 'a'.repeat(49_950), createdAt: '2026-01-01' },
          { role: 'assistant', content: 'Novo', createdAt: '2026-01-02' },
        ],
      }),
    );
    expect(server.repo.get('design-prototypes/card-1/.design/context-001.md')).toBe(full);
    expect(server.repo.get('design-prototypes/card-1/.design/context-002.md')).toBe(
      '# Continuação do contexto do protótipo\n\n## Agente · 2026-01-02\n\nNovo\n',
    );
  });

  it('rejects failed GitHub writes', async () => {
    const server = githubServer({}, (_url, init) =>
      init?.method === 'PUT' ? new Response('', { status: 422 }) : undefined,
    );
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    await expect(store.save('ws', project())).rejects.toMatchObject({
      message: 'Falha ao gravar design-prototypes/card-1/index.html no GitHub.',
    });
  });

  it('deletes project files, skipping files that vanished, and reports missing projects', async () => {
    const server = githubServer(
      {
        'design-prototypes/card-1/index.html': 'x',
        'design-prototypes/card-1/gone.css': 'y',
      },
      (url, init) =>
        url.includes('gone.css') && !init?.method ? new Response('', { status: 404 }) : undefined,
    );
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    await expect(store.delete('ws', 'github', 'card-1')).resolves.toBe(true);
    const deletes = server.calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.body).toEqual({
      message: 'design: delete card-1',
      branch: 'main',
      sha: 'sha-design-prototypes/card-1/index.html',
    });
    await expect(store.delete('ws', 'github', 'card-2')).resolves.toBe(false);
  });

  it('rejects failed GitHub deletes', async () => {
    const server = githubServer({ 'design-prototypes/card-1/index.html': 'x' }, (_url, init) =>
      init?.method === 'DELETE' ? new Response('', { status: 409 }) : undefined,
    );
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    await expect(store.delete('ws', 'github', 'card-1')).rejects.toMatchObject({
      message: 'Falha ao excluir design-prototypes/card-1/index.html.',
    });
  });
});

describe('RemoteDesignStore design systems', () => {
  it('saves, lists and deletes design systems on GitHub', async () => {
    const server = githubServer({
      'design-systems/plain.html': '<html>Plain</html>',
      'design-systems/blank.html': '<!-- name:   -->\n<html>Blank</html>',
      'design-systems/notes.md': 'ignored',
    });
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    const system = { id: 'aurora', name: 'Aurora --> X', content: '<html>A</html>', updatedAt: '' };
    await expect(store.saveDesignSystem('ws', 'github', system)).resolves.toBe(system);
    expect(server.repo.get('design-systems/aurora.html')).toBe(
      '<!-- name: Aurora  X -->\n<html>A</html>\n',
    );
    await expect(store.listDesignSystems('ws', 'github')).resolves.toEqual([
      { id: 'aurora', name: 'Aurora  X', content: '<html>A</html>\n', updatedAt: '' },
      { id: 'blank', name: 'blank', content: '<html>Blank</html>', updatedAt: '' },
      { id: 'plain', name: 'plain', content: '<html>Plain</html>', updatedAt: '' },
    ]);
    await expect(store.deleteDesignSystem('ws', 'github', 'aurora')).resolves.toBe(true);
    expect(server.repo.has('design-systems/aurora.html')).toBe(false);
    await expect(store.deleteDesignSystem('ws', 'github', 'aurora')).resolves.toBe(false);
  });

  it('lists a design system whose file disappears as empty content', async () => {
    const server = githubServer({ 'design-systems/x.html': 'x' }, (url) =>
      url.includes('/contents/') ? new Response('', { status: 404 }) : undefined,
    );
    const store = new RemoteDesignStore(integrations([github()]), server.fetcher);
    await expect(store.listDesignSystems('ws', 'github')).resolves.toEqual([
      { id: 'x', name: 'x', content: '', updatedAt: '' },
    ]);
  });
});

describe('RemoteDesignStore on Azure DevOps', () => {
  it('commits additions, edits and deletions in a single push', async () => {
    const server = azureServer({ 'design-systems/aurora.html': '<!-- name: Aurora -->\nold' });
    const store = new RemoteDesignStore(integrations([azure()]), server.fetcher);
    await store.saveDesignSystem('ws', 'azure', {
      id: 'aurora',
      name: 'Aurora',
      content: 'new',
      updatedAt: '',
    });
    const firstPush = server.calls.find((call) => call.url.includes('/pushes?'))!;
    expect(firstPush.body).toMatchObject({
      refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'abc' }],
      commits: [
        {
          comment: 'design: update system Aurora',
          changes: [
            {
              changeType: 'edit',
              item: { path: '/design-systems/aurora.html' },
              newContent: { content: '<!-- name: Aurora -->\nnew\n', contentType: 'rawtext' },
            },
          ],
        },
      ],
    });

    await store.save('ws', project({ provider: 'azure' }));
    const secondPush = server.calls.filter((call) => call.url.includes('/pushes?'))[1]!;
    const changes = (secondPush.body!.commits as { changes: { changeType: string }[] }[])[0]!
      .changes;
    expect(changes.every((change) => change.changeType === 'add')).toBe(true);
    await expect(store.find('ws', 'azure', 'card-1')).resolves.toMatchObject({
      provider: 'azure',
      title: 'Card',
    });

    await expect(store.delete('ws', 'azure', 'card-1')).resolves.toBe(true);
    const deletePush = server.calls.filter((call) => call.url.includes('/pushes?')).at(-1)!;
    const deleted = (deletePush.body!.commits as { changes: Record<string, unknown>[] }[])[0]!
      .changes;
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.every((change) => change.changeType === 'delete' && !change.newContent)).toBe(
      true,
    );
    expect([...server.repo.keys()]).toEqual(['design-systems/aurora.html']);
  });

  it('parses bare-array listings and raw or non-string item bodies', async () => {
    const server = azureServer({}, (url) => {
      if (url.includes('scopePath=')) {
        return Response.json([
          { path: '/design-prototypes/a', gitObjectType: 'tree' },
          { path: '/design-prototypes/a/index.html', gitObjectType: 'blob' },
          { path: '/design-prototypes/a/data.json', gitObjectType: 'blob' },
        ]);
      }
      if (url.includes('project.json')) return new Response('', { status: 404 });
      if (url.includes('data.json')) return Response.json({ content: 42 });
      return new Response('<main>raw</main>');
    });
    const store = new RemoteDesignStore(integrations([azure()]), server.fetcher);
    await expect(store.find('ws', 'azure', 'a')).resolves.toMatchObject({
      files: [
        { name: 'index.html', content: '<main>raw</main>' },
        { name: 'data.json', content: '{"content":42}' },
      ],
    });
  });

  it('treats listings without a value as empty and rejects invalid listings', async () => {
    const empty = azureServer({}, (url) =>
      url.includes('scopePath=') ? Response.json({}) : undefined,
    );
    await expect(
      new RemoteDesignStore(integrations([azure()]), empty.fetcher).list('ws', 'azure'),
    ).resolves.toEqual([]);

    const invalid = azureServer({}, () => new Response('<html>login</html>'));
    await expect(
      new RemoteDesignStore(integrations([azure()]), invalid.fetcher).list('ws', 'azure'),
    ).rejects.toMatchObject({ message: expect.stringContaining('resposta inválida') });

    const failing = azureServer({}, () => new Response('', { status: 401 }));
    await expect(
      new RemoteDesignStore(integrations([azure()]), failing.fetcher).list('ws', 'azure'),
    ).rejects.toMatchObject({ message: 'Azure DevOps respondeu HTTP 401.' });
  });

  it('reports branch lookup and push failures', async () => {
    const system = { id: 's', name: 'S', content: 'x', updatedAt: '' };
    const refsDown = azureServer({}, (url) =>
      url.includes('/refs?') ? new Response('', { status: 500 }) : undefined,
    );
    await expect(
      new RemoteDesignStore(integrations([azure()]), refsDown.fetcher).saveDesignSystem(
        'ws',
        'azure',
        system,
      ),
    ).rejects.toMatchObject({ message: 'Não foi possível ler a branch do Azure DevOps.' });

    const noBranch = azureServer({}, (url) =>
      url.includes('/refs?') ? Response.json({}) : undefined,
    );
    await expect(
      new RemoteDesignStore(integrations([azure()]), noBranch.fetcher).saveDesignSystem(
        'ws',
        'azure',
        system,
      ),
    ).rejects.toMatchObject({ message: 'Branch não encontrada no Azure DevOps.', statusCode: 404 });

    const pushFails = azureServer({}, (url) =>
      url.includes('/pushes?') ? new Response('', { status: 409 }) : undefined,
    );
    await expect(
      new RemoteDesignStore(integrations([azure()]), pushFails.fetcher).saveDesignSystem(
        'ws',
        'azure',
        system,
      ),
    ).rejects.toMatchObject({ message: 'Falha ao gravar no Azure DevOps (HTTP 409).' });
  });
});
