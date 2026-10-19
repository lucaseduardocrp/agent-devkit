import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eLocalRunnerPanel } from '../src/features/e2e/E2eLocalRunnerPanel.js';
import { E2eRepositoryPicker } from '../src/features/e2e/E2eRepositoryPicker.js';
import { E2eSavedCasePicker } from '../src/features/e2e/E2eSavedCasePicker.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('E2eRepositoryPicker', () => {
  it('shows a generic message when the repositories fail without an Error', async () => {
    const client = {
      getE2eRepositories: vi.fn().mockRejectedValue('offline'),
      getE2eBranches: vi.fn(),
    };
    render(
      <E2eRepositoryPicker
        apiClient={client as unknown as ApiClient}
        value={{ provider: '', id: '', branch: '', path: 'tests/e2e' }}
        invalid={false}
        onChange={vi.fn()}
        onPathChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByText('Não foi possível carregar os repositórios.'),
    ).toBeInTheDocument();
    expect(client.getE2eBranches).not.toHaveBeenCalled();
  });

  it('falls back to the first branch when the repository has no default branch listed', async () => {
    const client = {
      getE2eRepositories: vi.fn().mockResolvedValue({
        repositories: [{ id: '1', provider: 'github', name: 'org/app', defaultBranch: 'main' }],
        warnings: [],
      }),
      getE2eBranches: vi.fn().mockResolvedValue([
        { name: 'develop', isDefault: false },
        { name: 'release', isDefault: false },
      ]),
    };
    const onChange = vi.fn();
    const value = { provider: 'github' as const, id: '1', branch: 'deleted', path: 'tests/e2e' };
    render(
      <E2eRepositoryPicker
        apiClient={client as unknown as ApiClient}
        value={value}
        invalid={false}
        onChange={onChange}
        onPathChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...value, branch: 'develop' }));
    expect(client.getE2eBranches).toHaveBeenCalledWith('github', '1');
  });
});

describe('E2eSavedCasePicker', () => {
  it('shows the reason when the saved cases fail to load without an Error', async () => {
    const client = {
      getTestSuites: vi.fn().mockRejectedValue('service unavailable'),
      getAllSavedTestPlans: vi.fn().mockResolvedValue([]),
    };
    render(
      <E2eSavedCasePicker
        apiClient={client as unknown as ApiClient}
        value={{ suiteId: '', planId: '', caseIds: null }}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByText('service unavailable')).toBeInTheDocument();
  });
});

describe('E2eLocalRunnerPanel', () => {
  it('shows how to connect a runner when the runners cannot be listed', async () => {
    const client = {
      getE2eRunners: vi.fn().mockRejectedValue(new Error('offline')),
      apiUrl: '/api',
    };
    render(<E2eLocalRunnerPanel apiClient={client as unknown as ApiClient} />);
    expect((await screen.findByRole('status')).textContent).toBe('Nenhum executor online');
    expect(screen.getByText('devkit runner')).toBeInTheDocument();
    expect(screen.getByText(`devkit login --api-url ${window.location.origin}/api`)).toBeTruthy();
  });
});
