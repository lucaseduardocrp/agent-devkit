import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  E2eCasePicker,
  E2eImportCasesDialog,
  E2eReportingDialog,
  E2eReportStatus,
  E2eReportStrip,
  EMPTY_SELECTION,
  errorMessage,
  type TestManagementSelection,
} from '../src/features/e2e/E2eTestManagement.js';
import type {
  E2eCreationSummary,
  E2eImportResult,
  E2eLastReport,
} from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const creation: E2eCreationSummary = {
  id: 'run-1',
  agentId: 'agent-1',
  name: 'Empresas',
  mode: 'frontend',
  scope: 'codebase',
  baseUrl: 'https://example.test',
  path: '/',
  username: null,
  hasPassword: false,
  prdFileNames: [],
  repository: null,
  reporting: null,
  lastReport: null,
  status: 'completed',
  error: null,
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:01:00Z',
  finishedAt: '2026-10-07T10:01:00Z',
  passed: 0,
  total: 0,
  tests: [],
};

const providers = [
  {
    id: 'azure_devops',
    name: 'Azure DevOps Test Plans',
    configured: true,
    capabilities: {
      planLabel: 'Test Plan',
      suiteLabel: 'Suite',
      suiteRequired: true,
      caseIdLabel: 'Test Case ID',
      stepEvidence: true,
    },
  },
  {
    id: 'testrail',
    name: 'TestRail',
    configured: true,
    capabilities: {
      planLabel: 'Project',
      suiteLabel: 'Section',
      suiteRequired: false,
      caseIdLabel: 'Case ID',
      stepEvidence: false,
    },
  },
  {
    id: 'xray',
    name: 'Xray Cloud',
    configured: false,
    capabilities: {
      planLabel: 'Jira project',
      caseIdLabel: 'Issue key',
      stepEvidence: false,
    },
  },
];

const cases = [
  {
    provider: 'azure_devops',
    caseId: '50605',
    planId: '1',
    suiteId: '2',
    title: 'Permissões de Empresas',
    steps: [{ id: '2', action: 'Abrir grupos', expectedResult: 'Grupos visíveis' }],
  },
  {
    provider: 'azure_devops',
    caseId: '50606',
    planId: '1',
    suiteId: '2',
    title: 'Excluir empresa',
    steps: [],
  },
];

function api() {
  return {
    getTestManagementProviders: vi.fn().mockResolvedValue(providers),
    getTestManagementPlans: vi.fn().mockResolvedValue([{ id: '1', name: 'Empresas' }]),
    getTestManagementSuites: vi.fn().mockResolvedValue([{ id: '2', name: 'Permissões' }]),
    getTestManagementCases: vi.fn().mockResolvedValue(cases),
    setE2eReporting: vi.fn().mockResolvedValue(undefined),
    importE2eCases: vi.fn().mockResolvedValue({ imported: 1, skipped: 0, creation }),
  };
}

type Client = ReturnType<typeof api>;

