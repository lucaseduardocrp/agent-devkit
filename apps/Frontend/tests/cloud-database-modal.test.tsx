import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectView } from '../src/features/connect/ConnectView.js';
import type { DesktopStorageBridge, DesktopStorageStatus } from '../src/lib/desktop.js';

const target = { host: 'db.example.com', port: 5432, database: 'adk', user: 'owner' };

function desktop(status: DesktopStorageStatus, overrides: Partial<DesktopStorageBridge> = {}) {
  const storage = {
    status: vi.fn().mockResolvedValue(status),
    inspect: vi.fn().mockResolvedValue({
      ok: true,
      inspection: { kind: 'empty', users: 0, unknownMigrations: [], serverVersion: '17.2' },
      target,
    }),
    connect: vi.fn().mockResolvedValue({ ok: true }),
    disconnect: vi.fn().mockResolvedValue({ ok: true }),
    copyEncryptionKey: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  Object.defineProperty(window, 'adkDesktop', {
    value: { apiUrl: 'http://127.0.0.1:60675', storage },
    configurable: true,
  });
  return storage;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'adkDesktop');
});

async function openModal(view: ReturnType<typeof render>) {
  fireEvent.click(await view.findByTestId('conn-card-cloud-database'));
  return within(view.getByTestId('cloud-database-modal'));
}

async function checkUrl(
  modal: ReturnType<typeof within>,
  url = 'postgresql://u:p@db.example.com/adk',
) {
  fireEvent.change(modal.getByLabelText('URL de conexão'), { target: { value: url } });
  fireEvent.click(modal.getByRole('button', { name: 'Testar conexão' }));
}

