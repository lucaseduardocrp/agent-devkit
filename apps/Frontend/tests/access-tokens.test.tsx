import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccessTokensPanel } from '../src/features/settings/AccessTokensPanel.js';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { ApiClient, type AccessTokenDto } from '../src/lib/api-client.js';

const token: AccessTokenDto = {
  id: 't1',
  name: 'Claude Code',
  tokenPrefix: 'adk_pat_abc123',
  scope: 'full',
  expiresAt: '2026-12-24T00:00:00.000Z',
  lastUsedAt: null,
  createdAt: '2026-09-25T00:00:00.000Z',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('ApiClient access tokens', () => {
  it('lists, creates and revokes tokens', async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const client = new ApiClient({
      fetcher: async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body });
        if (init?.method === 'POST')
          return jsonResponse({ token: 'adk_pat_secret', accessToken: token }, true, 201);
        if (init?.method === 'DELETE') return jsonResponse({}, true, 204);
        return jsonResponse({ tokens: [token] });
      },
    });
    expect(await client.listAccessTokens()).toEqual([token]);
    expect(
      await client.createAccessToken({ name: 'Claude Code', scope: 'read', expiresInDays: 30 }),
    ).toMatchObject({ token: 'adk_pat_secret' });
    await client.revokeAccessToken('t/1');
    expect(calls.map((call) => `${call.method ?? 'GET'} ${call.url}`)).toEqual([
      'GET http://localhost:3000/auth/tokens',
      'POST http://localhost:3000/auth/tokens',
      'DELETE http://localhost:3000/auth/tokens/t%2F1',
    ]);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      name: 'Claude Code',
      scope: 'read',
      expiresInDays: 30,
    });

    const failing = new ApiClient({
      fetcher: async () => jsonResponse({ message: 'No' }, false, 403),
    });
    await expect(failing.listAccessTokens()).rejects.toMatchObject({ status: 403 });
    await expect(
      failing.createAccessToken({ name: 'x', scope: 'full', expiresInDays: null }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(failing.revokeAccessToken('t1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('AccessTokensPanel', () => {
  function renderPanel(client: ApiClient) {
    return render(<AccessTokensPanel apiClient={client} />);
  }

  it('creates a token, shows the secret once and copies it', async () => {
    const client = new ApiClient();
    const list = vi
      .spyOn(client, 'listAccessTokens')
      .mockResolvedValueOnce([])
      .mockResolvedValue([token]);
    const create = vi
      .spyOn(client, 'createAccessToken')
      .mockResolvedValue({ token: 'adk_pat_secret', accessToken: token });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const view = renderPanel(client);
    await waitFor(() => expect(view.getByText('Nenhum token ativo.')).toBeInTheDocument());

    fireEvent.click(view.getByTestId('create-token'));
    expect(await view.findByRole('alert')).toHaveTextContent('Informe um nome para o token.');

    fireEvent.change(view.getByTestId('token-name-input'), { target: { value: ' Claude Code ' } });
    fireEvent.change(view.getByTestId('token-scope-select'), { target: { value: 'read' } });
    fireEvent.change(view.getByTestId('token-expiry-select'), { target: { value: 'never' } });
    fireEvent.click(view.getByTestId('create-token'));

    await waitFor(() =>
      expect(view.getByTestId('created-token')).toHaveTextContent('adk_pat_secret'),
    );
    expect(create).toHaveBeenCalledWith({
      name: 'Claude Code',
      scope: 'read',
      expiresInDays: null,
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(view.getByText('Claude Code')).toBeInTheDocument();

    fireEvent.click(view.getByText('Copiar token'));
    await waitFor(() => expect(view.getByText('Token copiado.')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('adk_pat_secret');
  });

  it('keeps the secret visible when the clipboard is unavailable and sends numeric expiry', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens').mockResolvedValue([]);
    const create = vi
      .spyOn(client, 'createAccessToken')
      .mockResolvedValue({ token: 'adk_pat_secret', accessToken: token });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const view = renderPanel(client);
    fireEvent.change(view.getByTestId('token-name-input'), { target: { value: 'CI' } });
    fireEvent.click(view.getByTestId('create-token'));
    await waitFor(() => expect(view.getByTestId('created-token')).toBeInTheDocument());
    expect(create).toHaveBeenCalledWith({ name: 'CI', scope: 'full', expiresInDays: 90 });
    fireEvent.click(view.getByText('Copiar token'));
    await waitFor(() =>
      expect(view.getByTestId('created-token')).toHaveTextContent('adk_pat_secret'),
    );
    expect(view.queryByText('Token copiado.')).not.toBeInTheDocument();
  });

  it('lists and revokes tokens after confirmation', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens')
      .mockResolvedValueOnce([
        token,
        {
          ...token,
          id: 't2',
          name: 'Viewer',
          scope: 'read',
          expiresAt: null,
          lastUsedAt: '2026-09-26T00:00:00.000Z',
        },
      ])
      .mockResolvedValue([]);
    const revoke = vi.spyOn(client, 'revokeAccessToken').mockResolvedValue();
    const view = renderPanel(client);
    await waitFor(() => expect(view.getByText('Viewer')).toBeInTheDocument());
    const list = view.getByTestId('token-list');
    expect(list).toHaveTextContent('Somente leitura · Último uso');
    expect(list).toHaveTextContent('Sem expiração');
    expect(list).toHaveTextContent('Nunca usado');

    fireEvent.click(view.getByTestId('revoke-token-t1'));
    expect(view.getByText('Revogar token?')).toBeInTheDocument();
    fireEvent.click(view.getByText('Cancelar'));
    fireEvent.click(view.getByTestId('revoke-token-t1'));
    fireEvent.click(view.getAllByText('Revogar').at(-1)!);
    await waitFor(() => expect(view.getByText('Token revogado.')).toBeInTheDocument());
    expect(revoke).toHaveBeenCalledWith('t1');
  });

  it('reports load, create and revoke failures', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens').mockRejectedValueOnce('down').mockResolvedValue([token]);
    vi.spyOn(client, 'createAccessToken')
      .mockRejectedValueOnce(new Error('Limite'))
      .mockRejectedValueOnce('x');
    vi.spyOn(client, 'revokeAccessToken')
      .mockRejectedValueOnce(new Error('Falhou'))
      .mockRejectedValueOnce('x');
    const view = renderPanel(client);
    expect(await view.findByRole('alert')).toHaveTextContent('Falha ao carregar os tokens.');

    fireEvent.change(view.getByTestId('token-name-input'), { target: { value: 'A' } });
    fireEvent.click(view.getByTestId('create-token'));
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Limite'));
    fireEvent.click(view.getByTestId('create-token'));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Falha ao criar o token.'),
    );

    view.unmount();
    const second = renderPanel(client);
    await waitFor(() => expect(second.getByTestId('revoke-token-t1')).toBeInTheDocument());
    fireEvent.click(second.getByTestId('revoke-token-t1'));
    fireEvent.click(second.getAllByText('Revogar').at(-1)!);
    await waitFor(() => expect(second.getByRole('alert')).toHaveTextContent('Falhou'));
    fireEvent.click(second.getAllByText('Revogar').at(-1)!);
    await waitFor(() =>
      expect(second.getByRole('alert')).toHaveTextContent('Falha ao revogar o token.'),
    );
  });

  it('renders nothing remote without an API client and is reachable from settings', async () => {
    const view = render(<AccessTokensPanel />);
    fireEvent.change(view.getByTestId('token-name-input'), { target: { value: 'A' } });
    fireEvent.click(view.getByTestId('create-token'));
    expect(view.getByText('Nenhum token ativo.')).toBeInTheDocument();
    view.unmount();

    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens').mockResolvedValue([token]);
    const settings = render(<SettingsView apiClient={client} />);
    fireEvent.click(settings.getByTestId('settings-section-tokens'));
    await waitFor(() => expect(settings.getByTestId('access-tokens-panel')).toBeInTheDocument());
    expect(settings.getByText('Claude Code')).toBeInTheDocument();
  });
});
