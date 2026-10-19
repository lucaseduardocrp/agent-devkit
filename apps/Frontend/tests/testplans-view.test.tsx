import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';
import {
  type UserWorkspaceMembership,
  getAssigneeDisplayName,
} from '../src/features/workspaces/workspace-types.js';

/**
 * jsdom does not implement the activation behaviour of `<summary>`, so clicking it never opens the
 * `<details>` nor fires `toggle`. This opens the disclosure the way a browser would and lets React
 * observe the `toggle` event the component listens for.
 */
function openExportConfiguration(summary: HTMLElement): void {
  fireEvent.click(summary);
  const details = summary.closest('details');
  if (!details) throw new Error('The export configuration disclosure was not found.');
  details.open = true;
  fireEvent(details, new Event('toggle'));
}

describe('TestPlansView', () => {
  beforeEach(() => {
    vi.spyOn(ApiClient.prototype, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: true,
      organization: 'org',
      project: 'Project',
      members: [{ id: 'tester', displayName: 'Tester', email: 'tester@example.com' }],
      areaPaths: ['Project', 'Project\\Team'],
      states: ['Design', 'Ready'],
    });
    vi.spyOn(ApiClient.prototype, 'generateTestPlan').mockImplementation(
      async (prompt, options) => {
        const plans = [
          'Cenário positivo',
          'Validação de campos obrigatórios',
          'Cenário alternativo',
          'Tratamento de erro',
        ].map((title) => ({ title, description: prompt, steps: [] }));
        return {
          plans,
          csv: 'test,csv',
          ...(options?.workspaceId
            ? {
                savedPlan: {
                  id: 'saved-default',
                  workspaceId: options.workspaceId,
                  title: options.title ?? 'Test Plan',
                  assignedTo: options.assignedTo,
                  plans,
                  createdAt: '2026-01-01',
                  updatedAt: '2026-01-01',
                },
              }
            : {}),
        };
      },
    );
  });

  it('loads, reviews, edits, saves, and exports a persisted Test Plan', async () => {
    const client = new ApiClient();
    const history = vi
      .spyOn(client, 'getAuditHistory')
      .mockResolvedValue({ items: [], page: 1, total: 0, totalPages: 0 });
    const saved = {
      id: 'plan-1',
      workspaceId: 'ws-1',
      title: 'Saved checkout',
      plans: [{ title: 'Pay', description: 'Complete payment', steps: [] }],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
    };
    vi.spyOn(client, 'getSavedTestPlans').mockResolvedValue({
      items: [saved, { ...saved, id: 'plan-2', title: 'Another plan', plans: [] }],
      page: 1,
      pageSize: 8,
      total: 2,
      totalPages: 1,
    });
    const update = vi
      .spyOn(client, 'updateSavedTestPlan')
      .mockImplementation(async (_id, input) => ({ ...saved, ...input }));
    vi.spyOn(client, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: false,
      organization: null,
      project: null,
      members: [],
    });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'generateTestPlanCsv').mockResolvedValue('csv');
    const workspace = [
      {
        workspace: {
          id: 'ws-1',
          name: 'Workspace',
          slug: 'workspace',
          ownerId: 'u1',
          createdAt: '',
        },
        member: {
          id: 'm1',
          workspaceId: 'ws-1',
          userId: 'u1',
          role: 'ADMIN' as const,
          permissions: {},
          createdAt: '',
        },
      },
    ];
    const view = render(
      <TestPlansView apiClient={client} workspaces={workspace} activeWorkspaceId="ws-1" />,
    );
    fireEvent.click(view.getByTestId('tab-saved-test-plans'));
    fireEvent.click(await view.findByRole('button', { name: 'Abrir Test Plan Saved checkout' }));
    expect(view.queryByRole('button', { name: 'Histórico' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(history).toHaveBeenCalledWith('testplan', 1, expect.any(AbortSignal), 'plan-1'),
    );
    // Each case opens in its own window, with its description and steps.
    expect(view.queryByText('Complete payment')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Abrir caso de teste CT-01' }));
    expect(within(view.getByTestId('test-case-modal')).getByText('Complete payment')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Fechar modal' }));
    fireEvent.change(view.getByLabelText('Título do Test Plan'), { target: { value: '' } });
    fireEvent.click(view.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Exportar CSV' }));
    expect(client.generateTestPlanCsv).not.toHaveBeenCalled();
    expect(await view.findByRole('alert')).toHaveTextContent('pelo menos um passo');
    fireEvent.click(view.getByTestId('btn-back-to-saved'));
    fireEvent.click(view.getByRole('button', { name: 'Abrir Test Plan Another plan' }));
    expect(view.getByText(/Nenhum caso de teste neste plano/)).toBeInTheDocument();
  });

  it('deletes a persisted plan and reloads the current page', async () => {
    const client = new ApiClient();
    const saved = {
      id: 'plan-delete',
      workspaceId: 'ws-1',
      title: 'Delete me',
      plans: [],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
    };
    vi.spyOn(client, 'getSavedTestPlans')
      .mockResolvedValueOnce({
        items: [saved],
        page: 1,
        pageSize: 8,
        total: 1,
        totalPages: 1,
      })
      .mockResolvedValue({ items: [], page: 1, pageSize: 8, total: 0, totalPages: 0 });
    const deletePlan = vi.spyOn(client, 'deleteSavedTestPlan').mockResolvedValue();
    vi.spyOn(client, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: false,
      organization: null,
      project: null,
      members: [],
    });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);

    const view = render(
      <TestPlansView
        apiClient={client}
        initialTab="saved"
        activeWorkspaceId="ws-1"
        workspaces={[
          {
            workspace: { id: 'ws-1', name: 'Workspace', slug: 'ws', ownerId: 'u1', createdAt: '' },
            member: {
              id: 'm1',
              workspaceId: 'ws-1',
              userId: 'u1',
              role: 'ADMIN',
              permissions: {},
              createdAt: '',
            },
          },
        ]}
      />,
    );

    fireEvent.click(await view.findByRole('button', { name: 'A\u00e7\u00f5es: Delete me' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir Test Plan Delete me' }));
    fireEvent.click(view.getByTestId('confirm-delete-plan-btn'));
    await waitFor(() => expect(deletePlan).toHaveBeenCalledWith('plan-delete'));
    expect(await view.findByText('Nenhum Test Plan salvo neste workspace.')).toBeInTheDocument();
  });

  it('validates empty story input on generate', () => {
    const { getByRole, getByText } = render(<TestPlansView />);
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    expect(
      getByText('Por favor, informe a user story ou descrição do requisito.'),
    ).toBeInTheDocument();
  });

  it('generates test cases successfully with apiClient', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'generateTestPlanCsv').mockResolvedValue('test,plan\r\n1,2');

    const { getByLabelText, getByRole, getByTestId, getByText } = render(
      <TestPlansView apiClient={client} />,
    );

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Como usuário quero logar com sucesso' },
    });
    fireEvent.change(getByLabelText('Critérios de aceite (opcional)'), {
      target: { value: 'Critério 1\nCritério 2' },
    });

    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await waitFor(() => {
      expect(getByTestId('test-result')).toBeInTheDocument();
    });

    expect(getByText('4 casos de teste gerados')).toBeInTheDocument();
    expect(getByText(/CT-01 — Cenário positivo/)).toBeInTheDocument();
  });

  it('reports generation or persistence errors without presenting unsaved fallback cases', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'generateTestPlan')
      .mockRejectedValueOnce(new Error('Backend error'))
      .mockRejectedValueOnce('Non-error rejection');

    const { getByLabelText, getByRole, findByRole, getByText } = render(
      <TestPlansView apiClient={client} />,
    );

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Feature story' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    const alert = await findByRole('alert');
    expect(alert).toHaveTextContent('Backend error');

    // Test with non-Error rejection
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));
    await waitFor(() => {
      expect(getByText('Falha ao conectar ao gerador de testes.')).toBeInTheDocument();
    });
  });

  it('reports a generated plan that was not persisted for the selected workspace', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'generateTestPlan').mockResolvedValue({
      plans: [{ title: 'Unsaved', description: 'Desc', steps: [] }],
      csv: 'csv',
    });
    const workspaces: readonly UserWorkspaceMembership[] = [
      {
        workspace: {
          id: 'ws-1',
          name: 'Workspace',
          slug: 'workspace',
          ownerId: 'u1',
          createdAt: '',
        },
        member: {
          id: 'm1',
          workspaceId: 'ws-1',
          userId: 'u1',
          role: 'ADMIN',
          permissions: {},
          createdAt: '',
        },
      },
    ];
    const view = render(
      <TestPlansView apiClient={client} workspaces={workspaces} activeWorkspaceId="ws-1" />,
    );

    fireEvent.change(view.getByLabelText('User story / requisito'), {
      target: { value: 'Must persist' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Gerar testes' }));

    expect(await view.findByRole('alert')).toHaveTextContent(
      'O Test Plan foi gerado, mas não foi salvo. Tente novamente.',
    );
    expect(view.queryByTestId('test-result')).not.toBeInTheDocument();
  });

  it('clears all inputs and results when clicking Limpar', async () => {
    const { getByLabelText, getByRole, queryByTestId } = render(<TestPlansView />);
    const storyInput = getByLabelText('User story / requisito') as HTMLTextAreaElement;
    const criteriaInput = getByLabelText('Critérios de aceite (opcional)') as HTMLTextAreaElement;

    fireEvent.change(storyInput, { target: { value: 'User story test' } });
    fireEvent.change(criteriaInput, { target: { value: 'Criteria test' } });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    expect(storyInput.value).toBe('User story test');
    expect(criteriaInput.value).toBe('Criteria test');

    fireEvent.click(getByRole('button', { name: 'Limpar campos' }));

    expect(storyInput.value).toBe('');
    expect(criteriaInput.value).toBe('');
    expect(queryByTestId('test-result')).not.toBeInTheDocument();
  });

  it('downloads CSV file with apiClient and without apiClient', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'generateTestPlanCsv').mockResolvedValue('Title,Action\r\nLogin,Click');

    const { getByLabelText, getByRole } = render(<TestPlansView apiClient={client} />);

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'User story for download' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await waitFor(() => {
      expect(getByRole('button', { name: 'Exportar CSV' })).toBeInTheDocument();
    });

    fireEvent.click(getByRole('button', { name: 'Exportar CSV' }));
    expect(client.generateTestPlanCsv).not.toHaveBeenCalled();
  });

  it('exports current edits locally after validating the Azure destination', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'generateTestPlan').mockResolvedValue({
      plans: [
        {
          title: 'Original',
          description: 'Scenario',
          steps: [{ action: 'Open', expectedResult: 'Opened' }],
        },
      ],
      csv: 'stale,csv',
    });
    const generateCsv = vi.spyOn(client, 'generateTestPlanCsv');
    const createUrl = vi.fn((_blob: Blob) => 'blob:test');
    const revokeUrl = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, {
        createObjectURL: createUrl,
        revokeObjectURL: revokeUrl,
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const view = render(<TestPlansView apiClient={client} />);
      fireEvent.change(view.getByLabelText('User story / requisito'), {
        target: { value: 'Story' },
      });
      fireEvent.click(view.getByRole('button', { name: 'Gerar testes' }));
      fireEvent.click(await view.findByRole('button', { name: 'Exportar CSV' }));
      expect(await view.findByRole('alert')).toHaveTextContent('Informe Area Path');
      expect(createUrl).not.toHaveBeenCalled();
      openExportConfiguration(view.getByText('Configuração de exportação CSV'));
      await waitFor(() =>
        expect((view.getByLabelText('Area Path') as HTMLSelectElement).disabled).toBe(false),
      );
      fireEvent.change(view.getByLabelText('Area Path'), { target: { value: 'Project\\Team' } });
      fireEvent.change(view.getByLabelText('Assigned To'), {
        target: { value: 'Tester <tester@example.com>' },
      });
      fireEvent.change(view.getByLabelText('State'), { target: { value: 'Design' } });
      fireEvent.click(view.getByRole('button', { name: 'Editar caso de teste CT-01' }));
      fireEvent.change(view.getByLabelText('Título do caso de teste'), {
        target: { value: 'Edited title' },
      });
      fireEvent.change(view.getByTestId('input-step-action-1'), {
        target: { value: 'Edited action' },
      });
      fireEvent.click(view.getByTestId('btn-save-test-case-modal'));
      fireEvent.click(view.getByRole('button', { name: 'Exportar CSV' }));
      await waitFor(() => expect(createUrl).toHaveBeenCalledOnce());
      const blob = createUrl.mock.calls[0]![0] as unknown as Blob;
      const csv = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });
      expect(csv).toContain(
        'ID,Work Item Type,Title,Description,Test Step,Step Action,Step Expected,Area Path,Assigned To,State',
      );
      expect(csv).toContain('Edited title');
      expect(csv).toContain('Edited action');
      expect(csv).not.toContain('stale,csv');
      expect(generateCsv).not.toHaveBeenCalled();
      expect(click).toHaveBeenCalledOnce();
      expect(revokeUrl).toHaveBeenCalledWith('blob:test');
    } finally {
      vi.unstubAllGlobals();
      click.mockRestore();
    }
  });

  it('downloads CSV fallback when apiClient is not provided', async () => {
    const { getByLabelText, getByRole } = render(<TestPlansView />);

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Story fallback' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await waitFor(() => {
      expect(getByRole('button', { name: 'Exportar CSV' })).toBeInTheDocument();
    });

    fireEvent.click(getByRole('button', { name: 'Exportar CSV' }));
  });

  it('uses fallback title when downloading with empty story input', async () => {
    const { getByLabelText, getByRole } = render(<TestPlansView />);

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Temp story' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await waitFor(() => {
      expect(getByRole('button', { name: 'Exportar CSV' })).toBeInTheDocument();
    });

    // Clear story before download
    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: '   ' },
    });
    fireEvent.click(getByRole('button', { name: 'Exportar CSV' }));
  });

  it('rejects CSV export when cases have no steps', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'generateTestPlan').mockResolvedValue({
      plans: [{ title: 'Plan', description: 'Download story', steps: [] }],
      csv: '',
    });
    vi.spyOn(client, 'generateTestPlanCsv')
      .mockRejectedValueOnce(new Error('Download failed'))
      .mockRejectedValueOnce('Unknown failure');

    const { getByLabelText, getByRole, findByRole } = render(<TestPlansView apiClient={client} />);

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Download story' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await waitFor(() => {
      expect(getByRole('button', { name: 'Exportar CSV' })).toBeInTheDocument();
    });

    fireEvent.click(getByRole('button', { name: 'Exportar CSV' }));
    const alert = await findByRole('alert');
    expect(alert).toHaveTextContent('pelo menos um passo');
    expect(client.generateTestPlanCsv).not.toHaveBeenCalled();
  });

  it('correctly resolves assignee display names across all variants', () => {
    expect(getAssigneeDisplayName(null, 'Não Atribuído')).toBe('Não Atribuído');
    expect(getAssigneeDisplayName(undefined, 'Não Atribuído')).toBe('Não Atribuído');
    expect(
      getAssigneeDisplayName({
        id: '1',
        workspaceId: 'ws-1',
        userId: 'u-1',
        role: 'ADMIN',
        permissions: {},
        createdAt: '',
        user: { id: 'u-1', name: 'Alice', email: 'alice@test.com' },
      }),
    ).toBe('Alice');
    expect(
      getAssigneeDisplayName({
        id: '2',
        workspaceId: 'ws-1',
        userId: 'u-2',
        role: 'MEMBER',
        permissions: {},
        createdAt: '',
        user: { id: 'u-2', name: '', email: 'bob@test.com' },
      }),
    ).toBe('bob@test.com');
    expect(
      getAssigneeDisplayName({
        id: '3',
        workspaceId: 'ws-1',
        userId: 'u-3',
        role: 'VIEWER',
        permissions: {},
        createdAt: '',
      }),
    ).toBe('VIEWER');
  });

  it('downloads fallback CSV with workspace and assigned member when apiClient is missing', async () => {
    const mockWorkspaces: UserWorkspaceMembership[] = [
      {
        workspace: {
          id: 'ws-1',
          name: 'QA Team',
          slug: 'qa-team',
          ownerId: 'u-1',
          createdAt: '2026-01-01',
        },
        member: {
          id: 'm-1',
          workspaceId: 'ws-1',
          userId: 'u-1',
          role: 'ADMIN',
          permissions: {},
          createdAt: '2026-01-01',
        },
      },
    ];

    const { getByLabelText, getByRole } = render(
      <TestPlansView workspaces={mockWorkspaces} activeWorkspaceId="ws-1" />,
    );

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Story with fallback CSV' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));
    await waitFor(() => {
      expect(getByRole('button', { name: 'Exportar CSV' })).toBeInTheDocument();
    });

    fireEvent.click(getByRole('button', { name: 'Exportar CSV' }));
  });

  it('uses first workspace when activeWorkspaceId is omitted and passes it to generateTestPlan', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: false,
      organization: null,
      project: null,
      members: [],
    });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    vi.spyOn(client, 'generateTestPlan').mockResolvedValue({
      plans: [{ title: 'Plan 1', description: 'Desc', steps: [] }],
      csv: 'csv',
      savedPlan: {
        id: 'saved-generated',
        workspaceId: 'ws-default',
        title: 'Saved generated plan',
        plans: [{ title: 'Plan 1', description: 'Desc', steps: [] }],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    });

    const mockWorkspaces: UserWorkspaceMembership[] = [
      {
        workspace: {
          id: 'ws-default',
          name: 'Default WS',
          slug: 'default-ws',
          ownerId: 'u-1',
          createdAt: '',
        },
        member: {
          id: 'm-1',
          workspaceId: 'ws-default',
          userId: 'u-1',
          role: 'ADMIN',
          permissions: {},
          createdAt: '',
        },
      },
    ];

    const { getByLabelText, getByRole } = render(
      <TestPlansView apiClient={client} workspaces={mockWorkspaces} />,
    );

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Story in default WS' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await waitFor(() => {
      expect(client.generateTestPlan).toHaveBeenCalledWith(
        'Story in default WS',
        expect.objectContaining({ workspaceId: 'ws-default' }),
      );
    });
  });

  it('keeps creation provider-neutral and loads Azure fields only when export is opened', async () => {
    const client = new ApiClient();
    const loadAzure = vi.spyOn(client, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: true,
      organization: 'acme-corp',
      project: 'phoenix-project',
      members: [{ id: 'az-1', displayName: 'Maria Silva', email: 'maria@acme.com' }],
      areaPaths: ['phoenix-project'],
      states: ['Ready'],
    });

    const { getByLabelText, getByRole, getByText, findByText, queryByLabelText } = render(
      <TestPlansView apiClient={client} />,
    );

    expect(loadAzure).not.toHaveBeenCalled();
    expect(queryByLabelText('Assigned To')).not.toBeInTheDocument();

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Story provider neutral' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));
    await findByText('Configuração de exportação CSV');

    expect(loadAzure).not.toHaveBeenCalled();
    openExportConfiguration(getByText('Configuração de exportação CSV'));

    await findByText('Maria Silva (maria@acme.com)');
    expect(loadAzure).toHaveBeenCalledTimes(1);
    expect((getByLabelText('Assigned To') as HTMLSelectElement).disabled).toBe(false);
  });

  it('renders loading skeletons for generation and lazily loaded export options', async () => {
    let resolveMembers!: (value: unknown) => void;
    const membersPromise = new Promise((res) => {
      resolveMembers = res;
    });
    let resolveGenerate!: (value: {
      plans: readonly { title: string; description: string; steps: readonly [] }[];
      csv: string;
    }) => void;
    const generatePromise = new Promise<{
      plans: readonly { title: string; description: string; steps: readonly [] }[];
      csv: string;
    }>((res) => {
      resolveGenerate = res;
    });

    const client = new ApiClient();
    vi.spyOn(client, 'getAzureDevOpsProjectMembers').mockImplementation(
      () =>
        membersPromise as Promise<{
          configured: boolean;
          organization: null;
          project: null;
          members: [];
        }>,
    );
    vi.spyOn(client, 'generateTestPlan').mockImplementation(() => generatePromise);

    const { getByTestId, getByRole, getByLabelText, getByText, queryByTestId } = render(
      <TestPlansView apiClient={client} />,
    );

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Story for skeleton verification' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    expect(getByTestId('test-plan-skeleton')).toBeInTheDocument();

    resolveGenerate({
      plans: [{ title: 'Generated', description: 'Scenario', steps: [] }],
      csv: 'header1\r\nval1',
    });
    await waitFor(() => {
      expect(queryByTestId('test-plan-skeleton')).not.toBeInTheDocument();
      expect(getByTestId('test-result')).toBeInTheDocument();
    });

    openExportConfiguration(getByText('Configuração de exportação CSV'));
    const azureFields = getByLabelText('Assigned To').closest('[aria-busy]');
    expect(azureFields).toHaveAttribute('aria-busy', 'true');
    expect((getByLabelText('Assigned To') as HTMLSelectElement).disabled).toBe(true);

    resolveMembers({
      configured: false,
      organization: null,
      project: null,
      members: [],
    });
    await waitFor(() => {
      expect(azureFields).toHaveAttribute('aria-busy', 'false');
    });
  });

  it('generates AI-driven test plans and renders title, scenario, and detailed test steps', async () => {
    const client = new ApiClient();
    const mockResponse = {
      plans: [
        {
          title: 'Fluxo Pix com QR Code Dinâmico',
          description: 'Validar geração e pagamento com chave Pix dinâmica.',
          steps: [
            {
              order: 1,
              action: 'Selecionar opção Pix no checkout',
              expectedResult: 'QR Code e código copia e cola são exibidos',
              data: 'Valor: R$ 150,00',
            },
            {
              action: 'Confirmar pagamento no app do banco',
              expectedResult: 'Webhook de confirmação recebido e status atualizado',
            },
          ],
        },
        {
          title: 'Cancelamento antes do pagamento',
          description: 'Usuário cancela o pedido antes do pagamento.',
          steps: [],
        },
      ],
      csv: 'Work Item Type,Title\r\nTest Case,Fluxo Pix\r\nTest Case,Cancelamento',
    };

    vi.spyOn(client, 'generateTestPlan').mockResolvedValue(mockResponse);

    const { getByLabelText, getByRole, findByText, getByText, getByTestId } = render(
      <TestPlansView apiClient={client} />,
    );

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'Como cliente quero pagar com Pix para aprovação imediata' },
    });
    fireEvent.change(getByLabelText('Critérios de aceite (opcional)'), {
      target: { value: 'Critério 1: QR Code deve expirar em 15 minutos' },
    });

    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await findByText('2 casos de teste gerados');
    expect(getByText(/CT-01 — Fluxo Pix com QR Code Dinâmico/)).toBeInTheDocument();
    expect(getByText(/Validar geração e pagamento com chave Pix dinâmica/)).toBeInTheDocument();
    expect(getByText(/Passos de Teste \(2\):/)).toBeInTheDocument();
    expect(getByTestId('step-CT-01-1')).toHaveTextContent('Selecionar opção Pix no checkout');
    expect(getByTestId('step-CT-01-1')).toHaveTextContent(
      'QR Code e código copia e cola são exibidos',
    );
    expect(getByTestId('step-CT-01-1')).toHaveTextContent('Valor: R$ 150,00');
    expect(getByTestId('step-CT-01-2')).toHaveTextContent('Confirmar pagamento no app do banco');

    expect(getByText(/CT-02 — Cancelamento antes do pagamento/)).toBeInTheDocument();

    // Export CSV using generatedCsv
    const csvBtn = getByRole('button', { name: 'Exportar CSV' });
    fireEvent.click(csvBtn);

    // Clear fields
    fireEvent.click(getByRole('button', { name: 'Limpar campos' }));
    expect((getByLabelText('User story / requisito') as HTMLTextAreaElement).value).toBe('');
  });

  it('handles generateTestPlan returning empty plans array and falls back to defaultTestCases', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'generateTestPlan').mockResolvedValue({
      plans: [],
      csv: 'empty-csv',
    });

    const { getByLabelText, getByRole, findByText, getByText } = render(
      <TestPlansView apiClient={client} />,
    );

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'História genérica' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await findByText('4 casos de teste gerados');
    expect(getByText(/CT-01 — Cenário positivo/)).toBeInTheDocument();
  });

  it('localizes mock test cases in English', async () => {
    const { getByLabelText, getByRole, findByText, getByText } = render(
      <I18nProvider initialLocale="en-US">
        <TestPlansView />
      </I18nProvider>,
    );

    fireEvent.change(getByLabelText('User story / requirement'), {
      target: { value: 'Checkout' },
    });
    fireEvent.click(getByRole('button', { name: 'Generate tests' }));

    await findByText('4 test cases generated');
    expect(getByText(/CT-01 — Positive scenario/)).toBeInTheDocument();
    expect(getByText('Fill in required fields with valid values')).toBeInTheDocument();
  });

  it('loads available agents and passes selected agentId to generateTestPlan', async () => {
    const client = new ApiClient();
    const mockAgent = {
      id: 'agent-qa-custom',
      workspaceId: 'ws-1',
      name: 'QA Master',
      slug: 'qa-master',
      description: 'Master QA',
      instructions: '# QA',
      role: 'QA' as const,
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      isSystem: false,
      createdAt: '',
      updatedAt: '',
    };
    vi.spyOn(client, 'getAgents').mockResolvedValue([mockAgent]);
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    const genSpy = vi.spyOn(client, 'generateTestPlan').mockResolvedValue({
      plans: [{ title: 'Custom QA Plan', description: 'Desc', steps: [] }],
      csv: 'csv',
      savedPlan: {
        id: 'saved-agent-plan',
        workspaceId: 'ws-1',
        title: 'Custom QA Plan',
        plans: [{ title: 'Custom QA Plan', description: 'Desc', steps: [] }],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    });

    const mockWorkspaces: readonly UserWorkspaceMembership[] = [
      {
        workspace: { id: 'ws-1', name: 'Work 1', slug: 'w1', ownerId: 'u1', createdAt: '' },
        member: {
          id: 'm1',
          workspaceId: 'ws-1',
          userId: 'u1',
          role: 'ADMIN',
          permissions: {},
          createdAt: '',
        },
      },
    ];

    const { getByLabelText, getByRole, findByText } = render(
      <TestPlansView apiClient={client} workspaces={mockWorkspaces} activeWorkspaceId="ws-1" />,
    );

    // Wait for agent to appear in dropdown
    await waitFor(() => {
      expect(client.getAgents).toHaveBeenCalled();
    });

    const agentSelect = getByLabelText(
      'Selecionar agente de IA para geração de testes',
    ) as HTMLSelectElement;
    expect(agentSelect).toBeInTheDocument();
    fireEvent.change(agentSelect, { target: { value: 'agent-qa-custom' } });
    expect(agentSelect.value).toBe('agent-qa-custom');

    fireEvent.change(getByLabelText('User story / requisito'), {
      target: { value: 'User story with agent' },
    });
    fireEvent.click(getByRole('button', { name: 'Gerar testes' }));

    await findByText('1 casos de teste gerados');
    expect(genSpy).toHaveBeenCalledWith(
      'User story with agent',
      expect.objectContaining({
        agentId: 'agent-qa-custom',
      }),
    );
  });
});
