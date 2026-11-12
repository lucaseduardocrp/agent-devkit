import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  IntegrationConfigModal,
  type IntegrationCardItem,
} from '../src/features/connect/IntegrationConfigModal.js';
import { readTelegramSettings } from '../src/features/connect/telegram-settings.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import { ApiClient, type UserIntegrationDto } from '../src/lib/api-client.js';

const telegramItem: IntegrationCardItem = {
  id: 'telegram',
  providerId: 'telegram',
  category: 'MESSAGING',
  name: 'Telegram',
  desc: '',
  icon: 'ti-brand-telegram',
  iconBg: 'var(--bg-accent)',
  iconColor: 'var(--text-accent)',
  status: 'connected',
};

const saved: UserIntegrationDto = {
  id: 'int-tg',
  category: 'MESSAGING',
  providerId: 'telegram',
  isEnabled: true,
  settings: { mode: 'polling', defaultAgentId: 'a2', useKnowledge: false, notify: { load: false } },
  hasSecret: true,
  maskedSecret: '••••••••',
  updatedAt: '2026-10-25T12:00:00Z',
};

const chat = {
  id: 'c1',
  chatId: '42',
  userId: '7',
  displayName: 'Ana (@ana)',
  agentId: null,
  notifications: true,
  createdAt: '2026-10-25T12:00:00Z',
};

function client(online = true) {
  const api = new ApiClient();
  vi.spyOn(api, 'getAgents').mockResolvedValue([
    { id: 'a1', name: 'QA Agent', slug: 'qa' },
    { id: 'a2', name: 'Docs Agent', slug: 'docs' },
  ] as unknown as CustomAgentDto[]);
  vi.spyOn(api, 'getTelegramChats').mockResolvedValue({
    status: {
      running: online,
      mode: online ? 'polling' : null,
      botUsername: online ? 'adk_bot' : null,
      error: online ? null : 'Unauthorized',
    },
    chats: [chat],
  });
  return api;
}

function renderModal(api: ApiClient, currentConfig?: UserIntegrationDto) {
  return render(
    <IntegrationConfigModal
      isOpen={true}
      onClose={vi.fn()}
      integration={telegramItem}
      currentConfig={currentConfig}
      apiClient={api}
      onSaveSuccess={vi.fn()}
      onDeleteSuccess={vi.fn()}
    />,
  );
}

