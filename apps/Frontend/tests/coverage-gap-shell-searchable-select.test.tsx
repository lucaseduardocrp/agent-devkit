import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../src/components/ui/searchable-select.js';

const OPTIONS: SearchableSelectOption[] = [
  { value: 'low', label: 'Baixa' },
  { value: 'medium', label: 'Média' },
  { value: 'high', label: 'Alta' },
];

function PickOnly({
  options = OPTIONS,
  onChange,
}: {
  options?: SearchableSelectOption[];
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <SearchableSelect
      searchable={false}
      options={options}
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      label="Prioridade"
      placeholder="Escolha a prioridade"
      emptyMessage="Sem prioridades"
    />
  );
}

const field = () => screen.getByRole('combobox', { name: 'Prioridade' });

describe('SearchableSelect without search', () => {
  it('shows the placeholder, opens with Enter and closes with Escape or a second click', () => {
    render(<PickOnly />);
    expect(field()).toHaveTextContent('Escolha a prioridade');
    expect(screen.getByText('Escolha a prioridade')).toHaveClass('text-[var(--text-muted)]');

    // Escape on a closed field is left to the surrounding dialog.
    const escapeClosed = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    field().dispatchEvent(escapeClosed);
    expect(escapeClosed.defaultPrevented).toBe(false);

    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByRole('listbox', { name: 'Prioridade' })).toBeInTheDocument();
    const onDialogKey = vi.fn();
    document.addEventListener('keydown', onDialogKey);
    fireEvent.keyDown(field(), { key: 'Escape' });
    document.removeEventListener('keydown', onDialogKey);
    expect(onDialogKey).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(field());
    expect(field()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(field());
    expect(field()).toHaveAttribute('aria-expanded', 'false');
  });

  it('moves through the options with the arrows and picks with Space', () => {
    const onChange = vi.fn();
    render(<PickOnly onChange={onChange} />);

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    fireEvent.keyDown(field(), { key: ' ' });
    expect(onChange).toHaveBeenCalledWith('medium');
    expect(field()).toHaveTextContent('Média');
  });

  it('says there is nothing to pick when the list is empty', () => {
    const onChange = vi.fn();
    render(<PickOnly options={[]} onChange={onChange} />);
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(screen.getByText('Sem prioridades')).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
