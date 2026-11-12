import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsMenu } from '../src/components/ui/actions-menu.js';
import { Button } from '../src/components/ui/button.js';
import { FieldLabel, HelpTooltip } from '../src/components/ui/help-tooltip.js';
import { Modal } from '../src/components/ui/modal.js';
import { Pagination, usePaging } from '../src/components/ui/pagination.js';
import { sanitizeHtml } from '../src/lib/sanitize-html.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ActionsMenu with a labelled button trigger', () => {
  it('opens from the click and from the arrow keys, and names the menu after the label', () => {
    const edit = vi.fn();
    render(
      <ActionsMenu trigger="button" label="Mais">
        <Button onClick={edit}>Edit</Button>
      </ActionsMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Mais' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Mais' })).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'x' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(edit).toHaveBeenCalledOnce();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes when focus moves to something outside both the trigger and the menu', () => {
    render(
      <div>
        <ActionsMenu trigger="button" label="Mais">
          <Button>Edit</Button>
        </ActionsMenu>
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mais' }));
    fireEvent.blur(screen.getByRole('button', { name: 'Mais' }), {
      relatedTarget: screen.getByRole('button', { name: 'Edit' }),
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.blur(screen.getByRole('button', { name: 'Mais' }), {
      relatedTarget: screen.getByRole('button', { name: 'outside' }),
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ActionsMenu portaled to the page', () => {
  const geometry = (anchor: { top: number; bottom: number; right: number }, menuHeight: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const isMenu = this.getAttribute('role') === 'menu';
      return isMenu
        ? ({
            top: 0,
            bottom: menuHeight,
            left: 0,
            right: 200,
            width: 200,
            height: menuHeight,
          } as DOMRect)
        : ({ ...anchor, left: anchor.right - 30, width: 30, height: 30 } as DOMRect);
    });

  it('opens below the trigger when it fits and follows the page while it is open', () => {
    geometry({ top: 100, bottom: 130, right: 400 }, 120);
    render(
      <ActionsMenu portal>
        <Button>Edit</Button>
      </ActionsMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    const menu = screen.getByRole('menu');
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.top).toBe('134px');
    expect(menu.style.left).toBe('200px');
    geometry({ top: 200, bottom: 230, right: 400 }, 120);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(menu.style.top).toBe('234px');
    geometry({ top: 300, bottom: 330, right: 400 }, 120);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(menu.style.top).toBe('334px');
  });

  it('flips above the trigger when there is no room below, and stays inside the viewport', () => {
    geometry({ top: 700, bottom: 730, right: 20 }, 120);
    render(
      <ActionsMenu portal>
        <Button>Edit</Button>
      </ActionsMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    const menu = screen.getByRole('menu');
    expect(menu.style.top).toBe('576px');
    expect(menu.style.left).toBe('8px');
  });
});

describe('HelpTooltip', () => {
  it('shows its text on hover, focus and click, and hides it on leave, blur and Escape', () => {
    render(<HelpTooltip>Explica o campo</HelpTooltip>);
    const icon = screen.getByRole('button', { name: 'Mais informações' });
    const tip = screen.getByRole('tooltip');
    expect(icon).toHaveAttribute('aria-describedby', tip.id);
    expect(tip).toHaveClass('sr-only');
    fireEvent.mouseEnter(icon.parentElement as HTMLElement);
    expect(tip).not.toHaveClass('sr-only');
    fireEvent.mouseLeave(icon.parentElement as HTMLElement);
    expect(tip).toHaveClass('sr-only');
    fireEvent.focus(icon);
    expect(tip).not.toHaveClass('sr-only');
    fireEvent.keyDown(icon, { key: 'x' });
    expect(tip).not.toHaveClass('sr-only');
    fireEvent.keyDown(icon, { key: 'Escape' });
    expect(tip).toHaveClass('sr-only');
    fireEvent.click(icon);
    expect(tip).not.toHaveClass('sr-only');
    fireEvent.blur(icon);
    expect(tip).toHaveClass('sr-only');
  });

  it('takes a custom accessible name and class', () => {
    const view = render(
      <HelpTooltip label="Ajuda" className="extra">
        Texto
      </HelpTooltip>,
    );
    expect(screen.getByRole('button', { name: 'Ajuda' })).toBeInTheDocument();
    expect(view.container.firstElementChild).toHaveClass('extra');
  });
});

describe('FieldLabel', () => {
  it('renders the label with an optional hint', () => {
    const view = render(
      <FieldLabel htmlFor="name" className="wide">
        Nome
      </FieldLabel>,
    );
    expect(screen.getByText('Nome')).toHaveAttribute('for', 'name');
    expect(screen.queryByRole('tooltip')).toBeNull();
    view.rerender(<FieldLabel hint="Dica">Nome</FieldLabel>);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dica');
  });
});

describe('Modal scroll lock', () => {
  it('locks every scrolling container behind the backdrop and restores it on close', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.overflow = 'visible';
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
    const fits = document.createElement('div');
    fits.style.overflowY = 'auto';
    Object.defineProperty(fits, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(fits, 'clientHeight', { value: 100, configurable: true });
    document.body.append(scroller, fits);

    const view = render(
      <Modal open>
        <p>Dentro</p>
      </Modal>,
    );
    expect(scroller.style.overflow).toBe('hidden');
    expect(fits.style.overflow).not.toBe('hidden');
    view.unmount();
    expect(scroller.style.overflow).not.toBe('hidden');
    scroller.remove();
    fits.remove();
  });

  it('ignores Escape and backdrop presses when it is not dismissible', () => {
    const onClose = vi.fn();
    render(
      <Modal open closeOnBackdrop={false} onClose={onClose} labelledBy="t" describedBy="d">
        <p id="t">Titulo</p>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    const surface = document.querySelector('[data-modal-surface]') as HTMLElement;
    fireEvent.mouseDown(surface);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-labelledby', 't');
  });

  it('closes from the backdrop but not from a press inside, and works without a handler', () => {
    const onClose = vi.fn();
    const view = render(
      <Modal open onClose={onClose}>
        <p>Dentro</p>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByText('Dentro'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector('[data-modal-surface]') as HTMLElement);
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(
      <Modal open>
        <p>Dentro</p>
      </Modal>,
    );
    fireEvent.mouseDown(document.querySelector('[data-modal-surface]') as HTMLElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('Dentro')).toBeInTheDocument();
  });
});

describe('usePaging storage failures', () => {
  it('keeps working for the visit when the preference cannot be stored', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    function List() {
      const paging = usePaging(60, { storageKey: 'g1-paging', resetKey: '' });
      return <Pagination paging={paging} perPageLabel="Itens por página" />;
    }
    render(<List />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Itens por página' }), {
      target: { value: '50' },
    });
    expect(setItem).toHaveBeenCalled();
    expect(screen.getByText(/Exibindo 1–50 de 60/)).toBeInTheDocument();
  });
});

describe('sanitizeHtml images', () => {
  it('drops an image without a source and keeps one with a safe source', () => {
    expect(sanitizeHtml('<p>a<img>b</p>')).toBe('<p>ab</p>');
    expect(sanitizeHtml('<img src="https://example.com/a.png" alt="x" onerror="evil()">')).toBe(
      '<img src="https://example.com/a.png" alt="x">',
    );
  });
});

describe('ActionsMenu with a dialog opened from an item', () => {
  it('ignores keys pressed inside a portaled child, which are not the menu own', () => {
    render(
      <ActionsMenu>
        <Modal open>
          <button type="button">inside dialog</button>
        </Modal>
        <Button>Edit</Button>
      </ActionsMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside dialog' }), { key: 'Escape' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
