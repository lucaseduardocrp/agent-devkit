import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignRepositoryPicker } from '../src/features/design/DesignRepositoryPicker.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { DesignRepositoryDto, DesignSettingsDto } from '../src/lib/api-client.js';

const REPOSITORIES: readonly DesignRepositoryDto[] = [
  { id: '42', provider: 'github', name: 'acme/prototypes', defaultBranch: 'main' },
  { id: 'guid-1', provider: 'azure', name: 'BlueOpexII/BlueOpexII', defaultBranch: 'develop' },
];

function client(settings: DesignSettingsDto | null = null) {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignRepositories').mockResolvedValue({
    repositories: REPOSITORIES,
    warnings: [],
  });
  vi.spyOn(api, 'getDesignSettings').mockResolvedValue(settings);
  vi.spyOn(api, 'getDesignBranches').mockResolvedValue([
    { name: 'main', isDefault: true },
    { name: 'develop', isDefault: false },
  ]);
  vi.spyOn(api, 'saveDesignSettings');
  return api;
}

function view(api: ApiClient, isReadOnly = false) {
  const onSaved = vi.fn();
  const onError = vi.fn();
  const ui = render(
    <DesignRepositoryPicker
      apiClient={api}
      isReadOnly={isReadOnly}
      onSaved={onSaved}
      onError={onError}
    />,
  );
  return { ui, onSaved, onError };
}

afterEach(() => vi.restoreAllMocks());

describe('DesignRepositoryPicker', () => {
  it('lists the repositories of every connected provider and saves the chosen one', async () => {
    const api = client();
    const { ui, onSaved } = view(api);

    const repository = (await ui.findByLabelText('Repositório')) as HTMLSelectElement;
    expect([...repository.options].map((option) => option.textContent)).toEqual([
      'Escolha um repositório',
      'GitHub · acme/prototypes',
      'Azure DevOps · BlueOpexII/BlueOpexII',
    ]);

    fireEvent.change(repository, { target: { value: 'azure:guid-1' } });
    await waitFor(() => expect(api.getDesignBranches).toHaveBeenCalledWith('azure', 'guid-1'));
    const branch = ui.getByLabelText('Branch') as HTMLSelectElement;
    await waitFor(() => expect(branch.value).toBe('main'));
    fireEvent.change(branch, { target: { value: 'develop' } });

    const saved: DesignSettingsDto = {
      provider: 'azure',
      repositoryId: 'guid-1',
      repositoryName: 'BlueOpexII/BlueOpexII',
      branch: 'develop',
    };
    vi.mocked(api.saveDesignSettings).mockResolvedValue(saved);
    fireEvent.click(ui.getByRole('button', { name: /Salvar repositório/ }));
    await waitFor(() =>
      expect(api.saveDesignSettings).toHaveBeenCalledWith({
        provider: 'azure',
        repositoryId: 'guid-1',
        branch: 'develop',
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it('starts from the saved repository and only enables saving after a change', async () => {
    const api = client({
      provider: 'github',
      repositoryId: '42',
      repositoryName: 'acme/prototypes',
      branch: 'develop',
    });
    const { ui } = view(api);

    const repository = (await ui.findByLabelText('Repositório')) as HTMLSelectElement;
    await waitFor(() => expect(repository.value).toBe('github:42'));
    expect((ui.getByLabelText('Branch') as HTMLSelectElement).value).toBe('develop');
    expect(
      (ui.getByRole('button', { name: /Salvar repositório/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(ui.getByLabelText('Branch'), { target: { value: 'main' } });
    expect(
      (ui.getByRole('button', { name: /Salvar repositório/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('explains when no provider is connected and hides saving from viewers', async () => {
    const api = client();
    vi.mocked(api.getDesignRepositories).mockResolvedValue({ repositories: [], warnings: [] });
    const { ui } = view(api, true);

    const repository = (await ui.findByLabelText('Repositório')) as HTMLSelectElement;
    await waitFor(() => expect(repository.disabled).toBe(true));
    expect(repository.textContent).toContain('Configure uma integração');
    expect(ui.queryByRole('button', { name: /Salvar repositório/ })).toBeNull();
  });

  it('reports a listing that fails', async () => {
    const api = client();
    vi.mocked(api.getDesignRepositories).mockRejectedValue(new Error('Sem acesso'));
    const { onError } = view(api);
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Sem acesso'));
  });

  it('reports a listing that fails without an Error object', async () => {
    const api = client();
    vi.mocked(api.getDesignRepositories).mockRejectedValue('boom');
    const { onError } = view(api);
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Não foi possível carregar os repositórios.'),
    );
  });

  it('falls back to the default branch when none of the branches is marked as the default', async () => {
    const api = client();
    vi.mocked(api.getDesignBranches).mockResolvedValue([{ name: 'feature-x', isDefault: false }]);
    const { ui } = view(api);
    fireEvent.change(await ui.findByLabelText('Repositório'), {
      target: { value: 'github:42' },
    });
    await waitFor(() => expect(api.getDesignBranches).toHaveBeenCalled());
    fireEvent.click(ui.getByRole('button', { name: /Salvar repositório/ }));
    // The saved branch is the repository's own default, since none of the fetched branches
    // is marked as it and the field had no previous value to keep.
    await waitFor(() =>
      expect(api.saveDesignSettings).toHaveBeenCalledWith({
        provider: 'github',
        repositoryId: '42',
        branch: 'main',
      }),
    );
  });

  it('clears the branch list when loading branches fails', async () => {
    const api = client();
    vi.mocked(api.getDesignBranches).mockRejectedValue(new Error('offline'));
    const { ui } = view(api);
    fireEvent.change(await ui.findByLabelText('Repositório'), {
      target: { value: 'github:42' },
    });
    await waitFor(() => expect(api.getDesignBranches).toHaveBeenCalled());
    const branch = (await ui.findByLabelText('Branch')) as HTMLSelectElement;
    // The branch list comes back empty, so the select falls back to the repository's default.
    await waitFor(() => expect([...branch.options].map((o) => o.value)).toEqual(['main']));
  });

  it('reports a save that fails', async () => {
    const api = client();
    const { ui, onError } = view(api);
    fireEvent.change(await ui.findByLabelText('Repositório'), {
      target: { value: 'github:42' },
    });
    vi.mocked(api.saveDesignSettings).mockRejectedValue('boom');
    fireEvent.click(ui.getByRole('button', { name: /Salvar repositório/ }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Não foi possível salvar o repositório.'),
    );
  });

  it('reports the message of a save that fails with an Error', async () => {
    const api = client();
    const { ui, onError } = view(api);
    fireEvent.change(await ui.findByLabelText('Repositório'), {
      target: { value: 'github:42' },
    });
    vi.mocked(api.saveDesignSettings).mockRejectedValue(new Error('Token expirado'));
    fireEvent.click(ui.getByRole('button', { name: /Salvar repositório/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Token expirado'));
  });

  it('does not update branches once unmounted while they were still loading', async () => {
    const api = client();
    let resolveBranches: (list: { name: string; isDefault: boolean }[]) => void = () => undefined;
    vi.mocked(api.getDesignBranches).mockReturnValue(
      new Promise((resolve) => {
        resolveBranches = resolve;
      }),
    );
    const { ui } = view(api);
    fireEvent.change(await ui.findByLabelText('Repositório'), {
      target: { value: 'github:42' },
    });
    await waitFor(() => expect(api.getDesignBranches).toHaveBeenCalled());
    ui.unmount();
    expect(() => resolveBranches([{ name: 'main', isDefault: true }])).not.toThrow();
  });
});
