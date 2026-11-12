import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPane } from '../src/features/development/FilesPane.js';
import type { DiffFile } from '../src/features/development/development-types.js';
import type { DesktopDevelopmentBridge } from '../src/lib/desktop.js';
import { desktopApp } from './helpers/development.js';

const entry = (path: string, kind: 'directory' | 'file' = 'file') => ({
  name: path.split('/').pop(),
  path,
  kind,
});
const CONTENT: Record<string, string> = {
  'a.txt': 'alpha\nbeta',
  'b.txt': 'bravo',
  'README.md': '# Shop\n\nSome **text**',
  'src/index.ts': 'export {};\n',
};

/** A worktree on this computer, with a few files, as the desktop app answers for it. */
function setup(
  props: { refreshKey?: string; openRequest?: { path: string } | null; onSaved?: () => void } = {},
) {
  const { mock } = desktopApp();
  mock['listFiles']!.mockImplementation((_id: string, folder: string) =>
    Promise.resolve(
      folder === ''
        ? {
            ok: true,
            entries: [
              entry('src', 'directory'),
              entry('docs', 'directory'),
              entry('a.txt'),
              entry('b.txt'),
              entry('bin.dat'),
              entry('big.txt'),
              entry('gone.txt'),
              entry('README.md'),
            ],
          }
        : folder === 'src'
          ? { ok: true, entries: [entry('src/index.ts')] }
          : { ok: false, error: 'Cannot read docs' },
    ),
  );
  mock['readFile']!.mockImplementation((_id: string, path: string) =>
    Promise.resolve(
      path in CONTENT
        ? { ok: true, file: { kind: 'text', content: CONTENT[path], truncated: false } }
        : path === 'bin.dat'
          ? { ok: true, file: { kind: 'binary' } }
          : path === 'big.txt'
            ? { ok: true, file: { kind: 'text', content: 'start of a long file', truncated: true } }
            : { ok: false, error: 'File is gone' },
    ),
  );
  const bridge = window.adkDesktop!.development as DesktopDevelopmentBridge;
  const view = render(
    <FilesPane
      sessionId="s1"
      diff={[]}
      desktop={bridge}
      refreshKey={props.refreshKey ?? 'v1'}
      openRequest={props.openRequest ?? null}
      {...(props.onSaved ? { onSaved: props.onSaved } : {})}
    />,
  );
  const again = (next: { refreshKey?: string; openRequest?: { path: string } | null }) =>
    view.rerender(
      <FilesPane
        sessionId="s1"
        diff={[]}
        desktop={bridge}
        refreshKey={next.refreshKey ?? 'v1'}
        openRequest={next.openRequest ?? null}
      />,
    );
  return { mock, view, again };
}

const tree = () => within(screen.getByRole('navigation', { name: 'Árvore de arquivos' }));
const editor = (path: string) => screen.getByLabelText<HTMLTextAreaElement>(`Editor de ${path}`);
const tabs = () =>
  within(screen.getByRole('tablist', { name: 'Arquivos abertos' })).getAllByRole('tab');
