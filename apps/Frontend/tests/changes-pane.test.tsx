import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangesPane } from '../src/features/development/ChangesPane.js';
import type { DiffFile } from '../src/features/development/development-types.js';
import type { DesktopCommit, DesktopDevelopmentBridge } from '../src/lib/desktop.js';
import { desktopApp, session } from './helpers/development.js';

const files: DiffFile[] = [
  {
    path: 'src/lib/util.ts',
    status: 'added',
    additions: 2,
    deletions: 0,
    patch: '@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;',
  },
  {
    path: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: '@@ -4,2 +4,2 @@\n keep\n-old line\n+new line',
  },
  {
    path: 'gone.txt',
    status: 'deleted',
    additions: 0,
    deletions: 3,
    patch: '@@ -1,3 +0,0 @@\n-x\n-y\n-z',
  },
];
const commits: DesktopCommit[] = [
  {
    hash: '0123456789abcdef',
    author: 'Ana',
    date: '2026-11-10T10:00:00.000Z',
    subject: 'Add login form',
  },
  {
    hash: 'fedcba9876543210',
    author: 'Bia',
    date: '2026-11-09T10:00:00.000Z',
    subject: 'Fix typo',
  },
];
const SESSION = session({
  worktree: { branch: 'adk/login', baseBranch: 'main', path: 'D:\\wt\\s1' },
});

interface Over {
  desktop?: DesktopDevelopmentBridge;
  files?: DiffFile[];
  commits?: DesktopCommit[] | null;
  refreshKey?: string;
  maximized?: boolean;
}

function renderPane(over: Over = {}) {
  const calls = {
    onToggleMaximize: vi.fn(),
    onClose: vi.fn(),
    onOpenFile: vi.fn(),
    onAttachContext: vi.fn().mockResolvedValue(undefined),
  };
  const element = (next: Over) => (
    <ChangesPane
      session={SESSION}
      files={next.files ?? files}
      commits={next.commits === undefined ? commits : next.commits}
      {...(next.desktop ? { desktop: next.desktop } : {})}
      refreshKey={next.refreshKey ?? 'v1'}
      maximized={next.maximized ?? false}
      {...calls}
    />
  );
  const view = render(element(over));
  return { ...calls, view, again: (next: Over) => view.rerender(element({ ...over, ...next })) };
}

function desktop() {
  const { mock } = desktopApp();
  return { mock, bridge: window.adkDesktop!.development as DesktopDevelopmentBridge };
}

const pane = () => within(screen.getByRole('region', { name: 'Alterações' }));
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const section = (path: string) => screen.getByRole('region', { name: `Diff de ${path}` });
/** An item of the innermost open menu: by its exact name, or by its start when a hint follows it. */
const item = (name: string | RegExp): HTMLElement => {
  const menu = within(screen.getAllByRole('menu').at(-1)!);
  const roles = ['menuitemcheckbox', 'menuitemradio', 'menuitem'] as const;
  const matchers = typeof name === 'string' ? [name, new RegExp(`^${name}`)] : [name];
  for (const matcher of matchers)
    for (const role of roles) {
      const found = menu.queryAllByRole(role, { name: matcher });
      if (found[0]) return found[0];
    }
  throw new Error(`No menu item ${String(name)}`);
};

/** jsdom has no PointerEvent: a plain event that carries the fields the sidebar reads. */
const pointer = (type: string, properties: { button?: number; clientX?: number } = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.entries(properties).forEach(([key, value]) => {
    Object.defineProperty(event, key, { value });
  });
  return event;
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  Reflect.deleteProperty(window, 'adkDesktop');
  vi.restoreAllMocks();
});

