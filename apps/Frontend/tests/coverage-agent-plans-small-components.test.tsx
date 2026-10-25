import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentTopology } from '../src/features/agents/AgentTopology.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import { parseMarkdownBlocks } from '../src/features/brain/markdown-parser.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';
import { SpecWorkflowAction } from '../src/features/spec/SpecWorkflowAction.js';
import { AzureExportFields } from '../src/features/testplans/AzureExportFields.js';
import { TestSuiteTree } from '../src/features/testplans/TestSuiteTree.js';
import { ApiClient, type SavedTestPlanDto, type SpecificationDto } from '../src/lib/api-client.js';

const ISO = '2026-09-18T00:00:00.000Z';

describe('AzureExportFields', () => {
  it('offers members without an e-mail by their display name only', () => {
    const onAssignee = vi.fn();
    const view = render(
      <AzureExportFields
        areas={['Project\\Team']}
        members={[
          { id: 'm1', displayName: 'Ana', email: 'ana@example.com' },
          { id: 'm2', displayName: 'Build Service', email: '' },
        ]}
        states={['Design']}
        loading={false}
        error={false}
        area=""
        assignee=""
        state=""
        onArea={vi.fn()}
        onAssignee={onAssignee}
        onState={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const assigned = view.getByRole('combobox', { name: 'Assigned To' });
    expect(
      within(assigned).getByRole<HTMLOptionElement>('option', { name: 'Ana (ana@example.com)' })
        .value,
    ).toBe('Ana <ana@example.com>');
    expect(
      within(assigned).getByRole<HTMLOptionElement>('option', { name: 'Build Service' }).value,
    ).toBe('Build Service');
    fireEvent.change(assigned, { target: { value: 'Build Service' } });
    expect(onAssignee).toHaveBeenCalledWith('Build Service');
  });
});

describe('parseMarkdownBlocks doctype', () => {
  it('ends a lone doctype declaration at the next blank line', () => {
    expect(parseMarkdownBlocks('<!DOCTYPE html>\n\nAfter the declaration')).toEqual([
      { type: 'html', html: '<!DOCTYPE html>' },
      { type: 'paragraph', text: 'After the declaration' },
    ]);
  });
});

describe('SpecWorkflowAction feedback', () => {
  it('dismisses the success notification', async () => {
    const client = new ApiClient();
    const spec: SpecificationDto = {
      id: 's',
      workspaceId: 'w',
      title: 'Generated',
      sections: [],
      messages: [],
      createdAt: '',
      updatedAt: '',
    };
    vi.spyOn(client, 'clearSpecificationMessages').mockResolvedValue(spec);
    const view = render(
      <SpecWorkflowAction
        apiClient={client}
        spec={spec}
        action="clear"
        disabled={false}
        onCleared={vi.fn()}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Limpar contexto' }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar' }),
    );
    const toast = await view.findByRole('status');
    fireEvent.click(within(toast).getByRole('button', { name: 'Fechar notificação' }));
    await waitFor(() => expect(view.queryByRole('status')).not.toBeInTheDocument());
  });
});

describe('TestSuiteTree extra paths', () => {
  const suite = {
    id: 'suite-1',
    workspaceId: 'ws-1',
    name: 'Regression',
    createdAt: ISO,
    updatedAt: ISO,
  };
  const plan: SavedTestPlanDto = {
    id: 'plan-1',
    workspaceId: 'ws-1',
    suiteId: 'suite-1',
    title: 'Checkout',
    plans: [{ title: 'Pay', description: '', steps: [] }],
    sourceType: 'test_management',
    sourceId: 'qase:PRJ-1',
    createdAt: ISO,
    updatedAt: ISO,
  } as SavedTestPlanDto;

  it('shows an unknown import provider by its raw id and starts a plan inside a suite', () => {
    const onCreatePlan = vi.fn();
    const view = render(
      <TestSuiteTree
        suites={[suite]}
        plans={[plan]}
        onOpenPlan={vi.fn()}
        onExportSuite={vi.fn()}
        onCreatePlan={onCreatePlan}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Regression' }));
    expect(view.getByTitle('Importado de qase')).toHaveTextContent('qase');
    fireEvent.click(view.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(view.getByRole('button', { name: 'Criar Test Plan' }));
    expect(onCreatePlan).toHaveBeenCalledWith('suite-1');
  });

  it('opens the new suite field when the parent requests it', () => {
    const onCreateRequestHandled = vi.fn();
    const view = render(
      <TestSuiteTree
        suites={[]}
        plans={[]}
        onOpenPlan={vi.fn()}
        onExportSuite={vi.fn()}
        requestCreate
        onCreateRequestHandled={onCreateRequestHandled}
      />,
    );
    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(onCreateRequestHandled).toHaveBeenCalledTimes(1);
  });
});

describe('AgentTopology run details', () => {
  const agent: CustomAgentDto = {
    id: 'agent-1',
    workspaceId: 'workspace',
    parentAgentId: null,
    name: 'QA Lead',
    slug: 'qa-lead',
    description: '',
    instructions: 'Review tests',
    role: 'QA',
    temperature: 0.2,
    isSystem: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const run: AgentRun = {
    id: 'run-1',
    issueId: 'abcdef1234567890',
    agentId: agent.id,
    status: 'queued',
    mode: 'server',
    attempt: 1,
    output: null,
    error: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    createdAt: '2026-01-01',
    startedAt: null,
    finishedAt: null,
  };

  it('labels server runs of unknown issues and skips edges of agents off the map', () => {
    const issues: Issue[] = [];
    const view = render(
      <AgentTopology
        agents={[agent]}
        issues={issues}
        runs={[run, { ...run, id: 'run-2', agentId: 'deleted-agent' }]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    const card = view.getByTestId('topology-run-run-1');
    expect(card).toHaveTextContent('#abcdef12');
    expect(card).toHaveTextContent('Servidor');
    expect(view.getByTestId('run-edge-run-1')).toBeInTheDocument();
    expect(view.queryByTestId('run-edge-run-2')).not.toBeInTheDocument();
    expect(view.getByTestId('topology-run-run-2')).toBeInTheDocument();

    fireEvent.click(view.getByTestId('topology-agent-agent-1'));
    expect(view.getByTestId('topology-selection')).toHaveTextContent('Sem descrição cadastrada.');
  });
});
