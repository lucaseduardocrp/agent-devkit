import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthModal } from '../src/features/auth/AuthModal.js';
import { ApiClient } from '../src/lib/api-client.js';

const mockUser = {
  id: 'u-1',
  email: 'test@example.com',
  name: 'Test User',
  createdAt: '2026-09-11T12:00:00Z',
};

afterEach(() => {
  window.location.hash = '';
});

describe('AuthModal password recovery', () => {
  it('requests a recovery code and sets a new password with it', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuthOptions').mockResolvedValue({ oauthProviders: [] });
    vi.spyOn(client, 'requestPasswordReset').mockResolvedValue({ success: true });
    vi.spyOn(client, 'resetPassword').mockResolvedValue({ token: 'tok-reset', user: mockUser });
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <AuthModal isOpen onClose={onClose} onSuccess={onSuccess} apiClient={client} />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Esqueceu sua senha?' }));
    expect(view.getByRole('heading', { name: 'Recuperar conta' })).toBeInTheDocument();
    expect(
      view.getByText('Informe seu e-mail para recuperar o acesso à sua conta.'),
    ).toBeInTheDocument();
    expect(view.queryByLabelText('Senha')).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Criar Conta' })).not.toBeInTheDocument();

    fireEvent.change(view.getByLabelText('E-mail'), { target: { value: 'test@example.com' } });
    fireEvent.click(view.getByRole('button', { name: 'Recuperar conta' }));

    expect(
      await view.findByText('Se a conta existir, enviaremos um código de recuperação.'),
    ).toHaveAttribute('role', 'status');
    expect(client.requestPasswordReset).toHaveBeenCalledWith('test@example.com');

    const code = view.getByLabelText('Código de verificação') as HTMLInputElement;
    fireEvent.change(code, { target: { value: '12a-34 56' } });
    expect(code.value).toBe('123456');
    const newPassword = view.getByLabelText('Nova senha');
    expect(newPassword).toHaveAttribute('autocomplete', 'new-password');
    fireEvent.change(newPassword, { target: { value: 'NovaSenha123' } });
    fireEvent.click(view.getByRole('button', { name: 'Definir nova senha' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(mockUser, 'tok-reset'));
    expect(client.resetPassword).toHaveBeenCalledWith({
      email: 'test@example.com',
      code: '123456',
      password: 'NovaSenha123',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('returns to the login form from the recovery steps', () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuthOptions').mockResolvedValue({ oauthProviders: [] });
    const view = render(
      <AuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Esqueceu sua senha?' }));
    fireEvent.click(view.getByRole('button', { name: 'Voltar para o login' }));

    expect(view.getByRole('heading', { name: 'Entrar no adk' })).toBeInTheDocument();
    expect(view.getByLabelText('Senha')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Voltar para o login' })).not.toBeInTheDocument();
  });

  it('shows the recovery error and stays on the request step', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuthOptions').mockResolvedValue({ oauthProviders: [] });
    vi.spyOn(client, 'requestPasswordReset').mockRejectedValue(new Error('Muitas tentativas'));
    const view = render(
      <AuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Esqueceu sua senha?' }));
    fireEvent.change(view.getByLabelText('E-mail'), { target: { value: 'test@example.com' } });
    fireEvent.click(view.getByRole('button', { name: 'Recuperar conta' }));

    expect(await view.findByRole('alert')).toHaveTextContent('Muitas tentativas');
    expect(view.queryByLabelText('Código de verificação')).not.toBeInTheDocument();
  });
});

describe('AuthModal social sign-in', () => {
  it('offers every configured OAuth provider and starts its flow', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuthOptions').mockResolvedValue({
      oauthProviders: ['google', 'github'],
    });
    vi.spyOn(client, 'getOAuthStartUrl').mockImplementation((provider) => `#oauth-${provider}`);
    const view = render(
      <AuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );

    const google = await view.findByRole('button', { name: 'Continuar com Google' });
    const github = view.getByRole('button', { name: 'Continuar com GitHub' });
    expect(view.getByText('ou continue com')).toBeInTheDocument();
    expect(google.parentElement).toHaveClass('grid-cols-2');

    fireEvent.click(google);
    expect(client.getOAuthStartUrl).toHaveBeenCalledWith('google');
    expect(window.location.hash).toBe('#oauth-google');

    fireEvent.click(github);
    expect(client.getOAuthStartUrl).toHaveBeenCalledWith('github');
    expect(window.location.hash).toBe('#oauth-github');

    // Social sign-in is offered on registration too, but not while recovering a password.
    fireEvent.click(view.getByRole('button', { name: 'Criar Conta' }));
    expect(view.getByRole('button', { name: 'Continuar com Google' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Entrar' }));
    fireEvent.click(view.getByRole('button', { name: 'Esqueceu sua senha?' }));
    expect(view.queryByRole('button', { name: 'Continuar com Google' })).not.toBeInTheDocument();
  });

  it('lays out a single provider on one column', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuthOptions').mockResolvedValue({ oauthProviders: ['github'] });
    const view = render(
      <AuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );

    const github = await view.findByRole('button', { name: 'Continuar com GitHub' });
    expect(github.parentElement).toHaveClass('grid-cols-1');
    expect(view.queryByRole('button', { name: 'Continuar com Google' })).not.toBeInTheDocument();
  });

  it('ignores provider options that arrive after the modal closes', async () => {
    const client = new ApiClient();
    let resolve!: (value: { oauthProviders: readonly ('google' | 'github')[] }) => void;
    vi.spyOn(client, 'getAuthOptions')
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValue({ oauthProviders: [] });
    const props = { onClose: vi.fn(), onSuccess: vi.fn(), apiClient: client };
    const view = render(<AuthModal isOpen {...props} />);

    view.rerender(<AuthModal isOpen={false} {...props} />);
    resolve({ oauthProviders: ['google'] });
    await Promise.resolve();
    view.rerender(<AuthModal isOpen {...props} />);

    await waitFor(() => expect(client.getAuthOptions).toHaveBeenCalledTimes(2));
    expect(view.queryByRole('button', { name: 'Continuar com Google' })).not.toBeInTheDocument();
  });

  it('ignores a provider lookup failure that arrives after the modal closes', async () => {
    const client = new ApiClient();
    let reject!: (reason: unknown) => void;
    vi.spyOn(client, 'getAuthOptions')
      .mockReturnValueOnce(
        new Promise((_, fail) => {
          reject = fail;
        }),
      )
      .mockResolvedValue({ oauthProviders: ['google'] });
    const props = { onClose: vi.fn(), onSuccess: vi.fn(), apiClient: client };
    const view = render(<AuthModal isOpen {...props} />);

    view.rerender(<AuthModal isOpen={false} {...props} />);
    view.rerender(<AuthModal isOpen {...props} />);
    expect(await view.findByRole('button', { name: 'Continuar com Google' })).toBeInTheDocument();

    reject(new Error('offline'));
    await Promise.resolve();
    expect(view.getByRole('button', { name: 'Continuar com Google' })).toBeInTheDocument();
  });
});
