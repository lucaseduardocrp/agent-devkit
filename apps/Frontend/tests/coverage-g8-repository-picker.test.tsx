import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eRepositoryPicker } from '../src/features/e2e/E2eRepositoryPicker.js';
import type { ApiClient } from '../src/lib/api-client.js';

function setup(branches: { name: string; isDefault: boolean }[], branch: string) {
  const client = {
    getE2eRepositories: vi.fn().mockResolvedValue({
      repositories: [{ id: '1', provider: 'github', name: 'org/app', defaultBranch: 'main' }],
      warnings: [],
    }),
    getE2eBranches: vi.fn().mockResolvedValue(branches),
  };
  const onChange = vi.fn();
  const value = { provider: 'github' as const, id: '1', branch, path: 'tests/e2e' };
  render(
    <E2eRepositoryPicker
      apiClient={client as unknown as ApiClient}
      value={value}
      invalid={false}
      onChange={onChange}
      onPathChange={vi.fn()}
    />,
  );
  return { onChange, value };
}

describe('E2eRepositoryPicker branch fallback', () => {
  it('moves a deleted branch to the default branch of the repository', async () => {
    const { onChange, value } = setup(
      [
        { name: 'develop', isDefault: false },
        { name: 'trunk', isDefault: true },
      ],
      'deleted',
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...value, branch: 'trunk' }));
  });

  it('keeps the branch when it is still listed', async () => {
    const { onChange } = setup([{ name: 'develop', isDefault: false }], 'develop');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses the repository default branch when it has no branches listed', async () => {
    const { onChange, value } = setup([], 'deleted');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...value, branch: 'main' }));
  });
});
