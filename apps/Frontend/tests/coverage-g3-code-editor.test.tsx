import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodeEditor,
  type CodeEditorHandle,
  type CompletionSource,
} from '../src/features/apitests/integration/CodeEditor.js';
import { CodeEditorToolbar } from '../src/features/apitests/integration/CodeEditorToolbar.js';
import type { CodeLanguage } from '../src/features/apitests/integration/code-syntax.js';
import { VariablesContext } from '../src/features/apitests/variables-context.js';
import type { VariableSuggestion } from '../src/features/apitests/variables-context.js';

const VARIABLES: VariableSuggestion[] = [
  { name: 'baseUrl', source: 'collection', value: 'https://api.test' },
  { name: 'token', source: 'runtime', value: 'abc' },
];

/** `n` completes to `name` (typed String) and `nickname` (no type). */
const completions: CompletionSource = (text, caret) => {
  const word = /\w+$/.exec(text.slice(0, caret))?.[0] ?? '';
  if (!word.startsWith('n') || word.length === 0) return null;
  return {
    start: caret - word.length,
    items: [{ label: 'name', detail: 'String' }, { label: 'nickname' }],
  };
};

function Harness({
  initial = '',
  language = 'json',
  withVariables = true,
  withCompletions = false,
  handle,
}: {
  initial?: string;
  language?: CodeLanguage;
  withVariables?: boolean;
  withCompletions?: boolean;
  handle?: React.RefObject<CodeEditorHandle | null>;
}) {
  const [value, setValue] = useState(initial);
  const own = useRef<CodeEditorHandle>(null);
  const editor = handle ?? own;
  return (
    <VariablesContext.Provider value={withVariables ? VARIABLES : null}>
      <CodeEditorToolbar
        editor={editor}
        language={language}
        readOnly={false}
        mocks={null}
        mocksFailed={false}
        onRetryMocks={() => undefined}
      />
      <CodeEditor
        ref={editor}
        label="Body"
        value={value}
        language={language}
        readOnly={false}
        completions={withCompletions ? completions : undefined}
        onChange={setValue}
      />
    </VariablesContext.Provider>
  );
}

const editor = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Body' });
const state = () => ({
  value: editor().value,
  start: editor().selectionStart,
  end: editor().selectionEnd,
});
/** Types `text` at the end, as the keyboard would: focus, change, caret at the end, key up. */
function type(text: string) {
  editor().focus();
  fireEvent.change(editor(), { target: { value: text } });
  editor().setSelectionRange(text.length, text.length);
  fireEvent.keyUp(editor(), { key: 'a' });
}
/** Formats through the handle, inside act so the new text is rendered. */
function formatIn(handle: React.RefObject<CodeEditorHandle | null>): boolean {
  let done = false;
  act(() => {
    done = handle.current!.format();
  });
  return done;
}
const press = (init: KeyboardEventInit & { key: string }) => fireEvent.keyDown(editor(), init);

const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
afterEach(() => {
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
});

describe('CodeEditor word completions', () => {
  it('lists the words with and without a detail, follows the pointer and picks with a click', () => {
    render(<Harness language="graphql" withVariables={false} withCompletions />);
    type('{ n');
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['nameString', 'nickname']);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.mouseEnter(options[1]!);
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.mouseDown(screen.getAllByRole('option')[1]!);
    expect(state().value).toBe('{ nickname');
    expect(screen.queryByTestId('word-suggestions')).toBeNull();
  });

  it('moves up from the first word to the last, and picks with Enter', () => {
    render(<Harness language="graphql" withVariables={false} withCompletions />);
    type('{ n');
    expect(press({ key: 'ArrowUp' })).toBe(false);
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    press({ key: 'Enter' });
    expect(state().value).toBe('{ nickname');
  });

  it('shows no list for text without words when there are no variables either', () => {
    render(<Harness language="graphql" withVariables={false} withCompletions />);
    type('{ x');
    expect(screen.queryByTestId('word-suggestions')).toBeNull();
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });
});

