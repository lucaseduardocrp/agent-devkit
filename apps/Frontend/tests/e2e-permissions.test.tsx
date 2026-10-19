import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eView } from '../src/features/e2e/E2eView.js';
import { E2eLinkedCase } from '../src/features/e2e/E2eTestEvidence.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type { EffectiveAccess } from '../src/features/workspaces/workspace-types.js';
import type { ApiClient } from '../src/lib/api-client.js';
import type { E2eCreationSummary, E2eTestDetail } from '../src/features/e2e/e2e-types.js';

const TEST: E2eTestDetail = {
  id: 't1',
  creationId: 'c1',
  position: 1,
  code: 'TC001',
  title: 'Access public event page',
  description: 'Verify the public page.',
  steps: ['Open the page'],
  priority: 'high',
  scriptPath: 'tests/e2e/tc001-access.spec.ts',
  status: 'passed',
  error: null,
  analysis: null,
  verdict: null,
  durationMs: 1200,
  attempts: 1,
  hasVideo: false,
  externalCase: null,
  stepResults: [],
  createdAt: '2026-01-30T09:23:00Z',
  updatedAt: '2026-01-30T09:24:00Z',
  lastRunAt: '2026-01-30T09:24:00Z',
  logs: null,
  creation: {
    id: 'c1',
    name: 'ama',
    mode: 'frontend',
    baseUrl: 'http://localhost:3000',
    path: '/',
    status: 'completed',
  },
};

const CREATION: E2eCreationSummary = {
  id: 'c1',
  agentId: 'a1',
  name: 'ama',
  mode: 'frontend',
  scope: 'codebase',
  baseUrl: 'http://localhost:3000',
  path: '/e/123',
  username: null,
  hasPassword: false,
  reporting: null,
  lastReport: null,
  prdFileNames: [],
  repository: null,
  status: 'completed',
  error: null,
  createdAt: '2026-01-30T09:23:00Z',
  updatedAt: '2026-01-30T09:36:00Z',
  finishedAt: '2026-01-30T09:36:00Z',
  passed: 1,
  total: 1,
  tests: [TEST],
};

/** No agent and no repository, so the form offers its links to Agents and Integrations. */
function client(): ApiClient {
  return {
    getE2eCreations: vi.fn().mockResolvedValue([CREATION]),
    getAgents: vi.fn().mockResolvedValue([]),
    getE2eRepositories: vi.fn().mockResolvedValue({ repositories: [], warnings: [] }),
    getTestManagementProviders: vi.fn().mockResolvedValue([]),
  } as unknown as ApiClient;
}

function access(modules: Partial<EffectiveAccess['modules']>): EffectiveAccess {
  return { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, ...modules } };
}

async function view(grants: EffectiveAccess) {
  const onOpenAgents = vi.fn();
  const onOpenIntegrations = vi.fn();
  const ui = render(
    <PermissionsProvider access={grants}>
      <E2eView
        apiClient={client()}
        isReadOnly={!['edit', 'delete'].includes(grants.modules.e2e)}
        onOpenAgents={onOpenAgents}
        onOpenIntegrations={onOpenIntegrations}
      />
    </PermissionsProvider>,
  );
  await ui.findByText('ama');
  return { ui, onOpenAgents, onOpenIntegrations };
}

describe('E2eView permissions', () => {
  it('offers deleting a run only to members who can delete E2E runs', async () => {
    const full = await view(access({ e2e: 'delete' }));
    fireEvent.click(full.ui.getByRole('button', { name: 'Ações' }));
    expect(await full.ui.findByRole('menuitem', { name: /Excluir execução/ })).toBeInTheDocument();
    full.ui.unmount();

    const editor = await view(access({ e2e: 'edit' }));
    fireEvent.click(editor.ui.getByRole('button', { name: 'Ações' }));
    expect(await editor.ui.findByRole('menuitem', { name: /Editar/ })).toBeInTheDocument();
    expect(editor.ui.getByRole('menuitem', { name: /Executar todos novamente/ })).toBeTruthy();
    expect(editor.ui.queryByRole('menuitem', { name: /Excluir execução/ })).toBeNull();
  });

  it('hides importing cases from test plans without access to them', async () => {
    const { ui } = await view(access({ testplans: 'none' }));

    expect(ui.getByRole('button', { name: /Gestão de testes/ })).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: /Importar test cases/ })).toBeNull();
    fireEvent.click(ui.getByRole('button', { name: /Nova execução/ }));
    expect(await ui.findByTestId('e2e-config-form')).toBeInTheDocument();
    expect(ui.queryByRole('radiogroup', { name: 'Origem dos testes' })).toBeNull();
  });

  it('offers importing cases and choosing them as the source with access to test plans', async () => {
    const { ui } = await view(access({ testplans: 'view' }));

    fireEvent.click(ui.getByRole('button', { name: /Importar test cases/ }));
    expect(await ui.findByRole('dialog', { name: /Importar test cases · ama/ })).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(ui.getByRole('button', { name: /Nova execução/ }));
    expect(await ui.findByRole('radiogroup', { name: 'Origem dos testes' })).toBeInTheDocument();
  });

  it('links to Agents and Integrations only for members who can open them', async () => {
    const allowed = await view(access({ agents: 'view', integrations: 'view' }));
    fireEvent.click(allowed.ui.getByRole('button', { name: /Nova execução/ }));
    fireEvent.click(await allowed.ui.findByRole('button', { name: 'Agents' }));
    fireEvent.click(await allowed.ui.findByRole('button', { name: 'Integrações' }));
    expect(allowed.onOpenAgents).toHaveBeenCalled();
    expect(allowed.onOpenIntegrations).toHaveBeenCalled();
    allowed.ui.unmount();

    const denied = await view(access({ agents: 'none', integrations: 'none' }));
    fireEvent.click(denied.ui.getByRole('button', { name: /Nova execução/ }));
    expect(await denied.ui.findByText(/Crie um agente em Agents/)).toBeInTheDocument();
    expect(await denied.ui.findByText(/Nenhum repositório encontrado/)).toBeInTheDocument();
    expect(denied.ui.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(denied.ui.queryByRole('button', { name: 'Integrações' })).toBeNull();
  });

  it('shows a viewer the runs without any action', async () => {
    const { ui } = await view(access({ e2e: 'view' }));

    expect(ui.queryByRole('button', { name: /Nova execução/ })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Ações' })).toBeNull();
    expect(ui.queryByRole('button', { name: /Gestão de testes/ })).toBeNull();
    expect(ui.queryByRole('button', { name: /Importar test cases/ })).toBeNull();
  });
});

describe('E2eLinkedCase permissions', () => {
  function linkedCase(grants: EffectiveAccess) {
    return render(
      <PermissionsProvider access={grants}>
        <E2eLinkedCase
          apiClient={{} as ApiClient}
          test={TEST}
          reporting={null}
          isReadOnly={false}
          disabled={false}
          onChanged={vi.fn()}
        />
      </PermissionsProvider>,
    );
  }

  it('offers linking a case from a test plan only with access to test plans', () => {
    const allowed = linkedCase(access({ testplans: 'view' }));
    expect(screen.getByRole('button', { name: /Vincular/ })).toBeInTheDocument();
    allowed.unmount();

    linkedCase(access({ testplans: 'none' }));
    expect(screen.getByText('Nenhum test case vinculado.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vincular/ })).toBeNull();
  });
});
