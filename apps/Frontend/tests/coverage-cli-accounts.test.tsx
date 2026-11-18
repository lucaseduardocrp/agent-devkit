import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IntegrationConfigModal,
  type IntegrationCardItem,
} from '../src/features/connect/IntegrationConfigModal.js';
import {
  ApiClient,
  type LlmCliAvailability,
  type UserIntegrationDto,
} from '../src/lib/api-client.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';

const claude: IntegrationCardItem = {
  id: 'claude',
  providerId: 'claude',
  category: 'LLM',
  name: 'Anthropic Claude',
  desc: 'Modelos Claude',
  icon: 'ti-sparkles',
  iconBg: 'var(--bg-warning)',
  iconColor: 'var(--text-warning)',
  status: 'not-configured',
};
const local: LlmCliAvailability = {
  enabled: true,
  transport: 'local',
  providers: {
    claude: { id: 'claude', label: 'Claude', command: 'claude', installed: true, version: '1' },
  },
};
const work = { name: 'work', loginCommand: 'claude /login work' };
const home = { name: 'home', loginCommand: 'claude /login home' };

const saved = (settings: UserIntegrationDto['settings']): UserIntegrationDto => ({
  id: 'x',
  category: 'LLM',
  providerId: 'claude',
  isEnabled: true,
  settings,
  hasSecret: false,
  maskedSecret: null,
  updatedAt: '2026-01-01T00:00:00Z',
});

async function open(client: ApiClient, config?: UserIntegrationDto) {
  const view = render(
    <PermissionsProvider access={FULL_ACCESS}>
      <IntegrationConfigModal
        isOpen
        onClose={vi.fn()}
        integration={claude}
        apiClient={client}
        currentConfig={config}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />
    </PermissionsProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  if (!config) fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
  return view;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI accounts, beyond the happy path', () => {
  it('lists no account when they cannot be loaded', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
    vi.spyOn(client, 'getLlmCliProfiles').mockRejectedValue(new Error('down'));
    const view = await open(client);
    const select = (await view.findByLabelText('Conta da CLI')) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(1));
  });

  it('keeps an account saved earlier whose folder is gone', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
    vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work]);
    const view = await open(client, saved({ authMode: 'cli', cliProfile: 'gone' }));
    expect(await view.findByRole('option', { name: /gone \(não encontrada\)/ })).toBeTruthy();
  });

  it('replaces an account of the same name on create and reports failures', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
    vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work, home]);
    const create = vi
      .spyOn(client, 'createLlmCliProfile')
      .mockRejectedValueOnce(new Error('exists'))
      .mockRejectedValueOnce('nope')
      .mockResolvedValueOnce(work);
    const view = await open(client);
    await view.findByRole('option', { name: 'home' });
    fireEvent.click(view.getByRole('button', { name: 'Nova conta' }));
    const name = view.getByRole('textbox', { name: /Nome da conta/ });
    fireEvent.change(name, { target: { value: 'work' } });
    fireEvent.click(view.getByRole('button', { name: 'Criar' }));
    expect(await view.findByRole('alert')).toHaveTextContent('exists');
    fireEvent.click(view.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(/letras, números/));
    fireEvent.click(view.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(view.getAllByRole('option', { name: 'work' })).toHaveLength(1));
  });

  it('creates an account while the list is still loading', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
    vi.spyOn(client, 'getLlmCliProfiles').mockReturnValue(new Promise(() => undefined));
    vi.spyOn(client, 'createLlmCliProfile').mockResolvedValue(work);
    const view = await open(client);
    await view.findByLabelText('Conta da CLI');
    fireEvent.click(view.getByRole('button', { name: 'Nova conta' }));
    fireEvent.change(view.getByRole('textbox', { name: /Nome da conta/ }), {
      target: { value: 'work' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Criar' }));
    expect(await view.findByRole('option', { name: 'work' })).toBeTruthy();
  });

  it('deletes one of several accounts', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
    vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work, home]);
    vi.spyOn(client, 'deleteLlmCliProfile').mockResolvedValue(undefined);
    const view = await open(client);
    const select = (await view.findByLabelText('Conta da CLI')) as HTMLSelectElement;
    await view.findByRole('option', { name: 'home' });
    fireEvent.change(select, { target: { value: 'work' } });
    fireEvent.click(view.getByRole('button', { name: 'Excluir conta' }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir conta' }),
    );
    await waitFor(() => expect(view.queryByRole('option', { name: 'work' })).toBeNull());
    expect(view.getByRole('option', { name: 'home' })).toBeTruthy();
  });

  it(
    'copies the sign-in command, and survives a clipboard that refuses',
    { timeout: 10_000 },
    async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
      vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work]);
      const writeText = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const view = await open(client);
      const select = await view.findByLabelText('Conta da CLI');
      await view.findByRole('option', { name: 'work' });
      fireEvent.change(select, { target: { value: 'work' } });
      fireEvent.click(view.getByRole('button', { name: 'Mostrar comando de login' }));
      fireEvent.click(view.getByRole('button', { name: 'Copiar' }));
      expect(await view.findByRole('button', { name: 'Copiado!' })).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith(work.loginCommand);
      // The label goes back once the confirmation time is over.
      fireEvent.click(await view.findByRole('button', { name: 'Copiar' }, { timeout: 4000 }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      fireEvent.click(view.getByRole('button', { name: /Copiar|Copiado!/ }));
    },
  );
});
