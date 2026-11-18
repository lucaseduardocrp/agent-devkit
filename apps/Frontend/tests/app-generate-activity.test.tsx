import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiClient } from '../src/lib/api-client.js';
import { pickOption } from './helpers/pick-option.js';

describe('App: generating tests runs as a background activity', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('adk_locale', 'pt-BR');
  });

  it('shows the generation in the bell while it runs and notifies when it is done', async () => {
    const client = new ApiClient();
    localStorage.setItem('adk_token', 'stored-token');
    vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'r' });
    vi.spyOn(client, 'getMe').mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      name: 'Ana',
      createdAt: '2026-09-11T12:00:00Z',
    });
    vi.spyOn(client, 'getWorkspaces').mockResolvedValue([
      {
        workspace: { id: 'ws-1', name: 'WS', slug: 'ws-1', ownerId: 'u1', createdAt: '' },
        member: {
          id: 'm1',
          workspaceId: 'ws-1',
          userId: 'u1',
          role: 'ADMIN',
          permissions: {},
          createdAt: '',
        },
      },
    ]);
    vi.spyOn(client, 'getTestSuites').mockResolvedValue([
      { id: 's1', workspaceId: 'ws-1', name: 'Regression', createdAt: '', updatedAt: '' },
    ]);
    vi.spyOn(client, 'getSavedTestPlans').mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 8,
      total: 0,
      totalPages: 0,
    });
    vi.spyOn(client, 'getAllSavedTestPlans').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    vi.spyOn(client, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: false,
      organization: null,
      project: null,
      members: [],
    });
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    let finish!: (value: Awaited<ReturnType<ApiClient['generateTestPlan']>>) => void;
    vi.spyOn(client, 'generateTestPlan').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    render(<App apiClient={client} initialTab="testplans" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo Test Plan' }));
    await pickOption(await screen.findByRole('combobox', { name: 'Test suite' }), 'Regression');
    fireEvent.change(screen.getByLabelText('User story / requisito'), {
      target: { value: 'Pagar com Pix' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar testes' }));

    await waitFor(() => expect(client.generateTestPlan).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    expect(screen.queryByText('Nenhuma atividade recente.')).toBeNull();
    expect(screen.getByText(/Pagar com Pix/)).toBeInTheDocument();

    await act(async () =>
      finish({
        plans: [{ title: 'Pix', description: '', steps: [] }],
        csv: '',
        savedPlan: {
          id: 'p1',
          workspaceId: 'ws-1',
          title: 'Pix',
          suiteId: 's1',
          plans: [{ title: 'Pix', description: '', steps: [] }],
          createdAt: '',
          updatedAt: '',
        },
      }),
    );
    expect(await screen.findByText('Concluída')).toBeInTheDocument();
  });
});
