import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton, iconButtonVariants } from '../src/components/ui/icon-button.js';

describe('IconButton', () => {
  it('renders with default variant and default 40px size with accessible attributes', () => {
    const { getByRole } = render(
      <IconButton label="Editar item" icon={<i className="ti ti-edit" />} />,
    );
    const btn = getByRole('button', { name: 'Editar item' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label', 'Editar item');
    expect(btn).toHaveAttribute('title', 'Editar item');
    expect(btn.className).toContain('h-[40px]');
    expect(btn.className).toContain('w-[40px]');
  });

  it('allows overriding title prop', () => {
    const { getByRole } = render(
      <IconButton
        label="Ação rápida"
        title="Dica de ferramenta personalizada"
        icon={<i className="ti ti-star" />}
      />,
    );
    const btn = getByRole('button', { name: 'Ação rápida' });
    expect(btn).toHaveAttribute('title', 'Dica de ferramenta personalizada');
  });

  it('renders with children instead of icon prop', () => {
    const { getByText } = render(
      <IconButton label="Fechar">
        <span data-testid="custom-child">X</span>
      </IconButton>,
    );
    expect(getByText('X')).toBeInTheDocument();
  });

  it('renders all variant styles correctly', () => {
    const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'subtle'] as const;

    for (const variant of variants) {
      const { getByRole } = render(
        <IconButton
          variant={variant}
          label={`Botão ${variant}`}
          icon={<i className="ti ti-check" />}
        />,
      );
      expect(getByRole('button', { name: `Botão ${variant}` })).toBeInTheDocument();
    }
  });

  it('renders different sizes (sm, xs, lg)', () => {
    const { getByRole: getSm } = render(
      <IconButton size="sm" label="Botão sm" icon={<i className="ti ti-x" />} />,
    );
    expect(getSm('button', { name: 'Botão sm' }).className).toContain('h-8');

    const { getByRole: getXs } = render(
      <IconButton size="xs" label="Botão xs" icon={<i className="ti ti-x" />} />,
    );
    expect(getXs('button', { name: 'Botão xs' }).className).toContain('h-6');

    const { getByRole: getLg } = render(
      <IconButton size="lg" label="Botão lg" icon={<i className="ti ti-x" />} />,
    );
    expect(getLg('button', { name: 'Botão lg' }).className).toContain('h-12');
  });

  it('renders loading state with spinner and disables button', () => {
    const onClick = vi.fn();
    const { getByRole, container } = render(
      <IconButton
        label="Salvando"
        isLoading={true}
        onClick={onClick}
        icon={<i className="ti ti-check" />}
      />,
    );
    const btn = getByRole('button', { name: 'Salvando' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('.ti-loader-2.animate-spin')).toBeInTheDocument();

    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('handles click and disabled state', () => {
    const onClick = vi.fn();
    const { getByRole, rerender } = render(
      <IconButton label="Clique" onClick={onClick} icon={<i className="ti ti-click" />} />,
    );
    const btn = getByRole('button', { name: 'Clique' });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <IconButton
        label="Clique"
        disabled={true}
        onClick={onClick}
        icon={<i className="ti ti-click" />}
      />,
    );
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards ref to button element', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<IconButton ref={ref} label="Com ref" icon={<i className="ti ti-pin" />} />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('exposes iconButtonVariants helper', () => {
    expect(iconButtonVariants({ variant: 'destructive', size: 'lg' })).toContain(
      'bg-[var(--fill-danger)]',
    );
  });
});
