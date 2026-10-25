import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiSelect, type MultiSelectOption } from '../src/components/ui/multi-select.js';
import { FieldLabel, HelpTooltip } from '../src/components/ui/help-tooltip.js';
import { usePaging } from '../src/components/ui/pagination.js';

afterEach(() => vi.restoreAllMocks());

const OPTIONS: MultiSelectOption[] = [
  { value: 'chrome', label: 'Chrome', description: 'Navegador' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'safari', label: 'Safari' },
];

function Harness({
  initial = [],
  invalid,
  onChange,
}: {
  initial?: string[];
  invalid?: boolean;
  onChange?: (values: string[]) => void;
}) {
  const [values, setValues] = useState<string[]>(initial);
  return (
    <div>
      <MultiSelect
        options={OPTIONS}
        values={values}
        onChange={(next) => {
          onChange?.(next);
          setValues(next);
        }}
        label="Navegadores"
        placeholder="Escolha navegadores"
        emptyMessage="Nenhum navegador"
        invalid={invalid}
      />
      <button type="button">Fora</button>
    </div>
  );
}

const combobox = () => screen.getByRole('combobox', { name: 'Navegadores' });

describe('MultiSelect', () => {
  it('picks and removes options with the keyboard', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = combobox();

    fireEvent.focus(input);
    expect(screen.getByRole('listbox', { name: 'Navegadores' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['firefox']);
    expect(screen.getByRole('option', { name: 'Firefox' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Backspace in an empty search removes the last chip.
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    // Enter with the list closed picks nothing.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('searches labels and descriptions and says when nothing matches', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = combobox();

    fireEvent.change(input, { target: { value: 'navegador' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'ChromeNavegador',
    ]);
    fireEvent.change(input, { target: { value: 'opera' } });
    expect(screen.getByText('Nenhum navegador')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    // Backspace while typing edits the search instead of removing chips.
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows unknown values as chips, removes chips and closes when focus leaves', () => {
    const onChange = vi.fn();
    render(<Harness initial={['edge', 'safari']} invalid onChange={onChange} />);
    const input = combobox();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('placeholder', '');
    expect(screen.getByTitle('edge')).toHaveTextContent('edge');

    // Clicking the box focuses the search; clicking a chip does not.
    const box = input.parentElement!;
    const focus = vi.spyOn(input, 'focus');
    fireEvent.mouseDown(box);
    expect(focus).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByTitle('edge'));
    expect(focus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remover edge' }));
    expect(onChange).toHaveBeenLastCalledWith(['safari']);

    fireEvent.focus(input);
    const firefox = screen.getByRole('option', { name: 'Firefox' });
    expect(fireEvent.mouseDown(firefox)).toBe(false);
    fireEvent.click(firefox);
    expect(onChange).toHaveBeenLastCalledWith(['safari', 'firefox']);

    // Moving inside the control keeps the list; leaving it closes the list.
    fireEvent.blur(input, { relatedTarget: firefox });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Fora' }) });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('HelpTooltip', () => {
  it('shows its text while hovered, focused or clicked and hides on Escape or blur', () => {
    render(<HelpTooltip label="Ajuda do campo">Explicação</HelpTooltip>);
    const icon = screen.getByRole('button', { name: 'Ajuda do campo' });
    const tooltip = screen.getByRole('tooltip');
    expect(icon).toHaveAttribute('aria-describedby', tooltip.id);
    expect(tooltip).toHaveTextContent('Explicação');
    expect(tooltip).toHaveClass('sr-only');

    fireEvent.mouseEnter(icon.parentElement!);
    expect(tooltip).not.toHaveClass('sr-only');
    fireEvent.mouseLeave(icon.parentElement!);
    expect(tooltip).toHaveClass('sr-only');

    fireEvent.focus(icon);
    expect(tooltip).not.toHaveClass('sr-only');
    fireEvent.keyDown(icon, { key: 'Tab' });
    expect(tooltip).not.toHaveClass('sr-only');
    fireEvent.keyDown(icon, { key: 'Escape' });
    expect(tooltip).toHaveClass('sr-only');

    fireEvent.click(icon);
    expect(tooltip).not.toHaveClass('sr-only');
    fireEvent.blur(icon);
    expect(tooltip).toHaveClass('sr-only');
  });

  it('labels fields with an optional hint', () => {
    const { rerender } = render(
      <FieldLabel htmlFor="name" hint="Nome visível">
        Nome
      </FieldLabel>,
    );
    expect(screen.getByText('Nome')).toHaveAttribute('for', 'name');
    expect(screen.getByRole('button', { name: 'Mais informações' })).toBeInTheDocument();

    rerender(<FieldLabel>Nome</FieldLabel>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('usePaging storage', () => {
  it('keeps a new page size for the visit when it cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => usePaging(120, { storageKey: 'gap-paging' }));

    act(() => result.current.setPageSize(50));
    expect(result.current.pageSize).toBe(50);
    expect(result.current.end).toBe(50);
    expect(localStorage.getItem('gap-paging')).toBeNull();
  });
});

describe('MultiSelect disabled', () => {
  it('opens no list and blocks chip removal', () => {
    render(
      <MultiSelect
        options={OPTIONS}
        values={['chrome']}
        onChange={vi.fn()}
        label="Navegadores"
        placeholder="Escolha"
        emptyMessage="Nenhum"
        disabled
      />,
    );
    fireEvent.focus(combobox());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(combobox()).toHaveAttribute('disabled');
    expect(screen.getByRole('button', { name: 'Remover Chrome' })).toHaveAttribute('disabled');
  });
});
