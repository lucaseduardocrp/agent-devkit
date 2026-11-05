import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  CodeEditor,
  type CompletionSource,
} from '../src/features/apitests/integration/CodeEditor.js';

const completions: CompletionSource = (text, caret) => {
  const start = text.slice(0, caret).search(/\w*$/);
  const word = text.slice(start, caret);
  const items = [{ label: 'name', detail: 'String' }, { label: 'nickname' }].filter(
    (item) => word && item.label.startsWith(word),
  );
  return items.length ? { start, items } : null;
};

function Harness() {
  const [value, setValue] = useState('');
  return (
    <CodeEditor
      label="Query"
      value={value}
      language="graphql"
      readOnly={false}
      onChange={setValue}
      completions={completions}
    />
  );
}

const type = (editor: HTMLElement, value: string) =>
  fireEvent.change(editor, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });

describe('CodeEditor word completions without variables', () => {
  it('offers the words with their detail, and closes the list when nothing fits', () => {
    render(<Harness />);
    const editor = screen.getByLabelText('Query');
    editor.focus();
    type(editor, 'na');
    const list = screen.getByTestId('word-suggestions');
    expect(within(list).getByText('String')).toBeInTheDocument();
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    type(editor, 'zz');
    expect(screen.queryByTestId('word-suggestions')).toBeNull();
    type(editor, 'ni');
    fireEvent.mouseDown(within(screen.getByTestId('word-suggestions')).getAllByRole('option')[0]!);
    expect((editor as HTMLTextAreaElement).value).toBe('nickname');
  });
});
