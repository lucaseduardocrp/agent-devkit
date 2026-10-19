import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar, type NavTab } from '../src/components/layout/Sidebar.js';

describe('Sidebar work and core navigation', () => {
  it.each([
    ['issues', 'sidebar-issues-button'],
    ['pbis', 'sidebar-pbis-button'],
    ['dashboard', 'sidebar-dashboard-button'],
    ['inbox', 'sidebar-inbox-button'],
    ['design', 'sidebar-design-button'],
    ['releaseNotes', 'sidebar-release-notes-button'],
  ] as const)('marks %s as the current page and selects it on click', (tab, testId) => {
    const onSelect = vi.fn();
    const view = render(<Sidebar activeTab={tab as NavTab} onSelectTab={onSelect} />);

    const button = view.getByTestId(testId);
    expect(button).toHaveAttribute('aria-current', 'page');
    expect(button.className).toContain('bg-[var(--fill-ghost-selected)]');
    expect(view.getByRole('button', { name: 'Brain' })).not.toHaveAttribute('aria-current');

    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith(tab);
  });

  it('selects every work tab from another page', () => {
    const onSelect = vi.fn();
    const view = render(<Sidebar activeTab="brain" onSelectTab={onSelect} />);

    for (const testId of [
      'sidebar-issues-button',
      'sidebar-pbis-button',
      'sidebar-dashboard-button',
      'sidebar-inbox-button',
      'sidebar-design-button',
    ]) {
      expect(view.getByTestId(testId)).not.toHaveAttribute('aria-current');
      fireEvent.click(view.getByTestId(testId));
    }

    expect(onSelect.mock.calls.map(([tab]) => tab as NavTab)).toEqual([
      'issues',
      'pbis',
      'dashboard',
      'inbox',
      'design',
    ]);
  });

  it('shows the unread inbox count only when there are unread items', () => {
    const view = render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} inboxUnreadCount={3} />);
    expect(view.getByTestId('sidebar-inbox-button')).toHaveTextContent('3');
    expect(view.getByLabelText('3 unread')).toBeInTheDocument();
    expect(view.getByTestId('sidebar-dashboard-button').textContent).toBe('Dashboard');

    view.rerender(<Sidebar activeTab="brain" onSelectTab={vi.fn()} inboxUnreadCount={0} />);
    expect(view.queryByLabelText('0 unread')).not.toBeInTheDocument();
  });
});
