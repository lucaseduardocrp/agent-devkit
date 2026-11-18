import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichTextEditor } from '../src/features/shared/RichTextEditor.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RichTextEditor', () => {
  it('formats through the toolbar and reports the sanitized html', () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const onChange = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const view = render(
      <RichTextEditor
        initialHtml="<p>hi</p><script>x</script>"
        onChange={onChange}
        ariaLabel="Notes"
        editorRef={ref}
        placeholder="Write"
        className="extra"
        data-testid="rte"
      />,
    );
    const editor = view.getByRole('textbox', { name: 'Notes' });
    expect(editor.innerHTML).toBe('<p>hi</p>');
    expect(ref.current).toBe(editor);

    fireEvent.mouseDown(view.getAllByRole('button')[0]!);
    fireEvent.click(view.getAllByRole('button')[0]!);
    expect(exec).toHaveBeenLastCalledWith('bold', false);
    fireEvent.click(view.getAllByRole('button')[4]!);
    fireEvent.mouseDown(view.getAllByRole('button')[4]!);
    expect(exec).toHaveBeenLastCalledWith('formatBlock', false, 'h3');
    expect(onChange).toHaveBeenCalledTimes(2);

    editor.innerHTML = '<p>typed</p>';
    fireEvent.input(editor);
    expect(onChange).toHaveBeenLastCalledWith('<p>typed</p>');

    const paste = vi.fn();
    const drop = vi.fn();
    view.rerender(
      <RichTextEditor
        initialHtml=""
        onChange={onChange}
        ariaLabel="Notes"
        onPaste={paste}
        onDrop={drop}
      />,
    );
    fireEvent.paste(view.getByRole('textbox', { name: 'Notes' }));
    fireEvent.drop(view.getByRole('textbox', { name: 'Notes' }));
    expect(paste).toHaveBeenCalledOnce();
    expect(drop).toHaveBeenCalledOnce();
  });

  it('has no toolbar and ignores paste and drop when read only', () => {
    const paste = vi.fn();
    const drop = vi.fn();
    const view = render(
      <RichTextEditor
        initialHtml="<p>fixed</p>"
        onChange={vi.fn()}
        ariaLabel="Notes"
        readOnly
        onPaste={paste}
        onDrop={drop}
      />,
    );
    expect(view.queryByRole('button')).toBeNull();
    const editor = view.getByRole('textbox', { name: 'Notes' });
    fireEvent.paste(editor);
    fireEvent.drop(editor);
    expect(paste).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
  });
});
