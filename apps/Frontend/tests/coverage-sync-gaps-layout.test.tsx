import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResizableSidebar } from '../src/components/layout/ResizableSidebar.js';
import { MenuItem, MenuPanel } from '../src/features/development/development-menu.js';

const pointer = (type: string, properties: { button?: number; clientX?: number } = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.entries(properties).forEach(([key, value]) => {
    Object.defineProperty(event, key, { value });
  });
  return event;
};

describe('MenuPanel dismissal', () => {
  function open(onClose = vi.fn()) {
    const view = render(
      <div>
        <button type="button" aria-haspopup="menu" aria-expanded="true">
          Trigger
        </button>
        <MenuPanel label="Actions" onClose={onClose}>
          <MenuItem onSelect={vi.fn()}>Inside</MenuItem>
        </MenuPanel>
        <button type="button" aria-haspopup="menu" aria-expanded="true" data-testid="other">
          Other trigger
        </button>
      </div>,
    );
    return { view, onClose };
  }

  it('stays open for a press inside the menu or on its own trigger', () => {
    const { view, onClose } = open();
    fireEvent.pointerDown(view.getByRole('menuitem', { name: 'Inside' }));
    fireEvent.pointerDown(view.getByText('Trigger'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes for a press elsewhere, including the trigger of another menu', () => {
    const { view, onClose } = open();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Its wrapper is the parent of the trigger that opened it; this one is outside it only
    // when it lives in another wrapper.
    const outside = document.createElement('button');
    outside.setAttribute('aria-haspopup', 'menu');
    outside.setAttribute('aria-expanded', 'true');
    document.body.append(outside);
    fireEvent.pointerDown(outside);
    expect(onClose).toHaveBeenCalledTimes(2);
    outside.remove();
    view.unmount();
  });

  it('lets an item outside any menu be chosen without a menu to close', () => {
    const onSelect = vi.fn();
    const view = render(<MenuItem onSelect={onSelect}>Alone</MenuItem>);
    fireEvent.click(view.getByRole('menuitem', { name: 'Alone' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe('ResizableSidebar with the divider in the page gap', () => {
  it('marks a collapsed sidebar and clips what it holds', () => {
    const view = render(
      <ResizableSidebar gap collapsed onCollapse={vi.fn()} onExpand={vi.fn()} data-testid="side">
        Content
      </ResizableSidebar>,
    );
    const side = view.getByTestId('side');
    expect(side).toHaveAttribute('data-collapsed', 'true');
    expect(side.querySelector('aside')!.className).toContain('overflow-hidden');
  });

  it('highlights the divider while it is dragged', () => {
    const view = render(
      <ResizableSidebar gap data-testid="side">
        Content
      </ResizableSidebar>,
    );
    const handle = view.getByRole('separator');
    expect(handle.className).not.toContain('after:w-0.5 after:bg-[var(--fill-accent)]');
    fireEvent(handle, pointer('pointerdown', { button: 0, clientX: 240 }));
    expect(handle.className).toContain('after:bg-[var(--fill-accent)]');
    fireEvent(window, pointer('pointerup'));
  });
});