describe('CodeEditor {{ suggestions', () => {
  it('highlights the suggestion under the pointer and picks it', () => {
    render(<Harness />);
    type('{{');
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    fireEvent.mouseEnter(options[1]!);
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseDown(screen.getAllByRole('option')[1]!);
    expect(state().value).toBe('{{token}}');
  });

  it('closes the list on a click that selects a range, and opens it on a plain click', () => {
    render(<Harness />);
    editor().focus();
    fireEvent.change(editor(), { target: { value: '{{ba' } });
    editor().setSelectionRange(4, 4);
    fireEvent.click(editor());
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
    editor().setSelectionRange(0, 4);
    fireEvent.click(editor());
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('keeps the list when the arrows are released', () => {
    render(<Harness />);
    type('{{');
    fireEvent.keyUp(editor(), { key: 'ArrowDown' });
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
  });

  it('does not open a list without variables in the page', () => {
    render(<Harness withVariables={false} />);
    type('{{');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });
});

describe('CodeEditor keys and edits', () => {
  it('leaves a key that belongs to an IME composition alone', () => {
    render(<Harness initial="ab" />);
    editor().focus();
    editor().setSelectionRange(1, 1);
    expect(press({ key: 'Tab', isComposing: true })).toBe(true);
    expect(state().value).toBe('ab');
  });

  it('deleting the line of an empty editor changes nothing and keeps the caret', () => {
    render(<Harness />);
    editor().focus();
    press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
    expect(state()).toEqual({ value: '', start: 0, end: 0 });
  });

  it('falls back to setting the text when the browser command throws', () => {
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => {
        throw new Error('not allowed');
      }),
      configurable: true,
    });
    render(<Harness initial="a" />);
    editor().focus();
    editor().setSelectionRange(1, 1);
    press({ key: 'Tab' });
    expect(state().value).toBe('a  ');
  });
});

describe('CodeEditor handle', () => {
  it('formats XML and GraphQL, and refuses plain text and unbalanced text', () => {
    const xml = createRef<CodeEditorHandle>();
    const first = render(<Harness initial="<a><b>x</b></a>" language="xml" handle={xml} />);
    expect(formatIn(xml)).toBe(true);
    expect(editor().value).toBe('<a>\n  <b>x</b>\n</a>');
    first.unmount();

    const graphql = createRef<CodeEditorHandle>();
    const second = render(<Harness initial="{ a { b } }" language="graphql" handle={graphql} />);
    expect(formatIn(graphql)).toBe(true);
    expect(editor().value).toBe('{\n  a {\n    b\n  }\n}');
    second.unmount();

    const text = createRef<CodeEditorHandle>();
    render(<Harness initial="plain" language="text" handle={text} />);
    expect(text.current!.format()).toBe(false);
  });

  it('does nothing once the editor is gone', () => {
    const handle = createRef<CodeEditorHandle>();
    const view = render(<Harness initial='{"a":1}' handle={handle} />);
    const kept = handle.current!;
    view.unmount();
    expect(kept.format()).toBe(false);
    expect(() => kept.insertMock('$guid')).not.toThrow();
    expect(() => kept.insertTemplate('{}')).not.toThrow();
  });
});

describe('CodeEditorToolbar format', () => {
  it('says why a GraphQL document could not be formatted', () => {
    render(<Harness initial="{ a { b }" language="graphql" />);
    fireEvent.click(screen.getByTestId('format-body'));
    expect(
      screen.getByText('Não foi possível formatar: chaves ou parênteses não fecham.'),
    ).toBeTruthy();
  });
});

describe('CodeEditorToolbar format of XML', () => {
  it('says why an XML body could not be formatted', () => {
    render(<Harness initial="<a><b></a>" language="xml" />);
    fireEvent.click(screen.getByTestId('format-body'));
    expect(screen.getByText('Não foi possível formatar: as tags do XML não fecham.')).toBeTruthy();
  });
});
