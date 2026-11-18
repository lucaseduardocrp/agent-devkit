import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffFile } from '../src/features/development/development-types.js';
import {
  button,
  click,
  desktopApp,
  mockClient,
  session,
  show,
  worktree,
} from './helpers/development.js';

const diff: DiffFile[] = [
  {
    path: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: '@@ -1,2 +1,2 @@\n keep\n-old\n+new',
  },
  {
    path: 'README.md',
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+# Shop',
  },
];

afterEach(() => {
  Reflect.deleteProperty(window, 'adkDesktop');
  window.localStorage.clear();
});

describe('SessionWorkspace panels', () => {
  it('opens the changes from the toolbar or the sidebar, expands them and closes them', async () => {
    await show(mockClient([session({ diff })]).api);
    click(/Implement login/);
    expect(screen.queryByRole('region', { name: 'Alterações' })).toBeNull();
    click('Alterações');
    const panel = () => screen.getByRole('region', { name: 'Alterações' });
    expect(within(panel()).getByRole('region', { name: 'Diff de src/app.ts' })).toBeInTheDocument();
    click('Alterações');
    expect(screen.queryByRole('region', { name: 'Alterações' })).toBeNull();

    click('Ver alterações');
    click('Expandir painel');
    expect(panel()).toHaveClass('fixed');
    click('Restaurar painel');
    expect(panel()).not.toHaveClass('fixed');
    click('Expandir painel');
    // Leaving the panel through the toolbar un-expands it for the next time.
    click('Alterações');
    click('Alterações');
    expect(panel()).not.toHaveClass('fixed');
    click('Fechar painel');
    expect(screen.queryByRole('region', { name: 'Alterações' })).toBeNull();
    click('Ver alterações');
    click('Expandir painel');
    click('Fechar painel');
    click('Ver alterações');
    expect(panel()).not.toHaveClass('fixed');
  });

  it('opens a changed file in the Files panel from the changes', async () => {
    await show(mockClient([session({ diff })]).api);
    click(/Implement login/);
    click('Alterações');
    fireEvent.click(screen.getAllByRole('button', { name: 'Abrir arquivo' })[1]!);
    const files = within(await screen.findByRole('region', { name: 'Arquivos' }));
    expect(await files.findByRole('tab', { name: 'README.md' })).toBeInTheDocument();
    expect((files.getByLabelText('Editor de README.md') as HTMLTextAreaElement).value).toContain(
      '+# Shop',
    );
    expect(screen.getByRole('region', { name: 'Alterações' })).toBeInTheDocument();
  });

  it('attaches a file to the session as a comment the next attempt reads', async () => {
    const { api } = mockClient([session({ diff })]);
    await show(api);
    click(/Implement login/);
    click('Alterações');
    fireEvent.click(screen.getAllByRole('button', { name: 'Ações de src/app.ts' })[0]!);
    const menu = within(screen.getByRole('menu', { name: 'Ações de src/app.ts' }));
    fireEvent.click(menu.getByRole('menuitem', { name: 'Anexar como contexto' }));
    await waitFor(() =>
      expect(api.addDevelopmentComment).toHaveBeenCalledWith(
        's1',
        'Contexto anexado: src/app.ts',
        'src/app.ts',
      ),
    );
    expect(await screen.findByText('Arquivo anexado como contexto da sessão.')).toBeInTheDocument();
  });

  it('reads the worktree again each time the session reports', async () => {
    const { api, stream } = mockClient([session({ status: 'running' })]);
    const { mock } = desktopApp();
    mock['assignment']!.mockResolvedValue({ ok: true, assignment: worktree });
    mock['changes']!.mockResolvedValue({
      ok: true,
      files: [diff[0]],
      commits: [],
    });
    await show(api);
    click(/Implement login/);
    await waitFor(() => expect(mock['changes']).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button('Terminal').disabled).toBe(false));

    mock['changes']!.mockResolvedValue({ ok: true, files: [diff[0], diff[1]], commits: [] });
    api.getDevelopmentSession.mockResolvedValue(
      session({ status: 'running', updatedAt: '2026-11-10T10:00:05.000Z' }),
    );
    await act(async () => stream.event({ kind: 'session', id: 's1' }));
    await waitFor(() => expect(mock['changes']!.mock.calls.length).toBeGreaterThan(1));
    // The sidebar counts follow what the agent wrote.
    expect(await screen.findByText('+2')).toBeInTheDocument();

    mock['changes']!.mockResolvedValue({ ok: false, error: 'git is busy' });
    api.getDevelopmentSession.mockResolvedValue(
      session({ status: 'running', updatedAt: '2026-11-10T10:00:10.000Z' }),
    );
    await act(async () => stream.event({ kind: 'session', id: 's1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('git is busy');
  });
});

describe('SessionWorkspace changes', () => {
  it('reads the changes again after a file is saved, on coming back and on opening them', async () => {
    const { api } = mockClient([session({ status: 'running' })]);
    const { mock } = desktopApp();
    mock['assignment']!.mockResolvedValue({ ok: true, assignment: worktree });
    mock['changes']!.mockResolvedValue({ ok: true, files: [], commits: [] });
    mock['listFiles']!.mockResolvedValue({
      ok: true,
      entries: [{ name: 'a.txt', path: 'a.txt', kind: 'file' }],
    });
    mock['readFile']!.mockResolvedValue({
      ok: true,
      file: { kind: 'text', content: 'alpha', truncated: false },
    });
    await show(api);
    click(/Implement login/);
    await waitFor(() => expect(mock['changes']).toHaveBeenCalledTimes(1));
    expect(screen.getByText('+0')).toBeInTheDocument();

    // A file saved in the editor shows in the changes without the agent reporting.
    click('Arquivos');
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    const area = await screen.findByLabelText('Editor de a.txt');
    mock['changes']!.mockResolvedValue({ ok: true, files: [diff[1]], commits: [] });
    fireEvent.change(area, { target: { value: 'beta' } });
    fireEvent.keyDown(area, { key: 's', ctrlKey: true });
    await waitFor(() => expect(mock['writeFile']).toHaveBeenCalledWith('s1', 'a.txt', 'beta'));
    expect(await screen.findByText('+1')).toBeInTheDocument();

    // Changed outside the app: read again on coming back to the window.
    mock['changes']!.mockClear();
    mock['changes']!.mockResolvedValue({ ok: true, files: [diff[0], diff[1]], commits: [] });
    fireEvent.focus(window);
    await waitFor(() => expect(mock['changes']).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('+2')).toBeInTheDocument();

    // And each time the panel is opened.
    mock['changes']!.mockClear();
    click('Alterações');
    await waitFor(() => expect(mock['changes']).toHaveBeenCalled());
  });
});

describe('Code as a list page and a session page', () => {
  it('lists the sessions first, opens one and goes back to the list', async () => {
    await show(mockClient([session({ diff }), session({ id: 's2', title: 'Another' })]).api);
    expect(screen.getByRole('region', { name: 'Sessões' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Arquivos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ver sessões' })).toBeNull();

    click(/Implement login/);
    expect(screen.queryByRole('region', { name: 'Sessões' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Implement login' })).toBeInTheDocument();
    click('Ver sessões');
    expect(screen.getByText('Another')).toBeInTheDocument();
  });

  it('goes back to the list from the new session form', async () => {
    await show(mockClient([session()]).api);
    click(/Nova sessão/);
    expect(screen.queryByRole('region', { name: 'Sessões' })).toBeNull();
    click('Cancelar');
    expect(screen.getByRole('region', { name: 'Sessões' })).toBeInTheDocument();
  });

  it('puts the vertical handle of each panel in the gap below it', async () => {
    await show(mockClient([session({ diff })]).api);
    click(/Implement login/);
    click('Arquivos');
    click('Alterações');
    for (const name of ['Arquivos', 'Alterações']) {
      const panel = screen.getByRole('region', { name });
      const handle = panel.parentElement!.querySelector(
        '[role="separator"][aria-orientation="horizontal"]',
      )!;
      expect(panel.contains(handle)).toBe(false);
      expect(handle).toHaveClass('top-full');
    }
  });
});

describe('SessionWorkspace header', () => {
  it('puts the summary behind a button before the review, with every button neutral but delete', async () => {
    await show(
      mockClient([session({ status: 'waiting_review', summary: 'Nothing to do', diff })]).api,
    );
    click(/Implement login/);
    expect(screen.queryByText('Nothing to do')).toBeNull();
    const summary = button('Ver resumo');
    const review = button('Abrir revisão');
    expect(summary).toHaveAttribute('aria-pressed', 'false');
    // Left of "Abrir revisão".
    expect(summary.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click('Ver resumo');
    expect(screen.getByText('Nothing to do')).toBeInTheDocument();
    expect(button('Ocultar resumo')).toHaveAttribute('aria-pressed', 'true');

    // One size for all of them; only delete is red, the rest share the neutral look.
    const heights = ['Ver sessões', 'Ocultar resumo', 'Abrir revisão', 'Cancelar sessão', 'Excluir']
      .map((name) => button(name))
      .map((item) => item.className.match(/\bh-\[40px\]/)?.[0]);
    expect(new Set(heights)).toEqual(new Set(['h-[40px]']));
    for (const name of ['Ver sessões', 'Ocultar resumo', 'Abrir revisão', 'Cancelar sessão'])
      expect(button(name).className).toContain('bg-[var(--surface-2)]');
    expect(button('Excluir').className).toContain('bg-[var(--fill-danger)]');
  });
});
