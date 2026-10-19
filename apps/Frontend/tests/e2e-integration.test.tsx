import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { Sidebar } from '../src/components/layout/Sidebar.js';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';
import { isCreationActive, suggestedScriptFolder } from '../src/features/e2e/e2e-types.js';

describe('E2E ApiClient methods', () => {
  it('calls every E2E endpoint with auth and workspace headers', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/video')) return Promise.resolve(new Response('webm'));
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      if (url.includes('/e2e/tests/'))
        return Promise.resolve(Response.json({ test: { id: 't 1' } }));
      if (url.endsWith('/e2e/creations') && init?.method !== 'POST')
        return Promise.resolve(Response.json({ creations: [{ id: 'c1' }] }));
      return Promise.resolve(Response.json({ creation: { id: 'c1' } }, { status: 202 }));
    });
    const api = new ApiClient({ baseUrl: 'http://api', fetcher, token: 'tok', workspaceId: 'ws' });
    const input = {
      name: 'x',
      agentId: 'a',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://app',
      prd: 'p',
      repository: { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' },
    } as const;

    expect(await api.getE2eCreations()).toEqual([{ id: 'c1' }]);
    expect(await api.createE2eCreation(input)).toEqual({ id: 'c1' });
    expect(await api.getE2eCreation('c 1')).toEqual({ id: 'c1' });
    expect(await api.updateE2eCreation('c 1', input)).toEqual({ id: 'c1' });
    await api.rerunE2eCreation('c 1');
    await api.cancelE2eCreation('c1');
    await api.deleteE2eCreation('c1');
    expect(await api.getE2eTest('t 1')).toEqual({ id: 't 1' });
    await api.rerunE2eTest('t1', true);
    await api.rerunE2eTest('t1');
    expect((await api.getE2eTestVideo('t1')).size).toBe(4);

    expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
      'GET http://api/e2e/creations',
      'POST http://api/e2e/creations',
      'GET http://api/e2e/creations/c%201',
      'PUT http://api/e2e/creations/c%201',
      'POST http://api/e2e/creations/c%201/run',
      'POST http://api/e2e/creations/c1/cancel',
      'DELETE http://api/e2e/creations/c1',
      'GET http://api/e2e/tests/t%201',
      'POST http://api/e2e/tests/t1/run',
      'POST http://api/e2e/tests/t1/run',
      'GET http://api/e2e/tests/t1/video',
    ]);
    expect(calls[3]?.init?.body).toBe(JSON.stringify(input));
    expect(calls[8]?.init?.body).toBe('{"regenerate":true}');
    expect(calls[9]?.init?.body).toBe('{"regenerate":false}');
    expect((calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect((calls[0]?.init?.headers as Record<string, string>)['x-workspace-id']).toBe('ws');
  });

  it('calls the repository endpoints', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/e2e/repositories'))
        return Promise.resolve(Response.json({ repositories: [{ id: '42' }], warnings: [] }));
      if (url.includes('/branches?'))
        return Promise.resolve(Response.json({ branches: [{ name: 'main', isDefault: true }] }));
      if (url.endsWith('/pull'))
        return Promise.resolve(Response.json({ result: { linked: 1, imported: 0, missing: 0 } }));
      return Promise.resolve(Response.json({ script: { path: 'a.spec.ts', content: 'x' } }));
    });
    const api = new ApiClient({ baseUrl: 'http://api', fetcher });
    expect((await api.getE2eRepositories()).repositories).toEqual([{ id: '42' }]);
    expect(await api.getE2eBranches('azure_devops', 'guid 1')).toEqual([
      { name: 'main', isDefault: true },
    ]);
    expect((await api.getE2eScript('t 1')).path).toBe('a.spec.ts');
    expect((await api.pushE2eScript('t1', 'code')).content).toBe('x');
    expect(await api.pullE2eCreation('c1')).toEqual({ linked: 1, imported: 0, missing: 0 });
    expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
      'GET http://api/e2e/repositories',
      'GET http://api/e2e/repositories/branches?provider=azure_devops&repositoryId=guid+1',
      'GET http://api/e2e/tests/t%201/script',
      'PUT http://api/e2e/tests/t1/script',
      'POST http://api/e2e/creations/c1/pull',
    ]);
    expect(calls[3]?.init?.body).toBe('{"content":"code"}');
  });

  it('asks for a signed video URL', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ video: { url: 'https://r2/x', mimeType: 'video/mp4' } }),
      )
      .mockResolvedValueOnce(Response.json({ video: null }));
    const api = new ApiClient({ baseUrl: 'http://api', fetcher });
    expect(await api.getE2eTestVideoUrl('t 1')).toEqual({
      url: 'https://r2/x',
      mimeType: 'video/mp4',
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://api/e2e/tests/t%201/video-url');
    expect(await api.getE2eTestVideoUrl('t1')).toBeNull();
  });

  it('turns error responses into ApiClientError', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ message: 'Teste E2E não encontrado.' }, { status: 404 })),
      );
    const api = new ApiClient({ fetcher });
    await expect(api.deleteE2eCreation('x')).rejects.toBeInstanceOf(ApiClientError);
    await expect(api.getE2eTestVideo('x')).rejects.toThrow('Teste E2E não encontrado.');
  });
});