describe('ChangesPane in a browser', () => {
  it('shows every file with its numbered diff, the list and the comparison', () => {
    renderPane({ commits: null });
    expect(screen.getByRole('button', { name: 'Comparação' })).toHaveTextContent('mainadk/login');
    expect(pane().getAllByText('+2')).toHaveLength(2);
    expect(pane().getByText('-3')).toBeInTheDocument();
    expect(within(section('src/lib/util.ts')).getByText(/export const a = 1;/)).toBeInTheDocument();
    const rows = [...section('src/app.ts').children] as HTMLElement[];
    expect(rows.map((row) => row.textContent)).toEqual([
      '@@ -4,2 +4,2 @@',
      '4 keep',
      '5-old line',
      '5+new line',
    ]);
    expect(rows[2]).toHaveClass('bg-red-500/15');
    expect(rows[3]).toHaveClass('bg-green-500/15');
    expect(screen.queryByRole('region', { name: 'Commits' })).toBeNull();
    expect(pane().getByRole('list', { name: 'Arquivos alterados' })).toBeInTheDocument();
  });

  it('scrolls the diff and keeps the files apart from the commits, each with its own scroll', () => {
    renderPane();
    // The diff has the height of its column, so what does not fit can be scrolled to.
    const diff = section('src/app.ts').closest('[aria-busy]')!;
    expect(diff).toHaveClass('h-full');
    expect(diff).toHaveClass('overflow-auto');

    const list = pane().getByRole('list', { name: 'Arquivos alterados' });
    const commitsBlock = pane().getByRole('region', { name: 'Commits' });
    expect(list).toHaveClass('overflow-y-auto');
    expect(commitsBlock.contains(list)).toBe(false);
    expect(commitsBlock.querySelector('ul')).toHaveClass('overflow-y-auto');
    expect(commitsBlock).toHaveClass('flex-1');
    // Folded, the commits give their room back to the files.
    fireEvent.click(within(commitsBlock).getByRole('button', { name: /Commits/ }));
    expect(commitsBlock).toHaveClass('shrink-0');
    expect(commitsBlock).not.toHaveClass('flex-1');
  });

  it('says when there is nothing to show or nothing matches the search', () => {
    const view = renderPane({ files: [], commits: null });
    expect(pane().getByText('O runner ainda não enviou o diff desta sessão.')).toBeInTheDocument();
    view.view.unmount();
    renderPane();
    press('Buscar nas alterações');
    fireEvent.change(screen.getByLabelText('Buscar nas alterações', { selector: 'input' }), {
      target: { value: 'NEW LINE' },
    });
    expect(screen.queryByRole('region', { name: 'Diff de gone.txt' })).toBeNull();
    expect(section('src/app.ts')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Buscar nas alterações', { selector: 'input' }), {
      target: { value: 'util' },
    });
    expect(screen.queryByRole('region', { name: 'Diff de src/app.ts' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Buscar nas alterações', { selector: 'input' }), {
      target: { value: 'zzz' },
    });
    expect(pane().getByText('Nenhum arquivo corresponde à busca.')).toBeInTheDocument();
    // Closing the search brings every file back.
    press('Buscar nas alterações');
    expect(section('gone.txt')).toBeInTheDocument();
    expect(screen.queryByLabelText('Buscar nas alterações', { selector: 'input' })).toBeNull();
  });

  it('collapses and expands files, one by one or all, and remembers the viewed ones', () => {
    const view = renderPane();
    press('Recolher src/app.ts');
    expect(screen.queryByRole('region', { name: 'Diff de src/app.ts' })).toBeNull();
    press('Expandir src/app.ts');
    expect(section('src/app.ts')).toBeInTheDocument();

    press('Opções das alterações');
    fireEvent.click(item('Recolher tudo'));
    expect(screen.queryAllByRole('region', { name: /^Diff de / })).toHaveLength(0);
    press('Opções das alterações');
    fireEvent.click(item('Expandir tudo'));
    expect(screen.getAllByRole('region', { name: /^Diff de / })).toHaveLength(3);

    // Marking a file as viewed folds it away and keeps it so for the next visit.
    fireEvent.click(screen.getAllByRole('button', { name: 'Marcar como visto' })[0]!);
    expect(screen.queryAllByRole('region', { name: /^Diff de / })).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem('adk.development.viewed.s1')!)).toEqual([
      'src/lib/util.ts',
    ]);
    expect(screen.getByRole('button', { name: 'Marcar como não visto' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    view.view.unmount();
    renderPane();
    expect(screen.getAllByRole('region', { name: /^Diff de / })).toHaveLength(2);
    press('Marcar como não visto');
    expect(screen.getAllByRole('region', { name: /^Diff de / })).toHaveLength(3);
  });

  it('survives a damaged or blocked memory of what was viewed', () => {
    window.localStorage.setItem('adk.development.viewed.s1', '{"not":"a list"}');
    renderPane();
    expect(screen.getAllByRole('region', { name: /^Diff de / })).toHaveLength(3);
    window.localStorage.setItem('adk.development.viewed.s1', 'not json');
    renderPane();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Marcar como visto' })[0]!);
    expect(screen.getAllByRole('button', { name: 'Marcar como não visto' })).toHaveLength(1);
  });

  it('hides the list, expands the panel and closes it', () => {
    const view = renderPane();
    press('Mostrar lista de arquivos');
    expect(screen.queryByRole('list', { name: 'Arquivos alterados' })).toBeNull();
    press('Mostrar lista de arquivos');
    press('Expandir painel');
    expect(view.onToggleMaximize).toHaveBeenCalledOnce();
    press('Fechar painel');
    expect(view.onClose).toHaveBeenCalledOnce();
    view.again({ maximized: true });
    expect(screen.getByRole('region', { name: 'Alterações' })).toHaveClass('fixed');
    expect(screen.getByRole('button', { name: 'Restaurar painel' })).toBeInTheDocument();
  });

  it('keeps the list as a column inside the panel that can be resized', () => {
    renderPane();
    const card = () =>
      screen.getByRole('list', { name: 'Arquivos alterados' }).closest('[style]') as HTMLElement;
    expect(screen.getByRole('region', { name: 'Alterações' }).contains(card())).toBe(true);
    expect(card().style.width).toBe('280px');
    fireEvent(
      screen.getByRole('separator', { name: 'Redimensionar a lista de alterações' }),
      pointer('pointerdown', { button: 0, clientX: 800 }),
    );
    fireEvent(window, pointer('pointermove', { clientX: 700 }));
    expect(card().style.width).toBe('380px');
    fireEvent(window, pointer('pointerup'));
  });

  it('opens a file of the list in the editor and brings its diff into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPane();
    press('Recolher gone.txt');
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Arquivos alterados' })).getByRole('button', {
        name: /gone\.txt/,
      }),
    );
    expect(section('gone.txt')).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalled();
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Arquivos alterados' })).getByRole('button', {
        name: /app\.ts/,
      }),
    );
  });

  it('has a menu for each file: copy, attach, viewed and open', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const view = renderPane();
    press('Ações de src/app.ts');
    for (const name of [
      'Anexar como contexto',
      'Copiar',
      'Marcar como visto',
      'Abrir arquivo',
      'Abrir em',
      'Mostrar no Explorer',
    ])
      expect(item(name)).toBeInTheDocument();
    // Without the desktop app there is no path on this computer to copy, open or show.
    expect((item('Abrir em') as HTMLButtonElement).disabled).toBe(true);
    expect((item('Mostrar no Explorer') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(item('Copiar'));
    expect((item('Copiar caminho') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item('Copiar caminho relativo'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('src/app.ts'));
    expect(await screen.findByRole('status')).toHaveTextContent('Copiado.');
    press('Ações de src/app.ts');
    fireEvent.click(item('Copiar'));
    fireEvent.click(item('Copiar diff'));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(files[1]!.patch));

    press('Ações de src/app.ts');
    fireEvent.click(item('Abrir arquivo'));
    expect(view.onOpenFile).toHaveBeenCalledWith('src/app.ts');
    press('Ações de src/app.ts');
    fireEvent.click(item('Marcar como visto'));
    expect(screen.queryByRole('region', { name: 'Diff de src/app.ts' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Abrir arquivo' })[2]!);
    expect(view.onOpenFile).toHaveBeenLastCalledWith('gone.txt');

    press('Ações de gone.txt');
    fireEvent.click(item('Anexar como contexto'));
    await waitFor(() => expect(view.onAttachContext).toHaveBeenCalledWith('gone.txt'));
    expect(await screen.findByText('Arquivo anexado como contexto da sessão.')).toBeInTheDocument();
    view.onAttachContext.mockRejectedValueOnce(new Error('Session is closed'));
    press('Ações de gone.txt');
    fireEvent.click(item('Anexar como contexto'));
    expect(await screen.findByText('Session is closed')).toBeInTheDocument();
    view.onAttachContext.mockRejectedValueOnce('nope');
    press('Ações de gone.txt');
    fireEvent.click(item('Anexar como contexto'));
    expect(await screen.findByText('Não foi possível concluir a ação.')).toBeInTheDocument();
  });

  it('says when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('Clipboard blocked')) },
      configurable: true,
    });
    renderPane();
    press('Ações de src/app.ts');
    fireEvent.click(item('Copiar'));
    fireEvent.click(item('Copiar caminho relativo'));
    expect(await screen.findByText('Clipboard blocked')).toBeInTheDocument();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue('denied') },
      configurable: true,
    });
    press('Ações de src/app.ts');
    fireEvent.click(item('Copiar'));
    fireEvent.click(item('Copiar caminho relativo'));
    expect(await screen.findByText('Copiado.')).toBeInTheDocument();
  });

  it('clears its notice after a moment', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    renderPane();
    press('Ações de src/app.ts');
    fireEvent.click(item('Copiar'));
    fireEvent.click(item('Copiar caminho relativo'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('status')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.queryByRole('status')).toBeNull();
    vi.useRealTimers();
  });

  it('keeps the comparison and commit pickers out of reach', () => {
    renderPane();
    press('Comparação');
    expect(item('Todas as alterações')).toHaveAttribute('aria-checked', 'true');
    expect((item(/Comparar com/) as HTMLButtonElement).disabled).toBe(true);
    expect((item(/^Commits/) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ChangesPane with the desktop app', () => {
  it('compares against another branch, read from the worktree', async () => {
    const { mock, bridge } = desktop();
    renderPane({ desktop: bridge });
    await waitFor(() => expect(mock['branches']).toHaveBeenCalledWith('s1'));
    mock['changes']!.mockResolvedValue({
      ok: true,
      files: [files[2]],
      commits: [commits[0]],
    });
    press('Comparação');
    expect(item('Todas as alterações')).toHaveTextContent('vs main');
    fireEvent.click(item(/Comparar com/));
    const list = within(screen.getByRole('group', { name: 'Buscar branches' }));
    expect(list.getAllByRole('menuitemradio').map((row) => row.textContent)).toEqual([
      'develop',
      'mainpadrão',
    ]);
    fireEvent.change(screen.getByLabelText('Buscar branches', { selector: 'input' }), {
      target: { value: 'dev' },
    });
    expect(list.getAllByRole('menuitemradio')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Buscar branches', { selector: 'input' }), {
      target: { value: 'nothing' },
    });
    expect(list.getByText('Nenhum resultado.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Buscar branches', { selector: 'input' }), {
      target: { value: 'dev' },
    });
    fireEvent.click(list.getByRole('menuitemradio', { name: 'develop' }));
    await waitFor(() =>
      expect(mock['changes']).toHaveBeenCalledWith('s1', 'main', { against: 'develop' }),
    );
    expect(screen.getByRole('button', { name: 'Comparação' })).toHaveTextContent(
      'developadk/login',
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Diff de src/app.ts' })).toBeNull(),
    );
    expect(section('gone.txt')).toBeInTheDocument();
    expect(pane().getAllByText('1')).not.toHaveLength(0);

    // The base branch is the session's own comparison again.
    press('Comparação');
    fireEvent.click(item(/Comparar com/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /main/ }));
    await waitFor(() => expect(section('src/app.ts')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Comparação' })).toHaveTextContent('mainadk/login');
  });

  it('shows what one commit changed, from the menu or the list, and goes back to all changes', async () => {
    const { mock, bridge } = desktop();
    renderPane({ desktop: bridge });
    mock['changes']!.mockResolvedValue({ ok: true, files: [files[1]], commits });
    press('Comparação');
    fireEvent.click(item(/^Commits/));
    expect(
      within(screen.getByRole('group', { name: 'Buscar commits' })).getAllByRole('menuitemradio'),
    ).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Buscar commits', { selector: 'input' }), {
      target: { value: 'fedcba9' },
    });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Fix typo/ }));
    await waitFor(() =>
      expect(mock['changes']).toHaveBeenCalledWith('s1', 'main', { commit: 'fedcba9876543210' }),
    );
    press('Comparação');
    expect(item('Todas as alterações')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(item('Todas as alterações'));
    await waitFor(() => expect(section('gone.txt')).toBeInTheDocument());

    const list = within(pane().getByRole('region', { name: 'Commits' }));
    expect(list.getByText('2')).toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: /Add login form/ }));
    await waitFor(() =>
      expect(mock['changes']).toHaveBeenLastCalledWith('s1', 'main', {
        commit: '0123456789abcdef',
      }),
    );
    expect(list.getByRole('button', { name: /Add login form/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(list.getByRole('button', { name: 'Todas as alterações' }));
    await waitFor(() => expect(section('gone.txt')).toBeInTheDocument());

    fireEvent.click(list.getByRole('button', { name: /Commits/ }));
    expect(list.queryByRole('button', { name: 'Todas as alterações' })).toBeNull();
    fireEvent.click(list.getByRole('button', { name: /Commits/ }));
    expect(list.getByRole('button', { name: 'Todas as alterações' })).toBeInTheDocument();
  });

  it('shows a skeleton where the changes of a commit will be, until they are read', async () => {
    const { mock, bridge } = desktop();
    const view = renderPane({ desktop: bridge });
    let answer: (value: unknown) => void = () => {};
    mock['changes']!.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const list = within(pane().getByRole('region', { name: 'Commits' }));
    fireEvent.click(list.getByRole('button', { name: /Add login form/ }));

    // The files of the session are not shown as if they were the commit's.
    const loading = await pane().findByRole('status', { name: 'Carregando alterações…' });
    expect(loading).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Diff de/ })).toBeNull();
    expect(pane().getAllByTestId('skeleton').length).toBeGreaterThan(3);
    expect(loading.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    // The commits stay, so another one can be chosen meanwhile.
    expect(list.getByRole('button', { name: /Fix typo/ })).toBeInTheDocument();

    await act(async () => answer({ ok: true, files: [files[1]], commits }));
    expect(pane().queryByRole('status', { name: 'Carregando alterações…' })).toBeNull();
    expect(section('src/app.ts')).toBeInTheDocument();

    // The session moving reads the commit again behind what is shown, with no skeleton.
    mock['changes']!.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    view.again({ refreshKey: 'v2' });
    await waitFor(() => expect(mock['changes']).toHaveBeenCalledTimes(2));
    expect(pane().queryByRole('status', { name: 'Carregando alterações…' })).toBeNull();
    expect(section('src/app.ts')).toBeInTheDocument();
    await act(async () => answer({ ok: true, files: [files[1]], commits }));
  });

  it('says there are no commits, and cannot pick one in a browser', () => {
    renderPane({ commits: [] });
    const list = within(pane().getByRole('region', { name: 'Commits' }));
    expect(list.getByText('Nenhum commit nesta branch.')).toBeInTheDocument();
    expect(list.getByRole('button', { name: 'Todas as alterações' })).toBeInTheDocument();
  });

  it('reads the comparison again when the session moves, and says why it could not', async () => {
    const { mock, bridge } = desktop();
    mock['changes']!.mockResolvedValue({ ok: true, files: [files[0]], commits: [] });
    const view = renderPane({ desktop: bridge });
    await waitFor(() => expect(mock['branches']).toHaveBeenCalled());
    press('Comparação');
    fireEvent.click(item(/Comparar com/));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'develop' }));
    await waitFor(() => expect(mock['changes']).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();

    mock['changes']!.mockResolvedValue({ ok: false, error: 'bad revision' });
    view.again({ refreshKey: 'v2', desktop: bridge });
    expect(await screen.findByRole('alert')).toHaveTextContent('bad revision');
    mock['changes']!.mockResolvedValue({ ok: true, files: [files[1]], commits: [] });
    view.again({ refreshKey: 'v3', desktop: bridge });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(section('src/app.ts')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Alterações' }).querySelector('[aria-busy="false"]'),
    ).not.toBeNull();
  });

  it('ignores answers that arrive after it was left, and a failed branch list', async () => {
    const { mock, bridge } = desktop();
    mock['branches']!.mockResolvedValue({ ok: false, error: 'no git' });
    let answer: (value: unknown) => void = () => {};
    mock['changes']!.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const view = renderPane({ desktop: bridge });
    await waitFor(() => expect(mock['branches']).toHaveBeenCalled());
    press('Comparação');
    expect(item(/Comparar com/)).toBeInTheDocument();
    fireEvent.click(item(/^Commits/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Add login form/ }));
    await waitFor(() => expect(mock['changes']).toHaveBeenCalled());
    view.view.unmount();
    await act(async () => answer({ ok: true, files: [], commits: [] }));

    const second = renderPane({ desktop: bridge });
    second.view.unmount();
    let late: (value: unknown) => void = () => {};
    mock['branches']!.mockImplementation(() => new Promise((resolve) => (late = resolve)));
    renderPane({ desktop: bridge }).view.unmount();
    await act(async () => late({ ok: true, branches: ['x'] }));
  });

  it('copies the path on this computer, opens the file elsewhere and shows it in the Explorer', async () => {
    const { mock, bridge } = desktop();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPane({ desktop: bridge });
    press('Ações de src/app.ts');
    fireEvent.click(item('Copiar'));
    fireEvent.click(item('Copiar caminho'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('D:\\wt\\s1\\a.txt'));
    expect(mock['filePath']).toHaveBeenCalledWith('s1', 'src/app.ts');
    mock['filePath']!.mockResolvedValueOnce({ ok: false, error: 'Outside the worktree' });
    press('Ações de src/app.ts');
    fireEvent.click(item('Copiar'));
    fireEvent.click(item('Copiar caminho'));
    expect(await screen.findByText('Outside the worktree')).toBeInTheDocument();

    press('Ações de src/app.ts');
    fireEvent.click(item('Abrir em'));
    fireEvent.click(item('Aplicativo padrão'));
    expect(mock['openFile']).toHaveBeenCalledWith('s1', 'src/app.ts', 'default');
    press('Ações de src/app.ts');
    fireEvent.click(item('Abrir em'));
    fireEvent.click(item('VS Code'));
    expect(mock['openFile']).toHaveBeenLastCalledWith('s1', 'src/app.ts', 'vscode');
    mock['openFile']!.mockResolvedValueOnce({ ok: false, error: 'No application' });
    press('Ações de src/app.ts');
    fireEvent.click(item('Abrir em'));
    fireEvent.click(item('Aplicativo padrão'));
    expect(await screen.findByText('No application')).toBeInTheDocument();

    press('Ações de src/app.ts');
    fireEvent.click(item('Mostrar no Explorer'));
    expect(mock['revealFile']).toHaveBeenCalledWith('s1', 'src/app.ts');
    mock['revealFile']!.mockResolvedValueOnce({ ok: false });
    press('Ações de src/app.ts');
    fireEvent.click(item('Mostrar no Explorer'));
    expect(await screen.findByText('Não foi possível concluir a ação.')).toBeInTheDocument();
  });

  it('reverts one file or all the changes after asking, and reads the worktree again', async () => {
    const { mock, bridge } = desktop();
    mock['changes']!.mockResolvedValue({ ok: true, files: [files[1]], commits: [] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPane({ desktop: bridge });

    press('Ações de src/app.ts');
    fireEvent.click(item('Reverter arquivo'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('src/app.ts'));
    expect(mock['revertChanges']).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    press('Ações de src/app.ts');
    fireEvent.click(item('Reverter arquivo'));
    await waitFor(() =>
      expect(mock['revertChanges']).toHaveBeenCalledWith('s1', 'main', 'src/app.ts'),
    );
    expect(await screen.findByText('Alterações revertidas')).toBeInTheDocument();
    await waitFor(() => expect(mock['changes']).toHaveBeenCalled());

    press('Opções das alterações');
    fireEvent.click(item('Reverter todas as alterações'));
    await waitFor(() =>
      expect(mock['revertChanges']).toHaveBeenLastCalledWith('s1', 'main', undefined),
    );

    mock['revertChanges']!.mockResolvedValueOnce({ ok: false });
    press('Opções das alterações');
    fireEvent.click(item('Reverter todas as alterações'));
    expect(await screen.findByText('Não foi possível concluir a ação.')).toBeInTheDocument();
    mock['revertChanges']!.mockResolvedValueOnce({ ok: false, error: 'dirty' });
    press('Opções das alterações');
    fireEvent.click(item('Reverter todas as alterações'));
    expect(await screen.findByText('dirty')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('cannot revert in a browser', () => {
    renderPane();
    press('Opções das alterações');
    expect((item('Reverter todas as alterações') as HTMLButtonElement).disabled).toBe(true);
  });
});
