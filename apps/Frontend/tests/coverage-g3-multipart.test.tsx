import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FormField } from '../src/features/apitests/api-test-types.js';
import { MultipartEditor } from '../src/features/apitests/integration/MultipartEditor.js';

function Harness({
  initial,
  readOnly = false,
  onChange,
}: {
  initial: FormField[];
  readOnly?: boolean;
  onChange: (fields: FormField[]) => void;
}) {
  const [fields, setFields] = useState(initial);
  return (
    <MultipartEditor
      fields={fields}
      readOnly={readOnly}
      onChange={(next) => {
        setFields(next);
        onChange(next);
      }}
    />
  );
}

const last = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as FormField[];

describe('MultipartEditor', () => {
  it('adds text and file parts, switches a part between text and file, and removes it', () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar campo' }));
    expect(last(onChange)).toEqual([{ key: '', value: '', type: 'text' }]);
    // A part without a name is labelled by its value field.
    expect(screen.getByLabelText('Valor')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar arquivo' }));
    expect(last(onChange)[1]).toEqual({ key: '', value: '', type: 'file' });

    fireEvent.change(screen.getByLabelText('Tipo de #1'), { target: { value: 'file' } });
    expect(last(onChange)[0]).toEqual({ key: '', value: '', type: 'file' });
    fireEvent.change(screen.getByLabelText('Tipo de #1'), { target: { value: 'text' } });
    expect(last(onChange)[0]).toEqual({ key: '', value: '', type: 'text', file: undefined });

    fireEvent.click(screen.getAllByRole('button', { name: 'Remover' })[0]!);
    expect(last(onChange)).toHaveLength(1);
  });

  it('disables and enables a part, and sets its content type', () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ key: 'a', value: '1' }]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Ativo'));
    expect(last(onChange)[0]!.enabled).toBe(false);
    fireEvent.click(screen.getByLabelText('Ativo'));
    expect(last(onChange)[0]!.enabled).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Content type de a'), {
      target: { value: 'text/plain' },
    });
    expect(last(onChange)[0]!.contentType).toBe('text/plain');
    fireEvent.change(screen.getByLabelText('Content type de a'), { target: { value: '' } });
    expect(last(onChange)[0]!.contentType).toBeUndefined();
  });

  it('opens the file dialog from the button, shows the chosen file and clears it', async () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ key: 'doc', value: '', type: 'file' }]} onChange={onChange} />);
    const input = screen.getByTestId('multipart-file-0') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher arquivo' }));
    expect(click).toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [new File(['hello'], 'a.txt')] } });
    await waitFor(() => expect(last(onChange)[0]!.file?.fileName).toBe('a.txt'));
    expect(await screen.findByText(/a\.txt · 5B/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trocar arquivo' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remover arquivo' }));
    expect(last(onChange)[0]!.file).toBeUndefined();
  });

  it('shows read-only parts without any control to change them', () => {
    render(
      <Harness
        initial={[
          { key: 'doc', value: '', type: 'file', file: { fileName: 'a.txt', data: 'aGk=' } },
        ]}
        readOnly
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Adicionar campo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remover arquivo' })).toBeNull();
  });
});
