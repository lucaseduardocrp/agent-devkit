import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../src/components/ui/modal.js';

describe('Modal stacking', () => {
  it('closes only the topmost modal on Escape', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const view = render(
      <Modal open onClose={closeOuter}>
        <p>outer</p>
      </Modal>,
    );
    view.rerender(
      <Modal open onClose={closeOuter}>
        <Modal open onClose={closeInner}>
          <p>inner</p>
        </Modal>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();

    view.rerender(
      <Modal open onClose={closeOuter}>
        <Modal open={false} onClose={closeInner}>
          <p>inner</p>
        </Modal>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeOuter).toHaveBeenCalledOnce();
    expect(closeInner).toHaveBeenCalledOnce();
  });
});