describe('E2E navigation', () => {
  beforeEach(() => localStorage.setItem('adk_locale', 'pt-BR'));

  it('adds E2E Automation under the Test menu', () => {
    const onSelect = vi.fn();
    const view = render(<Sidebar activeTab="brain" onSelectTab={onSelect} />);
    fireEvent.click(view.getByRole('button', { name: /^Test$/i }));
    fireEvent.click(view.getByTestId('sidebar-e2e-button'));
    expect(onSelect).toHaveBeenCalledWith('e2e');
    view.unmount();

    const active = render(<Sidebar activeTab="e2e" onSelectTab={onSelect} />);
    expect(active.getByRole('button', { name: /^Test$/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(active.getByTestId('sidebar-e2e-button')).toHaveAttribute('aria-current', 'page');
  });

  it('renders the E2E screen in the app and links to Agents when none exist', async () => {
    localStorage.setItem('adk_token', 'stored');
    const client = new ApiClient();
    vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'r' });
    vi.spyOn(client, 'getMe').mockResolvedValue({
      id: 'u1',
      email: 'qa@example.com',
      name: 'QA',
      createdAt: '2026-01-01T00:00:00Z',
    });
    vi.spyOn(client, 'getWorkspaces').mockResolvedValue([]);
    vi.spyOn(client, 'getE2eCreations').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getE2eRepositories').mockResolvedValue({ repositories: [], warnings: [] });
    const view = render(<App apiClient={client} initialTab="e2e" />);
    expect(await view.findByTestId('e2e-view')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Nova execução/ }));
    // The sidebar also has an Agents entry; the form's shortcut is rendered last.
    await view.findByText(/Crie um agente em Agents/);
    const links = view.getAllByRole('button', { name: 'Agents' });
    fireEvent.click(links[links.length - 1]!);
    await waitFor(() => expect(view.getByTestId('agents-view')).toBeInTheDocument());

    // Without repositories the form links to Integrations.
    fireEvent.click(view.getByTestId('sidebar-e2e-button'));
    fireEvent.click(await view.findByRole('button', { name: /Nova execução/ }));
    await view.findByText(/Nenhum repositório encontrado/);
    const connect = view.getAllByRole('button', { name: 'Integrações' });
    fireEvent.click(connect[connect.length - 1]!);
    await waitFor(() => expect(view.getByTestId('screen-connect')).toBeInTheDocument());
    localStorage.removeItem('adk_token');
  });

  it('knows which statuses are active', () => {
    expect(isCreationActive('planning')).toBe(true);
    expect(isCreationActive('completed')).toBe(false);
    expect(suggestedScriptFolder('Fluxo de Perguntas!')).toBe('tests/e2e/fluxo-de-perguntas');
    expect(suggestedScriptFolder('!!!')).toBe('tests/e2e');
  });
});
