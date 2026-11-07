import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from '../src/components/ui/switch.js';

describe('Switch', () => {
  it('is an accessible switch that reports changes and can be disabled', () => {
    const onChange = vi.fn();
    const view = render(<Switch aria-label="Notify" checked={false} onChange={onChange} />);
    const input = view.getByRole('switch', { name: 'Notify' }) as HTMLInputElement;
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledTimes(1);

    view.rerender(
      <Switch aria-label="Notify" checked disabled className="extra" onChange={onChange} />,
    );
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.parentElement).toHaveClass('extra');
  });
});
