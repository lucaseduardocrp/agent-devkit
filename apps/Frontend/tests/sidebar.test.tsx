import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/components/layout/Sidebar.js';

// jsdom has no PointerEvent: a MouseEvent with the same type carries clientX.
const moveTo = (clientX: number) =>
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
  });

const pressAt = (element: Element, clientX: number) =>
  fireEvent(element, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX }));

const release = () =>
  act(() => {
    window.dispatchEvent(new MouseEvent('pointerup'));
  });

describe('Sidebar', () => {
  it('renders navigation sections and settings in footer', () => {
    const onSelect = vi.fn();
    const { getByText, queryByText, getByRole, getByTestId } = render(
      <Sidebar activeTab="brain" onSelectTab={onSelect} />,
    );

    expect(getByText('Agent DevKit')).toBeInTheDocument();
    expect(getByText('Principal')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Integrações' })).toBeInTheDocument();
    expect(queryByText('Configuração')).not.toBeInTheDocument();

    const brainBtn = getByRole('button', { name: 'Brain' });
    expect(brainBtn).toHaveAttribute('aria-current', 'page');
    const navigationButtons = getByRole('navigation').querySelectorAll('button');
    expect(navigationButtons[0]).toHaveTextContent('Issues');
    expect(navigationButtons[1]).toHaveTextContent('PBIs');
    expect(navigationButtons[2]).toHaveTextContent('Inbox');
    expect(navigationButtons[3]).toHaveTextContent('Dashboard');

    const settingsFooterBtn = getByTestId('sidebar-settings-footer-button');
    expect(settingsFooterBtn).toBeInTheDocument();
  });

  it('renders and highlights Settings in the footer when activeTab is settings', () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(<Sidebar activeTab="settings" onSelectTab={onSelect} />);

    const settingsFooterBtn = getByTestId('sidebar-settings-footer-button');
    expect(settingsFooterBtn).toHaveAttribute('aria-current', 'page');
    expect(settingsFooterBtn.className).toContain('bg-[var(--fill-ghost-selected)]');
  });

  it('handles navigation item clicks including footer settings', () => {
    const onSelect = vi.fn();
    const { getByRole, getByTestId } = render(<Sidebar activeTab="brain" onSelectTab={onSelect} />);

    fireEvent.click(getByRole('button', { name: 'Brain' }));
    expect(onSelect).toHaveBeenCalledWith('brain');

    fireEvent.click(getByRole('button', { name: 'Agents' }));
    expect(onSelect).toHaveBeenCalledWith('agents');

    fireEvent.click(getByRole('button', { name: 'Spec' }));
    expect(onSelect).toHaveBeenCalledWith('spec');

    fireEvent.click(getByRole('button', { name: 'Integrações' }));
    expect(onSelect).toHaveBeenCalledWith('connect');

    fireEvent.click(getByTestId('sidebar-settings-footer-button'));
    expect(onSelect).toHaveBeenCalledWith('settings');
  });

  it('renders and highlights Agents tab when activeTab is agents', () => {
    const onSelect = vi.fn();
    const { getByRole } = render(<Sidebar activeTab="agents" onSelectTab={onSelect} />);

    const agentsBtn = getByRole('button', { name: 'Agents' });
    expect(agentsBtn).toHaveAttribute('aria-current', 'page');
    expect(agentsBtn.className).toContain('bg-[var(--fill-ghost-selected)]');
  });

  it('toggles the Test submenu and navigates to Test Plans', () => {
    const onSelect = vi.fn();
    const { getByRole } = render(<Sidebar activeTab="brain" onSelectTab={onSelect} />);

    const testBtn = getByRole('button', { name: /^Test$/i });
    expect(testBtn).toHaveAttribute('aria-expanded', 'false');

    // Click to expand
    fireEvent.click(testBtn);
    expect(testBtn).toHaveAttribute('aria-expanded', 'true');

    // Click child testplans
    const testPlansBtn = getByRole('button', { name: /Planos de Teste/i });
    fireEvent.click(testPlansBtn);
    expect(onSelect).toHaveBeenCalledWith('testplans');

    // Click to collapse
    fireEvent.click(testBtn);
    expect(testBtn).toHaveAttribute('aria-expanded', 'false');
  });

  it('initializes the Test submenu as expanded when a child is active', () => {
    const onSelect = vi.fn();
    const { getByRole, rerender } = render(
      <Sidebar activeTab="testplans" onSelectTab={onSelect} />,
    );

    const testBtn = getByRole('button', { name: /^Test$/i });
    expect(testBtn).toHaveAttribute('aria-expanded', 'true');

    const testPlansBtn = getByRole('button', { name: /Planos de Teste/i });
    expect(testPlansBtn).toHaveAttribute('aria-current', 'page');

    rerender(<Sidebar activeTab="brain" onSelectTab={onSelect} />);
  });

  it('renders workspace banner when authenticated and navigates to workspaces tab on click', () => {
    const onSelect = vi.fn();
    const mockWorkspaces = [
      {
        workspace: { id: 'w1', name: 'My WS', slug: 'my-ws', ownerId: 'u1', createdAt: '' },
        member: {
          id: 'm1',
          workspaceId: 'w1',
          userId: 'u1',
          role: 'ADMIN' as const,
          permissions: {},
          createdAt: '',
        },
      },
    ];
    const { getByTestId } = render(
      <Sidebar
        activeTab="brain"
        onSelectTab={onSelect}
        isAuthenticated={true}
        workspaces={mockWorkspaces}
        activeWorkspaceId="w1"
      />,
    );

    const wsBtn = getByTestId('sidebar-workspaces-button');
    expect(wsBtn).toHaveTextContent('My WS');
    fireEvent.click(wsBtn);
    expect(onSelect).toHaveBeenCalledWith('workspaces');
  });

  it('renders default Workspaces text when authenticated without active membership', () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <Sidebar
        activeTab="workspaces"
        onSelectTab={onSelect}
        isAuthenticated={true}
        workspaces={[]}
        activeWorkspaceId={null}
      />,
    );

    const wsBtn = getByTestId('sidebar-workspaces-button');
    expect(wsBtn).toHaveTextContent('Workspaces');
    expect(wsBtn).toHaveAttribute('aria-current', 'page');
  });

  it('follows the pointer below the minimum width and folds to icons when released there', () => {
    window.localStorage.removeItem('adk.sidebar.collapsed');
    const view = render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} />);
    const edge = () => view.getByRole('separator', { name: 'Redimensionar barra lateral' });
    pressAt(edge(), 280);
    moveTo(120);
    release();
    expect(view.getByRole('complementary')).toHaveAttribute('data-collapsed', 'true');
    // Only icons: the module name is the accessible label, without a visible text.
    expect(view.getByRole('button', { name: 'Brain' }).textContent).toBe('');
    expect(window.localStorage.getItem('adk.sidebar.collapsed')).toBe('1');

    // Released just below the minimum, it springs back to the minimum instead of folding.
    pressAt(edge(), 64);
    moveTo(280);
    release();
    expect(view.getByRole('complementary')).not.toHaveAttribute('data-collapsed');
    expect(view.getByRole('button', { name: 'Brain' }).textContent).toBe('Brain');
    pressAt(edge(), 280);
    moveTo(220);
    release();
    expect(view.getByRole('complementary')).not.toHaveAttribute('data-collapsed');
  });
});
