import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/components/layout/Sidebar.js';

const COLLAPSED_KEY = 'adk.sidebar.collapsed';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('Sidebar collapsed mode', () => {
  it('collapses to icons, remembers it and expands again', () => {
    render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Recolher barra lateral' }));
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('1');
    const expand = screen.getByRole('button', { name: 'Expandir barra lateral' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Brain' })).not.toHaveTextContent('Brain');

    fireEvent.click(expand);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('0');
    expect(screen.getByRole('button', { name: 'Recolher barra lateral' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('names an icon in a tooltip while it is hovered or focused', () => {
    localStorage.setItem(COLLAPSED_KEY, '1');
    const onSelectTab = vi.fn();
    render(<Sidebar activeTab="workspaces" onSelectTab={onSelectTab} inboxUnreadCount={3} />);

    const settings = screen.getByTestId('sidebar-settings-footer-button');
    fireEvent.mouseEnter(settings.parentElement!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Configurações');
    fireEvent.mouseLeave(settings.parentElement!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.focus(settings);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Configurações');
    fireEvent.blur(settings);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // The unread badge stays on the icon and the workspaces entry shows it is open.
    expect(screen.getByLabelText('3 unread')).toHaveTextContent('3');
    const workspaces = screen.getByTestId('sidebar-workspaces-button');
    expect(workspaces.className).toContain('bg-[var(--fill-ghost-selected)]');
    fireEvent.click(workspaces);
    expect(onSelectTab).toHaveBeenCalledWith('workspaces');
  });

  it('works without storage, starting expanded and still collapsing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Recolher barra lateral' }));
    expect(screen.getByRole('button', { name: 'Expandir barra lateral' })).toBeInTheDocument();
  });
});
