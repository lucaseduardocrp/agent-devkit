import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResizableSidebar } from '../src/components/layout/ResizableSidebar.js';

const pointerEvent = (type: string, properties: { button?: number; clientX?: number } = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.entries(properties).forEach(([key, value]) => {
    Object.defineProperty(event, key, { value });
  });
  return event;
};

describe('ResizableSidebar drag end', () => {
  it('keeps the dropped width when the pointer is released and cancelled at once', () => {
    render(
      <ResizableSidebar data-testid="sidebar" defaultWidth={240} minWidth={200} maxWidth={400}>
        Content
      </ResizableSidebar>,
    );
    const sidebar = screen.getByTestId('sidebar');
    const handle = screen.getByRole('separator', { name: 'Redimensionar barra lateral' });

    fireEvent(handle, pointerEvent('pointerdown', { button: 0, clientX: 100 }));
    fireEvent(window, pointerEvent('pointermove', { clientX: 160 }));
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup'));
      window.dispatchEvent(pointerEvent('pointercancel'));
    });

    expect(sidebar.style.width).toBe('300px');
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    expect(document.body.style.cursor).toBe('');
  });
});
