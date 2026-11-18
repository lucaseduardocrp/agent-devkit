import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CachePanel } from '../src/features/settings/CachePanel.js';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import type { DesktopCacheBridge } from '../src/lib/desktop.js';

const MB = 1024 * 1024;
const usage = [
  { id: 'web', bytes: 12 * MB },
  { id: 'temp', bytes: 0 },
  { id: 'browser', bytes: 300 * MB },
] as const;

interface CacheMocks {
  status: Mock<DesktopCacheBridge['status']>;
  clear: Mock<DesktopCacheBridge['clear']>;
}

function desktop(overrides: Partial<DesktopCacheBridge> = {}): CacheMocks {
  const mocks: CacheMocks = {
    status: vi
      .fn<DesktopCacheBridge['status']>()
      .mockResolvedValue({ ok: true, usage: [...usage] }),
    clear: vi
      .fn<DesktopCacheBridge['clear']>()
      .mockResolvedValue({ ok: true, freedBytes: 12 * MB, failed: 0 }),
  };
  Object.defineProperty(window, 'adkDesktop', {
    value: { apiUrl: 'http://127.0.0.1:1', cache: { ...mocks, ...overrides } },
    configurable: true,
  });
  return mocks;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'adkDesktop');
});

describe('Settings > cache cleanup', () => {
  it('is hidden in a browser', () => {
    const view = render(<SettingsView />);
    expect(view.queryByTestId('cache-card')).toBeNull();
    expect(render(<CachePanel />).container.childNodes).toHaveLength(0);
  });

  it('is part of Settings > General in the desktop app', async () => {
    desktop();
    const view = render(<SettingsView />);
    expect(await view.findByTestId('cache-card')).toBeInTheDocument();
    fireEvent.click(view.getByTestId('settings-section-members'));
    expect(view.queryByTestId('cache-card')).toBeNull();
  });

  it('shows each category with its size and selects only what is safe', async () => {
    desktop();
    const view = render(<CachePanel />);
    expect(view.getByTestId('cache-loading')).toBeInTheDocument();
    const card = within(await view.findByTestId('cache-card'));
    await waitFor(() => expect(card.getByText('12 MB')).toBeInTheDocument());
    expect(card.getByText('300 MB')).toBeInTheDocument();
    expect(card.getByText('Nada para apagar')).toBeInTheDocument();
    expect(card.getByTestId<HTMLInputElement>('cache-toggle-web').checked).toBe(true);
    expect(card.getByTestId<HTMLInputElement>('cache-toggle-temp').disabled).toBe(true);
    expect(card.getByTestId<HTMLInputElement>('cache-toggle-browser').checked).toBe(false);
    expect(card.getByText('Selecionado: 12 MB')).toBeInTheDocument();
  });

  it('adds what is selected to the total', async () => {
    desktop();
    const view = render(<CachePanel />);
    fireEvent.click(await view.findByTestId('cache-toggle-browser'));
    expect(view.getByText('Selecionado: 312 MB')).toBeInTheDocument();
    fireEvent.click(view.getByTestId('cache-toggle-browser'));
    expect(view.getByText('Selecionado: 12 MB')).toBeInTheDocument();
  });

  it('asks before deleting, then reports what was freed and reloads the sizes', async () => {
    const cache = desktop();
    cache.status.mockResolvedValueOnce({ ok: true, usage: [...usage] }).mockResolvedValueOnce({
      ok: true,
      usage: [
        { id: 'web', bytes: 0 },
        { id: 'temp', bytes: 0 },
      ],
    });
    const view = render(<CachePanel />);
    await waitFor(() =>
      expect((view.getByTestId('cache-clear') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(view.getByTestId('cache-clear'));
    expect(cache.clear).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(cache.clear).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId('cache-clear'));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Liberar espaço' }),
    );
    await waitFor(() => expect(cache.clear).toHaveBeenCalledWith(['web']));
    expect(await view.findByRole('status')).toHaveTextContent('12 MB liberados.');
    await waitFor(() =>
      expect((view.getByTestId('cache-clear') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(view.getByText('Selecionado: 0 B')).toBeInTheDocument();
  });

  it('says when something was in use and kept', async () => {
    desktop({ clear: vi.fn().mockResolvedValue({ ok: true, freedBytes: 2048, failed: 2 }) });
    const view = render(<CachePanel />);
    await waitFor(() =>
      expect((view.getByTestId('cache-clear') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(view.getByTestId('cache-clear'));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Liberar espaço' }),
    );
    expect(await view.findByRole('status')).toHaveTextContent(
      '2 KB liberados. 2 item(ns) estão em uso e foram mantidos.',
    );
  });

  it('shows why the deletion failed', async () => {
    desktop({ clear: vi.fn().mockResolvedValue({ ok: false, error: 'Not allowed.' }) });
    const view = render(<CachePanel />);
    await waitFor(() =>
      expect((view.getByTestId('cache-clear') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(view.getByTestId('cache-clear'));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Liberar espaço' }),
    );
    expect(await view.findByRole('alert')).toHaveTextContent('Not allowed.');
    expect((view.getByTestId('cache-clear') as HTMLButtonElement).disabled).toBe(false);
  });

  it('falls back to a message when the call throws without one', async () => {
    desktop({ clear: vi.fn().mockRejectedValue('boom') });
    const view = render(<CachePanel />);
    await waitFor(() =>
      expect((view.getByTestId('cache-clear') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(view.getByTestId('cache-clear'));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Liberar espaço' }),
    );
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Não foi possível apagar os arquivos.',
    );
  });

  it('shows the reason when the sizes cannot be read', async () => {
    desktop({ status: vi.fn().mockResolvedValue({ ok: false, error: 'Not allowed.' }) });
    const view = render(<CachePanel />);
    expect(await view.findByRole('alert')).toHaveTextContent('Not allowed.');
    expect((view.getByTestId('cache-clear') as HTMLButtonElement).disabled).toBe(true);
  });

  it('falls back to a message when reading the sizes throws without one', async () => {
    desktop({ status: vi.fn().mockRejectedValue('boom') });
    const view = render(<CachePanel />);
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Não foi possível ler o tamanho do cache.',
    );
  });
});
