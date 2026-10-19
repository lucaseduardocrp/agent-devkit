import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Topbar } from '../src/components/layout/Topbar.js';
import type { NavTab } from '../src/components/layout/Sidebar.js';

describe('Topbar', () => {
  it('renders correct header titles for all tabs', () => {
    const pairs: Array<[NavTab, string]> = [
      ['brain', 'Brain'],
      ['testplans', 'Planos de Teste'],
      ['connect', 'Integrações'],
      ['settings', 'Configurações'],
      ['workspaces', 'Workspaces'],
    ];

    pairs.forEach(([tab, title]) => {
      const { getByRole, unmount } = render(<Topbar activeTab={tab} />);
      expect(getByRole('heading', { level: 1 })).toHaveTextContent(title);
      unmount();
    });
  });

  it('renders user profile button and toggles dropdown menu on click', () => {
    const onAuthClick = vi.fn();
    const onLogout = vi.fn();
    const { getByRole, getByText, getByTestId, queryByTestId } = render(
      <Topbar
        activeTab="brain"
        isAuthenticated={true}
        userName="Ana Souza"
        userEmail="ana@example.com"
        userInitials="AS"
        onAuthClick={onAuthClick}
        onLogout={onLogout}
      />,
    );

    expect(getByText('Ana Souza')).toBeInTheDocument();
    expect(getByText('AS')).toBeInTheDocument();

    const menuBtn = getByRole('button', { name: 'Perfil: Ana Souza' });
    expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
    expect(queryByTestId('topbar-user-dropdown')).not.toBeInTheDocument();

    // Click to open dropdown
    fireEvent.click(menuBtn);
    expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
    expect(getByTestId('topbar-user-dropdown')).toBeInTheDocument();
    expect(getByText('ana@example.com')).toBeInTheDocument();

    // Click "Sair"
    const logoutItem = getByTestId('topbar-menu-logout');
    fireEvent.click(logoutItem);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(queryByTestId('topbar-user-dropdown')).not.toBeInTheDocument();
  });

  it('closes dropdown when clicking outside or pressing Escape', () => {
    const { getByTestId, queryByTestId } = render(
      <Topbar activeTab="brain" isAuthenticated={true} userName="Ana" onLogout={vi.fn()} />,
    );

    const menuBtn = getByTestId('topbar-user-menu-button');

    // Open and press Escape
    fireEvent.click(menuBtn);
    expect(getByTestId('topbar-user-dropdown')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByTestId('topbar-user-dropdown')).not.toBeInTheDocument();

    // Open and click outside
    fireEvent.click(menuBtn);
    expect(getByTestId('topbar-user-dropdown')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(queryByTestId('topbar-user-dropdown')).not.toBeInTheDocument();
  });

  it('does not render profile or logout actions in dropdown if callbacks are omitted', () => {
    const { getByTestId, queryByTestId } = render(
      <Topbar activeTab="brain" isAuthenticated={true} userName="Ana" />,
    );

    const menuBtn = getByTestId('topbar-user-menu-button');
    fireEvent.click(menuBtn);

    expect(getByTestId('topbar-user-dropdown')).toBeInTheDocument();
    expect(queryByTestId('topbar-menu-profile')).not.toBeInTheDocument();
    expect(queryByTestId('topbar-menu-logout')).not.toBeInTheDocument();
  });

  it('renders sign in button when unauthenticated and calls onAuthClick on click', () => {
    const onAuthClick = vi.fn();
    const { getByRole } = render(
      <Topbar activeTab="brain" isAuthenticated={false} onAuthClick={onAuthClick} />,
    );

    const loginBtn = getByRole('button', { name: 'Entrar no sistema' });
    expect(loginBtn).toBeInTheDocument();
    fireEvent.click(loginBtn);
    expect(onAuthClick).toHaveBeenCalledTimes(1);
  });

  it('renders fallback initials and user label when authenticated with undefined details', () => {
    const { getByRole, getByText, getByTestId } = render(
      <Topbar activeTab="brain" isAuthenticated={true} />,
    );

    const btn = getByRole('button', { name: 'Perfil: Usuário' });
    expect(btn).toBeInTheDocument();
    expect(getByText('US')).toBeInTheDocument();

    fireEvent.click(btn);
    expect(getByTestId('topbar-user-dropdown')).toHaveTextContent('Usuário');
  });

  it('renders user role badge next to user name and not inside dropdown', () => {
    const { getByTestId, getAllByText } = render(
      <Topbar activeTab="brain" isAuthenticated={true} userName="Ana Souza" userRole="ADMIN" />,
    );

    const roleBadge = getByTestId('topbar-user-role-badge');
    expect(roleBadge).toHaveTextContent('Admin');

    // Open dropdown and ensure role badge is not duplicated inside
    fireEvent.click(getByTestId('topbar-user-menu-button'));
    const adminBadges = getAllByText('Administrador');
    expect(adminBadges.length).toBe(1);
  });

  it('does not render the removed language switcher', () => {
    const { queryByTestId } = render(<Topbar activeTab="brain" />);
    expect(queryByTestId('topbar-language-switcher')).not.toBeInTheDocument();
  });
});
