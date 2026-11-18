import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor } from '../src/features/shared/markdown-editor/MarkdownEditor.js';
import { MediaProvider } from '../src/features/shared/media.js';
import { ApiClient } from '../src/lib/api-client.js';

const execCommand = vi.fn((..._args: unknown[]) => true);

type Props = Partial<ComponentProps<typeof MarkdownEditor>>;

function Harness({
  initial = '',
  onValue,
  ...props
}: Props & { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor
      scope="brain"
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

function setup(initial = '', props: Props = {}, media = false) {
  const onValue = vi.fn();
  const ui = <Harness initial={initial} onValue={onValue} {...props} />;
  const view = render(
    media ? (
      <MediaProvider apiClient={new ApiClient({ baseUrl: 'http://api.test' })}>{ui}</MediaProvider>
    ) : (
      ui
    ),
  );
  return { ...view, onValue };
}

const surface = () => screen.getByTestId('markdown-editor-formatted');
const area = () => screen.getByTestId('markdown-editor-code') as HTMLTextAreaElement;
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const toCode = () => click('editor-mode-code');
const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' });

function select(node: Node, start = 0, end = node.textContent?.length ?? 0) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Puts the caret in the first text of the element matching `selector`. */
function selectIn(selector: string, start?: number, end?: number) {
  const text = surface().querySelector(selector)!.firstChild!;
  select(text, start, end);
  return text;
}

beforeEach(() => {
  execCommand.mockClear();
  execCommand.mockReturnValue(true);
  Object.defineProperty(document, 'execCommand', {
    value: execCommand,
    configurable: true,
    writable: true,
  });
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom collapses the selection when a contenteditable gets focus; browsers keep it.
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>)['execCommand'];
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe('MarkdownEditor modes', () => {
  it('opens formatted and switches to the Markdown code and back', () => {
    const { onValue } = setup('# Title\n\nSome **bold** text');
    expect(surface().querySelector('h1')!.textContent).toBe('Title');
    expect(surface().querySelector('strong')!.textContent).toBe('bold');
    expect(screen.getByTestId('editor-mode-formatted').getAttribute('aria-pressed')).toBe('true');

    toCode();
    expect(area().value).toBe('# Title\n\nSome **bold** text');
    expect(screen.queryByTestId('markdown-editor-formatted')).toBeNull();
    fireEvent.change(area(), { target: { value: '## New' } });
    expect(onValue).toHaveBeenLastCalledWith('## New');

    click('editor-mode-formatted');
    expect(surface().querySelector('h2')!.textContent).toBe('New');
  });

  it('keeps the tabs at the end of the toolbar, apart from the tools', () => {
    setup();
    const toolbar = screen.getByRole('toolbar');
    const tabs = screen.getByRole('group', { name: 'Modo de edição' });
    expect(toolbar.className).toContain('justify-between');
    expect(toolbar.lastElementChild).toBe(tabs);
    expect(tabs.textContent).toContain('Formatado');
    expect(tabs.textContent).toContain('Código .md');
  });

  it('fills the width it is given and accepts its own class and test ids', () => {
    setup('', { className: 'extra', testId: 'my-editor', codeTestId: 'my-code' });
    const root = screen.getByTestId('my-editor');
    expect(root.className).toContain('w-full');
    expect(root.className).toContain('extra');
    expect(screen.getByTestId('my-editor-formatted')).toBeTruthy();
    toCode();
    expect(screen.getByTestId('my-code')).toBeTruthy();
  });

  it('writes Markdown while typing in the formatted view without rebuilding it', () => {
    const { onValue } = setup('Hello');
    const paragraph = surface().querySelector('p')!;
    paragraph.innerHTML = 'Hello <b>there</b>';
    fireEvent.input(surface());
    expect(onValue).toHaveBeenLastCalledWith('Hello **there**');
    expect(surface().querySelector('p')).toBe(paragraph);
  });

  it('rebuilds the formatted view when the text changes from outside', () => {
    function Outside() {
      const [value, setValue] = useState('first');
      return (
        <>
          <button onClick={() => setValue('# second')}>set</button>
          <MarkdownEditor scope="brain" value={value} onChange={setValue} />
        </>
      );
    }
    render(<Outside />);
    expect(surface().textContent).toBe('first');
    fireEvent.click(screen.getByText('set'));
    expect(surface().querySelector('h1')!.textContent).toBe('second');
  });

  it('gives the Markdown textarea to the caller and reports typing, keys and the overlay', () => {
    const codeRef = createRef<HTMLTextAreaElement>();
    const onCodeInput = vi.fn();
    const onCodeKeyDown = vi.fn();
    setup('abc', {
      codeRef,
      onCodeInput,
      onCodeKeyDown,
      codeOverlay: <div data-testid="overlay" />,
      placeholder: 'Write here',
    });
    expect(screen.queryByTestId('overlay')).toBeNull();
    toCode();
    expect(codeRef.current).toBe(area());
    expect(screen.getByTestId('overlay')).toBeTruthy();
    expect(area().placeholder).toBe('Write here');
    fireEvent.change(area(), { target: { value: 'abcd' } });
    expect(onCodeInput).toHaveBeenCalledWith('abcd', expect.any(Number));
    fireEvent.keyDown(area(), { key: 'a' });
    expect(onCodeKeyDown).toHaveBeenCalled();
  });

  it('works without the optional callbacks', () => {
    setup('abc');
    toCode();
    fireEvent.change(area(), { target: { value: 'abcd' } });
    fireEvent.keyDown(area(), { key: 'a' });
    expect(area().value).toBe('abcd');
  });
});

describe('MarkdownEditor menus', () => {
  it('keeps the selection of the document when the toolbar and its menus are pressed', () => {
    setup('text');
    const pressed = (element: Element) => fireEvent.mouseDown(element) === false;
    expect(pressed(screen.getByTestId('editor-bold'))).toBe(true);
    click('editor-style');
    expect(pressed(screen.getByTestId('editor-heading-1'))).toBe(true);
    click('editor-color');
    expect(pressed(screen.getByTestId('editor-color-ef4444'))).toBe(true);
    expect(pressed(screen.getByTestId('editor-color-default'))).toBe(true);
  });

  it('opens one menu at a time and closes it on a second click, outside clicks and mode change', () => {
    setup('text');
    click('editor-style');
    expect(screen.getByRole('menu', { name: 'Estilo do texto' })).toBeTruthy();
    expect(screen.getByTestId('editor-style').getAttribute('aria-expanded')).toBe('true');
    click('editor-color');
    expect(screen.queryByRole('menu', { name: 'Estilo do texto' })).toBeNull();
    expect(screen.getByRole('menu', { name: 'Cor do texto' })).toBeTruthy();
    click('editor-color');
    expect(screen.queryByRole('menu')).toBeNull();

    click('editor-style');
    fireEvent.mouseDown(screen.getByTestId('markdown-editor-formatted'));
    expect(screen.queryByRole('menu')).toBeNull();

    click('editor-style');
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeTruthy();
    toCode();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('MarkdownEditor formatted commands', () => {
  it('formats text with the browser commands', () => {
    setup('hello');
    selectIn('p');
    for (const [id, command] of [
      ['editor-bold', 'bold'],
      ['editor-italic', 'italic'],
      ['editor-strike', 'strikeThrough'],
      ['editor-ul', 'insertUnorderedList'],
      ['editor-ol', 'insertOrderedList'],
      ['editor-undo', 'undo'],
      ['editor-redo', 'redo'],
    ] as const) {
      click(id);
      expect(execCommand).toHaveBeenLastCalledWith(command, false, undefined);
    }
  });

  it('sets the text style from the menu', () => {
    setup('hello');
    click('editor-style');
    click('editor-heading-2');
    expect(execCommand).toHaveBeenLastCalledWith('formatBlock', false, 'h2');
    click('editor-style');
    click('editor-heading-0');
    expect(execCommand).toHaveBeenLastCalledWith('formatBlock', false, 'p');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('inserts task lists and tables', () => {
    setup('hello');
    click('editor-task');
    expect(execCommand).toHaveBeenLastCalledWith(
      'insertHTML',
      false,
      expect.stringContaining('type="checkbox"'),
    );
    click('editor-table');
    expect(execCommand).toHaveBeenLastCalledWith(
      'insertHTML',
      false,
      expect.stringContaining('<table>'),
    );
  });

  it('toggles quotes and code blocks', () => {
    setup('> quoted\n\n```\ncode\n```\n\nplain');
    selectIn('blockquote p');
    click('editor-quote');
    expect(execCommand).toHaveBeenLastCalledWith('outdent', false, undefined);
    selectIn('pre code');
    click('editor-code-block');
    expect(execCommand).toHaveBeenLastCalledWith('formatBlock', false, 'p');
    selectIn('pre code');
    surface().querySelector('pre')!.replaceWith(document.createElement('p'));
    selectIn('blockquote p');
    surface().querySelector('blockquote')!.replaceWith(document.createElement('p'));
    const plain = surface().lastElementChild!;
    select(plain.firstChild!, 0, 0);
    click('editor-quote');
    expect(execCommand).toHaveBeenLastCalledWith('formatBlock', false, 'blockquote');
    click('editor-code-block');
    expect(execCommand).toHaveBeenLastCalledWith('formatBlock', false, 'pre');
  });

  it('wraps inline code, highlights and colours around the selection', () => {
    setup('say <b>hi</b> there');
    selectIn('p', 0, 3);
    click('editor-inline-code');
    expect(execCommand).toHaveBeenLastCalledWith('insertHTML', false, '<code>say</code>');
    click('editor-highlight');
    expect(execCommand).toHaveBeenLastCalledWith('insertHTML', false, '<mark>say</mark>');
    click('editor-color');
    click('editor-color-ef4444');
    expect(execCommand).toHaveBeenLastCalledWith(
      'insertHTML',
      false,
      '<span style="color: #ef4444">say</span>',
    );
  });

  it('keeps inline markup when highlighting and uses placeholders without a selection', () => {
    setup('a **bold**');
    const paragraph = surface().querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    click('editor-highlight');
    expect(execCommand).toHaveBeenLastCalledWith(
      'insertHTML',
      false,
      '<mark>a <strong>bold</strong></mark>',
    );
    window.getSelection()!.removeAllRanges();
    click('editor-inline-code');
    expect(execCommand).toHaveBeenLastCalledWith('insertHTML', false, '<code>código</code>');
    click('editor-highlight');
    expect(execCommand).toHaveBeenLastCalledWith('insertHTML', false, '<mark>Destaque</mark>');
  });

  it('removes inline code, highlights and colours that are already there', () => {
    setup('`code` and <mark>marked</mark> and <span style="color: #ef4444">red</span>');
    selectIn('code');
    click('editor-inline-code');
    expect(surface().querySelector('code')).toBeNull();
    selectIn('mark');
    click('editor-highlight');
    expect(surface().querySelector('mark')).toBeNull();
    selectIn('span[style]');
    click('editor-color');
    click('editor-color-default');
    expect(surface().querySelector('span[style]')).toBeNull();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('clears the colour without a coloured word under the caret', () => {
    setup('plain');
    click('editor-color');
    click('editor-color-default');
    expect(surface().textContent).toBe('plain');
  });

  it('writes the result back as Markdown', () => {
    const { onValue } = setup('hello');
    execCommand.mockImplementation(() => {
      surface().querySelector('p')!.innerHTML = '<b>hello</b>';
      return true;
    });
    selectIn('p');
    click('editor-bold');
    expect(onValue).toHaveBeenLastCalledWith('**hello**');
  });

  it('adds links to the selection or inserts the address', () => {
    setup('go here now');
    selectIn('p', 3, 7);
    click('editor-link');
    const field = screen.getByTestId('editor-link-url');
    expect((screen.getByTestId('editor-link-apply') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: 'a' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(execCommand).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: ' https://x.dev ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(execCommand).toHaveBeenLastCalledWith('createLink', false, 'https://x.dev');
    expect(screen.queryByTestId('editor-link-url')).toBeNull();

    select(surface().querySelector('p')!.firstChild!, 2, 2);
    click('editor-link');
    fireEvent.change(screen.getByTestId('editor-link-url'), {
      target: { value: 'https://y.dev?a=1&b=2' },
    });
    click('editor-link-apply');
    expect(execCommand).toHaveBeenLastCalledWith(
      'insertHTML',
      false,
      '<a href="https://y.dev?a=1&amp;b=2">https://y.dev?a=1&amp;b=2</a>',
    );
  });

  it('inserts a link when the selection was lost before the address was typed', () => {
    setup('text');
    window.getSelection()!.removeAllRanges();
    click('editor-link');
    fireEvent.change(screen.getByTestId('editor-link-url'), { target: { value: '/doc' } });
    click('editor-link-apply');
    expect(execCommand).toHaveBeenLastCalledWith(
      'insertHTML',
      false,
      expect.stringContaining('/doc'),
    );
  });
});

describe('MarkdownEditor Markdown commands', () => {
  function code(value: string, start = 0, end = value.length) {
    const result = setup(value);
    toCode();
    area().setSelectionRange(start, end);
    return result;
  }

  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  it('edits the text directly when the browser has no editing commands', async () => {
    delete (document as unknown as Record<string, unknown>)['execCommand'];
    const { onValue } = code('hello world', 0, 5);
    click('editor-bold');
    expect(area().value).toBe('**hello** world');
    expect(onValue).toHaveBeenLastCalledWith('**hello** world');
    await frame();
    expect(area().selectionStart).toBe(2);
    click('editor-bold');
    expect(area().value).toBe('hello world');
  });

  it('applies edits as typed text so the undo history is kept', () => {
    code('hello world', 0, 5);
    click('editor-italic');
    expect(execCommand).toHaveBeenLastCalledWith('insertText', false, '*hello*');
    expect(area().selectionStart).toBe(0);
  });

  it('falls back to plain text when the command is refused', () => {
    execCommand.mockReturnValue(false);
    code('hello', 0, 5);
    click('editor-strike');
    expect(area().value).toBe('~~hello~~');
  });

  it('removes a marker with an empty replacement', () => {
    code('- ', 0, 0);
    click('editor-ul');
    expect(area().value).toBe('');
  });

  it('inserts formatting for every toolbar button', () => {
    delete (document as unknown as Record<string, unknown>)['execCommand'];
    const checks: [string, string, RegExp | string][] = [
      ['editor-ol', 'a', '1. a'],
      ['editor-task', 'a', '- [ ] a'],
      ['editor-quote', 'a', '> a'],
      ['editor-inline-code', 'a', '`a`'],
      ['editor-highlight', 'a', '<mark>a</mark>'],
      ['editor-code-block', 'a', /^```\na\n```/],
      ['editor-table', '', /\| Column 1 \|/],
    ];
    for (const [id, text, expected] of checks) {
      const view = code(text);
      click(id);
      if (typeof expected === 'string') expect(area().value).toBe(expected);
      else expect(area().value).toMatch(expected);
      view.unmount();
    }
  });

  it('uses placeholders when nothing is selected', () => {
    delete (document as unknown as Record<string, unknown>)['execCommand'];
    code('', 0, 0);
    click('editor-bold');
    expect(area().value).toBe('**Negrito**');
  });

  it('sets headings from the menu', () => {
    delete (document as unknown as Record<string, unknown>)['execCommand'];
    code('title', 0, 0);
    click('editor-style');
    click('editor-heading-3');
    expect(area().value).toBe('### title');
    click('editor-style');
    click('editor-heading-0');
    expect(area().value).toBe('title');
  });

  it('colours text and hides the clear option', () => {
    delete (document as unknown as Record<string, unknown>)['execCommand'];
    code('word', 0, 4);
    click('editor-color');
    expect(screen.queryByTestId('editor-color-default')).toBeNull();
    click('editor-color-22c55e');
    expect(area().value).toBe('<span style="color: #22c55e">word</span>');
  });

  it('adds links', () => {
    delete (document as unknown as Record<string, unknown>)['execCommand'];
    code('docs', 0, 4);
    click('editor-link');
    fireEvent.change(screen.getByTestId('editor-link-url'), { target: { value: 'https://x.dev' } });
    click('editor-link-apply');
    expect(area().value).toBe('[docs](https://x.dev)');
  });

  it('undoes and redoes in the textarea', () => {
    code('text');
    click('editor-undo');
    expect(execCommand).toHaveBeenLastCalledWith('undo', false, undefined);
    click('editor-redo');
    expect(execCommand).toHaveBeenLastCalledWith('redo', false, undefined);
  });
});

describe('MarkdownEditor outline', () => {
  it('lists the headings and jumps to them in the formatted view', () => {
    setup('# One\n\ntext\n\n## Two');
    click('editor-outline');
    expect(screen.getByTestId('editor-outline').getAttribute('aria-pressed')).toBe('true');
    const panel = screen.getByTestId('editor-outline-panel');
    expect(panel.textContent).toContain('One');
    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    click('editor-outline');
    expect(screen.queryByTestId('editor-outline-panel')).toBeNull();
  });

  it('ignores a heading that is no longer in the document', () => {
    setup('# One');
    click('editor-outline');
    surface().querySelector('h1')!.remove();
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('jumps to the heading in the Markdown code', () => {
    const value = '# One\n\ntext\n\n## Two';
    setup(value);
    click('editor-outline');
    toCode();
    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    expect(area().selectionStart).toBe(value.indexOf('## Two'));
    expect(area().scrollTop).toBeGreaterThan(0);
  });

  it('says when there are no headings', () => {
    setup('just text');
    click('editor-outline');
    expect(screen.getByTestId('editor-outline-panel').textContent).toContain('Adicione títulos');
  });
});

describe('MarkdownEditor tables, lists and pasting', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';

  it('moves between cells with Tab and adds a row after the last one', () => {
    const { onValue } = setup(table);
    const cells = () => [...surface().querySelectorAll('th,td')];
    selectIn('th');
    fireEvent.keyDown(surface(), { key: 'Tab' });
    expect(window.getSelection()!.anchorNode).toBe(cells()[1]);
    fireEvent.keyDown(surface(), { key: 'Tab', shiftKey: true });
    expect(window.getSelection()!.anchorNode).toBe(cells()[0]);
    fireEvent.keyDown(surface(), { key: 'Tab', shiftKey: true });
    expect(window.getSelection()!.anchorNode).toBe(cells()[0]);

    select(cells().at(-1)!.firstChild!);
    fireEvent.keyDown(surface(), { key: 'Tab' });
    expect(cells()).toHaveLength(6);
    expect(window.getSelection()!.anchorNode).toBe(cells()[4]);
    expect(onValue).toHaveBeenLastCalledWith(expect.stringContaining('|  |  |'));
  });

  it('leaves Tab alone outside tables and ignores other keys', () => {
    setup(`text\n\n${table}`);
    selectIn('p');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    surface().dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    selectIn('th');
    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    surface().dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('writes the checkbox state when it is toggled', () => {
    const { onValue } = setup('- [ ] todo');
    const box = surface().querySelector('input')!;
    fireEvent.click(box);
    expect(onValue).toHaveBeenLastCalledWith('- [x] todo');
    const before = onValue.mock.calls.length;
    fireEvent.click(surface().querySelector('li')!);
    expect(onValue.mock.calls.length).toBe(before);
  });

  const paste = (text: string, files: File[] = []) =>
    fireEvent.paste(surface(), { clipboardData: { files, getData: () => text } });

  it('pastes text as plain text or as Markdown', () => {
    const { onValue } = setup('');
    paste('one line');
    expect(execCommand).toHaveBeenLastCalledWith('insertText', false, 'one line');
    paste('# Title\n\n- a');
    expect(execCommand).toHaveBeenLastCalledWith(
      'insertHTML',
      false,
      expect.stringContaining('<h1>Title</h1>'),
    );
    expect(onValue).toHaveBeenCalled();
    execCommand.mockClear();
    paste('');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('keeps pasted images as drafts', () => {
    const { onValue } = setup('', {}, true);
    paste('', [png('shot.png')]);
    expect(execCommand).not.toHaveBeenCalled();
    expect(onValue).toHaveBeenLastCalledWith(
      expect.stringMatching(/!\[shot\.png\]\(\/attachments\/drafts\//),
    );
  });
});

describe('MarkdownEditor images', () => {
  it('inserts images chosen with the picker in both modes', () => {
    const { onValue } = setup('text', {}, true);
    const picker = () => screen.getByTestId('input-document-image') as HTMLInputElement;
    fireEvent.change(picker(), { target: { files: [png('one.png')] } });
    expect(onValue).toHaveBeenLastCalledWith(expect.stringContaining('![one.png]('));
    toCode();
    fireEvent.change(picker(), { target: { files: [png('two.png')] } });
    expect(area().value).toContain('![two.png](');
  });

  it('accepts dropped images in both modes', () => {
    setup('', {}, true);
    fireEvent.drop(surface(), { dataTransfer: { files: [png('d1.png')] } });
    expect(surface().querySelector('img')).toBeTruthy();
    toCode();
    fireEvent.paste(area(), { clipboardData: { files: [png('p.png')] } });
    fireEvent.drop(area(), { dataTransfer: { files: [png('d2.png')] } });
    expect(area().value).toContain('![d1.png](');
    expect(area().value).toContain('![d2.png](');
  });

  it('offers no way to add images when they are turned off', () => {
    setup('', { images: false }, true);
    expect(screen.queryByTestId('input-document-image')).toBeNull();
    expect(screen.queryByText('Inserir imagem')).toBeNull();
    toCode();
    expect(screen.queryByTestId('input-document-image')).toBeNull();
    // Everything else about the editor stays.
    expect(screen.getByTestId('editor-mode-formatted')).toBeInTheDocument();
  });

  it('ignores pasted and dropped files when images are turned off, in both modes', () => {
    const { onValue } = setup('', { images: false }, true);
    const picture = { files: [png('p.png')], getData: () => '' };
    // The browser would insert a picture or open a file by itself: both are cancelled.
    expect(fireEvent.paste(surface(), { clipboardData: picture })).toBe(false);
    expect(fireEvent.drop(surface(), { dataTransfer: { files: [png('d.png')] } })).toBe(false);
    expect(surface().querySelector('img')).toBeNull();
    // Dragging text, or pasting nothing at all, is left to the browser.
    expect(fireEvent.drop(surface(), { dataTransfer: { files: [] } })).toBe(true);
    expect(fireEvent.paste(surface(), { clipboardData: { files: [], getData: () => '' } })).toBe(
      true,
    );
    // Text pasted along with a picture still goes in; the picture does not.
    fireEvent.paste(surface(), {
      clipboardData: { files: [png('p.png')], getData: () => 'only the text' },
    });
    expect(execCommand).toHaveBeenLastCalledWith('insertText', false, 'only the text');
    expect(onValue).not.toHaveBeenCalledWith(expect.stringContaining('!['));

    toCode();
    expect(fireEvent.drop(area(), { dataTransfer: { files: [png('d.png')] } })).toBe(false);
    expect(fireEvent.drop(area(), { dataTransfer: { files: [] } })).toBe(true);
    fireEvent.paste(area(), { clipboardData: { files: [png('p.png')] } });
    expect(area().value).not.toContain('![');
  });

  it('shows why an image could not be kept', async () => {
    setup('', {}, true);
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('input-document-image'), { target: { files: [big] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('10 MB'));
    toCode();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
