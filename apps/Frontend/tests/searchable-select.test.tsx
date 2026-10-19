import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from '../src/components/ui/searchable-select.js';

const options = [
  { value: '101', label: '101 · Login válido' },
  { value: '102', label: '102 · Senha incorreta' },
];

describe('SearchableSelect', () => {
  it('filters options by label or ID and emits only a selected value', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        options={options}
        value=""
        onChange={onChange}
        label="Caso"
        placeholder="Buscar caso"
        emptyMessage="Sem resultados"
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Caso' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'senha' } });
    expect(screen.getByRole('option', { name: '102 · Senha incorreta' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '101 · Login válido' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('102');
  });

  it('shows an empty state and closes with Escape', () => {
    render(
      <SearchableSelect
        options={options}
        value=""
        onChange={vi.fn()}
        label="Caso"
        placeholder="Buscar caso"
        emptyMessage="Sem resultados"
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Caso' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'inexistente' } });
    expect(screen.getByText('Sem resultados')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
