import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eRepositoryPicker } from '../src/features/e2e/E2eRepositoryPicker.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('E2eRepositoryPicker branch fallback', () => {
  it('uses the repository default branch when it lists no branches', async () => {
    const client = {
      getE2eRepositories: vi.fn().mockResolvedValue({
        repositories: [{ id: '1', provider: 'github', name: 'org/app', defaultBranch: 'main' }],
        warnings: [],
      }),
      getE2eBranches: vi.fn().mockResolvedValue([]),
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
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...value, branch: 'main' }));
  });

  it.each([
    ['the branch marked as default', true, 'release'],
    ['the first listed branch when none is marked as default', false, 'develop'],
  ])('falls back to %s', async (_label, hasDefault, expected) => {
    const client = {
      getE2eRepositories: vi.fn().mockResolvedValue({
        repositories: [{ id: '1', provider: 'github', name: 'org/app', defaultBranch: 'main' }],
        warnings: [],
      }),
      getE2eBranches: vi.fn().mockResolvedValue([
        { name: 'develop', isDefault: false },
        { name: 'release', isDefault: hasDefault },
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
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...value, branch: expected }));
  });

  it('keeps the default branch already chosen when the repository lists no branches', async () => {
    const client = {
      getE2eRepositories: vi.fn().mockResolvedValue({
        repositories: [{ id: '1', provider: 'github', name: 'org/app', defaultBranch: 'main' }],
        warnings: [],
      }),
      getE2eBranches: vi.fn().mockResolvedValue([]),
    };
    const onChange = vi.fn();
    const value = { provider: 'github' as const, id: '1', branch: 'main', path: 'tests/e2e' };
    render(
      <E2eRepositoryPicker
        apiClient={client as unknown as ApiClient}
        value={value}
        invalid={false}
        onChange={onChange}
        onPathChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(client.getE2eBranches).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).not.toHaveBeenCalled();
  });
});
