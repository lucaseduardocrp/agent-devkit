import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiClient } from '../src/lib/api-client.js';

describe('authentication guard', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('adk_locale', 'pt-BR');
  });

  it('renders only the login screen when there is no session', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'health' });

    const view = render(<App apiClient={client} />);

    await waitFor(() => expect(view.getByTestId('auth-modal')).toBeInTheDocument());
    expect(view.queryByTestId('screen-brain')).not.toBeInTheDocument();
    expect(view.queryByLabelText('Fechar')).not.toBeInTheDocument();
  });

  it('does not render protected screens while a stored session is being checked', () => {
    localStorage.setItem('adk_token', 'pending-token');
    const client = new ApiClient();
    vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'health' });
    vi.spyOn(client, 'getMe').mockReturnValue(new Promise(() => {}));

    const view = render(<App apiClient={client} />);

    expect(view.getByTestId('auth-session-loading')).toBeInTheDocument();
    expect(view.queryByTestId('screen-brain')).not.toBeInTheDocument();
  });

  it('clears an expired session and redirects to login', async () => {
    localStorage.setItem('adk_token', 'expired-token');
    const client = new ApiClient();
    vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'health' });
    vi.spyOn(client, 'getMe').mockRejectedValue(new Error('Expired session'));

    const view = render(<App apiClient={client} />);

    expect(view.getByTestId('auth-session-loading')).toBeInTheDocument();
    await waitFor(() => expect(view.getByTestId('auth-modal')).toBeInTheDocument());
    expect(localStorage.getItem('adk_token')).toBeNull();
    expect(view.queryByTestId('screen-brain')).not.toBeInTheDocument();
  });

  it('opens the application only after a successful login and returns to login on logout', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'health' });
    vi.spyOn(client, 'getWorkspaces').mockResolvedValue([]);
    vi.spyOn(client, 'login').mockResolvedValue({
      token: 'valid-token',
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: 'User',
        createdAt: '2026-09-21T00:00:00.000Z',
      },
    });
    vi.spyOn(client, 'logout').mockResolvedValue();

    const view = render(<App apiClient={client} />);
    await waitFor(() => expect(view.getByTestId('auth-modal')).toBeInTheDocument());

    fireEvent.change(view.getByLabelText('E-mail'), { target: { value: 'user@example.com' } });
    fireEvent.change(view.getByLabelText('Senha'), { target: { value: 'password123' } });
    fireEvent.click(view.getByRole('button', { name: 'Entrar na Plataforma' }));

    await waitFor(() => expect(view.getByTestId('screen-brain')).toBeInTheDocument());
    expect(view.queryByTestId('auth-modal')).not.toBeInTheDocument();

    fireEvent.click(view.getByTestId('topbar-user-menu-button'));
    fireEvent.click(view.getByTestId('topbar-menu-logout'));

    await waitFor(() => expect(view.getByTestId('auth-modal')).toBeInTheDocument());
    expect(view.queryByTestId('screen-brain')).not.toBeInTheDocument();
  });
});
