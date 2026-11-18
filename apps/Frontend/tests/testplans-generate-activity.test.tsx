import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActivityCenter, ActivityProvider } from '../src/features/activities/ActivityCenter.js';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import { pickOption } from './helpers/pick-option.js';

const ISO = '2026-09-18T00:00:00.000Z';
const WORKSPACES = [
  {
    workspace: { id: 'ws-1', name: 'Workspace', slug: 'ws', ownerId: 'u1', createdAt: '' },
    member: {
      id: 'm1',
      workspaceId: 'ws-1',
      userId: 'u1',
      role: 'ADMIN' as const,
      permissions: {},
      createdAt: '',
    },
  },
];

describe('TestPlansView generation as an activity', () => {
  it('lists the generation in the activity center while it runs, then reports it done', async () => {
    const api = new ApiClient();
    vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 8,
      total: 0,
      totalPages: 1,
    });
    vi.spyOn(api, 'getTestSuites').mockResolvedValue([
      { id: 'suite-1', workspaceId: 'ws-1', name: 'Regression', createdAt: ISO, updatedAt: ISO },
    ]);
    vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getAgents').mockResolvedValue([]);
    let finish!: (value: Awaited<ReturnType<ApiClient['generateTestPlan']>>) => void;
    vi.spyOn(api, 'generateTestPlan').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    render(
      <ActivityProvider>
        <ActivityCenter />
        <TestPlansView
          apiClient={api}
          initialTab="create"
          activeWorkspaceId="ws-1"
          workspaces={WORKSPACES}
        />
      </ActivityProvider>,
    );

    await pickOption(await screen.findByRole('combobox', { name: 'Test suite' }), 'Regression');
    fireEvent.change(screen.getByLabelText('User story / requisito'), {
      target: { value: 'Pagar com Pix' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar testes' }));

    expect(await screen.findByText('1 em andamento')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    expect(screen.getByText(/Pagar com Pix/)).toBeInTheDocument();

    await act(async () =>
      finish({
        plans: [{ title: 'Pix', description: '', steps: [] }],
        csv: '',
        savedPlan: {
          id: 'p1',
          workspaceId: 'ws-1',
          title: 'Pix',
          suiteId: 'suite-1',
          plans: [{ title: 'Pix', description: '', steps: [] }],
          createdAt: ISO,
          updatedAt: ISO,
        },
      }),
    );
    expect(await screen.findByText('Concluída')).toBeInTheDocument();
  });
});