describe('Integrations > Storage', () => {
  it('appears only in the desktop app', async () => {
    const view = render(<ConnectView />);
    await waitFor(() => expect(view.getByTestId('screen-connect')).toBeInTheDocument());
    expect(view.queryByTestId('conn-card-cloud-database')).toBeNull();
    expect(view.queryByRole('tab', { name: /Armazenamento/ })).toBeNull();
  });

  it('shows the storage section with its own filter while the data is local', async () => {
    desktop({ mode: 'local', busy: false });
    const view = render(<ConnectView />);
    const card = await view.findByTestId('conn-card-cloud-database');
    expect(card).toHaveTextContent('Não configurado');
    expect(view.getByRole('heading', { name: 'Armazenamento' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: /Armazenamento/ }));
    expect(view.getByTestId('conn-card-cloud-database')).toBeInTheDocument();
    expect(view.queryByTestId('conn-card-azure')).toBeNull();
    expect(view.getByRole('tab', { name: /Armazenamento/ })).toHaveTextContent('1');
    fireEvent.click(view.getByRole('tab', { name: /Conhecimento/ }));
    expect(view.queryByTestId('conn-card-cloud-database')).toBeNull();
  });

  it('copies the data on this computer to an empty cloud database', async () => {
    const storage = desktop({ mode: 'local', busy: false });
    const view = render(<ConnectView />);
    const modal = await openModal(view);
    const connect = modal.getByRole('button', { name: 'Usar este banco' });
    expect(connect).toHaveProperty('disabled', true);
    await checkUrl(modal, '  postgresql://u:p@db.example.com/adk  ');
    expect(storage.inspect).toHaveBeenCalledWith('postgresql://u:p@db.example.com/adk');
    expect(await modal.findByText('Conectado a db.example.com. O banco está vazio.')).toBeTruthy();
    const copy = modal.getByRole('switch', { name: /Copiar os dados deste computador/ });
    expect(copy).toHaveProperty('checked', true);
    fireEvent.click(connect);
    await waitFor(() =>
      expect(storage.connect).toHaveBeenCalledWith({
        url: 'postgresql://u:p@db.example.com/adk',
        copyLocalData: true,
      }),
    );
  });

  it('can start the cloud database empty, and asks again after the URL changes', async () => {
    const storage = desktop({ mode: 'local', busy: false });
    const view = render(<ConnectView />);
    const modal = await openModal(view);
    await checkUrl(modal);
    fireEvent.click(await modal.findByRole('switch', { name: /Copiar os dados/ }));
    fireEvent.click(modal.getByRole('button', { name: 'Usar este banco' }));
    await waitFor(() =>
      expect(storage.connect).toHaveBeenCalledWith(
        expect.objectContaining({ copyLocalData: false }),
      ),
    );
    fireEvent.change(modal.getByLabelText('URL de conexão'), {
      target: { value: 'postgresql://u:p@other/adk' },
    });
    expect(modal.queryByTestId('cloud-database-checked')).toBeNull();
    expect(modal.getByRole('button', { name: 'Usar este banco' })).toHaveProperty('disabled', true);
  });

  it('uses a database that already has ADK data, with the other computer key', async () => {
    const storage = desktop(
      { mode: 'local', busy: false },
      {
        inspect: vi.fn().mockResolvedValue({
          ok: true,
          inspection: { kind: 'adk', users: 3, unknownMigrations: [], serverVersion: '16' },
          target,
        }),
      },
    );
    const view = render(<ConnectView />);
    const modal = await openModal(view);
    await checkUrl(modal);
    expect(
      await modal.findByText('Conectado a db.example.com. Ele já tem dados do ADK (3 usuários).'),
    ).toBeTruthy();
    expect(modal.queryByRole('switch')).toBeNull();
    fireEvent.click(modal.getByRole('button', { name: 'Usar este banco' }));
    await waitFor(() =>
      expect(storage.connect).toHaveBeenLastCalledWith({
        url: 'postgresql://u:p@db.example.com/adk',
        copyLocalData: false,
      }),
    );
    fireEvent.change(modal.getByLabelText(/Chave de criptografia do computador/), {
      target: { value: ` ${'k'.repeat(64)} ` },
    });
    fireEvent.click(modal.getByRole('button', { name: 'Usar este banco' }));
    await waitFor(() =>
      expect(storage.connect).toHaveBeenLastCalledWith({
        url: 'postgresql://u:p@db.example.com/adk',
        copyLocalData: false,
        integrationEncryptionKey: 'k'.repeat(64),
      }),
    );
  });

  it('shows why a database cannot be used', async () => {
    const inspect = vi.fn().mockResolvedValue({ ok: false, error: 'The server refused.' });
    desktop({ mode: 'local', busy: false }, { inspect });
    const view = render(<ConnectView />);
    const modal = await openModal(view);
    await checkUrl(modal);
    expect(await modal.findByRole('alert')).toHaveTextContent('The server refused.');
    expect(modal.getByRole('button', { name: 'Usar este banco' })).toHaveProperty('disabled', true);

    inspect.mockRejectedValueOnce(new Error('IPC failed'));
    fireEvent.click(modal.getByRole('button', { name: 'Testar conexão' }));
    await waitFor(() => expect(modal.getByRole('alert')).toHaveTextContent('IPC failed'));
    inspect.mockRejectedValueOnce('plain failure');
    fireEvent.click(modal.getByRole('button', { name: 'Testar conexão' }));
    await waitFor(() => expect(modal.getByRole('alert')).toHaveTextContent('plain failure'));
  });

  it('shows the cloud database in use, copies its key and disconnects', async () => {
    const storage = desktop({ mode: 'cloud', target, busy: false });
    const view = render(<ConnectView />);
    expect(await view.findByTestId('conn-card-cloud-database')).toHaveTextContent('Conectado');
    const modal = await openModal(view);
    expect(modal.getByText('db.example.com:5432')).toBeTruthy();
    expect(modal.getByText('owner')).toBeTruthy();

    fireEvent.click(modal.getByRole('button', { name: /Copiar chave de criptografia/ }));
    expect(await modal.findByRole('status')).toHaveTextContent('Chave de criptografia copiada');

    fireEvent.click(modal.getByRole('button', { name: 'Desconectar' }));
    await waitFor(() => expect(storage.disconnect).toHaveBeenCalledWith({ copyCloudData: false }));
    fireEvent.click(modal.getByRole('switch', { name: /Trazer os dados da nuvem/ }));
    fireEvent.click(modal.getByRole('switch', { name: /Trazer os dados da nuvem/ }));
    fireEvent.click(modal.getByRole('switch', { name: /Trazer os dados da nuvem/ }));
    fireEvent.click(modal.getByRole('button', { name: 'Desconectar' }));
    await waitFor(() =>
      expect(storage.disconnect).toHaveBeenLastCalledWith({ copyCloudData: true }),
    );
  });

  it('reports a failed disconnect or key copy and closes', async () => {
    desktop(
      { mode: 'cloud', target, busy: false },
      {
        disconnect: vi.fn().mockResolvedValue({ ok: false, error: 'Agent DevKit is busy.' }),
        copyEncryptionKey: vi.fn().mockResolvedValue({ ok: false, error: 'Not allowed.' }),
      },
    );
    const view = render(<ConnectView />);
    const modal = await openModal(view);
    fireEvent.click(modal.getByRole('button', { name: /Copiar chave/ }));
    expect(await modal.findByRole('alert')).toHaveTextContent('Not allowed.');
    fireEvent.click(modal.getByRole('button', { name: 'Desconectar' }));
    await waitFor(() =>
      expect(modal.getByRole('alert')).toHaveTextContent('Agent DevKit is busy.'),
    );
    fireEvent.click(modal.getByRole('button', { name: 'Fechar modal de integração' }));
    expect(view.queryByTestId('cloud-database-modal')).toBeNull();
  });

  it('keeps the modal closed while ADK is busy and for read-only members', async () => {
    desktop({ mode: 'local', busy: true });
    const view = render(<ConnectView />);
    const modal = await openModal(view);
    expect(modal.getByRole('button', { name: 'Cancelar' })).toHaveProperty('disabled', true);
    view.unmount();

    desktop({ mode: 'local', busy: false });
    const readOnly = render(<ConnectView canManageIntegrations={false} />);
    fireEvent.click(await readOnly.findByTestId('conn-card-cloud-database'));
    expect(readOnly.queryByTestId('cloud-database-modal')).toBeNull();
  });

  it('closes with Cancel, and ignores a status call that fails', async () => {
    desktop({ mode: 'local', busy: false });
    const view = render(<ConnectView />);
    const modal = await openModal(view);
    fireEvent.click(modal.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByTestId('cloud-database-modal')).toBeNull();
    view.unmount();

    desktop(
      { mode: 'local', busy: false },
      { status: vi.fn().mockRejectedValue(new Error('no bridge')) },
    );
    const broken = render(<ConnectView />);
    await waitFor(() => expect(window.adkDesktop?.storage?.status).toHaveBeenCalled());
    expect(broken.queryByTestId('conn-card-cloud-database')).toBeNull();
  });
});
