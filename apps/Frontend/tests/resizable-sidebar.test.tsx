import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResizableSidebar } from '../src/components/layout/ResizableSidebar.js';

describe('ResizableSidebar', () => {
  const pointerEvent = (type: string, properties: { button?: number; clientX?: number } = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.entries(properties).forEach(([key, value]) => {
      Object.defineProperty(event, key, { value });
    });
    return event;
  };

  it('resizes by pointer drag and respects both width limits', () => {
    const { getByRole, getByTestId } = render(
      <ResizableSidebar data-testid="sidebar" defaultWidth={240} minWidth={200} maxWidth={400}>
        Content
      </ResizableSidebar>,
    );
    const sidebar = getByTestId('sidebar');
    const handle = getByRole('separator', { name: 'Redimensionar barra lateral' });

    expect(sidebar.style.width).toBe('240px');
    fireEvent(handle, pointerEvent('pointerdown', { button: 1 }));
    fireEvent(window, pointerEvent('pointermove', { clientX: 300 }));
    expect(sidebar.style.width).toBe('240px');

    fireEvent(handle, pointerEvent('pointerdown', { button: 0, clientX: 340 }));
    fireEvent(window, pointerEvent('pointermove', { clientX: 600 }));
    expect(sidebar.style.width).toBe('400px');
    expect(document.body.style.cursor).toBe('col-resize');

    fireEvent(window, pointerEvent('pointermove', { clientX: 0 }));
    expect(sidebar.style.width).toBe('200px');
    fireEvent(window, pointerEvent('pointercancel'));
    expect(document.body.style.cursor).toBe('');
  });

  it('stops at the available parent width without overflowing the container', () => {
    const { getByRole, getByTestId } = render(
      <div data-testid="container">
        <ResizableSidebar data-testid="sidebar" defaultWidth={240} maxWidth="container">
          Content
        </ResizableSidebar>
      </div>,
    );
    const container = getByTestId('container');
    const sidebar = getByTestId('sidebar');
    const handle = getByRole('separator', { name: 'Redimensionar barra lateral' });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 900,
      top: 0,
      width: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent(handle, pointerEvent('pointerdown', { button: 0, clientX: 240 }));
    fireEvent(window, pointerEvent('pointermove', { clientX: 2000 }));

    expect(sidebar.style.width).toBe('900px');
    expect(sidebar.style.maxWidth).toBe('100%');
  });

  it('supports accessible keyboard resizing', () => {
    const { getByRole } = render(<ResizableSidebar>Content</ResizableSidebar>);
    const handle = getByRole('separator');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '250');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '240');
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(handle).toHaveAttribute('aria-valuenow', '240');

    fireEvent(handle, pointerEvent('pointerdown', { button: 0 }));
    fireEvent(window, pointerEvent('pointerup'));
  });

  it('allows a consumer to resize up to the full viewport width', () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const { getByRole, getByTestId } = render(
      <ResizableSidebar data-testid="sidebar" maxWidth="viewport">
        Content
      </ResizableSidebar>,
    );
    const handle = getByRole('separator');

    fireEvent(handle, pointerEvent('pointerdown', { button: 0, clientX: 300 }));
    fireEvent(window, pointerEvent('pointermove', { clientX: 2000 }));

    expect(getByTestId('sidebar').style.width).toBe('1440px');
    expect(handle).toHaveAttribute('aria-valuemax', '1440');
    fireEvent(window, pointerEvent('pointerup'));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('resizes a right sidebar from its left edge', () => {
    const { getByRole, getByTestId } = render(
      <ResizableSidebar data-testid="sidebar" defaultWidth={300} resizeEdge="left">
        Content
      </ResizableSidebar>,
    );
    const handle = getByRole('separator');
    expect(handle).toHaveClass('left-0');
    fireEvent(handle, pointerEvent('pointerdown', { button: 0, clientX: 700 }));
    fireEvent(window, pointerEvent('pointermove', { clientX: 650 }));
    expect(getByTestId('sidebar').style.width).toBe('350px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(getByTestId('sidebar').style.width).toBe('360px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(getByTestId('sidebar').style.width).toBe('350px');
    fireEvent(window, pointerEvent('pointerup'));
  });
});
