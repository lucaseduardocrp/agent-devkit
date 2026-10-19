import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacesView } from '../src/features/workspaces/WorkspacesView.js';
import type { UserWorkspaceMembership } from '../src/features/workspaces/workspace-types.js';

describe('WorkspacesView', () => {
  const mockWorkspaces: readonly UserWorkspaceMembership[] = [
    {
      workspace: {
        id: 'ws-1',
        name: 'Workspace Alpha',
        slug: 'alpha',
        ownerId: 'usr-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      member: {
        id: 'm-1',
        workspaceId: 'ws-1',
        userId: 'usr-1',
        role: 'ADMIN',
        permissions: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
    {
      workspace: {
        id: 'ws-2',
        name: 'Workspace Beta',
        slug: 'beta',
        ownerId: 'usr-2',
        createdAt: '',
      },
      member: {
        id: 'm-2',
        workspaceId: 'ws-2',
        userId: 'usr-1',
        role: 'VIEWER',
        permissions: {},
        createdAt: '',
      },
    },
    {
      workspace: {
        id: 'ws-3',
        name: 'Workspace Gamma',
        slug: 'gamma',
        ownerId: 'usr-3',
        createdAt: '',
      },
      member: {
        id: 'm-3',
        workspaceId: 'ws-3',
        userId: 'usr-1',
        role: 'INTEGRATOR',
        permissions: {},
        createdAt: '',
      },
    },
    {
      workspace: {
        id: 'ws-4',
        name: 'Workspace Delta',
        slug: 'delta',
        ownerId: 'usr-4',
        createdAt: '',
      },
      member: {
        id: 'm-4',
        workspaceId: 'ws-4',
        userId: 'usr-1',
        role: 'MEMBER',
        permissions: {},
        createdAt: '',
      },
    },
  ];

  it('renders empty state when there are no workspaces', () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    const { getByText } = render(
      <WorkspacesView
        workspaces={[]}
        activeWorkspaceId={null}
        onSelectWorkspace={onSelect}
        onCreateWorkspace={onCreate}
      />,
    );

    expect(
      getByText(/nenhum workspace encontrado\. crie o primeiro workspace acima/i),
    ).toBeInTheDocument();
  });

  it('renders workspaces list and allows selecting an inactive workspace', () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    const { getByText, getByRole } = render(
      <WorkspacesView
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={onSelect}
        onCreateWorkspace={onCreate}
      />,
    );

    expect(getByText('Workspace Alpha')).toBeInTheDocument();
    expect(getByText('Workspace Ativo')).toBeInTheDocument();
    expect(getByText('Workspace Beta')).toBeInTheDocument();
    expect(getByText('Administrador')).toBeInTheDocument();
    expect(getByText('Visualizador')).toBeInTheDocument();
    expect(getByText('Integrador')).toBeInTheDocument();
    expect(getByText('Membro')).toBeInTheDocument();

    const selectBetaBtn = getByRole('button', { name: 'Selecionar workspace Workspace Beta' });
    fireEvent.click(selectBetaBtn);
    expect(onSelect).toHaveBeenCalledWith('ws-2');
  });

  it('validates empty workspace name on form submit', async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    const { getByRole, getByText } = render(
      <WorkspacesView
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={onSelect}
        onCreateWorkspace={onCreate}
      />,
    );

    fireEvent.click(getByRole('button', { name: 'Criar Workspace' }));
    expect(getByText('Nome do workspace é obrigatório.')).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('submits workspace creation with name and slug successfully', async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);

    const { getByLabelText, getByRole } = render(
      <WorkspacesView
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={onSelect}
        onCreateWorkspace={onCreate}
      />,
    );

    const nameInput = getByLabelText(/nome do workspace/i);
    const slugInput = getByLabelText(/slug \/ identificador/i);

    fireEvent.change(nameInput, { target: { value: 'Novo Espaço' } });
    fireEvent.change(slugInput, { target: { value: 'novo-espaco' } });
    fireEvent.click(getByRole('button', { name: 'Criar Workspace' }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: 'Novo Espaço',
        slug: 'novo-espaco',
      });
    });

    expect((nameInput as HTMLInputElement).value).toBe('');
    expect((slugInput as HTMLInputElement).value).toBe('');
  });

  it('submits workspace creation without slug successfully', async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);

    const { getByLabelText, getByRole } = render(
      <WorkspacesView
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={onSelect}
        onCreateWorkspace={onCreate}
      />,
    );

    const nameInput = getByLabelText(/nome do workspace/i);
    fireEvent.change(nameInput, { target: { value: 'Apenas Nome' } });
    fireEvent.click(getByRole('button', { name: 'Criar Workspace' }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: 'Apenas Nome',
        slug: undefined,
      });
    });
  });

  it('handles creation error with Error instance and fallback message', async () => {
    const onSelect = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Slug duplicado'))
      .mockRejectedValueOnce('Falha desconhecida');

    const { getByLabelText, getByRole, findByText } = render(
      <WorkspacesView
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={onSelect}
        onCreateWorkspace={onCreate}
      />,
    );

    const nameInput = getByLabelText(/nome do workspace/i);

    // 1. Error instance
    fireEvent.change(nameInput, { target: { value: 'Tentativa 1' } });
    fireEvent.click(getByRole('button', { name: 'Criar Workspace' }));
    expect(await findByText('Slug duplicado')).toBeInTheDocument();

    // 2. Fallback error message
    fireEvent.change(nameInput, { target: { value: 'Tentativa 2' } });
    fireEvent.click(getByRole('button', { name: 'Criar Workspace' }));
    expect(await findByText('Falha ao criar workspace.')).toBeInTheDocument();
  });

  it('renders loading skeleton when isLoading is true', () => {
    const { getByTestId } = render(
      <WorkspacesView
        workspaces={[]}
        activeWorkspaceId={null}
        isLoading={true}
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );

    expect(getByTestId('workspaces-loading-skeleton')).toBeInTheDocument();
  });
});
