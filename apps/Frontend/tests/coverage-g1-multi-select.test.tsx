import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelect } from '../src/components/ui/multi-select.js';

const options = [
  { value: 'a', label: 'Alpha', description: 'first letter' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function Pick({
  initial = [],
  onChange,
  ...rest
}: {
  initial?: string[];
  onChange?: (values: string[]) => void;
} & Partial<React.ComponentProps<typeof MultiSelect>>) {
  const [values, setValues] = useState<string[]>(initial);
  return (
    <div>
      <MultiSelect
        options={options}
        values={values}
        onChange={(next) => {
          setValues(next);
          onChange?.(next);
        }}
        label="Letras"
        placeholder="Escolha letras"
        emptyMessage="Nada"
        {...rest}
      />
      <button type="button">outside</button>
    </div>
  );
}

describe('MultiSelect', () => {
  it('picks and removes options with the mouse and shows picked ones as chips', () => {
    const onChange = vi.fn();
    render(<Pick onChange={onChange} id="letters" />);
    const field = screen.getByRole('combobox', { name: 'Letras' });
    expect(field).toHaveAttribute('id', 'letters');
    expect(field).toHaveAttribute('placeholder', 'Escolha letras');
    fireEvent.focus(field);
    expect(screen.getByText('first letter')).toBeInTheDocument();
    // Pressing an option does not take focus from the field.
    expect(fireEvent.mouseDown(screen.getByRole('option', { name: /Alpha/ }))).toBe(false);
    fireEvent.click(screen.getByRole('option', { name: /Alpha/ }));
    fireEvent.click(screen.getByRole('option', { name: /Gamma/ }));
    expect(onChange).toHaveBeenLastCalledWith(['a', 'c']);
    expect(field).toHaveAttribute('placeholder', '');
    fireEvent.click(screen.getByRole('button', { name: 'Remover Alpha' }));
    expect(onChange).toHaveBeenLastCalledWith(['c']);
    // Toggling a picked option in the list unpicks it.
    fireEvent.click(screen.getByRole('option', { name: /Gamma/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('shows a picked value missing from the options as its raw value', () => {
    render(<Pick initial={['zzz']} />);
    expect(screen.getByText('zzz')).toBeInTheDocument();
  });

  it('filters while typing and offers an empty message', () => {
    render(<Pick />);
    const field = screen.getByRole('combobox', { name: 'Letras' });
    fireEvent.change(field, { target: { value: 'first' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(field, { target: { value: 'nothing' } });
    expect(screen.getByText('Nada')).toBeInTheDocument();
  });

  it('is driven from the keyboard', () => {
    const onChange = vi.fn();
    render(<Pick onChange={onChange} initial={['c']} />);
    const field = screen.getByRole('combobox', { name: 'Letras' });
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field.getAttribute('aria-activedescendant')).toMatch(/-2$/);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(field.getAttribute('aria-activedescendant')).toMatch(/-0$/);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['c', 'a']);

    // Escape closes the list; Enter then does nothing; an arrow reopens it.
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    onChange.mockClear();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    // Backspace on an empty search drops the last chip; with text it only edits the text.
    fireEvent.keyDown(field, { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(['c']);
    fireEvent.change(field, { target: { value: 'x' } });
    onChange.mockClear();
    fireEvent.keyDown(field, { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
    // With every chip gone, Backspace has nothing left to drop.
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.keyDown(field, { key: 'Backspace' });
    onChange.mockClear();
    fireEvent.keyDown(field, { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the highlight at the top when nothing matches', () => {
    render(<Pick options={[]} />);
    const field = screen.getByRole('combobox', { name: 'Letras' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field).not.toHaveAttribute('aria-activedescendant');
  });

  it('focuses the search when the box is pressed, not when a chip is', () => {
    render(<Pick initial={['a']} />);
    const field = screen.getByRole('combobox', { name: 'Letras' });
    const box = field.parentElement as HTMLElement;
    expect(fireEvent.mouseDown(box)).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(fireEvent.mouseDown(screen.getByTitle('Alpha'))).toBe(true);
  });

  it('closes and clears the search when focus leaves', () => {
    render(<Pick />);
    const field = screen.getByRole('combobox', { name: 'Letras' });
    fireEvent.change(field, { target: { value: 'be' } });
    fireEvent.blur(field, { relatedTarget: screen.getByRole('option') });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.blur(field, { relatedTarget: screen.getByRole('button', { name: 'outside' }) });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('marks an invalid field and never opens while disabled', () => {
    const view = render(<Pick invalid />);
    expect(screen.getByRole('combobox', { name: 'Letras' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    view.unmount();
    render(<Pick disabled initial={['a']} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letras' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remover Alpha' })).toHaveProperty('disabled', true);
  });

  it('shows the loading row, alone while the first page loads', () => {
    const view = render(<Pick loadingMore loadingMessage="Carregando" />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letras' }));
    expect(screen.getByRole('status')).toHaveTextContent('Carregando');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    view.unmount();
    render(<Pick options={[]} loadingMore />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letras' }));
    expect(screen.getByRole('status')).toHaveTextContent('Carregando...');
    expect(screen.queryByText('Nada')).toBeNull();
  });

  it('draws a page at a time and asks for more only when the source has more', () => {
    const onLoadMore = vi.fn();
    render(
      <Pick
        pageSize={2}
        hasMore
        onLoadMore={onLoadMore}
        options={[...options, { value: 'd', label: 'Delta' }, { value: 'e', label: 'Epsilon' }]}
      />,
    );
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letras' }));
    expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(2);
    const listbox = screen.getByRole('listbox');
    Object.defineProperty(listbox, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(listbox, 'clientHeight', { value: 100, configurable: true });
    listbox.scrollTop = 900;
    for (let step = 0; step < 4; step += 1) fireEvent.scroll(listbox);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
