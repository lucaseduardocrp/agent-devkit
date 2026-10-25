import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiMockValue } from '../src/features/apitests/api-test-types.js';
import {
  CodeEditor,
  type CodeEditorHandle,
} from '../src/features/apitests/integration/CodeEditor.js';
import { CodeEditorToolbar } from '../src/features/apitests/integration/CodeEditorToolbar.js';
import { EditorPopover } from '../src/features/apitests/integration/EditorPopover.js';
import type { CodeLanguage } from '../src/features/apitests/integration/code-syntax.js';
import {
  VariablesContext,
  variableSuggestions,
} from '../src/features/apitests/variables-context.js';

const MOCKS: ApiMockValue[] = [
  { name: '$randomFullName', group: 'person', sample: 'Ana Souza' },
  { name: '$randomEmail', group: 'contact', sample: 'ana@example.com' },
];

let handle: CodeEditorHandle | null = null;

function Harness({
  initial = '',
  language = 'json',
}: {
  initial?: string;
  language?: CodeLanguage;
}) {
  const [value, setValue] = useState(initial);
  const editor = useRef<CodeEditorHandle>(null);
  const suggestions = variableSuggestions({ variables: [], items: [] }, null, MOCKS);
  return (
    <VariablesContext.Provider value={suggestions}>
      <CodeEditorToolbar
        editor={editor}
        language={language}
        readOnly={false}
        mocks={MOCKS}
        mocksFailed={false}
        onRetryMocks={() => undefined}
      />
      <CodeEditor
        ref={(current) => {
          editor.current = current;
          handle = current;
        }}
        label="Body"
        value={value}
        language={language}
        readOnly={false}
        mocks={MOCKS}
        onChange={setValue}
      />
    </VariablesContext.Provider>
  );
}

const editor = () => screen.getByLabelText<HTMLTextAreaElement>('Body');
function put(text: string, start: number, end = start) {
  editor().focus();
  fireEvent.change(editor(), { target: { value: text } });
  editor().setSelectionRange(start, end);
}
function type(text: string) {
  put(text, text.length);
  fireEvent.keyUp(editor(), { key: 'a' });
}

const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
function useExecCommand(implementation: unknown) {
  Object.defineProperty(document, 'execCommand', { value: implementation, configurable: true });
}
beforeEach(() => useExecCommand(undefined));
afterEach(() => {
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
  vi.useRealTimers();
});

describe('CodeEditor edge cases', () => {
  it('sets the text directly when the browser command throws', () => {
    useExecCommand(
      vi.fn(() => {
        throw new Error('not allowed');
      }),
    );
    render(<Harness />);
    put('a', 1);
    fireEvent.keyDown(editor(), { key: 'Tab' });
    expect(editor().value).toBe('a  ');
    expect(document.execCommand).toHaveBeenCalled();
  });

  it('leaves the text alone when an edit has nothing to insert or replace', () => {
    const exec = vi.fn(() => true);
    useExecCommand(exec);
    render(<Harness />);
    act(() => handle!.insertTemplate(''));
    expect(editor().value).toBe('');
    // A delete with nothing selected would remove a character, so it is not sent.
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not format plain text with Shift+Alt+F', () => {
    render(<Harness language="text" />);
    put('a  b', 1);
    expect(
      fireEvent.keyDown(editor(), { key: 'F', code: 'KeyF', altKey: true, shiftKey: true }),
    ).toBe(false);
    expect(editor().value).toBe('a  b');
    expect(handle!.format()).toBe(false);
  });

  it('ignores keys while an IME is composing', () => {
    render(<Harness />);
    put('x', 1);
    expect(fireEvent.keyDown(editor(), { key: 'Tab', isComposing: true })).toBe(true);
    expect(editor().value).toBe('x');
  });

  it('moves up the list, follows the mouse, and opens again on click', () => {
    render(<Harness />);
    type('{{$random');
    const options = () => screen.getAllByRole('option');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    // Up from the first wraps to the last.
    fireEvent.keyDown(editor(), { key: 'ArrowUp' });
    expect(options()[options().length - 1]!.getAttribute('aria-selected')).toBe('true');
    // Arrow keys going up do not refresh the list.
    fireEvent.keyUp(editor(), { key: 'ArrowUp' });
    expect(options()[options().length - 1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseEnter(options()[0]!);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.blur(editor());
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    editor().focus();
    fireEvent.click(editor());
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
  });

  it('closes the list when text is selected', () => {
    render(<Harness />);
    type('{{$random');
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
    editor().setSelectionRange(0, 3);
    fireEvent.click(editor());
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });
});

describe('CodeEditorToolbar', () => {
  it('says when XML cannot be formatted, and the notice goes away by itself', () => {
    vi.useFakeTimers();
    render(<Harness language="xml" initial="<a><b></a>" />);
    fireEvent.click(screen.getByTestId('format-body'));
    expect(screen.getByRole('status').textContent).toBe(
      'Não foi possível formatar: as tags do XML não fecham.',
    );
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('EditorPopover', () => {
  function Popover() {
    return (
      <EditorPopover icon="ti-star" label="Open" title="Panel">
        {(close) => (
          <button type="button" onClick={close}>
            Done
          </button>
        )}
      </EditorPopover>
    );
  }
  const trigger = () => screen.getByRole('button', { name: 'Open' });

  it('toggles from the button, ignores other keys and closes on resize', () => {
    render(<Popover />);
    fireEvent.click(trigger());
    const panel = screen.getByRole('dialog', { name: 'Panel' });
    expect(panel.getAttribute('data-testid')).toBeNull();
    fireEvent.keyDown(document, { key: 'a' });
    // A click inside the panel keeps it open.
    fireEvent.mouseDown(panel);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger());
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
