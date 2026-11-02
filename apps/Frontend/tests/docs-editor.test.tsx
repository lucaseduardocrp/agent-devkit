import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocsEditor } from '../src/features/apitests/integration/DocsEditor.js';

describe('DocsEditor', () => {
  it('opens notes already written in preview, and empty ones in edit mode', () => {
    const view = render(<DocsEditor value="# Notes" readOnly={false} onChange={vi.fn()} />);
    expect(view.getByText('Notes')).toBeTruthy();

    const empty = render(<DocsEditor value="" readOnly={false} onChange={vi.fn()} />);
    expect(empty.getByLabelText('Descrição')).toBeTruthy();
  });

  it('shows a hint and writes changes back, without a data-testid on either mode', () => {
    const onChange = vi.fn();
    const view = render(
      <DocsEditor value="" readOnly={false} hint="Visible to the team" onChange={onChange} />,
    );
    expect(view.getByText('Visible to the team')).toBeTruthy();
    const textarea = view.getByLabelText('Descrição');
    expect(textarea).not.toHaveAttribute('data-testid');
    fireEvent.change(textarea, { target: { value: 'written' } });
    expect(onChange).toHaveBeenCalledWith('written');
  });
});
