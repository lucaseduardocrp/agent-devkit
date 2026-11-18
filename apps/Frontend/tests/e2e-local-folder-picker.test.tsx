import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  E2eRepositoryPicker,
  type E2eRepositorySelection,
} from '../src/features/e2e/E2eRepositoryPicker.js';
import type { ApiClient } from '../src/lib/api-client.js';

const pickFolder = vi.fn();

function useDesktop() {
  Object.defineProperty(window, 'adkDesktop', {
    configurable: true,
    value: { development: { pickFolder } },
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, 'adkDesktop');
  pickFolder.mockReset();
});

function setup(
  value: E2eRepositorySelection,
  options: {
    branches?: { name: string; isDefault: boolean }[] | Error;
    source?: 'e2e' | 'integrationTests';
    disabled?: boolean;
  } = {},
) {
  const branches = options.branches ?? [{ name: 'main', isDefault: true }];
  const list = vi.fn().mockResolvedValue({ repositories: [], warnings: [] });
  const listBranches = vi.fn(() =>
    branches instanceof Error ? Promise.reject(branches) : Promise.resolve(branches),
  );
  const client = {
    getE2eRepositories: list,
    getE2eBranches: listBranches,
    listApiTestRepositories: list,
    listApiTestBranches: listBranches,
  };
  const onChange = vi.fn();
  render(
    <E2eRepositoryPicker
      apiClient={client as unknown as ApiClient}
      value={value}
      invalid={false}
      onChange={onChange}
      onPathChange={vi.fn()}
      {...(options.source ? { source: options.source } : {})}
      {...(options.disabled ? { disabled: true } : {})}
    />,
  );
  return { onChange, listBranches };
}

const empty: E2eRepositorySelection = { provider: '', id: '', branch: '', path: 'tests/e2e' };
const local: E2eRepositorySelection = {
  provider: 'local',
  id: 'D:\\Projects\\Personal\\finance-app-demo',
  branch: '',
  path: 'tests/e2e',
};

describe('E2eRepositoryPicker with a project folder', () => {
  it('offers no folder outside the desktop app', async () => {
    setup(empty);
    await screen.findByTestId('e2e-repository-picker');
    expect(screen.queryByTestId('e2e-local-folder')).not.toBeInTheDocument();
  });

  it('offers no folder to the API test pipelines, even in the desktop app', async () => {
    useDesktop();
    setup(empty, { source: 'integrationTests' });
    await screen.findByTestId('e2e-repository-picker');
    expect(screen.queryByTestId('e2e-local-folder')).not.toBeInTheDocument();
  });

  it('keeps the specs in the folder picked in the native dialog', async () => {
    useDesktop();
    pickFolder.mockResolvedValue({ ok: true, path: 'D:\\Projects\\Personal\\finance-app-demo' });
    const { onChange } = setup(empty);
    expect(await screen.findByTestId('e2e-local-folder')).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>('Pasta do projeto neste computador').value).toBe(
      '',
    );

    fireEvent.click(screen.getByRole('button', { name: /Escolher pasta/ }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        ...empty,
        provider: 'local',
        id: 'D:\\Projects\\Personal\\finance-app-demo',
        branch: '',
        name: 'finance-app-demo',
      }),
    );
  });

  it('names a folder after its path when it has no name (a drive root)', async () => {
    useDesktop();
    pickFolder.mockResolvedValue({ ok: true, path: '/' });
    const { onChange } = setup(empty);
    fireEvent.click(await screen.findByRole('button', { name: /Escolher pasta/ }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: '/', name: '/' })),
    );
  });

  it('shows why the dialog failed and ignores a cancelled one', async () => {
    useDesktop();
    pickFolder.mockResolvedValueOnce({ ok: false, error: 'Dialog unavailable' });
    const { onChange } = setup(empty);
    fireEvent.click(await screen.findByRole('button', { name: /Escolher pasta/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Dialog unavailable');

    pickFolder.mockResolvedValueOnce({ ok: true, path: null });
    fireEvent.click(screen.getByRole('button', { name: /Escolher pasta/ }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(2));
    expect(onChange).not.toHaveBeenCalled();
    // The message stays until a folder is picked.
    expect(screen.getByRole('alert')).toBeInTheDocument();

    pickFolder.mockResolvedValueOnce({ ok: true, path: 'D:\\app' });
    fireEvent.click(screen.getByRole('button', { name: /Escolher pasta/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('does not open the dialog while the form is locked', async () => {
    useDesktop();
    setup(empty, { disabled: true });
    expect(
      (await screen.findByRole<HTMLButtonElement>('button', { name: /Escolher pasta/ })).disabled,
    ).toBe(true);
  });

  it('shows the chosen folder and takes the branch checked out in it', async () => {
    useDesktop();
    const { onChange, listBranches } = setup(local, {
      branches: [{ name: 'feature/filtro', isDefault: true }],
    });
    expect(screen.getByLabelText<HTMLInputElement>('Pasta do projeto neste computador').value).toBe(
      local.id,
    );
    expect(listBranches).toHaveBeenCalledWith('local', local.id);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ ...local, branch: 'feature/filtro' }),
    );
  });

  it('falls back to "local" when the folder reports no branch', async () => {
    useDesktop();
    const { onChange } = setup(local, { branches: [] });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...local, branch: 'local' }));
  });

  it('keeps the branch it already has when the folder cannot be read', async () => {
    useDesktop();
    setup({ ...local, branch: 'main' }, { branches: new Error('The folder does not exist') });
    expect(await screen.findByText('The folder does not exist')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'main' })).toBeInTheDocument();
  });
});
