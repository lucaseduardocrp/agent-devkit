import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthModal } from '../src/features/auth/AuthModal.js';
import { ApiClient } from '../src/lib/api-client.js';

describe('AuthModal', () => {
  const mockUser = {
    id: 'u-1',
    email: 'test@example.com',
    name: 'Test User',
    createdAt: '2026-09-11T12:00:00Z',
  };

  it('renders nothing when isOpen is false', () => {
    const client = new ApiClient();
    const { queryByTestId } = render(
      <AuthModal isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );
    expect(queryByTestId('auth-modal')).not.toBeInTheDocument();
  });

  it('allows switching between login and register modes', () => {
    const client = new ApiClient();
    const { getByRole, queryByLabelText, getByLabelText } = render(
      <AuthModal isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );

    expect(getByRole('heading', { name: 'Entrar no adk' })).toBeInTheDocument();
    expect(
      getByRole('heading', { name: 'Seu workspace, suas ideias, um só lugar.' }),
    ).toBeInTheDocument();
    expect(queryByLabelText('Nome Completo')).not.toBeInTheDocument();

    // Switch to register
    fireEvent.click(getByRole('button', { name: 'Criar Conta' }));
    expect(getByRole('heading', { name: 'Criar Conta de Usuário' })).toBeInTheDocument();
    expect(getByLabelText('Nome Completo')).toBeInTheDocument();

    // Switch back to login
    fireEvent.click(getByRole('button', { name: 'Entrar' }));
    expect(getByRole('heading', { name: 'Entrar no adk' })).toBeInTheDocument();
  });

  it('allows showing and hiding the password', () => {
    const { getByLabelText } = render(
      <AuthModal isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} apiClient={new ApiClient()} />,
    );

    const password = getByLabelText('Senha');
    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(getByLabelText('Mostrar senha'));
    expect(password).toHaveAttribute('type', 'text');
    fireEvent.click(getByLabelText('Ocultar senha'));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('successfully logs in and invokes callbacks', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'login').mockResolvedValue({ token: 'tok-123', user: mockUser });
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    const { getByLabelText, getByRole } = render(
      <AuthModal isOpen={true} onClose={onClose} onSuccess={onSuccess} apiClient={client} />,
    );

    fireEvent.change(getByLabelText('E-mail'), { target: { value: 'test@example.com' } });
    fireEvent.change(getByLabelText('Senha'), { target: { value: 'password123' } });
    fireEvent.click(getByRole('button', { name: 'Entrar na Plataforma' }));

    await waitFor(() => {
      expect(client.login).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123',
      });
      expect(onSuccess).toHaveBeenCalledWith(mockUser, 'tok-123');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('displays error message when login fails', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'login').mockRejectedValue(new Error('Credenciais inválidas.'));

    const { getByLabelText, getByRole, getByText } = render(
      <AuthModal isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );

    fireEvent.change(getByLabelText('E-mail'), { target: { value: 'wrong@example.com' } });
    fireEvent.change(getByLabelText('Senha'), { target: { value: 'wrongpass' } });
    fireEvent.click(getByRole('button', { name: 'Entrar na Plataforma' }));

    await waitFor(() => {
      expect(getByText('Credenciais inválidas.')).toBeInTheDocument();
    });
  });

  it('handles non-Error objects gracefully on failure', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'login').mockRejectedValue('string error');

    const { getByLabelText, getByRole, getByText } = render(
      <AuthModal isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );

    fireEvent.change(getByLabelText('E-mail'), { target: { value: 'test@example.com' } });
    fireEvent.change(getByLabelText('Senha'), { target: { value: 'password123' } });
    fireEvent.click(getByRole('button', { name: 'Entrar na Plataforma' }));

    await waitFor(() => {
      expect(getByText('Falha na autenticação.')).toBeInTheDocument();
    });
  });

  it('successfully registers and invokes callbacks', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'register').mockResolvedValue({ token: 'tok-reg', user: mockUser });
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    const { getByLabelText, getByRole } = render(
      <AuthModal
        isOpen={true}
        initialMode="register"
        onClose={onClose}
        onSuccess={onSuccess}
        apiClient={client}
      />,
    );

    fireEvent.change(getByLabelText('Nome Completo'), { target: { value: 'Test User' } });
    fireEvent.change(getByLabelText('E-mail'), { target: { value: 'test@example.com' } });
    fireEvent.change(getByLabelText('Senha'), { target: { value: 'password123' } });
    fireEvent.click(getByRole('button', { name: 'Criar Minha Conta' }));

    await waitFor(() => {
      expect(client.register).toHaveBeenCalledWith({
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123',
      });
      expect(onSuccess).toHaveBeenCalledWith(mockUser, 'tok-reg');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('submits registration with undefined name when name field is omitted or whitespace', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'register').mockResolvedValue({ token: 'tok-reg-2', user: mockUser });
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    const { getByLabelText, getByRole } = render(
      <AuthModal
        isOpen={true}
        initialMode="register"
        onClose={onClose}
        onSuccess={onSuccess}
        apiClient={client}
      />,
    );

    fireEvent.change(getByLabelText('Nome Completo'), { target: { value: '   ' } });
    fireEvent.change(getByLabelText('E-mail'), { target: { value: 'noname@example.com' } });
    fireEvent.change(getByLabelText('Senha'), { target: { value: 'password123' } });
    fireEvent.click(getByRole('button', { name: 'Criar Minha Conta' }));

    await waitFor(() => {
      expect(client.register).toHaveBeenCalledWith({
        name: undefined,
        email: 'noname@example.com',
        password: 'password123',
      });
      expect(onSuccess).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('closes on close button click and on Escape key press', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <AuthModal isOpen={true} onClose={onClose} onSuccess={vi.fn()} apiClient={new ApiClient()} />,
    );

    fireEvent.click(getByLabelText('Fechar'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('cannot be dismissed when used as the authentication guard', () => {
    const onClose = vi.fn();
    const { queryByLabelText } = render(
      <AuthModal
        isOpen={true}
        canClose={false}
        onClose={onClose}
        onSuccess={vi.fn()}
        apiClient={new ApiClient()}
      />,
    );

    expect(queryByLabelText('Fechar')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
