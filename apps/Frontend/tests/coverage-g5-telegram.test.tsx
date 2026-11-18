import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramConfigForm,
  type TelegramConfigFormProps,
} from '../src/features/connect/TelegramIntegrationPanel.js';
import {
  readTelegramSettings,
  type TelegramSettingsValue,
} from '../src/features/connect/telegram-settings.js';
import {
  ApiClient,
  type TelegramBotStatusDto,
  type TelegramChatDto,
} from '../src/lib/api-client.js';

const chat = (id: string, name: string): TelegramChatDto => ({
  id,
  chatId: id,
  userId: '1',
  displayName: name,
  agentId: null,
  notifications: true,
  createdAt: '',
});

const online: TelegramBotStatusDto = {
  running: true,
  mode: 'polling',
  botUsername: 'adk_bot',
  error: null,
};

function api(chats: TelegramChatDto[], status = online) {
  const client = new ApiClient();
  vi.spyOn(client, 'getAgents').mockResolvedValue([]);
  vi.spyOn(client, 'getTelegramChats').mockResolvedValue({ status, chats });
  return client;
}

function Harness({
  onValue,
  ...props
}: Partial<TelegramConfigFormProps> & { onValue?: (value: TelegramSettingsValue) => void }) {
  const [value, setValue] = useState(readTelegramSettings());
  return (
    <TelegramConfigForm
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      isSaved
      secret=""
      onSecretChange={() => {}}
      hasExistingSecret={false}
      isEnabled
      onEnabledChange={() => {}}
      {...props}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TelegramConfigForm settings switches', () => {
  it('stores the knowledge and notification switches', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} isSaved={false} />);

    fireEvent.click(screen.getByLabelText('Usar o Brain nas respostas'));
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ useKnowledge: false }));
    fireEvent.click(screen.getByLabelText('Testes E2E'));
    expect(onValue).toHaveBeenLastCalledWith(
      expect.objectContaining({ notify: expect.objectContaining({ e2e: false }) }),
    );
  });

  it('works without an API client: no agents, no chats, nothing to load', () => {
    render(<Harness isSaved={false} />);
    expect(screen.queryByTestId('telegram-status')).toBeNull();
    expect(screen.queryByText('Chats pareados')).toBeNull();
  });
});

describe('TelegramConfigForm chats', () => {
  it('updates only the toggled chat and removes only the chosen one', async () => {
    const client = api([chat('c1', 'Ana'), chat('c2', 'Bia')]);
    vi.spyOn(client, 'updateTelegramChat').mockResolvedValue({
      ...chat('c2', 'Bia'),
      notifications: false,
    });
    vi.spyOn(client, 'removeTelegramChat').mockResolvedValue();
    render(<Harness apiClient={client} />);

    const bia = (await screen.findByText('Bia')).closest('li')!;
    fireEvent.click(within(bia).getByLabelText('Avisos'));
    await waitFor(() =>
      expect((within(bia).getByLabelText('Avisos') as HTMLInputElement).checked).toBe(false),
    );
    const ana = screen.getByText('Ana').closest('li')!;
    expect((within(ana).getByLabelText('Avisos') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Remover Bia' }));
    await waitFor(() => expect(screen.queryByText('Bia')).toBeNull());
    expect(screen.getByText('Ana')).toBeTruthy();
  });

  it('shows the generic failure when a chat change fails without a message', async () => {
    const client = api([chat('c1', 'Ana')]);
    vi.spyOn(client, 'removeTelegramChat').mockRejectedValue('offline');
    render(<Harness apiClient={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remover Ana' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toBe('offline');
  });

  it('shows the bot as online even when Telegram reports no mode', async () => {
    const client = api([], { running: true, mode: null, botUsername: 'adk_bot', error: null });
    render(<Harness apiClient={client} />);
    await waitFor(() =>
      expect(screen.getByTestId('telegram-status').textContent).toContain('@adk_bot online ()'),
    );
  });

  it('ignores a failed load of a form that was already closed', async () => {
    const client = api([]);
    let reject: (reason: Error) => void = () => {};
    vi.spyOn(client, 'getTelegramChats').mockImplementation(
      (signal) =>
        new Promise((_, fail) => {
          reject = (reason) => {
            expect(signal?.aborted).toBe(true);
            fail(reason);
          };
        }),
    );
    const view = render(<Harness apiClient={client} />);
    await waitFor(() => expect(client.getTelegramChats).toHaveBeenCalled());
    view.unmount();
    reject(new Error('late failure'));
    await Promise.resolve();
    expect(screen.queryByText('late failure')).toBeNull();
  });

  it('stops polling for the pairing when the API client goes away', async () => {
    const client = api([]);
    vi.spyOn(client, 'createTelegramPairingCode').mockResolvedValue({
      code: 'ZZZZ9999',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      botUsername: 'adk_bot',
      deepLink: 'https://t.me/adk_bot?start=ZZZZ9999',
    });
    const view = render(<Harness apiClient={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar código de pareamento' }));
    await screen.findByText('ZZZZ9999');

    const callbacks: Array<() => void> = [];
    const native = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 4_000) callbacks.push(fn);
      return native(() => {}, 1_000_000);
    }) as typeof window.setInterval);
    view.rerender(<Harness />);
    expect(callbacks).toHaveLength(1);
    await act(async () => callbacks[0]!());
    expect(client.getTelegramChats).toHaveBeenCalledTimes(1);
  });
});
