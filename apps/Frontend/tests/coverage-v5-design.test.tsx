import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignView } from '../src/features/design/DesignView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { DesignProjectDto, DesignSystemDto } from '../src/lib/api-client.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const PROJECT: DesignProjectDto = {
  id: 'landing-123',
  provider: 'github',
  title: 'Landing',
  agentId: AGENT_ID,
  updatedAt: '2026-09-17T10:00:00.000Z',
  files: [{ name: 'index.html', language: 'html', content: '<html><body>Olá</body></html>' }],
  messages: [],
};

const core: DesignSystemDto = {
  id: 'system-1',
  name: 'Core',
  content: '<html><body>tokens</body></html>',
  updatedAt: '2026-09-17T10:00:00.000Z',
};
const other: DesignSystemDto = { ...core, id: 'system-2', name: 'Other' };

function client() {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignProviders').mockResolvedValue(['github']);
  vi.spyOn(api, 'getDesignProjects').mockResolvedValue([PROJECT]);
  vi.spyOn(api, 'getDesignSystems').mockResolvedValue([core, other]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([
    {
      id: AGENT_ID,
      workspaceId: 'ws',
      name: 'Designer',
      slug: 'designer',
      description: '',
      instructions: '',
      role: 'CUSTOM',
      model: '',
      temperature: 0.2,
      isSystem: false,
      createdAt: '',
      updatedAt: '',
    },
  ]);
  return api;
}

async function onSystems(api: ApiClient) {
  const ui = render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
  await ui.findByText('Landing');
  fireEvent.click(ui.getByRole('button', { name: /Design Systems/ }));
  return ui;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DesignView saved system list', () => {
  it('replaces the edited system in the list instead of duplicating it', async () => {
    const api = client();
    const save = vi.spyOn(api, 'saveDesignSystem').mockResolvedValue({ ...core, name: 'Core v2' });
    const ui = await onSystems(api);
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo do Design System' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'Core' }));
    fireEvent.change(ui.getByLabelText('Nome do Design System'), { target: { value: 'Core v2' } });
    fireEvent.click(ui.getByRole('button', { name: 'Salvar template' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('github', expect.objectContaining({ id: 'system-1' })),
    );
    expect(await ui.findByRole('button', { name: 'Core v2' })).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: 'Core' })).not.toBeInTheDocument();
    expect(ui.getByRole('button', { name: 'Other' })).toBeInTheDocument();
  });

  it('sends reference images when generating a system and keeps the other systems', async () => {
    const api = client();
    const generate = vi
      .spyOn(api, 'generateDesignSystem')
      .mockResolvedValue({ content: '<html>tokens</html>' });
    vi.spyOn(api, 'saveDesignSystem').mockResolvedValue({ ...other, id: 'system-3', name: 'New' });
    const ui = await onSystems(api);
    const inputs = ui.getAllByLabelText('Adicionar imagens', { selector: 'input' });
    fireEvent.change(inputs[inputs.length - 1]!, {
      target: { files: [new File(['x'], 'ref.png', { type: 'image/png' })] },
    });
    await ui.findByAltText('ref.png');
    fireEvent.change(ui.getByLabelText('Descrição do Design System'), {
      target: { value: 'A calm palette' },
    });
    fireEvent.click(ui.getByRole('button', { name: /Gerar HTML com agente/ }));

    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith(AGENT_ID, 'A calm palette', [
        expect.objectContaining({ mimeType: 'image/png' }),
      ]),
    );
    expect(await ui.findByText('Template HTML gerado e salvo no repositório.')).toBeInTheDocument();
    expect(ui.getByRole('button', { name: 'Core' })).toBeInTheDocument();
  });
});

describe('DesignView preview window', () => {
  it('releases the preview URL a minute after opening it in a new page', async () => {
    const api = client();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const timers: (() => void)[] = [];
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /Landing/ }));
    const setTimer = vi.spyOn(window, 'setTimeout').mockImplementation(((callback: () => void) => {
      timers.push(callback);
      return 0;
    }) as unknown as typeof window.setTimeout);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir preview em nova página' }));
    setTimer.mockRestore();
    expect(revoke).not.toHaveBeenCalled();
    timers.forEach((callback) => callback());
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });
});
