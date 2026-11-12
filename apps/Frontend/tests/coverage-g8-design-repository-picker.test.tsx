import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignRepositoryPicker } from '../src/features/design/DesignRepositoryPicker.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { DesignRepositoryDto, DesignSettingsDto } from '../src/lib/api-client.js';

const REPOSITORIES: readonly DesignRepositoryDto[] = [
  { id: '42', provider: 'github', name: 'acme/prototypes', defaultBranch: 'main' },
];

function client(settings: DesignSettingsDto | null = null) {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignRepositories').mockResolvedValue({
    repositories: REPOSITORIES,
    warnings: [],
  });
  vi.spyOn(api, 'getDesignSettings').mockResolvedValue(settings);
  vi.spyOn(api, 'getDesignBranches').mockResolvedValue([{ name: 'main', isDefault: true }]);
  return api;
}

function view(api: ApiClient) {
  const onSaved = vi.fn();
  const onError = vi.fn();
  const ui = render(<DesignRepositoryPicker apiClient={api} onSaved={onSaved} onError={onError} />);
  return { ui, onSaved, onError };
}

afterEach(() => vi.restoreAllMocks());

describe('DesignRepositoryPicker edge cases', () => {
  it('ignores the repositories that arrive after it is gone', async () => {
    const api = client();
    let resolve!: (value: DesignSettingsDto | null) => void;
    vi.spyOn(api, 'getDesignSettings').mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    const { ui, onError } = view(api);
    await waitFor(() => expect(api.getDesignRepositories).toHaveBeenCalled());
    ui.unmount();
    resolve(null);
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores a failure that arrives after it is gone', async () => {
    const api = client();
    let reject!: (reason: unknown) => void;
    vi.spyOn(api, 'getDesignSettings').mockReturnValue(
      new Promise((_, rej) => {
        reject = rej;
      }),
    );
    const { ui, onError } = view(api);
    ui.unmount();
    reject(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the listing fails without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignRepositories').mockRejectedValue('offline');
    const { onError } = view(api);
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Não foi possível carregar os repositórios.'),
    );
  });

  it('ignores branches that arrive after it is gone', async () => {
    const api = client({
      provider: 'github',
      repositoryId: '42',
      repositoryName: 'acme/protos',
      branch: 'main',
    });
    let resolve!: (value: { name: string; isDefault: boolean }[]) => void;
    vi.spyOn(api, 'getDesignBranches').mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    const { ui } = view(api);
    await waitFor(() => expect(api.getDesignBranches).toHaveBeenCalled());
    ui.unmount();
    resolve([{ name: 'main', isDefault: true }]);
    await Promise.resolve();
  });

  it('follows the repository default when the branches list none as default', async () => {
    const api = client({
      provider: 'github',
      repositoryId: '42',
      repositoryName: 'acme/protos',
      branch: 'deleted',
    });
    vi.spyOn(api, 'getDesignBranches').mockResolvedValue([{ name: 'develop', isDefault: false }]);
    vi.spyOn(api, 'saveDesignSettings').mockResolvedValue({
      provider: 'github',
      repositoryId: '42',
      repositoryName: 'acme/protos',
      branch: 'main',
    });
    const { ui, onSaved } = view(api);
    await waitFor(() => expect(api.getDesignBranches).toHaveBeenCalled());
    const save = ui.getByRole('button', { name: /Salvar repositório/ });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.saveDesignSettings).toHaveBeenCalledWith({
      provider: 'github',
      repositoryId: '42',
      branch: 'main',
    });
  });

  it('reports why saving the repository failed', async () => {
    const api = client();
    vi.spyOn(api, 'saveDesignSettings').mockRejectedValue(new Error('Denied.'));
    const { ui, onError } = view(api);
    await waitFor(() =>
      expect(ui.getByLabelText('Repositório').querySelectorAll('option').length).toBe(2),
    );
    fireEvent.change(ui.getByLabelText('Repositório'), { target: { value: 'github:42' } });
    await waitFor(() =>
      expect((ui.getByLabelText('Branch') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.click(ui.getByRole('button', { name: /Salvar repositório/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Denied.'));
  });
});