const names = () => tabs().map((tab) => tab.textContent);
/** Clicks a file of the tree, and waits for its tab unless it is not going to open. */
const open = async (name: string, options: { double?: boolean; tab?: boolean } = {}) => {
  const row = await tree().findByRole('button', { name });
  fireEvent.click(row);
  if (options.double) fireEvent.doubleClick(row);
  if (options.tab ?? true)
    await waitFor(() => expect(names().some((tab) => tab?.startsWith(name))).toBe(true));
};
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const openMenu = () => press('Opções dos arquivos');
/** An item of the open menu, by the start of its name (a shortcut may follow it). */
const menuItem = (name: string | RegExp): HTMLElement => {
  const menu = within(screen.getAllByRole('menu')[0]!);
  const matcher = typeof name === 'string' ? new RegExp(`^${name}`) : name;
  for (const role of ['menuitemcheckbox', 'menuitemradio', 'menuitem'] as const) {
    const found = menu.queryAllByRole(role, { name: matcher });
    if (found[0]) return found[0];
  }
  throw new Error(`No menu item "${String(name)}".`);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FilesPane tree and tabs', () => {
  it('reads the worktree and opens files in preview tabs that the next one replaces', async () => {
    const { mock } = setup();
    expect(screen.getByText('Os arquivos abertos aparecem aqui')).toBeInTheDocument();
    fireEvent.click(await tree().findByRole('button', { name: 'docs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot read docs');
    fireEvent.click(tree().getByRole('button', { name: 'src' }));
    await open('index.ts');
    expect(mock['listFiles']).toHaveBeenCalledWith('s1', 'src');
    expect(editor('src/index.ts').value).toBe('export {};\n');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(names()).toEqual(['index.ts']);
    expect(tabs()[0]).toHaveClass('italic');
    expect(screen.getByText('src \\ index.ts')).toBeInTheDocument();

    await open('a.txt');
    await waitFor(() => expect(names()).toEqual(['a.txt']));
    // Pinned by a double click, so the next file does not replace it.
    await open('b.txt', { double: true });
    await waitFor(() => expect(names()).toEqual(['b.txt']));
    expect(tabs()[0]).not.toHaveClass('italic');
    await open('README.md');
    await waitFor(() => expect(names()).toEqual(['b.txt', 'README.md']));
    expect(tabs()[1]).toHaveClass('italic');

    // Opening one that is open only brings it forward, and a double click pins it.
    fireEvent.click(tabs()[0]!);
    expect(editor('b.txt').value).toBe('bravo');
    fireEvent.doubleClick(tabs()[1]!);
    expect(tabs()[1]).not.toHaveClass('italic');
    fireEvent.click(tree().getByRole('button', { name: 'README.md' }));
    fireEvent.doubleClick(tree().getByRole('button', { name: 'README.md' }));
    fireEvent.click(tree().getByRole('button', { name: 'b.txt' }));
    expect(names()).toEqual(['b.txt', 'README.md']);
  });

  it('says what could not be shown: binary, long and missing files', async () => {
    setup();
    await open('bin.dat');
    expect(await screen.findByText('Arquivo binário: não pode ser exibido.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Editor de/)).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Ver prévia (somente leitura)' })
        .disabled,
    ).toBe(true);
    await open('big.txt');
    expect(await screen.findByText('Arquivo longo: só o início é exibido.')).toBeInTheDocument();
    expect(editor('big.txt').readOnly).toBe(true);
    await open('gone.txt', { tab: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('File is gone');
    await open('a.txt');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(editor('a.txt').readOnly).toBe(false);
  });

  it('closes tabs and moves to the neighbour', async () => {
    setup();
    await open('a.txt', { double: true });
    await open('b.txt', { double: true });
    await open('README.md', { double: true });
    await waitFor(() => expect(tabs()).toHaveLength(3));
    press('Fechar README.md');
    expect(editor('b.txt')).toBeInTheDocument();
    press('Fechar a.txt');
    expect(names()).toEqual(['b.txt']);
    press('Fechar b.txt');
    expect(screen.getByText('Os arquivos abertos aparecem aqui')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('opens a file another panel asked for, pinned', async () => {
    const { again } = setup();
    again({ openRequest: { path: 'README.md' } });
    await waitFor(() => expect(names()).toEqual(['README.md']));
    expect(tabs()[0]).not.toHaveClass('italic');
  });

  it('reads the folders and the untouched files again when the session moves', async () => {
    const { mock, again } = setup();
    await open('a.txt', { double: true });
    await open('b.txt', { double: true });
    await waitFor(() => expect(tabs()).toHaveLength(2));
    fireEvent.change(editor('b.txt'), { target: { value: 'my edit' } });
    const listed = mock['listFiles']!.mock.calls.length;
    mock['readFile']!.mockImplementation((_id: string, path: string) =>
      Promise.resolve(
        path === 'a.txt'
          ? { ok: true, file: { kind: 'text', content: 'agent wrote this', truncated: false } }
          : path === 'b.txt'
            ? { ok: true, file: { kind: 'text', content: 'agent b', truncated: false } }
            : { ok: true, file: { kind: 'binary' } },
      ),
    );
    again({ refreshKey: 'v2' });
    await waitFor(() => expect(mock['listFiles']!.mock.calls.length).toBe(listed + 1));
    fireEvent.click(tabs()[0]!);
    await waitFor(() => expect(editor('a.txt').value).toBe('agent wrote this'));
    fireEvent.click(tabs()[1]!);
    expect(editor('b.txt').value).toBe('my edit');
    // The same key twice changes nothing.
    again({ refreshKey: 'v2' });
    expect(mock['listFiles']!.mock.calls.length).toBe(listed + 1);
  });

  it('keeps a binary result of the refresh out of the open text file', async () => {
    const { mock, again } = setup();
    await open('a.txt');
    const reads = () => mock['readFile']!.mock.calls.length;
    const first = reads();
    mock['readFile']!.mockResolvedValue({ ok: true, file: { kind: 'binary' } });
    again({ refreshKey: 'v2' });
    await waitFor(() => expect(reads()).toBe(first + 1));
    expect(editor('a.txt').value).toBe('alpha\nbeta');
    mock['readFile']!.mockResolvedValue({ ok: false, error: 'gone' });
    again({ refreshKey: 'v3' });
    await waitFor(() => expect(reads()).toBe(first + 2));
    expect(editor('a.txt').value).toBe('alpha\nbeta');
  });

  it('turns preview tabs off from the menu: every file opens in a tab of its own', async () => {
    setup();
    openMenu();
    fireEvent.click(menuItem('Abas de prévia'));
    expect(menuItem('Abas de prévia')).toHaveAttribute('aria-checked', 'false');
    await open('a.txt');
    await open('b.txt');
    await waitFor(() => expect(names()).toEqual(['a.txt', 'b.txt']));
    expect(tabs()[0]).not.toHaveClass('italic');
  });
});

describe('FilesPane editor', () => {
  it('saves what is typed after a pause, and says when it cannot', async () => {
    const { mock } = setup();
    await open('a.txt');
    vi.useFakeTimers();
    fireEvent.change(editor('a.txt'), { target: { value: 'changed' } });
    // Edited: the tab is kept, and shows it has something unsaved.
    expect(screen.getByRole('img', { name: 'Alterações não salvas' })).toBeInTheDocument();
    expect(tabs()[0]).not.toHaveClass('italic');
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(mock['writeFile']).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(mock['writeFile']).toHaveBeenCalledWith('s1', 'a.txt', 'changed');
    expect(screen.queryByRole('img', { name: 'Alterações não salvas' })).toBeNull();

    mock['writeFile']!.mockResolvedValueOnce({ ok: false, error: 'Disk is full' });
    fireEvent.change(editor('a.txt'), { target: { value: 'changed again' } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('alert')).toHaveTextContent('Disk is full');
  });

  it('saves on demand when auto save is off, with the button or Ctrl+S', async () => {
    const { mock } = setup();
    openMenu();
    fireEvent.click(menuItem('Salvar automaticamente'));
    await open('a.txt');
    fireEvent.change(editor('a.txt'), { target: { value: 'one' } });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(mock['writeFile']).not.toHaveBeenCalled();
    press('Salvar arquivo');
    await waitFor(() => expect(mock['writeFile']).toHaveBeenCalledWith('s1', 'a.txt', 'one'));
    expect(screen.queryByRole('button', { name: 'Salvar arquivo' })).toBeNull();

    fireEvent.change(editor('a.txt'), { target: { value: 'two' } });
    fireEvent.keyDown(editor('a.txt'), { key: 's', ctrlKey: true });
    await waitFor(() => expect(mock['writeFile']).toHaveBeenLastCalledWith('s1', 'a.txt', 'two'));
    // Nothing unsaved: saving again does nothing.
    fireEvent.keyDown(editor('a.txt'), { key: 'S', metaKey: true });
    expect(mock['writeFile']).toHaveBeenCalledTimes(2);
  });

  it('asks before closing a tab with unsaved changes when auto save is off', async () => {
    const { mock } = setup();
    openMenu();
    fireEvent.click(menuItem('Salvar automaticamente'));
    await open('a.txt', { double: true });
    fireEvent.change(editor('a.txt'), { target: { value: 'unsaved' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    press('Fechar a.txt');
    expect(confirm).toHaveBeenCalledWith('Descartar as alterações não salvas de a.txt?');
    expect(tabs()).toHaveLength(1);
    confirm.mockReturnValue(true);
    press('Fechar a.txt');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(mock['writeFile']).not.toHaveBeenCalled();
  });

  it('saves a tab with unsaved changes when it is closed with auto save on', async () => {
    const { mock } = setup();
    await open('a.txt', { double: true });
    fireEvent.change(editor('a.txt'), { target: { value: 'closing' } });
    press('Fechar a.txt');
    await waitFor(() => expect(mock['writeFile']).toHaveBeenCalledWith('s1', 'a.txt', 'closing'));
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('indents with the Tab key, outdents with Shift+Tab and leaves Tab alone when it is off', async () => {
    setup();
    await open('a.txt');
    const area = () => editor('a.txt');
    const caret = (start: number, end = start) => {
      area().setSelectionRange(start, end);
    };
    caret(2);
    fireEvent.keyDown(area(), { key: 'Tab' });
    expect(area().value).toBe('al  pha\nbeta');
    expect(area().selectionStart).toBe(4);

    caret(0, area().value.length);
    fireEvent.keyDown(area(), { key: 'Tab' });
    expect(area().value).toBe('    al  pha\n    beta');
    fireEvent.keyDown(area(), { key: 'Tab', shiftKey: true });
    expect(area().value).toBe('al  pha\nbeta');
    // Modified Tab is the browser's own.
    fireEvent.keyDown(area(), { key: 'Tab', ctrlKey: true });
    expect(area().value).toBe('al  pha\nbeta');

    openMenu();
    fireEvent.click(menuItem('A tecla Tab recua o texto'));
    caret(0);
    fireEvent.keyDown(area(), { key: 'Tab' });
    expect(area().value).toBe('al  pha\nbeta');
  });

  it('does not take Tab in a file that cannot be edited', async () => {
    setup();
    await open('big.txt');
    const area = editor('big.txt');
    fireEvent.keyDown(area, { key: 'Tab' });
    expect(area.value).toBe('start of a long file');
  });

  it('draws line numbers, indent guides and visible whitespace as asked', async () => {
    const { mock } = setup();
    mock['readFile']!.mockResolvedValue({
      ok: true,
      file: { kind: 'text', content: 'top\n    nested  \n\t\ttabs\n\nend', truncated: false },
    });
    await open('a.txt');
    const layer = () => screen.getByTestId('editor-layer');
    const lines = () => [...layer().children] as HTMLElement[];
    expect(lines().map((line) => line.dataset['line'])).toEqual(['1', '2', '3', '4', '5']);
    expect(
      layer().querySelectorAll('.shadow-\\[inset_1px_0_0_var\\(--border-strong\\)\\]'),
    ).toHaveLength(3);
    expect(layer().textContent).not.toContain('·');

    openMenu();
    fireEvent.click(menuItem('Mostrar espaços em branco'));
    expect(layer().textContent).toContain('····nested··');
    fireEvent.click(menuItem('Guias de recuo'));
    expect(
      layer().querySelectorAll('.shadow-\\[inset_1px_0_0_var\\(--border-strong\\)\\]'),
    ).toHaveLength(0);
    fireEvent.click(menuItem('Mostrar espaços em branco'));
    expect(layer().textContent).not.toContain('·');

    fireEvent.click(menuItem('Quebra de linha'));
    expect(layer()).toHaveClass('whitespace-pre-wrap');
    expect(editor('a.txt')).toHaveAttribute('wrap', 'soft');
    fireEvent.click(menuItem('Rolar além do fim'));
    expect(editor('a.txt').style.paddingBottom).toBe('50vh');
  });

  it('colours the source being edited as the preview does, and keeps the text as typed', async () => {
    setup();
    fireEvent.click(await tree().findByRole('button', { name: 'src' }));
    await open('index.ts');
    const layer = screen.getByTestId('editor-layer');
    expect(layer.querySelector('.hljs-keyword')).toHaveTextContent('export');
    expect(layer.textContent).toContain('export {};');

    // What is typed is coloured at once, a comment over several lines included.
    fireEvent.change(editor('src/index.ts'), {
      target: { value: "const a = 'x';\n/* one\ntwo */\n" },
    });
    expect(layer.querySelector('.hljs-string')).toHaveTextContent("'x'");
    const comments = [...layer.querySelectorAll('.hljs-comment')].map((item) => item.textContent);
    // Each piece of whitespace and text is its own span, all with the colour of the comment.
    expect(comments.join('')).toBe('/* onetwo */');
    // A file the highlighter does not know stays plain.
    await open('a.txt');
    expect(screen.getByTestId('editor-layer').querySelector('[class*="hljs"]')).toBeNull();
  });

  it('fills the room of the panel with the file instead of stopping at a height of its own', async () => {
    setup();
    await open('a.txt');
    const area = editor('a.txt');
    expect(area.parentElement).toHaveClass('h-full');
    expect(area.parentElement!.className).not.toContain('max-h');
    press('Ver prévia (somente leitura)');
    expect(screen.getByTestId('file-preview')).toHaveClass('h-full');
    expect(screen.getByTestId('file-preview').className).not.toContain('max-h');
  });

  it('tells the panel a file was written, whether by hand or by the auto-save', async () => {
    const onSaved = vi.fn();
    const { mock } = setup({ onSaved });
    await open('a.txt');
    fireEvent.change(editor('a.txt'), { target: { value: 'two' } });
    fireEvent.keyDown(editor('a.txt'), { key: 's', ctrlKey: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    mock['writeFile']!.mockResolvedValueOnce({ ok: false, error: 'Disk is full' });
    fireEvent.change(editor('a.txt'), { target: { value: 'three' } });
    fireEvent.keyDown(editor('a.txt'), { key: 's', ctrlKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('keeps the layer under the text scrolled with it', async () => {
    setup();
    await open('a.txt');
    const area = editor('a.txt');
    area.scrollTop = 12;
    area.scrollLeft = 7;
    fireEvent.scroll(area);
    const layer = screen.getByTestId('editor-layer');
    expect(layer.scrollTop).toBe(12);
    expect(layer.scrollLeft).toBe(7);
  });

  it('switches between the source and a read-only preview', async () => {
    setup();
    await open('README.md');
    press('Ver prévia (somente leitura)');
    expect(screen.getByTestId('file-preview')).toHaveTextContent('Shop');
    expect(screen.queryByLabelText(/Editor de/)).toBeNull();
    press('Ver código-fonte (editar)');
    expect(editor('README.md').value).toContain('# Shop');

    await open('a.txt');
    press('Ver prévia (somente leitura)');
    expect(screen.getByTestId('file-preview')).toHaveTextContent('alpha');
  });
});

describe('FilesPane menu', () => {
  it('holds every option of the editor, each remembered between visits', async () => {
    setup();
    openMenu();
    const menu = within(screen.getByRole('menu', { name: 'Opções dos arquivos' }));
    for (const name of [
      'Ir para arquivo ou busca',
      'Mostrar árvore de arquivos',
      'Abas de prévia',
      'Salvar automaticamente',
      'A tecla Tab recua o texto',
      'Quebra de linha',
      'Guias de recuo',
      'Mostrar espaços em branco',
      'Rolar além do fim',
    ])
      expect(menuItem(name)).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: /Posição da árvore de arquivos/ })).toHaveTextContent(
      'Automática',
    );
    expect(menu.getByRole('menuitem', { name: /Tamanho da tabulação/ })).toHaveTextContent('4');
    expect(menu.getByText('Ctrl+P')).toBeInTheDocument();
    expect(menu.getByText('Ctrl+Shift+Y')).toBeInTheDocument();
    const checked = (name: string) => menuItem(name).getAttribute('aria-checked');
    expect(checked('Abas de prévia')).toBe('true');
    expect(checked('Salvar automaticamente')).toBe('true');
    expect(checked('Quebra de linha')).toBe('false');

    fireEvent.click(menu.getByRole('menuitem', { name: /Tamanho da tabulação/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '8' }));
    // Choosing from a group closes the menu; an option that is turned on or off keeps it open.
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    fireEvent.click(menuItem(/Posição da árvore de arquivos/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Esquerda' }));
    openMenu();
    fireEvent.click(menuItem('Quebra de linha'));
    expect(JSON.parse(window.localStorage.getItem('adk.development.files')!)).toMatchObject({
      tabSize: 8,
      treePosition: 'left',
      wordWrap: true,
    });
  });

  it('starts from what was remembered', () => {
    window.localStorage.setItem(
      'adk.development.files',
      JSON.stringify({ treeVisible: false, treePosition: 'right', tabSize: 2 }),
    );
    setup();
    expect(screen.queryByRole('navigation', { name: 'Árvore de arquivos' })).toBeNull();
  });

  it('shows and hides the tree with its button, the menu and Ctrl+Shift+Y', async () => {
    setup();
    const region = screen.getByRole('region', { name: 'Arquivos' });
    press('Mostrar árvore de arquivos');
    expect(screen.queryByRole('navigation', { name: 'Árvore de arquivos' })).toBeNull();
    fireEvent.keyDown(region, { key: 'y', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('navigation', { name: 'Árvore de arquivos' })).toBeInTheDocument();
    openMenu();
    fireEvent.click(menuItem('Mostrar árvore de arquivos'));
    expect(screen.queryByRole('navigation', { name: 'Árvore de arquivos' })).toBeNull();
    // Other keys are not shortcuts.
    fireEvent.keyDown(region, { key: 'y', ctrlKey: true });
    fireEvent.keyDown(region, { key: 'p', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(region, { key: 'p' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('places the tree on either side, as a column inside the card of the files', async () => {
    setup();
    const column = () =>
      screen.getByRole('navigation', { name: 'Árvore de arquivos' }).parentElement!;
    const panel = screen.getByRole('region', { name: 'Arquivos' });
    expect(panel).toHaveClass('rounded-lg');
    expect(panel.contains(column())).toBe(true);
    const side = () => {
      const kids = [...column().parentElement!.children];
      return kids.indexOf(column()) === 0 ? 'left' : kids.indexOf(column()) === 2 ? 'right' : '?';
    };
    expect(side()).toBe('right');
    openMenu();
    fireEvent.click(menuItem(/Posição da árvore/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Esquerda' }));
    expect(side()).toBe('left');
    openMenu();
    fireEvent.click(menuItem(/Posição da árvore/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Direita' }));
    expect(side()).toBe('right');
  });

  it('resizes the tree by dragging its edge or with the arrow keys', () => {
    setup();
    const card = () =>
      screen.getByRole('navigation', { name: 'Árvore de arquivos' }).parentElement!;
    const handle = () =>
      screen.getByRole('separator', { name: 'Redimensionar a árvore de arquivos' });
    expect(card().style.width).toBe('260px');
    fireEvent(handle(), pointer('pointerdown', { button: 0, clientX: 500 }));
    fireEvent(window, pointer('pointermove', { clientX: 450 }));
    expect(card().style.width).toBe('310px');
    fireEvent(window, pointer('pointerup'));
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(card().style.width).toBe('320px');
    // On the left the edge is the right one and drags the other way.
    openMenu();
    fireEvent.click(menuItem(/Posição da árvore/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Esquerda' }));
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(card().style.width).toBe('310px');
  });

  it('collapses every folder, and only when one is open', async () => {
    setup();
    fireEvent.click(await tree().findByRole('button', { name: 'src' }));
    await tree().findByRole('button', { name: 'index.ts' });
    openMenu();
    expect((menuItem('Recolher todas as pastas') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(menuItem('Recolher todas as pastas'));
    expect(tree().queryByRole('button', { name: 'index.ts' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    expect((menuItem('Recolher todas as pastas') as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes with Escape or a click outside, and moves with the arrow keys', async () => {
    setup();
    openMenu();
    const menu = screen.getByRole('menu', { name: 'Opções dos arquivos' });
    menuItem('Ir para arquivo ou busca').focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuItem('Mostrar árvore de arquivos'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(menuItem('Ir para arquivo ou busca'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(menuItem('Tamanho da tabulação')).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: 'Enter' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a submenu with the mouse or the arrow keys and closes it on leaving', async () => {
    setup();
    openMenu();
    const size = menuItem(/Tamanho da tabulação/);
    fireEvent.mouseEnter(size);
    expect(screen.getByRole('menu', { name: 'Tamanho da tabulação' })).toBeInTheDocument();
    fireEvent.mouseLeave(size.parentElement!);
    expect(screen.queryByRole('menu', { name: 'Tamanho da tabulação' })).toBeNull();
    fireEvent.keyDown(size, { key: 'ArrowRight' });
    expect(screen.getByRole('menu', { name: 'Tamanho da tabulação' })).toBeInTheDocument();
    fireEvent.click(size);
    expect(screen.queryByRole('menu', { name: 'Tamanho da tabulação' })).toBeNull();
    fireEvent.keyDown(size, { key: 'a' });
  });
});

describe('FilesPane search', () => {
  it('filters the tree by name', async () => {
    setup();
    fireEvent.click(await tree().findByRole('button', { name: 'src' }));
    await tree().findByRole('button', { name: 'index.ts' });
    fireEvent.change(screen.getByLabelText('Filtrar arquivos'), { target: { value: 'INDEX' } });
    expect(
      tree()
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['src/index.ts']);
    fireEvent.change(screen.getByLabelText('Filtrar arquivos'), { target: { value: 'zzz' } });
    expect(tree().getByText('Nenhum arquivo.')).toBeInTheDocument();
  });

  it('searches the contents of the files when the filter starts with a question mark', async () => {
    const { mock } = setup();
    mock['searchFiles']!.mockResolvedValue({
      ok: true,
      matches: [{ path: 'a.txt', line: 2, text: 'beta' }],
    });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Filtrar arquivos'), { target: { value: '?beta' } });
    expect(tree().getByText('Buscando…')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(mock['searchFiles']).toHaveBeenCalledWith('s1', 'beta');
    expect(tree().getByText('a.txt:2')).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(tree().getByRole('button', { name: /a\.txt:2/ }));
    await waitFor(() => expect(editor('a.txt')).toBeInTheDocument());

    vi.useFakeTimers();
    mock['searchFiles']!.mockResolvedValue({ ok: true, matches: [] });
    fireEvent.change(screen.getByLabelText('Filtrar arquivos'), { target: { value: '?nothing' } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(tree().getByText('Nenhum resultado.')).toBeInTheDocument();
    mock['searchFiles']!.mockResolvedValue({ ok: false, error: 'Search failed' });
    fireEvent.change(screen.getByLabelText('Filtrar arquivos'), { target: { value: '?again' } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByRole('alert')).toHaveTextContent('Search failed');
    // A bare "?" searches for nothing and shows the tree again.
    fireEvent.change(screen.getByLabelText('Filtrar arquivos'), { target: { value: '?' } });
    expect(tree().queryByText('Nenhum resultado.')).toBeNull();
  });

  it('goes to a file by name from the menu or Ctrl+P', async () => {
    const { mock } = setup();
    mock['fileIndex']!.mockResolvedValue({
      ok: true,
      files: ['README.md', 'a.txt', 'docs/guide.md', 'src/index.ts'],
    });
    openMenu();
    fireEvent.click(menuItem('Ir para arquivo ou busca'));
    expect(screen.queryByRole('menu')).toBeNull();
    const dialog = within(await screen.findByRole('dialog', { name: 'Ir para arquivo ou busca' }));
    await waitFor(() => expect(dialog.getByText('docs/guide.md')).toBeInTheDocument());
    fireEvent.change(dialog.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      target: { value: 'GUIDE' },
    });
    expect(dialog.getAllByRole('button').map((item) => item.textContent)).toEqual([
      'docs/guide.md',
    ]);
    fireEvent.change(dialog.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      target: { value: 'nothing' },
    });
    expect(dialog.getByText('Nenhum resultado.')).toBeInTheDocument();
    fireEvent.keyDown(dialog.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      key: 'Enter',
    });
    fireEvent.change(dialog.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      target: { value: 'index' },
    });
    fireEvent.keyDown(dialog.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      key: 'Enter',
    });
    await waitFor(() => expect(editor('src/index.ts')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(screen.getByRole('region', { name: 'Arquivos' }), {
      key: 'p',
      ctrlKey: true,
    });
    const again = within(await screen.findByRole('dialog'));
    fireEvent.keyDown(again.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Other keys inside the box do nothing special.
    fireEvent.keyDown(screen.getByRole('region', { name: 'Arquivos' }), {
      key: 'p',
      metaKey: true,
    });
    fireEvent.keyDown(
      await screen.findByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'),
      { key: 'a' },
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('searches contents from the quick open box too, and says when the index fails', async () => {
    const { mock } = setup();
    mock['fileIndex']!.mockResolvedValue({ ok: false, error: 'Index failed' });
    openMenu();
    fireEvent.click(menuItem('Ir para arquivo ou busca'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Index failed');
    mock['searchFiles']!.mockResolvedValue({
      ok: true,
      matches: [{ path: 'b.txt', line: 1, text: 'bravo' }],
    });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      target: { value: '?bravo' },
    });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Buscando…')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(dialog.getByText(/:1 bravo/)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(dialog.getByRole('button', { name: /b\.txt/ }));
    await waitFor(() => expect(editor('b.txt')).toBeInTheDocument());
  });
});

describe('FilesPane without the desktop app', () => {
  const diff: DiffFile[] = [
    {
      path: 'src/lib/util.ts',
      status: 'added',
      additions: 1,
      deletions: 0,
      patch: '@@ -0,0 +1 @@\n+export const a = 1;',
    },
    { path: 'README.md', status: 'modified', additions: 1, deletions: 1, patch: '-old\n+# Shop' },
  ];

  it('shows the changed files and their patch, read only', async () => {
    render(<FilesPane sessionId="s1" diff={diff} refreshKey="v1" openRequest={null} />);
    fireEvent.click(tree().getByRole('button', { name: 'src' }));
    fireEvent.click(tree().getByRole('button', { name: 'lib' }));
    fireEvent.click(tree().getByRole('button', { name: 'util.ts' }));
    expect(editor('src/lib/util.ts').value).toContain('+export const a = 1;');
    expect(editor('src/lib/util.ts').readOnly).toBe(true);
    expect(screen.getByText(/só os arquivos alterados aparecem aqui/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar arquivo' })).toBeNull();

    fireEvent.change(editor('src/lib/util.ts'), { target: { value: 'typed' } });
    fireEvent.keyDown(editor('src/lib/util.ts'), { key: 'Tab' });
  });

  it('goes to a changed file by name and searches the patches', async () => {
    render(<FilesPane sessionId="s1" diff={diff} refreshKey="v1" openRequest={null} />);
    fireEvent.keyDown(screen.getByRole('region', { name: 'Arquivos' }), {
      key: 'p',
      ctrlKey: true,
    });
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getAllByRole('button').map((item) => item.textContent)).toEqual([
      'src/lib/util.ts',
      'README.md',
    ]);
    fireEvent.keyDown(dialog.getByLabelText('Buscar arquivo, ou ? para buscar no conteúdo'), {
      key: 'Escape',
    });

    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Filtrar arquivos'), { target: { value: '?SHOP' } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(tree().getByText('README.md:2')).toBeInTheDocument();
    expect(tree().getByText('+# Shop')).toBeInTheDocument();
  });

  it('reads the tree from the diff again when it changes', () => {
    const view = render(
      <FilesPane sessionId="s1" diff={diff} refreshKey="v1" openRequest={null} />,
    );
    expect(tree().getByRole('button', { name: 'README.md' })).toBeInTheDocument();
    view.rerender(
      <FilesPane sessionId="s1" diff={[diff[1]!]} refreshKey="v2" openRequest={null} />,
    );
    expect(tree().queryByRole('button', { name: 'src' })).toBeNull();
  });

  it('keeps the defaults when the browser blocks its storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<FilesPane sessionId="s1" diff={diff} refreshKey="v1" openRequest={null} />);
    openMenu();
    fireEvent.click(menuItem('Quebra de linha'));
    expect(menuItem('Quebra de linha')).toHaveAttribute('aria-checked', 'true');
  });
});
