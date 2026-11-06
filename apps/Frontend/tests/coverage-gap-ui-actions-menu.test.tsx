import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionsMenu } from '../src/components/ui/actions-menu.js';

describe('ActionsMenu button trigger', () => {
  it('toggles on click and opens with the arrow keys', () => {
    render(
      <ActionsMenu trigger="button" label="Mais">
        <button type="button">Item</button>
      </ActionsMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Mais' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(trigger, { key: 'a' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });
});
