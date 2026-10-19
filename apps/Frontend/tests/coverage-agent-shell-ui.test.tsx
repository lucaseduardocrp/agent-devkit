import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsMenu } from '../src/components/ui/actions-menu.js';
import { Button } from '../src/components/ui/button.js';
import { ConfirmationDialog } from '../src/components/ui/confirmation-dialog.js';
import { Modal } from '../src/components/ui/modal.js';
import { SearchableSelect } from '../src/components/ui/searchable-select.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Modal backdrop', () => {
  it('closes only when the backdrop itself is pressed and backdrop closing is enabled', () => {
    const onClose = vi.fn();
    const view = render(
      <Modal open onClose={onClose} labelledBy="modal-title">
        <h2 id="modal-title">Detalhes</h2>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Detalhes' });
    const backdrop = dialog.parentElement!;

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      <Modal open closeOnBackdrop={false} onClose={onClose} labelledBy="modal-title">
        <h2 id="modal-title">Detalhes</h2>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores backdrop presses when no close handler is provided', () => {
    render(
      <Modal open labelledBy="modal-title">
        <h2 id="modal-title">Sem fechamento</h2>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Sem fechamento' });
    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Sem fechamento' })).toBeInTheDocument();
  });
});

describe('ConfirmationDialog', () => {
  it('cancels with Escape unless the confirmation is loading', () => {
    const onCancel = vi.fn();
    const props = {
      open: true,
      title: 'Arquivar item',
      description: 'O item será arquivado.',
      confirmLabel: 'Arquivar',
      cancelLabel: 'Voltar',
      onConfirm: vi.fn(),
      onCancel,
    };
    const view = render(<ConfirmationDialog {...props} />);

    const confirm = screen.getByRole('button', { name: 'Arquivar' });
    expect(confirm.className).toContain('bg-[var(--fill-accent)]');
    expect(confirm.className).not.toContain('bg-[var(--fill-danger)]');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Voltar' }));

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();

    onCancel.mockClear();
    view.rerender(<ConfirmationDialog {...props} isLoading />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

function NestedPortalButton({ label }: { readonly label: string }) {
  return createPortal(<button type="button">{label}</button>, document.body);
}

function rect(values: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...values,
  } as DOMRect;
}

describe('ActionsMenu in a portal', () => {
  it('opens above the trigger when there is no room below it', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'menu'
        ? rect({ width: 220, height: 200 })
        : rect({ top: 700, bottom: 730, left: 260, right: 300, width: 40, height: 30 });
    });
    render(
      <ActionsMenu portal>
        <Button>Editar</Button>
      </ActionsMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));

    const menu = screen.getByRole('menu', { name: 'Ações' });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.top).toBe('496px');
    expect(menu.style.left).toBe('80px');
  });

  it('ignores keys pressed inside content portaled out of the menu', () => {
    render(
      <ActionsMenu portal>
        <Button>Editar</Button>
        <NestedPortalButton label="Janela aninhada" />
      </ActionsMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Janela aninhada' }), {
      key: 'Escape',
    });

    expect(screen.getByRole('menu', { name: 'Ações' })).toBeInTheDocument();
  });
});

describe('SearchableSelect keyboard and pointer behavior', () => {
  const options = [
    { value: '101', label: '101 · Login válido' },
    { value: '102', label: '102 · Senha incorreta' },
    { value: '103', label: '103 · Conta bloqueada' },
  ];

  it('moves the active option with the arrow keys and selects it with Enter', () => {
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

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const optionId = (label: string) => screen.getByRole('option', { name: label }).id;
    expect(input).toHaveAttribute('aria-activedescendant', optionId('102 · Senha incorreta'));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', optionId('103 · Conta bloqueada'));

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', optionId('101 · Login válido'));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('102');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps the first index when there are no matches to move through', () => {
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
    fireEvent.change(input, { target: { value: 'nada' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByText('Sem resultados')).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('clears the current value when the user types a new search', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        options={options}
        value="101"
        onChange={onChange}
        label="Caso"
        placeholder="Buscar caso"
        emptyMessage="Sem resultados"
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Caso' }) as HTMLInputElement;
    expect(input.value).toBe('101 · Login válido');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'conta' } });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('keeps focus on the input when an option is pressed and closes when focus leaves', () => {
    const onChange = vi.fn();
    render(
      <>
        <SearchableSelect
          options={options}
          value=""
          onChange={onChange}
          label="Caso"
          placeholder="Buscar caso"
          emptyMessage="Sem resultados"
        />
        <button type="button">Fora</button>
      </>,
    );
    const input = screen.getByRole('combobox', { name: 'Caso' });
    fireEvent.focus(input);
    const option = screen.getByRole('option', { name: '103 · Conta bloqueada' });

    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.blur(input, { relatedTarget: option });
    expect(screen.getByRole('listbox', { name: 'Caso' })).toBeInTheDocument();

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('103');

    fireEvent.focus(input);
    expect(screen.getByRole('listbox', { name: 'Caso' })).toBeInTheDocument();
    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Fora' }) });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