describe('Telegram integration', () => {
  it('reads settings with the API defaults', () => {
    expect(readTelegramSettings()).toEqual({
      mode: 'auto',
      defaultAgentId: '',
      useKnowledge: true,
      notify: { e2e: true, integration: true, load: true, onlyFailures: false },
    });
  });

  it('still shows the form when the agents cannot be loaded', async () => {
    const api = client();
    vi.spyOn(api, 'getAgents').mockRejectedValue(new Error('offline'));
    const { getByLabelText } = renderModal(api);
    await waitFor(() => expect(api.getAgents).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getByLabelText('Recebimento de mensagens')).toBeInTheDocument();
  });

  it('saves typed settings instead of strings', async () => {
    const api = client();
    vi.spyOn(api, 'saveIntegration').mockResolvedValue(saved);
    const { getByLabelText, getByRole, findByRole, queryByText } = renderModal(api);

    expect(queryByText('Chats pareados')).not.toBeInTheDocument();
    await findByRole('option', { name: 'Docs Agent (docs)' });
    fireEvent.change(getByLabelText('Recebimento de mensagens'), {
      target: { value: 'polling' },
    });
    fireEvent.change(getByLabelText('Agente que responde'), { target: { value: 'a2' } });
    fireEvent.click(getByLabelText('Somente falhas'));
    fireEvent.change(getByLabelText('Chave de Acesso / Token / Segredo'), {
      target: { value: '123:ABC' },
    });
    fireEvent.click(getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(api.saveIntegration).toHaveBeenCalledWith('MESSAGING', 'telegram', {
        isEnabled: true,
        settings: {
          mode: 'polling',
          defaultAgentId: 'a2',
          useKnowledge: true,
          notify: { e2e: true, integration: true, load: true, onlyFailures: true },
        },
        secret: '123:ABC',
      }),
    );
  });

  it('lists paired chats, toggles notifications, removes chats and pairs new ones', async () => {
    const api = client();
    vi.spyOn(api, 'updateTelegramChat').mockResolvedValue({ ...chat, notifications: false });
    vi.spyOn(api, 'removeTelegramChat').mockResolvedValue();
    vi.spyOn(api, 'createTelegramPairingCode').mockResolvedValue({
      code: 'ABCD2345',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      botUsername: 'adk_bot',
      deepLink: 'https://t.me/adk_bot?start=ABCD2345',
    });
    const view = renderModal(api, saved);

    expect((view.getByLabelText('Recebimento de mensagens') as HTMLSelectElement).value).toBe(
      'polling',
    );
    expect((view.getByLabelText('Overload Tests') as HTMLInputElement).checked).toBe(false);
    expect(await view.findByText('Ana (@ana)')).toBeInTheDocument();
    expect(view.getByTestId('telegram-status')).toHaveTextContent('@adk_bot online (polling)');

    const row = view.getByText('Ana (@ana)').closest('li')!;
    fireEvent.click(within(row).getByLabelText('Avisos'));
    await waitFor(() =>
      expect(api.updateTelegramChat).toHaveBeenCalledWith('c1', { notifications: false }),
    );

    fireEvent.click(view.getByRole('button', { name: 'Gerar código de pareamento' }));
    expect(await view.findByText('ABCD2345')).toBeInTheDocument();
    expect(view.getByRole('link', { name: /Abrir no Telegram/ })).toHaveAttribute(
      'href',
      'https://t.me/adk_bot?start=ABCD2345',
    );

    fireEvent.click(view.getByRole('button', { name: 'Remover Ana (@ana)' }));
    await waitFor(() => expect(view.queryByText('Ana (@ana)')).not.toBeInTheDocument());
    expect(api.removeTelegramChat).toHaveBeenCalledWith('c1');
  });

  it('explains why chats cannot be paired while the bot is offline', async () => {
    const view = renderModal(client(false), saved);
    expect(await view.findByText('Unauthorized')).toBeInTheDocument();
    expect(view.getByText('Bot offline')).toBeInTheDocument();
    expect(
      view.queryByRole('button', { name: 'Gerar código de pareamento' }),
    ).not.toBeInTheDocument();
  });

  it('shows the bot status, a link to it, and a loading state before the status arrives', async () => {
    const api = client();
    let resolve!: (value: Awaited<ReturnType<ApiClient['getTelegramChats']>>) => void;
    vi.spyOn(api, 'getTelegramChats').mockReturnValue(new Promise((r) => (resolve = r)));
    const view = renderModal(api, saved);
    expect(view.getByTestId('skeleton')).toBeInTheDocument();
    resolve({
      status: { running: true, mode: 'polling', botUsername: 'adk_bot', error: null },
      chats: [],
    });
    expect(await view.findByRole('link', { name: /Abrir @adk_bot/ })).toHaveAttribute(
      'href',
      'https://t.me/adk_bot',
    );
    expect(view.getByText('Nenhum chat pareado ainda.')).toBeInTheDocument();
    expect(view.getByText(/Pareie seu primeiro chat/)).toBeInTheDocument();
  });

  it('counts down the pairing code, copies the command and clears the code when it expires', async () => {
    const api = client();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.spyOn(api, 'createTelegramPairingCode').mockResolvedValue({
      code: 'ABCD2345',
      expiresAt: new Date(Date.now() + 2_500).toISOString(),
      botUsername: 'adk_bot',
      deepLink: 'https://t.me/adk_bot?start=ABCD2345',
    });
    const view = renderModal(api, saved);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar código de pareamento' }));
    expect(await view.findByText(/Expira em 0:[0-9][0-9]/)).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Copiar comando' }));
    expect(writeText).toHaveBeenCalledWith('/start ABCD2345');
    expect(await view.findByRole('button', { name: 'Copiado' })).toBeInTheDocument();

    await waitFor(() => expect(view.queryByText('ABCD2345')).not.toBeInTheDocument(), {
      timeout: 4_000,
    });
  });

  it('marks chats that talk to an AI CLI and falls back to an initial for odd names', async () => {
    const api = client();
    vi.spyOn(api, 'getTelegramChats').mockResolvedValue({
      status: { running: true, mode: 'polling', botUsername: 'adk_bot', error: null },
      chats: [
        { ...chat, id: 'c1', agentId: 'cli:claude' },
        { ...chat, id: 'c2', displayName: '  ', agentId: 'a1' },
      ],
    });
    const view = renderModal(api, saved);
    expect(await view.findByText('CLI: claude')).toBeInTheDocument();
    expect(view.getAllByText('A').length).toBeGreaterThan(0);
    expect(view.getByText('?')).toBeInTheDocument();
    expect(view.getAllByText(/^CLI:/)).toHaveLength(1);
  });

  it('reports failures to load or change chats, and hides remove without permission', async () => {
    const api = client();
    vi.spyOn(api, 'getTelegramChats').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(api, 'updateTelegramChat').mockRejectedValue(new Error('nope'));
    const view = renderModal(api, saved);
    expect(await view.findByText('boom')).toBeInTheDocument();
    vi.mocked(api.getTelegramChats).mockResolvedValue({
      status: { running: true, mode: 'polling', botUsername: 'adk_bot', error: null },
      chats: [chat],
    });
    view.unmount();

    const again = renderModal(api, saved);
    const row = (await again.findByText('Ana (@ana)')).closest('li')!;
    fireEvent.click(within(row).getByLabelText('Avisos'));
    expect(await again.findByText('nope')).toBeInTheDocument();

    vi.spyOn(api, 'getTelegramChats').mockRejectedValue('weird');
    const third = renderModal(api, saved);
    expect(await third.findByText('Não foi possível carregar os chats.')).toBeInTheDocument();
  });

  it('is read only for people who cannot edit the integration', async () => {
    const view = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={telegramItem}
        currentConfig={saved}
        apiClient={client()}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
        isReadOnly={true}
      />,
    );
    expect(await view.findByText('Ana (@ana)')).toBeInTheDocument();
    expect(
      view.queryByRole('button', { name: 'Gerar código de pareamento' }),
    ).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Remover Ana (@ana)' })).not.toBeInTheDocument();
    expect((view.getByLabelText('Overload Tests') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Telegram bot conflict', () => {
  it('explains what to do when another process already reads the bot', async () => {
    const api = client(false);
    vi.spyOn(api, 'getTelegramChats').mockResolvedValue({
      status: {
        running: false,
        mode: null,
        botUsername: null,
        error: 'Conflict: terminated by other getUpdates request',
      },
      chats: [],
    });
    const view = renderModal(api, saved);
    expect(await view.findByText(/Outro processo já está lendo este bot/)).toBeInTheDocument();
    expect(view.queryByText(/terminated by other getUpdates/)).not.toBeInTheDocument();
  });
});
