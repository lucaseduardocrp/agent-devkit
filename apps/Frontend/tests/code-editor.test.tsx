import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import type { ApiMockValue } from '../src/features/apitests/api-test-types.js';
import type { ApiClient } from '../src/lib/api-client.js';
import {
  CodeEditor,
  type CodeEditorHandle,
} from '../src/features/apitests/integration/CodeEditor.js';
import { CodeEditorToolbar } from '../src/features/apitests/integration/CodeEditorToolbar.js';
import type { CodeLanguage } from '../src/features/apitests/integration/code-syntax.js';
import {
  insideJsonString,
  MOCK_TEMPLATES,
  mockSnippet,
} from '../src/features/apitests/integration/mock-templates.js';
import {
  VariablesContext,
  variableSuggestions,
} from '../src/features/apitests/variables-context.js';

const MOCKS: ApiMockValue[] = [
  { name: '$guid', group: 'ids', sample: '3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab' },
  { name: '$randomFullName', group: 'person', sample: 'Ana Souza' },
  { name: '$randomEmail', group: 'contact', sample: 'ana.souza12@example.com' },
  { name: '$randomAge', group: 'numbers', sample: '34' },
  { name: '$randomCPF', group: 'documents', sample: '529.982.247-25' },
];

function Harness({
  initial = '',
  language = 'json',
  readOnly = false,
  mocks = MOCKS,
  mocksFailed = false,
  onRetry = () => undefined,
}: {
  initial?: string;
  language?: CodeLanguage;
  readOnly?: boolean;
  mocks?: ApiMockValue[] | null;
  mocksFailed?: boolean;
  onRetry?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const editor = useRef<CodeEditorHandle>(null);
  const suggestions = variableSuggestions(
    { variables: [{ key: 'baseUrl', value: 'https://api.test' }], items: [] },
    null,
    mocks,
  );
  return (
    <VariablesContext.Provider value={suggestions}>
      <CodeEditorToolbar
        editor={editor}
        language={language}
        readOnly={readOnly}
        mocks={mocks}
        mocksFailed={mocksFailed}
        onRetryMocks={onRetry}
      />
      <CodeEditor
        ref={editor}
        label="Body"
        value={value}
        language={language}
        readOnly={readOnly}
        mocks={mocks}
        onChange={setValue}
      />
    </VariablesContext.Provider>
  );
}

const editor = () => screen.getByLabelText<HTMLTextAreaElement>('Body');
const state = () => ({
  value: editor().value,
  start: editor().selectionStart,
  end: editor().selectionEnd,
});
function put(text: string, start: number, end = start) {
  fireEvent.change(editor(), { target: { value: text } });
  editor().setSelectionRange(start, end);
}
/** True when the page did not cancel the key, so the browser would handle it. */
const press = (init: KeyboardEventInit & { key: string }) => fireEvent.keyDown(editor(), init);

/**
 * What a browser does for `execCommand('insertText' | 'delete')` on a textarea: replace the
 * selection and fire an input event, so the edit also lands on the undo stack.
 */
function fakeExecCommand() {
  return vi.fn((command: string, _ui?: boolean, text?: string) => {
    const element = document.activeElement as HTMLTextAreaElement;
    if (command === 'insertText') {
      element.setRangeText(text ?? '', element.selectionStart, element.selectionEnd, 'end');
    } else if (command === 'delete') {
      element.setRangeText('', element.selectionStart, element.selectionEnd, 'end');
    } else {
      return false;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
}

const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
function useExecCommand(implementation: ReturnType<typeof fakeExecCommand> | undefined) {
  Object.defineProperty(document, 'execCommand', { value: implementation, configurable: true });
}
afterEach(() => {
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
});

// Both ways an edit can reach the textarea give the same text and selection.
describe.each([
  ['through the browser (execCommand)', true],
  ['directly, where the browser has no execCommand', false],
])('editor commands, %s', (_name, withBrowser) => {
  let exec: ReturnType<typeof fakeExecCommand> | undefined;
  beforeEach(() => {
    exec = withBrowser ? fakeExecCommand() : undefined;
    useExecCommand(exec);
  });

  it('indents with Tab and takes it off with Shift+Tab', () => {
    render(<Harness />);
    put('a\nb', 0, 3);
    expect(press({ key: 'Tab' })).toBe(false);
    expect(state()).toEqual({ value: '  a\n  b', start: 0, end: 7 });
    press({ key: 'Tab', shiftKey: true });
    expect(state()).toEqual({ value: 'a\nb', start: 0, end: 3 });
    put('x', 1);
    expect(press({ key: 'Tab' })).toBe(false);
    expect(state()).toEqual({ value: 'x  ', start: 3, end: 3 });
    // Nothing to take off: the key is still kept in the field and the text is untouched.
    put('x', 1);
    expect(press({ key: 'Tab', shiftKey: true })).toBe(false);
    expect(state().value).toBe('x');
    if (exec) expect(exec).toHaveBeenCalled();
  });

  it('keeps the indentation on Enter and opens a block between braces', () => {
    render(<Harness />);
    put('  abc', 5);
    expect(press({ key: 'Enter' })).toBe(false);
    expect(state()).toEqual({ value: '  abc\n  ', start: 8, end: 8 });
    put('{}', 1);
    press({ key: 'Enter' });
    expect(state()).toEqual({ value: '{\n  \n}', start: 4, end: 4 });
  });

  it('copies the line down and up, duplicates, moves and deletes lines', () => {
    render(<Harness />);
    put('one\ntwo\nthree', 5);
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(state()).toEqual({ value: 'one\ntwo\ntwo\nthree', start: 9, end: 9 });

    put('one\ntwo\nthree', 5);
    press({ key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(state()).toEqual({ value: 'one\ntwo\ntwo\nthree', start: 5, end: 5 });

    put('one\ntwo\nthree', 5);
    expect(press({ key: 'd', code: 'KeyD', ctrlKey: true })).toBe(false);
    expect(state().value).toBe('one\ntwo\ntwo\nthree');

    put('one\ntwo\nthree', 5);
    press({ key: 'ArrowUp', altKey: true });
    expect(state()).toEqual({ value: 'two\none\nthree', start: 1, end: 1 });
    press({ key: 'ArrowDown', altKey: true });
    expect(state().value).toBe('one\ntwo\nthree');

    put('one\ntwo\nthree', 5);
    press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
    expect(state()).toEqual({ value: 'one\nthree', start: 4, end: 4 });
  });

  it('does not move the first line up or the last line down', () => {
    render(<Harness />);
    put('one\ntwo', 1);
    press({ key: 'ArrowUp', altKey: true });
    expect(state().value).toBe('one\ntwo');
    put('one\ntwo', 5);
    press({ key: 'ArrowDown', altKey: true });
    expect(state().value).toBe('one\ntwo');
  });

  it('cuts and copies the line when nothing is selected', () => {
    render(<Harness />);
    put('one\ntwo\nthree', 5);
    const setData = vi.fn();
    fireEvent.copy(editor(), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', 'two\n');
    expect(state().value).toBe('one\ntwo\nthree');

    fireEvent.cut(editor(), { clipboardData: { setData } });
    expect(setData).toHaveBeenLastCalledWith('text/plain', 'two\n');
    expect(state()).toEqual({ value: 'one\nthree', start: 4, end: 4 });
  });

  it('leaves copy and cut alone when there is a selection', () => {
    render(<Harness />);
    put('one\ntwo', 0, 3);
    const setData = vi.fn();
    fireEvent.copy(editor(), { clipboardData: { setData } });
    fireEvent.cut(editor(), { clipboardData: { setData } });
    expect(setData).not.toHaveBeenCalled();
  });

  it('formats JSON, also with variables, and says when it cannot', () => {
    render(<Harness />);
    put('{"a":1,"b":"{{$guid}}","c":{{age}}}', 3);
    fireEvent.click(screen.getByTestId('format-body'));
    expect(state().value).toBe('{\n  "a": 1,\n  "b": "{{$guid}}",\n  "c": {{age}}\n}');
    expect(screen.queryByRole('status')).toBeNull();

    put('{"a": [1, 2}', 2);
    fireEvent.click(screen.getByTestId('format-body'));
    expect(screen.getByRole('status').textContent).toContain('não fecham');
    expect(state().value).toBe('{"a": [1, 2}');
    // The next click that works clears it.
    put('{"a":1}', 1);
    fireEvent.click(screen.getByTestId('format-body'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('formats with Shift+Alt+F', () => {
    render(<Harness />);
    put('{"a":1}', 1);
    expect(press({ key: 'F', code: 'KeyF', altKey: true, shiftKey: true })).toBe(false);
    expect(state().value).toBe('{\n  "a": 1\n}');
  });

  it('inserts mocks from the menu: quoted where JSON wants a string, bare for numbers', async () => {
    render(<Harness />);
    put('{\n  "email": \n}', 13);
    fireEvent.click(screen.getByTestId('mocks'));
    fireEvent.click(await screen.findByTestId('mock-$randomEmail'));
    expect(state().value).toBe('{\n  "email": "{{$randomEmail}}"\n}');
    expect(screen.queryByTestId('mocks-panel')).toBeNull();
    expect(state().start).toBe(13 + '"{{$randomEmail}}"'.length);

    put('{\n  "age": \n}', 11);
    fireEvent.click(screen.getByTestId('mocks'));
    fireEvent.click(await screen.findByTestId('mock-$randomAge'));
    expect(state().value).toBe('{\n  "age": {{$randomAge}}\n}');

    put('{"name": "Dr. "}', 14);
    fireEvent.click(screen.getByTestId('mocks'));
    fireEvent.click(await screen.findByTestId('mock-$randomFullName'));
    expect(state().value).toBe('{"name": "Dr. {{$randomFullName}}"}');
  });

  it('fills an empty body with a template, and inserts at the caret in a body that has text', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('mocks'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Modelos' }));
    fireEvent.click(screen.getByTestId('mock-template-customer'));
    const customer = MOCK_TEMPLATES.find((template) => template.id === 'customer')!.body;
    expect(state().value).toBe(customer);

    put('{\n  "a": \n}', 9);
    fireEvent.click(screen.getByTestId('mocks'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Modelos' }));
    fireEvent.click(screen.getByTestId('mock-template-user'));
    expect(state().value).toContain('"username": "{{$randomUserName}}"');
    expect(state().value.startsWith('{\n  "a": {')).toBe(true);
  });
});

describe('colors', () => {
  beforeEach(() => useExecCommand(undefined));
  const layer = () => screen.getByTestId('code-highlight');
  // By exact text: Testing Library's matchers trim it, and `"Ana ` ends in a space.
  const span = (text: string) =>
    [...layer().querySelectorAll('span')].find((element) => element.textContent === text)!;

  it('colors each kind of token, and the variables by whether they exist', () => {
    render(
      <Harness
        initial={
          '{"name": "Ana {{$randomFullName}}", "age": 34, "ok": true, "x": null, "u": {{baseUrl}}, "bad": {{nope}}, "m": {{$nope}}}'
        }
      />,
    );
    expect(span('"name"').className).toContain('--code-key');
    expect(span('"Ana ').className).toContain('--code-string');
    expect(span('34').className).toContain('--code-number');
    expect(span('true').className).toContain('--code-keyword');
    expect(span('null').className).toContain('--code-keyword');
    expect(span('{{$randomFullName}}').className).toContain('--text-pro');
    expect(span('{{baseUrl}}').className).toContain('--text-success');
    expect(span('{{nope}}').className).toContain('--text-danger');
    // A $name the API does not know is flagged like a missing variable.
    expect(span('{{$nope}}').className).toContain('--text-danger');
  });

  it('does not flag mocks while the list is still loading', () => {
    render(<Harness initial={'{"a": "{{$randomFullName}}"}'} mocks={null} />);
    expect(span('{{$randomFullName}}').className).toContain('--text-pro');
  });

  it('colors XML tags, attributes and comments', () => {
    render(<Harness language="xml" initial={'<order id="{{$guid}}"><!-- note --></order>'} />);
    expect(span('order').className).toContain('--code-tag');
    expect(span('id').className).toContain('--code-attr');
    expect(span('<!-- note -->').className).toContain('--code-comment');
  });

  it('shows the text as typed: the layer holds exactly the value', () => {
    render(<Harness initial={'{\n  "a": [1, 2]\n}'} />);
    expect(layer().textContent).toBe('{\n  "a": [1, 2]\n}');
    expect(layer().getAttribute('aria-hidden')).toBe('true');
    expect(editor().className).toContain('text-transparent');
  });

  it('numbers the lines', () => {
    const { container } = render(<Harness initial={'a\nb\nc'} />);
    const gutter = container.querySelector('[aria-hidden="true"].sticky')!;
    expect(gutter.textContent).toBe('123');
  });
});

describe('leaving the field and the page shortcuts', () => {
  beforeEach(() => useExecCommand(undefined));

  it('lets Tab leave the field after Escape, once', () => {
    render(<Harness />);
    put('x', 1);
    expect(press({ key: 'Escape' })).toBe(true);
    expect(press({ key: 'Tab' })).toBe(true);
    expect(state().value).toBe('x');
    expect(press({ key: 'Tab' })).toBe(false);
    expect(state().value).toBe('x  ');
  });

  it('does not take Ctrl+Enter, which sends the request', () => {
    render(<Harness />);
    put('abc', 3);
    expect(press({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(press({ key: 'Enter', metaKey: true })).toBe(true);
    expect(state().value).toBe('abc');
  });
});

/** Types `text` at the end, as the keyboard would: focus, change, caret at the end, key up. */
function type(text: string) {
  editor().focus();
  fireEvent.change(editor(), { target: { value: text } });
  editor().setSelectionRange(text.length, text.length);
  fireEvent.keyUp(editor(), { key: 'a' });
}

describe('completing a value with a mock', () => {
  beforeEach(() => useExecCommand(undefined));
  // The name is the first span of each option; then come the sample and the source.
  const options = () =>
    screen.getAllByRole('option').map((option) => option.querySelector('span')?.textContent ?? '');

  it('offers the mocks as soon as the quote of a value is typed, the one for the key first', () => {
    render(<Harness />);
    type('{\n  "name": "');
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
    expect(options()[0]).toBe('$randomFullName');
    expect(options().length).toBeGreaterThan(1);

    type('{\n  "email": "');
    expect(options()[0]).toBe('$randomEmail');
  });

  it('completes with Enter: the mock goes in and the string is closed', () => {
    render(<Harness />);
    type('{\n  "name": "');
    expect(press({ key: 'Enter' })).toBe(false);
    expect(state().value).toBe('{\n  "name": "{{$randomFullName}}"');
    expect(state().start).toBe(state().value.length);
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('completes with a click, and with the arrows plus Tab', () => {
    render(<Harness />);
    type('{"x": "');
    fireEvent.mouseDown(screen.getAllByRole('option')[1]!);
    expect(state().value).toMatch(/^\{"x": "\{\{\$random\w+\}\}"$/);

    type('{"name": "');
    press({ key: 'ArrowDown' });
    press({ key: 'Tab' });
    expect(state().value).not.toBe('{"name": "{{$randomFullName}}"');
    expect(state().value).toMatch(/^\{"name": "\{\{\$\w+\}\}"$/);
  });

  it('does not repeat a closing quote that is already there', () => {
    render(<Harness />);
    editor().focus();
    fireEvent.change(editor(), { target: { value: '{"name": ""}' } });
    editor().setSelectionRange(10, 10);
    fireEvent.keyUp(editor(), { key: '"' });
    press({ key: 'Enter' });
    expect(state()).toEqual({ value: '{"name": "{{$randomFullName}}"}', start: 30, end: 30 });
  });

  it('turns the quote of a number into the number', () => {
    render(<Harness />);
    type('{"age": "');
    expect(options()[0]).toBe('$randomAge');
    press({ key: 'Enter' });
    expect(state().value).toBe('{"age": {{$randomAge}}');
  });

  it('narrows the list as the value is typed, and closes when nothing fits', () => {
    render(<Harness />);
    type('{"x": "ema');
    expect(options()).toEqual(['$randomEmail']);
    type('{"x": "Ana');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    // A plain string is typed as usual: Enter is not taken.
    expect(press({ key: 'Enter' })).toBe(false);
    expect(state().value).toBe('{"x": "Ana\n');
  });

  it('closes with Escape and stays closed for the rest of the string', () => {
    render(<Harness />);
    type('{"name": "');
    expect(press({ key: 'Escape' })).toBe(false);
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('does not open for keys, after a string is closed, or outside JSON', () => {
    render(<Harness />);
    type('{"na');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    type('{"a": "x"');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    type('{"a": 1, "b');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('does not open in XML or text bodies', () => {
    const { unmount } = render(<Harness language="xml" />);
    type('<a b="');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    unmount();
    render(<Harness language="text" />);
    type('name: "');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('offers mocks for the value of the key with Ctrl+Space, before any quote', () => {
    render(<Harness />);
    editor().focus();
    put('{\n  "email": ', 13);
    expect(press({ key: ' ', code: 'Space', ctrlKey: true })).toBe(false);
    expect(options()[0]).toBe('$randomEmail');
    // Letting go of the keys is not typing: the list stays.
    fireEvent.keyUp(editor(), { key: ' ', code: 'Space' });
    fireEvent.keyUp(editor(), { key: 'Control', code: 'ControlLeft' });
    expect(options()[0]).toBe('$randomEmail');
    press({ key: 'Enter' });
    expect(state().value).toBe('{\n  "email": "{{$randomEmail}}"');
  });

  it('inserts a number without quotes with Ctrl+Space, and no extra quote inside a string', () => {
    render(<Harness />);
    editor().focus();
    put('{"age": ', 8);
    press({ key: ' ', code: 'Space', ctrlKey: true });
    expect(options()[0]).toBe('$randomAge');
    press({ key: 'Enter' });
    expect(state().value).toBe('{"age": {{$randomAge}}');

    put('{"name": "Dr. ', 14);
    press({ key: ' ', code: 'Space', metaKey: true });
    press({ key: 'Enter' });
    expect(state().value).toBe('{"name": "Dr. {{$randomFullName}}');
  });

  it('does nothing on Ctrl+Space outside JSON', () => {
    render(<Harness language="text" />);
    editor().focus();
    put('abc', 3);
    expect(press({ key: ' ', code: 'Space', ctrlKey: true })).toBe(false);
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });
});

describe('{{ suggestions', () => {
  beforeEach(() => useExecCommand(undefined));

  it('suggests variables and mocks with a sample while typing {{', async () => {
    render(<Harness />);
    type('{{$ran');
    const list = await screen.findByTestId('variable-suggestions');
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('$randomFullName')]),
    );
    expect(within(list).getByText('Ana Souza')).toBeTruthy();
  });

  it('quotes a mock completed where a JSON value goes, and not inside a string', () => {
    render(<Harness />);
    type('{{$randomE');
    press({ key: 'Enter' });
    expect(state().value).toBe('"{{$randomEmail}}"');

    type('{"a": "x {{$randomE');
    press({ key: 'Enter' });
    expect(state().value).toBe('{"a": "x {{$randomEmail}}');
  });

  it('completes a plain variable with Tab and replaces the rest of the token', () => {
    render(<Harness />);
    type('{"a": "{{base');
    press({ key: 'Tab' });
    expect(state().value).toBe('{"a": "{{baseUrl}}');
    put('{"a": "{{ba}}"}', 11);
    fireEvent.keyUp(editor(), { key: 'a' });
    press({ key: 'Enter' });
    expect(state().value).toBe('{"a": "{{baseUrl}}"}');
  });

  it('moves with the arrows and closes with Escape', () => {
    render(<Harness />);
    type('{{$random');
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    const before = screen.getAllByRole('option').map((o) => o.getAttribute('aria-selected'));
    expect(before[0]).toBe('true');
    expect(press({ key: 'ArrowDown' })).toBe(false);
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    expect(press({ key: 'Escape' })).toBe(false);
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    // Escape closed the list; it did not arm "Tab leaves the field".
    expect(press({ key: 'Tab' })).toBe(false);
  });

  it('shows nothing for text that is not a variable', () => {
    render(<Harness />);
    type('{"a": 1');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });
});

describe('the Mocks and Shortcuts menus', () => {
  beforeEach(() => useExecCommand(undefined));

  it('groups the mocks, searches names, samples and groups', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('mocks'));
    const panel = await screen.findByTestId('mocks-panel');
    expect(within(panel).getByRole('region', { name: 'Pessoas' })).toBeTruthy();
    expect(within(panel).getByText('Ana Souza')).toBeTruthy();
    const search = within(panel).getByPlaceholderText('Buscar mock...');
    fireEvent.change(search, { target: { value: 'cpf' } });
    expect(within(panel).getAllByTestId(/^mock-/)).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'documentos' } });
    expect(within(panel).getAllByTestId(/^mock-/)).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(within(panel).getByText('Nenhum mock encontrado.')).toBeTruthy();
  });

  it('closes with Escape or a click outside, and focus goes back to the button', async () => {
    render(<Harness />);
    const button = screen.getByTestId('mocks');
    fireEvent.click(button);
    await screen.findByTestId('mocks-panel');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('mocks-panel')).toBeNull());
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await screen.findByTestId('mocks-panel');
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId('mocks-panel')).toBeNull());
  });

  it('says so when the mocks could not be loaded, and shows a skeleton while they load', async () => {
    const { unmount } = render(<Harness mocks={null} />);
    fireEvent.click(screen.getByTestId('mocks'));
    const panel = await screen.findByTestId('mocks-panel');
    expect(within(panel).getAllByTestId('skeleton').length).toBeGreaterThan(0);
    unmount();

    render(<Harness mocks={null} mocksFailed />);
    fireEvent.click(screen.getByTestId('mocks'));
    expect(await screen.findByText('Não foi possível carregar os mocks agora.')).toBeTruthy();
  });

  it('offers to try again when the mocks could not be loaded', async () => {
    const onRetry = vi.fn();
    render(<Harness mocks={null} mocksFailed onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('mocks'));
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('searches with the same input as the rest of the app: default size, icon on the left', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('mocks'));
    const panel = await screen.findByTestId('mocks-panel');
    const search = within(panel).getByPlaceholderText('Buscar mock...');
    // The sidebar's search box is `<Input leftIcon>` at the default size too.
    expect(search.className).toContain('h-[40px]');
    expect(search.className).toContain('pl-');
    expect(panel.querySelector('.ti-search')).toBeTruthy();
  });

  it('only offers templates for JSON', async () => {
    render(<Harness language="xml" initial="<a/>" />);
    fireEvent.click(screen.getByTestId('mocks'));
    await screen.findByTestId('mocks-panel');
    expect(screen.queryByRole('tab', { name: 'Modelos' })).toBeNull();
  });

  it('lists the shortcuts', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('shortcuts'));
    const panel = await screen.findByTestId('shortcuts-panel');
    for (const keys of ['Shift+Alt+F', 'Shift+Alt+↓', 'Shift+Alt+↑', 'Ctrl+D', 'Ctrl+Shift+K']) {
      expect(panel.textContent).toContain(keys);
    }
    expect(panel.textContent).toContain('Copiar linha para baixo');
  });

  it('hides editing tools from read-only members and the Format button from plain text', () => {
    const { unmount } = render(<Harness readOnly initial="{}" />);
    expect(screen.queryByTestId('mocks')).toBeNull();
    expect(screen.queryByTestId('format-body')).toBeNull();
    expect(editor().disabled).toBe(true);
    expect(screen.getByTestId('shortcuts')).toBeTruthy();
    unmount();

    render(<Harness language="text" />);
    expect(screen.queryByTestId('format-body')).toBeNull();
    expect(screen.getByTestId('mocks')).toBeTruthy();
  });
});

describe('mock templates and quoting', () => {
  it('has bodies that are valid JSON once the mocks are filled', () => {
    for (const template of MOCK_TEMPLATES) {
      const filled = template.body
        .replace(/\{\{\$random(?:Int|Price|Age)\}\}/g, '1')
        .replace(/\{\{[^}]+\}\}/g, 'x');
      expect(() => void JSON.parse(filled), template.id).not.toThrow();
    }
  });

  it('knows when the caret is inside a JSON string', () => {
    expect(insideJsonString('{"a": "x', 9)).toBe(true);
    expect(insideJsonString('{"a": ', 6)).toBe(false);
    expect(insideJsonString('{"a": "x\\"y', 12)).toBe(true);
    expect(insideJsonString('{"a": "x"\n"b', 13)).toBe(true);
    expect(insideJsonString('{"a": "x"\n', 10)).toBe(false);
  });

  it('quotes string mocks only in JSON outside a string', () => {
    expect(mockSnippet('$randomEmail', 'json', false)).toBe('"{{$randomEmail}}"');
    expect(mockSnippet('$randomEmail', 'json', true)).toBe('{{$randomEmail}}');
    expect(mockSnippet('$randomAge', 'json', false)).toBe('{{$randomAge}}');
    expect(mockSnippet('$randomBoolean', 'json', false)).toBe('{{$randomBoolean}}');
    expect(mockSnippet('$randomEmail', 'xml', false)).toBe('{{$randomEmail}}');
    expect(mockSnippet('$randomEmail', 'text', false)).toBe('{{$randomEmail}}');
  });
});

describe('variable suggestions with mocks', () => {
  const collection = { variables: [{ key: 'baseUrl', value: 'https://api.test' }], items: [] };

  it('offers every mock with its sample as the value, after the variables', () => {
    const list = variableSuggestions(collection, null, MOCKS);
    expect(list[0]).toMatchObject({ name: 'baseUrl', source: 'collection' });
    expect(list.find((item) => item.name === '$randomFullName')).toEqual({
      name: '$randomFullName',
      source: 'dynamic',
      value: 'Ana Souza',
    });
    expect(list.filter((item) => item.source === 'dynamic')).toHaveLength(MOCKS.length);
  });

  it('falls back to the helpers every server has until the list arrives', () => {
    const list = variableSuggestions(collection, null);
    expect(list.filter((item) => item.source === 'dynamic').map((item) => item.name)).toEqual([
      '$guid',
      '$timestamp',
      '$isoTimestamp',
      '$randomInt',
    ]);
    expect(variableSuggestions(collection, null, [])).toEqual(list);
  });

  it('lets a variable of the collection win over a mock with the same name', () => {
    const list = variableSuggestions(
      { variables: [{ key: '$guid', value: 'mine' }], items: [] },
      null,
      MOCKS,
    );
    expect(list.filter((item) => item.name === '$guid')).toEqual([
      expect.objectContaining({ source: 'collection', value: 'mine' }),
    ]);
  });
});

describe('Integration Tests view: loading the mocks', () => {
  const request = {
    id: 'r1',
    type: 'request',
    name: 'Create customer',
    method: 'POST',
    url: '{{baseUrl}}/customers',
    query: [],
    pathParams: [],
    headers: [],
    body: { mode: 'json', content: '{\n  "name": "\n}' },
    auth: { type: 'inherit' },
    captures: [],
    assertions: [],
  };
  const collection = {
    id: 'c1',
    workspaceId: 'w1',
    name: 'Customers',
    variables: [{ key: 'baseUrl', value: 'https://api.test' }],
    auth: { type: 'none' },
    source: { kind: 'manual' },
    updatedAt: '',
    items: [request],
  };
  const summary = { ...collection, description: '', requestCount: 1 };

  it('shows the mocks that were missing once the server answers, without reloading the page', async () => {
    const api = {
      listApiCollections: vi.fn(() => Promise.resolve([summary])),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(() => Promise.resolve(collection)),
      // The first call fails like a server that does not have the route yet.
      listApiMockValues: vi
        .fn()
        .mockRejectedValueOnce(new Error('Not Found'))
        .mockResolvedValueOnce(MOCKS),
    };
    render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    fireEvent.click(await screen.findByTestId('mocks'));
    expect(await screen.findByText('Não foi possível carregar os mocks agora.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByTestId('mock-$randomFullName')).toBeTruthy();
    expect(api.listApiMockValues).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Não foi possível carregar os mocks agora.')).toBeNull();
  });

  it('completes a value with a mock in the real body editor', async () => {
    const api = {
      listApiCollections: vi.fn(() => Promise.resolve([summary])),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(() => Promise.resolve(collection)),
      listApiMockValues: vi.fn(() => Promise.resolve(MOCKS)),
    };
    render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    const body = await screen.findByLabelText<HTMLTextAreaElement>('Body');
    await waitFor(() => expect(api.listApiMockValues).toHaveBeenCalled());
    body.focus();
    body.setSelectionRange(13, 13); // right after the quote that opens the value
    fireEvent.keyUp(body, { key: '"' });
    await screen.findByTestId('variable-suggestions');
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(body.value).toBe('{\n  "name": "{{$randomFullName}}"\n}');
  });
});
