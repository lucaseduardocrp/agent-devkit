import { fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignView } from '../src/features/design/DesignView.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type { EffectiveAccess } from '../src/features/workspaces/workspace-types.js';
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
  messages: [
    { role: 'assistant', content: 'Protótipo criado.', createdAt: '2026-09-17T10:00:00.000Z' },
  ],
};

const SYSTEM: DesignSystemDto = {
  id: 'system-1',
  name: 'Core',
  content: '<html><body>tokens</body></html>',
  updatedAt: '2026-09-17T10:00:00.000Z',
};

function client() {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignProviders').mockResolvedValue(['github']);
  vi.spyOn(api, 'getDesignProjects').mockResolvedValue([PROJECT]);
  vi.spyOn(api, 'getDesignSystems').mockResolvedValue([SYSTEM]);
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

function access(modules: Partial<EffectiveAccess['modules']>): EffectiveAccess {
  return { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, ...modules } };
}

/** Renders the view the way App does: read-only unless the member can edit designs. */
async function view(
  grants: EffectiveAccess,
  onManageRepositories: () => void = vi.fn(),
): Promise<ReturnType<typeof render>> {
  const ui = render(
    <PermissionsProvider access={grants}>
      <DesignView
        apiClient={client()}
        activeWorkspaceId="ws"
        isReadOnly={!['edit', 'delete'].includes(grants.modules.design)}
        onManageRepositories={onManageRepositories}
      />
    </PermissionsProvider>,
  );
  await ui.findByText('Landing');
  return ui;
}

function openSystem(ui: ReturnType<typeof render>) {
  fireEvent.click(ui.getByRole('button', { name: /Design Systems/ }));
  fireEvent.click(ui.getByRole('button', { name: 'Core' }));
}

afterEach(() => vi.restoreAllMocks());

describe('DesignView permissions', () => {
  it('offers the delete actions to a member who can delete designs', async () => {
    const ui = await view(access({ design: 'delete' }));

    fireEvent.click(ui.getByRole('button', { name: 'Landing' }));
    expect(ui.getByRole('button', { name: 'Excluir projeto' })).toBeInTheDocument();

    openSystem(ui);
    expect(ui.getByRole('button', { name: 'Excluir' })).toBeInTheDocument();
  });

  it('lets an editor create and change designs without deleting them', async () => {
    const ui = await view(access({ design: 'edit' }));

    expect(ui.getByRole('button', { name: /Criar com agente/ })).toBeInTheDocument();
    fireEvent.click(ui.getByRole('button', { name: 'Landing' }));
    expect(ui.queryByRole('button', { name: 'Excluir projeto' })).toBeNull();
    expect(ui.getByLabelText('Mensagem para o agente')).toBeInTheDocument();

    openSystem(ui);
    expect(ui.getByRole('button', { name: 'Salvar template' })).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: 'Excluir' })).toBeNull();
  });

  it('shows a viewer the prototypes and systems without any way to change them', async () => {
    const ui = await view(access({ design: 'view' }));

    expect(ui.queryByRole('button', { name: /Novo protótipo/ })).toBeNull();
    expect(ui.queryByRole('button', { name: /Criar com agente/ })).toBeNull();
    expect(ui.queryByRole('button', { name: /Gerenciar repositórios/ })).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'Landing' }));
    expect(ui.getByText('Protótipo criado.')).toBeInTheDocument();
    expect(ui.getByRole('button', { name: /Pull/ })).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: 'Excluir projeto' })).toBeNull();
    expect(ui.queryByLabelText('Mensagem para o agente')).toBeNull();
    expect(ui.queryByRole('button', { name: /Enviar/ })).toBeNull();
    expect(ui.queryByLabelText('Agente')).toBeNull();
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
        name: 'Código',
      }),
    );
    expect(ui.getByLabelText('Código de index.html')).toHaveAttribute('readonly');
    expect(ui.queryByRole('button', { name: 'Push' })).toBeNull();

    openSystem(ui);
    expect(ui.queryByRole('button', { name: 'Novo template' })).toBeNull();
    expect(ui.queryByLabelText('Nome do Design System')).toBeNull();
    expect(ui.queryByRole('button', { name: /Gerar HTML com agente/ })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Salvar template' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Excluir' })).toBeNull();
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo do Design System' })).getByRole('button', {
        name: 'Código',
      }),
    );
    expect(ui.getByLabelText('HTML do Design System')).toHaveAttribute('readonly');
  });

  it('links to the repositories only for members who can open the integrations', async () => {
    const onManageRepositories = vi.fn();
    const allowed = await view(access({ integrations: 'view' }), onManageRepositories);
    fireEvent.click(allowed.getByRole('button', { name: /Gerenciar repositórios/ }));
    expect(onManageRepositories).toHaveBeenCalled();
    allowed.unmount();

    const denied = await view(access({ integrations: 'none' }));
    expect(denied.getByRole('button', { name: /Criar com agente/ })).toBeInTheDocument();
    expect(denied.queryByRole('button', { name: /Gerenciar repositórios/ })).toBeNull();
  });
});
