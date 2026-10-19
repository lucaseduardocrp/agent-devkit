import { describe, expect, it, vi } from 'vitest';
import { RemoteDesignStore } from '../src/modules/design/adapters/remote-design-store.js';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';

describe('RemoteDesignStore', () => {
  it('stores code and rotates AI context markdown files in GitHub', async () => {
    const integrations = {
      listIntegrations: vi.fn().mockResolvedValue([
        {
          category: 'PROJECT_MANAGEMENT',
          providerId: 'github_projects',
          isEnabled: true,
          settings: { owner: 'acme', repo: 'ui', branch: 'main' },
        },
      ]),
      getDecryptedSecret: vi.fn().mockResolvedValue('token'),
    } as unknown as IntegrationsService;
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/git/trees/'))
        return new Response(JSON.stringify({ tree: [] }), { status: 200 });
      if (init?.method === 'PUT') {
        writes.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response('{}', { status: 201 });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const store = new RemoteDesignStore(integrations, fetcher);
    expect(await store.configuredProviders('ws')).toEqual(['github']);
    await store.save('ws', {
      id: 'landing-123',
      provider: 'github',
      title: 'Landing',
      agentId: 'agent',
      updatedAt: new Date().toISOString(),
      files: [{ name: 'index.html', language: 'html', content: '<main />' }],
      messages: [
        { role: 'user', content: 'a'.repeat(30_000), createdAt: '2026-01-01' },
        { role: 'assistant', content: 'b'.repeat(30_000), createdAt: '2026-01-02' },
      ],
    });
    expect(writes.some((item) => item.url.includes('context-001.md'))).toBe(true);
    expect(writes.some((item) => item.url.includes('context-002.md'))).toBe(true);
    expect(writes.some((item) => item.url.includes('project.json'))).toBe(true);
    expect(writes.some((item) => item.url.includes('index.html'))).toBe(true);
    const contexts = writes.filter((item) => item.url.includes('context-'));
    expect(
      contexts.every(
        (item) =>
          Buffer.from(String(item.body.content), 'base64').toString('utf8').length <= 50_000,
      ),
    ).toBe(true);
  });

  it('reads file content returned by Azure DevOps Git Items', async () => {
    const integrations = {
      listIntegrations: vi.fn().mockResolvedValue([
        {
          category: 'KNOWLEDGE',
          providerId: 'azure_devops_wiki',
          isEnabled: true,
          settings: {
            organization: 'acme',
            project: 'workspace',
            repository: 'prototypes',
            branch: 'main',
          },
        },
      ]),
      getDecryptedSecret: vi.fn().mockResolvedValue('token'),
    } as unknown as IntegrationsService;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('recursionLevel=Full')) {
        return new Response(
          JSON.stringify({
            value: [
              { path: '/design-prototypes/card-123/.design/project.json' },
              { path: '/design-prototypes/card-123/index.html' },
            ],
          }),
          { status: 200 },
        );
      }
      const content = url.includes('project.json')
        ? JSON.stringify({ title: 'Card', agentId: 'agent', updatedAt: '2026-01-01' })
        : '<main>Card</main>';
      return new Response(JSON.stringify({ content }), { status: 200 });
    }) as unknown as typeof fetch;
    const store = new RemoteDesignStore(integrations, fetcher);

    expect(await store.configuredProviders('ws')).toEqual(['azure']);
    await expect(store.find('ws', 'azure', 'card-123')).resolves.toMatchObject({
      title: 'Card',
      files: [{ name: 'index.html', content: '<main>Card</main>' }],
    });
  });

  it('reads raw HTML Design Systems returned by Azure DevOps', async () => {
    const integrations = {
      listIntegrations: vi.fn().mockResolvedValue([
        {
          category: 'KNOWLEDGE',
          providerId: 'azure_devops_wiki',
          isEnabled: true,
          settings: {
            organization: 'acme',
            project: 'workspace',
            repository: 'prototypes',
            branch: 'main',
          },
        },
      ]),
      getDecryptedSecret: vi.fn().mockResolvedValue('token'),
    } as unknown as IntegrationsService;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('recursionLevel=Full')) {
        return new Response(JSON.stringify({ value: [{ path: '/design-systems/aurora.html' }] }), {
          status: 200,
        });
      }
      return new Response(
        '<!-- name: Aurora -->\n<!doctype html><html><body>Aurora</body></html>',
        {
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    const store = new RemoteDesignStore(integrations, fetcher);

    await expect(store.listDesignSystems('ws', 'azure')).resolves.toEqual([
      expect.objectContaining({
        id: 'aurora',
        name: 'Aurora',
        content: '<!doctype html><html><body>Aurora</body></html>',
      }),
    ]);
  });

  it('lists prototype folders created before Design metadata existed', async () => {
    const integrations = {
      listIntegrations: vi.fn().mockResolvedValue([
        {
          category: 'KNOWLEDGE',
          providerId: 'azure_devops_wiki',
          isEnabled: true,
          settings: {
            organization: 'acme',
            project: 'workspace',
            repository: 'prototypes',
            branch: 'main',
          },
        },
      ]),
      getDecryptedSecret: vi.fn().mockResolvedValue('token'),
    } as unknown as IntegrationsService;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('recursionLevel=Full')) {
        return new Response(
          JSON.stringify([
            { path: '/design-prototypes/login-44ec5436', gitObjectType: 'tree' },
            { path: '/design-prototypes/login-44ec5436/index.html', gitObjectType: 'blob' },
            { path: '/design-prototypes/login-44ec5436/styles.css', gitObjectType: 'blob' },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('project.json')) return new Response('', { status: 404 });
      if (url.includes('styles.css')) return new Response('main { color: rebeccapurple; }');
      return new Response('<main>Login</main>');
    }) as unknown as typeof fetch;
    const store = new RemoteDesignStore(integrations, fetcher);

    await expect(store.list('ws', 'azure')).resolves.toEqual([
      expect.objectContaining({
        id: 'login-44ec5436',
        title: 'login-44ec5436',
        files: expect.arrayContaining([
          expect.objectContaining({ name: 'index.html', content: '<main>Login</main>' }),
        ]),
      }),
    ]);
  });
});
