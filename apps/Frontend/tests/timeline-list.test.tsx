import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimelineList } from '../src/features/development/TimelineList.js';
import type { DevSession } from '../src/features/development/development-types.js';

type Event = DevSession['events'][number];

const event = (id: string, kind: Event['kind'], text: string): Event => ({
  id,
  kind,
  text,
  at: '2026-11-10T10:18:00.000Z',
  subagentId: null,
});

const LONG = `First line of the answer\nSecond line with more detail`;

describe('TimelineList', () => {
  it('keeps short events plain, without a fold control', () => {
    render(<TimelineList events={[event('e1', 'status', 'Session queued.')]} />);
    expect(screen.getByText('Session queued.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('folds a multi-line event to its first line and opens it on demand', () => {
    render(<TimelineList events={[event('e1', 'message', LONG)]} />);
    expect(screen.getByText('First line of the answer')).toBeTruthy();
    expect(screen.queryByRole('region')).toBeNull();

    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('region').textContent).toBe(LONG);

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('cuts a long single line to a preview', () => {
    const text = 'x'.repeat(200);
    render(<TimelineList events={[event('e1', 'tool', text)]} />);
    expect(screen.getByText(`${'x'.repeat(120)}…`)).toBeTruthy();
  });

  it('opens and folds every event from the header', () => {
    render(
      <TimelineList
        events={[event('e1', 'message', LONG), event('e2', 'message', `${LONG}\nthird`)]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^(Expand all|Expandir tudo)/ }));
    expect(screen.getAllByRole('region')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /^(Collapse all|Recolher tudo)/ }));
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });
});