function Picker({
  client,
  initial = EMPTY_SELECTION,
  single,
  invalid,
  onChange,
}: {
  readonly client: Client;
  readonly initial?: TestManagementSelection;
  readonly single?: boolean;
  readonly invalid?: boolean;
  readonly onChange?: (value: TestManagementSelection) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <E2eCasePicker
      apiClient={client as unknown as ApiClient}
      value={value}
      single={single}
      invalid={invalid}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

const report = (overrides: Partial<E2eLastReport>): E2eLastReport => ({
  status: 'published',
  provider: 'azure_devops',
  remoteRunId: null,
  url: null,
  publishedCases: 2,
  warnings: [],
  error: null,
  updatedAt: '2026-10-07T10:02:00Z',
  ...overrides,
});

describe('errorMessage', () => {
  it('uses the error message and falls back for other values', () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom');
    expect(errorMessage('boom', 'fallback')).toBe('fallback');
  });
});

describe('E2eCasePicker', () => {
  it('shows a provider load failure and retries it', async () => {
    const client = api();
    client.getTestManagementProviders.mockRejectedValueOnce(new Error('Sem acesso'));
    render(<Picker client={client} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Sem acesso');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByLabelText('Plataforma')).toBeInTheDocument();
    expect(client.getTestManagementProviders).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generic message when the providers fail without an Error', async () => {
    const client = api();
    client.getTestManagementProviders.mockRejectedValueOnce('nope');
    render(<Picker client={client} />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível carregar os dados da plataforma.',
    );
  });

  it('marks unconfigured platforms and asks for a location before listing cases', async () => {
    const client = api();
    render(<Picker client={client} />);
    const option = await screen.findByRole('option', { name: 'Xray Cloud (não configurado)' });
    expect((option as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Plataforma'), { target: { value: 'azure_devops' } });
    expect(
      await screen.findByText('Escolha a plataforma e o local para listar os test cases.'),
    ).toBeInTheDocument();
  });

  it('shows plan and suite failures with a retry', async () => {
    const client = api();
    client.getTestManagementPlans.mockRejectedValueOnce(new Error('Planos indisponíveis'));
    client.getTestManagementSuites.mockRejectedValueOnce(new Error('Suítes indisponíveis'));
    render(<Picker client={client} />);
    fireEvent.change(await screen.findByLabelText('Plataforma'), {
      target: { value: 'azure_devops' },
    });
    expect(await screen.findByText('Planos indisponíveis')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tentar novamente'));
    await screen.findByRole('option', { name: 'Empresas' });
    fireEvent.change(screen.getByLabelText('Test Plan'), { target: { value: '1' } });
    expect(await screen.findByText('Suítes indisponíveis')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tentar novamente'));
    expect(await screen.findByRole('option', { name: 'Permissões' })).toBeInTheDocument();
    expect(client.getTestManagementSuites).toHaveBeenCalledTimes(2);
  });

  it('lists cases of a platform whose suite is optional, without a suite filter', async () => {
    const client = api();
    render(<Picker client={client} />);
    fireEvent.change(await screen.findByLabelText('Plataforma'), {
      target: { value: 'testrail' },
    });
    await screen.findByRole('option', { name: 'Empresas' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '1' } });
    expect(await screen.findByRole('option', { name: 'Todas' })).toBeInTheDocument();
    await screen.findByText('Permissões de Empresas');
    expect(client.getTestManagementCases).toHaveBeenCalledWith('testrail', { planId: '1' });
  });

  it('selects all cases, toggles them one by one and clears them', async () => {
    const client = api();
    const onChange = vi.fn<(value: TestManagementSelection) => void>();
    render(
      <Picker
        client={client}
        initial={{ provider: 'azure_devops', planId: '1', suiteId: '2', caseIds: [] }}
        onChange={onChange}
      />,
    );
    await screen.findByText('Permissões de Empresas');
    expect(screen.getByText('0 passos')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Selecionar todos/));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ caseIds: ['50605', '50606'] }),
    );
    expect(screen.getByText('2/2')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/50605/));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ caseIds: ['50606'] }));
    fireEvent.click(screen.getByLabelText(/50605/));
    fireEvent.click(screen.getByLabelText(/Selecionar todos/));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ caseIds: [] }));
  });

  it('shows a validation message when no case is selected', async () => {
    const client = api();
    render(
      <Picker
        client={client}
        invalid
        initial={{ provider: 'azure_devops', planId: '1', suiteId: '2', caseIds: [] }}
      />,
    );
    await screen.findByText('Permissões de Empresas');
    expect(screen.getByRole('alert').textContent).toBe('Selecione ao menos um test case.');
  });

  it('reports empty locations and case load failures', async () => {
    const client = api();
    client.getTestManagementCases
      .mockRejectedValueOnce(new Error('Casos indisponíveis'))
      .mockResolvedValueOnce([]);
    render(
      <Picker
        client={client}
        initial={{ provider: 'azure_devops', planId: '1', suiteId: '2', caseIds: [] }}
      />,
    );
    expect(await screen.findByText('Casos indisponíveis')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Nenhum test case encontrado.')).toBeInTheDocument();
  });

  it('picks a single case with the searchable select and clears it by typing', async () => {
    const client = api();
    const onChange = vi.fn<(value: TestManagementSelection) => void>();
    render(
      <Picker
        client={client}
        single
        initial={{ provider: 'azure_devops', planId: '1', suiteId: '2', caseIds: [] }}
        onChange={onChange}
      />,
    );
    const combobox = await screen.findByRole('combobox', { name: 'ID do test case' });
    fireEvent.focus(combobox);
    fireEvent.click(screen.getByRole('option', { name: '50606 · Excluir empresa' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ caseIds: ['50606'] }));
    fireEvent.change(combobox, { target: { value: 'x' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ caseIds: [] }));
  });
});

