import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilePicker, MultipartEditor } from '../src/features/apitests/integration/MultipartEditor.js';
import type { FormField } from '../src/features/apitests/api-test-types.js';

describe('MultipartEditor', () => {
  it('toggles a field back on and switches its type to and from file', () => {
    const onChange = vi.fn();
    const fields: FormField[] = [
      { key: 'a', value: '1', enabled: false },
      { key: 'b', value: '2', type: 'file', file: { fileName: 'x.png', data: '' } },
    ];
    const view = render(<MultipartEditor fields={fields} readOnly={false} onChange={onChange} />);
    const checkboxes = view.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    expect(onChange.mock.lastCall?.[0][0]).toMatchObject({ enabled: undefined });

    const selects = view.getAllByRole('combobox');
    fireEvent.change(selects[1]!, { target: { value: 'text' } });
    expect(onChange.mock.lastCall?.[0][1]).toMatchObject({ type: 'text', file: undefined });
    fireEvent.change(selects[0]!, { target: { value: 'file' } });
    expect(onChange.mock.lastCall?.[0][0]).toMatchObject({ type: 'file', value: '' });
  });
});

describe('FilePicker', () => {
  it('opens the hidden file input when the button is clicked', () => {
    const onChange = vi.fn();
    const view = render(
      <FilePicker file={null} readOnly={false} label="File" onChange={onChange} testId="file-input" />,
    );
    const input = view.getByTestId('file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(view.getByRole('button', { name: /arquivo/i }));
    expect(click).toHaveBeenCalled();
  });
});
