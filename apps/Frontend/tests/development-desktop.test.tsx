import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  button,
  click,
  desktopApp,
  field,
  mockClient,
  session,
  show,
  type,
  worktree,
} from './helpers/development.js';

afterEach(() => {
  Reflect.deleteProperty(window, 'adkDesktop');
});

describe('Development code in the desktop app', () => {
  it('signs the runner in as the person using the app', async () => {
    const { mock } = desktopApp();
    await show(mockClient().api);
    expect(mock['connect']).toHaveBeenCalledWith({ token: 'tok', workspaceId: 'ws' });
    await show(mockClient().api, { workspaceId: null });
    expect(mock['connect']).toHaveBeenLastCalledWith(null);
  });

  it('queues a session in the folder and with the autonomy chosen for it', async () => {
    const { api } = mockClient();
    const { mock } = desktopApp();
    await show(api);
    click(/Nova sessão/);
    await waitFor(() => expect(field('Pasta do repositório').value).toBe('D:\\Work\\shop'));
    expect(field('Autonomia do agente').value).toBe('auto');

    mock['pickFolder']!.mockResolvedValueOnce({ ok: false, error: 'Not a git repository' });
    click(/Escolher pasta/);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a git repository');
    click(/Escolher pasta/);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(field('Pasta do repositório').value).toBe('D:\\Work\\shop');
    mock['pickFolder']!.mockResolvedValueOnce({ ok: true, path: 'D:\\Work\\api' });
    click(/Escolher pasta/);
    await waitFor(() => expect(field('Pasta do repositório').value).toBe('D:\\Work\\api'));

    type('Autonomia do agente', 'safe');
    type('Título', 'Fix typo');
    type('Instruções para o agente', 'Fix the typo');
    click('Enfileirar sessão');
    await waitFor(() =>
      expect(mock['assign']).toHaveBeenCalledWith('s-new', {
        repoPath: 'D:\\Work\\api',
        autonomy: 'safe',
      }),
    );

    mock['assign']!.mockResolvedValueOnce({ ok: false, error: 'The folder is gone' });
    click(/Nova sessão/);
    click('Enfileirar sessão');
    expect(await screen.findByRole('alert')).toHaveTextContent('The folder is gone');
  });

  it('queues without a folder when none was ever chosen', async () => {
    const { api } = mockClient();
    const { mock } = desktopApp();
    mock['preferences']!.mockResolvedValue({ ok: true, lastRepoPath: null, autonomy: 'safe' });
    await show(api);
    click(/Nova sessão/);
    type('Título', 'Fix typo');
    type('Instruções para o agente', 'Fix the typo');
    expect(field('Pasta do repositório').value).toBe('');
    click('Enfileirar sessão');
    await waitFor(() => expect(api.createDevelopmentSession).toHaveBeenCalled());
    expect(mock['assign']).not.toHaveBeenCalled();
  });

  it('starts a queued session here once it is given a folder', async () => {
    const { mock } = desktopApp();
    mock['preferences']!.mockResolvedValue({ ok: false, error: 'busy' });
    await show(mockClient([session({ status: 'queued' })]).api);
    click(/Implement login/);
    expect(
      await screen.findByText(/Escolha a pasta do repositório para os agentes/),
    ).toBeInTheDocument();
    expect(button('Terminal').disabled).toBe(true);
    expect(button('Terminal')).toHaveAttribute(
      'title',
      'O terminal abre quando o worktree da sessão existir neste computador.',
    );

    mock['pickFolder']!.mockResolvedValueOnce({ ok: false, error: 'No dialog' });
    click(/Escolher pasta/);
    expect(await screen.findByRole('alert')).toHaveTextContent('No dialog');
    click(/Escolher pasta/);
    await waitFor(() => expect(mock['pickFolder']).toHaveBeenCalledTimes(2));
    expect(mock['assign']).not.toHaveBeenCalled();

    mock['pickFolder']!.mockResolvedValue({ ok: true, path: 'D:\\Work\\shop' });
    mock['assign']!.mockResolvedValueOnce({ ok: false, error: 'Not a git repository' });
    click(/Escolher pasta/);
    expect(await screen.findByText('Not a git repository')).toBeInTheDocument();
    click(/Escolher pasta/);
    expect(await screen.findByText('Este computador')).toBeInTheDocument();
    expect(mock['assign']).toHaveBeenLastCalledWith('s1', {
      repoPath: 'D:\\Work\\shop',
      autonomy: 'safe',
    });
    expect(screen.getByText('shop')).toHaveTextContent('shop · D:\\Work');
    expect(screen.getByText(/A sessão começa neste computador/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /Escolher pasta/ })).toBeNull();
  });

  it('does not offer the folder to a read-only member', async () => {
    desktopApp();
    await show(mockClient([session({ status: 'queued' })]).api, { readOnly: true });
    click(/Implement login/);
    expect(
      await screen.findByText(/Escolha a pasta do repositório para os agentes/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Escolher pasta/ })).toBeNull();
  });

  it('runs commands in a terminal of the worktree', async () => {
    const { api, stream } = mockClient([session()]);
    const { mock, emit, unsubscribe } = desktopApp();
    mock['assignment']!.mockResolvedValue({ ok: true, assignment: worktree });
    await show(api);
    click(/Implement login/);
    await waitFor(() => expect(button('Terminal').disabled).toBe(false));
    click('Terminal');
    const terminal = within(screen.getByRole('region', { name: 'Terminal' }));
    const log = terminal.getByRole('log');
    expect(await terminal.findByText('D:\\wt\\s1>')).toBeInTheDocument();
    expect(button('Executar').disabled).toBe(true);

    type('Comando', 'npm test');
    click('Executar');
    expect(mock['runInTerminal']).toHaveBeenCalledWith('s1', 'npm test');
    expect(log).toHaveTextContent('D:\\wt\\s1> npm test');
    click('Parar');
    expect(mock['stopTerminal']).toHaveBeenCalledWith('s1');
    emit('another', { type: 'output', text: 'not mine' });
    emit('s1', { type: 'output', text: '2 passed\n' });
    emit('s1', { type: 'exit', code: 1, cwd: 'D:\\wt\\s1\\src' });
    expect(log).toHaveTextContent('2 passed');
    expect(log).toHaveTextContent('[1]');
    expect(log.textContent).not.toContain('not mine');
    expect(terminal.getByText('D:\\wt\\s1\\src>')).toBeInTheDocument();

    mock['runInTerminal']!.mockResolvedValueOnce({ ok: false, error: 'The terminal is busy' });
    type('Comando', 'ls');
    click('Executar');
    await waitFor(() => expect(log).toHaveTextContent('The terminal is busy'));
    type('Comando', 'ls');
    click('Executar');
    emit('s1', { type: 'exit', code: 0, cwd: 'D:\\wt\\s1' });
    expect(log.textContent).not.toContain('[0]');
    expect(button('Executar')).toBeInTheDocument();

    // The session lost its place on this computer: the terminal has nothing to run in.
    mock['assignment']!.mockResolvedValue({ ok: false, error: 'gone' });
    api.getDevelopmentSession.mockResolvedValue(session({ updatedAt: '2026-11-10T11:00:00.000Z' }));
    stream.event({ kind: 'session', id: 's1' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Terminal' })).toBeNull());
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
  });

  it('says why a terminal could not open', async () => {
    const { mock } = desktopApp();
    mock['assignment']!.mockResolvedValue({ ok: true, assignment: worktree });
    mock['terminalFolder']!.mockResolvedValue({ ok: false, error: 'The worktree was removed' });
    await show(mockClient([session()]).api);
    click(/Implement login/);
    await waitFor(() => expect(button('Terminal').disabled).toBe(false));
    click('Terminal');
    await waitFor(() =>
      expect(screen.getByRole('log')).toHaveTextContent('The worktree was removed'),
    );
  });

  it('shows the terminal button disabled in a browser', async () => {
    await show(mockClient([session()]).api);
    click(/Implement login/);
    expect(button('Terminal').disabled).toBe(true);
    expect(button('Terminal')).toHaveAttribute(
      'title',
      'O terminal só está disponível no app desktop.',
    );
    fireEvent.click(button('Terminal'));
    expect(screen.queryByRole('region', { name: 'Terminal' })).toBeNull();
  });
});