describe('E2eReportingDialog', () => {
  const reporting = {
    provider: 'testrail' as const,
    planId: '1',
    suiteId: null,
    autoPublish: false,
  };

  it('starts from the current reporting and saves an empty suite as null', async () => {
    const client = api();
    const onSaved = vi.fn();
    render(
      <E2eReportingDialog
        apiClient={client as unknown as ApiClient}
        creation={{ ...creation, reporting }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await screen.findByRole('option', { name: 'Todas' });
    const checkbox = screen.getByLabelText(
      'Publicar automaticamente ao fim de cada execução',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.setE2eReporting).toHaveBeenCalledWith('run-1', {
        provider: 'testrail',
        planId: '1',
        suiteId: null,
        autoPublish: true,
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('saves a platform without plan as null', async () => {
    const client = api();
    const onSaved = vi.fn();
    render(
      <E2eReportingDialog
        apiClient={client as unknown as ApiClient}
        creation={{ ...creation, reporting }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Plataforma'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.setE2eReporting).toHaveBeenCalledWith('run-1', {
        provider: 'azure_devops',
        planId: null,
        suiteId: null,
        autoPublish: false,
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('stops publishing the results', async () => {
    const client = api();
    const onSaved = vi.fn();
    render(
      <E2eReportingDialog
        apiClient={client as unknown as ApiClient}
        creation={{ ...creation, reporting }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await screen.findByLabelText('Plataforma');
    fireEvent.click(screen.getByRole('button', { name: 'Não publicar' }));
    await waitFor(() => expect(client.setE2eReporting).toHaveBeenCalledWith('run-1', null));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('shows why saving failed and lets the user try again', async () => {
    const client = api();
    client.setE2eReporting.mockRejectedValueOnce(new Error('Sem permissão'));
    const onSaved = vi.fn();
    render(
      <E2eReportingDialog
        apiClient={client as unknown as ApiClient}
        creation={{ ...creation, reporting }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await screen.findByLabelText('Plataforma');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sem permissão');
    expect(onSaved).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('points to the integrations when no platform is configured', async () => {
    const client = api();
    client.getTestManagementProviders.mockResolvedValueOnce([
      { ...providers[0], configured: false },
    ]);
    const onOpenIntegrations = vi.fn();
    render(
      <E2eReportingDialog
        apiClient={client as unknown as ApiClient}
        creation={creation}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onOpenIntegrations={onOpenIntegrations}
      />,
    );
    expect(
      await screen.findByText(/Nenhuma plataforma de gestão de testes configurada/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Não publicar' })).toBeNull();
  });
});

describe('E2eImportCasesDialog', () => {
  it('imports from the reporting plan without a suite', async () => {
    const client = api();
    const onImported = vi.fn<(result: E2eImportResult) => void>();
    render(
      <E2eImportCasesDialog
        apiClient={client as unknown as ApiClient}
        creation={{
          ...creation,
          reporting: { provider: 'testrail', planId: '1', suiteId: null, autoPublish: true },
        }}
        onClose={vi.fn()}
        onImported={onImported}
      />,
    );
    fireEvent.click(await screen.findByLabelText(/50606/));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Importar (1)' }));
    });
    expect(client.importE2eCases).toHaveBeenCalledWith('run-1', {
      provider: 'testrail',
      planId: '1',
      caseIds: ['50606'],
    });
    expect(onImported).toHaveBeenCalledWith({ imported: 1, skipped: 0, creation });
  });

  it('shows why the import failed', async () => {
    const client = api();
    client.importE2eCases.mockRejectedValueOnce(new Error('Falha no import'));
    const onImported = vi.fn();
    render(
      <E2eImportCasesDialog
        apiClient={client as unknown as ApiClient}
        creation={{
          ...creation,
          reporting: { provider: 'azure_devops', planId: '1', suiteId: '2', autoPublish: true },
        }}
        onClose={vi.fn()}
        onImported={onImported}
      />,
    );
    fireEvent.click(await screen.findByLabelText(/50605/));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Importar (1)' }));
    });
    expect((await screen.findByText('Falha no import')).getAttribute('role')).toBe('alert');
    expect(onImported).not.toHaveBeenCalled();
  });

  it('keeps the import disabled until a plan and a case are chosen', async () => {
    const client = api();
    render(
      <E2eImportCasesDialog
        apiClient={client as unknown as ApiClient}
        creation={creation}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Plataforma'), {
      target: { value: 'azure_devops' },
    });
    expect(
      (screen.getByRole('button', { name: 'Importar (0)' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(client.getTestManagementCases).not.toHaveBeenCalled();
  });
});

describe('E2eReportStatus', () => {
  it('shows a publication in progress', () => {
    render(<E2eReportStatus report={report({ status: 'publishing' })} />);
    expect(screen.getByRole('status').textContent).toBe('Publicando em Azure Test Plans…');
  });

  it('shows a failed publication with and without an error', () => {
    const { rerender } = render(
      <E2eReportStatus report={report({ status: 'failed', error: 'Token expirado' })} />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'Falha ao publicar em Azure Test Plans: Token expirado',
    );
    rerender(<E2eReportStatus report={report({ status: 'failed', provider: 'xray' })} />);
    expect(screen.getByRole('alert').textContent).toBe('Falha ao publicar em Xray Cloud: ');
  });

  it('shows a published run without link or warnings', () => {
    render(<E2eReportStatus report={report({})} />);
    expect(screen.getByRole('status').textContent).toBe(
      'Publicado em Azure Test Plans: 2 test cases',
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('E2eReportStrip', () => {
  it('offers configuration only when the run is not reported', () => {
    const onManage = vi.fn();
    render(
      <E2eReportStrip
        creation={creation}
        isReadOnly={false}
        onManage={onManage}
        onPublish={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Os resultados não são publicados em uma plataforma de gestão de testes.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Importar test cases/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Publicar run/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Gestão de testes/ }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('shows the reporting target, its last report and the actions', () => {
    const onImport = vi.fn();
    const onPublish = vi.fn();
    render(
      <E2eReportStrip
        creation={{
          ...creation,
          reporting: { provider: 'testrail', planId: '1', suiteId: null, autoPublish: true },
          lastReport: report({ provider: 'testrail' }),
        }}
        isReadOnly={false}
        onManage={vi.fn()}
        onImport={onImport}
        onPublish={onPublish}
      />,
    );
    expect(screen.getByText(/Publica em TestRail/)).toBeInTheDocument();
    expect(screen.getByText('Publicação automática')).toBeInTheDocument();
    expect(screen.getByText(/Publicado em TestRail: 2 test cases/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Importar test cases/ }));
    fireEvent.click(screen.getByRole('button', { name: /Publicar run/ }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it('disables actions while publishing and hides them for read-only members', () => {
    const reported = {
      ...creation,
      reporting: {
        provider: 'azure_devops' as const,
        planId: null,
        suiteId: null,
        autoPublish: false,
      },
      lastReport: report({ status: 'publishing' }),
    };
    const { rerender } = render(
      <E2eReportStrip
        creation={reported}
        isReadOnly={false}
        onManage={vi.fn()}
        onImport={vi.fn()}
        onPublish={vi.fn()}
      />,
    );
    expect(screen.queryByText('Publicação automática')).toBeNull();
    expect(
      (screen.getByRole('button', { name: /Publicar run/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: /Importar test cases/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(
      <E2eReportStrip creation={reported} isReadOnly onManage={vi.fn()} onPublish={vi.fn()} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
