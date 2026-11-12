import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHubPanel } from '../src/features/agents/AgentHubPanel.js';
import { AgentModal } from '../src/features/agents/AgentModal.js';
import { AgentRunFlowModal } from '../src/features/agents/AgentRunFlowModal.js';
import { AgentSkillsField } from '../src/features/agents/AgentSkillsField.js';
import { AgentTopology } from '../src/features/agents/AgentTopology.js';
import {
  AgentWorkflowBoard,
  describeWorkflowNode,
} from '../src/features/agents/AgentWorkflowBoard.js';
import { HubSkillsPanel } from '../src/features/agents/HubSkillsPanel.js';
import { I18nProvider } from '../src/lib/i18n/index.js';
import type {
  AgentSkillDto,
  AgentWorkflowDto,
  CustomAgentDto,
  HubAgentCatalogDto,
  HubSkillDto,
} from '../src/features/agents/agent-types.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const baseAgent: CustomAgentDto = {
  id: 'agent-1',
  workspaceId: 'workspace',
  parentAgentId: null,
  name: 'PO',
  slug: 'po',
  description: 'Owns the backlog',
  instructions: 'Do things',
  role: 'CUSTOM',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AgentHubPanel edge states', () => {
  const emptyCatalog: HubAgentCatalogDto = {
    generatedAt: '2026-10-23T12:00:00Z',
    agents: [],
    plugins: [],
  };

  function setup(catalog: HubAgentCatalogDto | Error | string, apiExtras = {}) {
    const api = {
      listHubAgents: vi.fn(() =>
        catalog instanceof Error || typeof catalog === 'string'
          ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            Promise.reject(catalog)
          : Promise.resolve(catalog),
      ),
      installHubAgent: vi.fn(() => Promise.resolve([])),
      updateHubAgent: vi.fn(() => Promise.resolve({})),
      updateAgent: vi.fn(() => Promise.resolve({})),
      ...apiExtras,
    };
    const view = render(
      <AgentHubPanel
        apiClient={api as unknown as ApiClient}
        isReadOnly={false}
        getRoleLabel={(role) => role}
        onChanged={vi.fn()}
      />,
    );
    return { api, view };
  }

  it('says nothing matches when the hub offers no agents, and no skills on the skills view', async () => {
    const { view } = setup(emptyCatalog);
    expect(await view.findByText('Nenhum agente do hub corresponde a esses filtros.')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Skills' }));
    expect(view.getByText('Nenhuma skill do hub corresponde à busca.')).toBeTruthy();
  });

  it('falls back to a generic message when the load fails without a message', async () => {
    const { view } = setup(new Error(''));
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar o ADK Hub agora.',
    );
    setup('not an error');
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent(
      'Não foi possível carregar o ADK Hub agora.',
    );
  });

  it('shows verified tiers, installed items, plugin versions from the sha and skills without tags', async () => {
    const catalog: HubAgentCatalogDto = {
      generatedAt: '2026-10-23T12:00:00Z',
      agents: [
        {
          name: 'verified-agent',
          description: 'Verified one',
          overview: '',
          category: 'qa',
          role: 'QA',
          tags: [],
          toolsets: [],
          author: 'ADK',
          version: '1.0.0',
          license: 'MIT',
          tier: 'verified',
          status: 'installed',
          installed: { agentId: 'agent-v', name: 'Verified', version: '1.0.0' },
        },
        {
          name: 'orphan-update',
          description: 'Update without install info',
          overview: '',
          category: 'qa',
          role: 'QA',
          tags: [],
          toolsets: [],
          author: 'ADK',
          version: '3.0.0',
          license: 'MIT',
          tier: 'community',
          status: 'update-available',
        },
      ],
      plugins: [
        {
          name: 'noversion',
          title: 'No version plugin',
          description: 'Plugin',
          maintainer: 'acme',
          tier: 'verified',
          license: 'MIT',
          repo: 'https://github.com/acme/x',
          sha: 'abcdef1234567890',
          agents: [{ name: 'only-one', status: 'available' }],
        },
      ],
      skills: [
        {
          name: 'untagged-skill',
          description: 'No tags here',
          category: 'qa',
          version: '1.0.0',
          author: 'ADK',
          tier: 'official',
          revision: 'r1',
        },
      ],
    };
    const { api, view } = setup(catalog);
    const verified = await view.findByTestId('hub-agent-verified-agent');
    expect(verified).toHaveTextContent('Verificado');
    expect(verified).toHaveTextContent('Instalado');
    expect(view.getByTestId('hub-plugin-noversion')).toHaveTextContent('abcdef12');

    // An update without the installed record is never confirmed nor sent.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(view.getByTestId('hub-update-orphan-update'));
    expect(confirm).not.toHaveBeenCalled();
    expect(api.updateHubAgent).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Skills' }));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'untagged' } });
    expect(view.getByTestId('hub-skill-untagged-skill')).toBeTruthy();
  });

  it('reports an install that rejects with something that is not an Error', async () => {
    const catalog: HubAgentCatalogDto = {
      ...emptyCatalog,
      agents: [
        {
          name: 'qa',
          description: 'QA',
          overview: '',
          category: 'qa',
          role: 'QA',
          tags: [],
          toolsets: [],
          author: 'ADK',
          version: '1.0.0',
          license: 'MIT',
          tier: 'official',
          status: 'available',
        },
      ],
    };
    const { view } = setup(catalog, {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      installHubAgent: vi.fn(() => Promise.reject('quota exceeded')),
    });
    fireEvent.click(await view.findByTestId('hub-install-qa'));
    expect(await view.findByRole('alert')).toHaveTextContent('quota exceeded');
  });
});

describe('HubSkillsPanel', () => {
  const skill = (over: Partial<HubSkillDto> = {}): HubSkillDto => ({
    name: 'test-design',
    description: 'Designs test cases.',
    category: 'qa',
    version: '2.0.0',
    author: 'ADK',
    tier: 'official',
    revision: 'new',
    ...over,
  });
  const copy = (over: Partial<AgentSkillDto> = {}): AgentSkillDto => ({
    name: 'test-design',
    description: 'Designs test cases.',
    version: '1.0.0',
    revision: 'old',
    ...over,
  });
  const tenSkills = Array.from({ length: 10 }, (_, index) => copy({ name: `other-${index}` }));

  function setup(props: Partial<React.ComponentProps<typeof HubSkillsPanel>> = {}) {
    const run = vi.fn(async (_key: string, _title: string, operation: () => Promise<unknown>) => {
      await operation();
    });
    const updateAgentSkills = vi.fn(() => Promise.resolve({}));
    const view = render(
      <HubSkillsPanel
        skills={[skill()]}
        agents={[]}
        isReadOnly={false}
        busy={null}
        run={run}
        updateAgentSkills={updateAgentSkills}
        {...props}
      />,
    );
    return { run, updateAgentSkills, view };
  }

  it('labels the three tiers and only links the ones that live in the hub repository', () => {
    const { view } = setup({
      skills: [
        skill({ name: 'builtin', tier: 'built-in' }),
        skill({ name: 'official', tier: 'official', tags: ['qa', 'bdd'] }),
        skill({ name: 'community', tier: 'community' }),
      ],
    });
    expect(view.getByTestId('hub-skill-builtin')).toHaveTextContent('Nativa');
    expect(view.getByTestId('hub-skill-official')).toHaveTextContent('#qa');
    expect(view.getByTestId('hub-skill-community')).toHaveTextContent('Comunidade');
    expect(within(view.getByTestId('hub-skill-builtin')).queryByRole('link')).toBeNull();
    expect(within(view.getByTestId('hub-skill-official')).getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/lucaseduardocrp/agent-devkit-hub/tree/main/skills/official',
    );
  });

  it('offers no actions to a read-only user', () => {
    const { view } = setup({ isReadOnly: true });
    expect(view.queryByTestId('hub-skill-assign-test-design')).toBeNull();
  });

  it('explains that there are no agents to assign a skill to, and cancels', () => {
    const { view, run } = setup();
    fireEvent.click(view.getByTestId('hub-skill-assign-test-design'));
    expect(screen.getByText('Crie ou instale um agente para associar esta skill.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveAttribute('disabled');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('closes the dialog without saving when nothing changed', () => {
    const { view, run } = setup({
      agents: [{ ...baseAgent, skills: [copy({ revision: 'new' })] }],
    });
    fireEvent.click(view.getByTestId('hub-skill-assign-test-design'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds the skill to an agent without skills and removes it from the one that had it', async () => {
    const { view, run, updateAgentSkills } = setup({
      agents: [
        baseAgent,
        { ...baseAgent, id: 'agent-2', name: 'Dev', skills: [copy(), copy({ name: 'keep' })] },
      ],
    });
    fireEvent.click(view.getByTestId('hub-skill-assign-test-design'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /PO/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Dev/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Dev/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Dev/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateAgentSkills).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[0]![0]).toBe('skill-assign:test-design');
    expect(updateAgentSkills).toHaveBeenCalledWith('agent-1', { skills: ['test-design'] });
    expect(updateAgentSkills).toHaveBeenCalledWith('agent-2', { skills: ['keep'] });
  });

  it('refreshes only the outdated copies and disables the other actions while busy', async () => {
    const { view, updateAgentSkills } = setup({
      agents: [
        { ...baseAgent, skills: [copy()] },
        { ...baseAgent, id: 'agent-2', name: 'Fresh', skills: [copy({ revision: 'new' })] },
        { ...baseAgent, id: 'agent-3', name: 'Plain' },
      ],
    });
    fireEvent.click(view.getByRole('button', { name: /Atualizar para 2.0.0 nos agentes/ }));
    await waitFor(() => expect(updateAgentSkills).toHaveBeenCalledTimes(1));
    expect(updateAgentSkills).toHaveBeenCalledWith('agent-1', { refreshSkills: ['test-design'] });
    view.unmount();

    const busy = setup({
      busy: 'skill-assign:test-design',
      agents: [{ ...baseAgent, skills: [copy()] }],
    });
    expect(busy.view.getByTestId('hub-skill-assign-test-design')).toHaveAttribute('disabled');
  });

  it('blocks agents at the skill limit unless they already use the skill', () => {
    const { view } = setup({
      agents: [
        { ...baseAgent, id: 'full', name: 'Full agent', skills: tenSkills },
        {
          ...baseAgent,
          id: 'user',
          name: 'Already using',
          skills: [...tenSkills.slice(1), copy()],
        },
      ],
    });
    fireEvent.click(view.getByTestId('hub-skill-assign-test-design'));
    const dialog = screen.getByRole('dialog');
    const full = within(dialog).getByRole('checkbox', { name: /Full agent/ });
    expect(full).toHaveAttribute('disabled');
    expect(dialog).toHaveTextContent('Já usa 10 skills, o limite');
    expect(within(dialog).getByRole('checkbox', { name: /Already using/ })).not.toHaveAttribute(
      'disabled',
    );
  });
});

describe('AgentSkillsField', () => {
  const hubSkill = (over: Partial<HubSkillDto> = {}): HubSkillDto => ({
    name: 'alpha',
    description: 'x'.repeat(120),
    category: 'qa',
    version: '2.0.0',
    author: 'ADK',
    tier: 'official',
    revision: 'new',
    ...over,
  });

  function Host({
    initial,
    catalog,
    attached = [],
  }: {
    readonly initial: readonly string[];
    readonly catalog: readonly HubSkillDto[] | null;
    readonly attached?: readonly AgentSkillDto[];
  }) {
    const [value, setValue] = useState(initial);
    const [refresh, setRefresh] = useState<readonly string[]>([]);
    return (
      <AgentSkillsField
        value={value}
        onChange={setValue}
        refresh={refresh}
        onRefreshChange={setRefresh}
        attached={attached}
        catalog={catalog}
        catalogError={false}
      />
    );
  }

  it('truncates long descriptions in the picker and queues, then unqueues, an update', () => {
    render(
      <Host
        initial={['alpha']}
        catalog={[hubSkill(), hubSkill({ name: 'beta', description: 'Short one' })]}
        attached={[{ name: 'alpha', description: 'copy', version: '1.0.0', revision: 'old' }]}
      />,
    );
    expect(screen.getByRole('option', { name: /beta — Short one/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar para 2.0.0' }));
    expect(screen.getByRole('button', { name: 'Atualiza ao salvar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Atualiza ao salvar' }));
    expect(screen.getByRole('button', { name: 'Atualizar para 2.0.0' })).toBeTruthy();
  });

  it('truncates the description of a skill that can still be added', () => {
    render(<Host initial={[]} catalog={[hubSkill()]} />);
    expect(screen.getByRole('option', { name: `alpha — ${'x'.repeat(90)}…` })).toBeTruthy();
  });

  it('stops offering skills once the agent has the maximum', () => {
    const names = Array.from({ length: 10 }, (_, index) => `s${index}`);
    render(
      <Host initial={names} catalog={[...names.map((name) => hubSkill({ name })), hubSkill()]} />,
    );
    expect(screen.getByText('Limite de 10 skills por agente.')).toBeTruthy();
    expect(screen.getByLabelText('Skills', { selector: 'select' })).toHaveAttribute('disabled');
  });
});

describe('AgentModal legacy model', () => {
  it('keeps saving an agent whose model is no longer offered by an active integration', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const gemini = {
      providerId: 'gemini',
      providerLabel: 'Google Gemini',
      model: 'gemini-2.5-flash',
    } as const;
    const view = render(
      <AgentModal
        isOpen
        onClose={vi.fn()}
        onSave={onSave}
        initialData={{ ...baseAgent, model: 'legacy-model' }}
        availableLlmModels={[gemini]}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Atualizar Agente' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ model: 'legacy-model' })),
    );
  });
});

describe('AgentRunFlowModal', () => {
  const workflow: AgentWorkflowDto = {
    enabled: true,
    autonomy: 'balanced',
    finalReview: true,
    uncertaintyBehavior: 'ask',
    issueCreationBehavior: 'ask',
    defaultAction: 'allow',
    steps: [
      { id: 's1', name: 'Triage', instructions: 'Triage it.' },
      { id: 's2', name: 'Summary', instructions: 'Summarise it.' },
    ],
    rules: [],
  };
  const issue: Issue = {
    id: 'issue-1',
    workspaceId: 'workspace',
    number: 95,
    title: 'Approve exchanges',
    description: '',
    status: 'in_progress',
    priority: 'medium',
    assigneeAgentId: baseAgent.id,
    assigneeUserId: null,
    createdBy: 'user',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const run = (over: Partial<AgentRun> = {}): AgentRun => ({
    id: 'run-1',
    issueId: issue.id,
    agentId: baseAgent.id,
    status: 'running',
    mode: 'host',
    attempt: 1,
    output: null,
    error: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    createdAt: '2026-01-01',
    startedAt: '2026-01-01',
    finishedAt: null,
    ...over,
  });
  const steps = workflow.steps.map(({ id, name }) => ({ id, name }));

  function open(runs: readonly AgentRun[], onOpenIssue?: (issueId: string) => void) {
    return render(
      <AgentRunFlowModal
        agent={baseAgent}
        runs={runs}
        issues={[issue]}
        agents={[baseAgent]}
        workflow={workflow}
        {...(onOpenIssue ? { onOpenIssue } : {})}
        onClose={vi.fn()}
      />,
    );
  }

  it('switches between the runs of an agent and labels runs whose issue is unknown', () => {
    open([
      run(),
      run({
        id: 'run-2',
        issueId: 'abcdef12-0000',
        mode: 'server',
        model: 'gpt-x',
        status: 'queued',
      }),
    ]);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('#95 Approve exchanges');
    expect(tabs[1]).toHaveTextContent('#abcdef12');
    fireEvent.click(tabs[1]!);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    const flow = screen.getByTestId('agent-run-flow');
    expect(flow).toHaveTextContent('Servidor · gpt-x');
  });

  it('shows the question a waiting run asks, the results so far, and opens the issue', () => {
    const onOpenIssue = vi.fn();
    open(
      [
        run({
          status: 'waiting_input',
          workflowState: {
            autonomy: 'balanced',
            steps,
            currentStepIndex: 1,
            question: 'Which environment?',
            results: [{ stepId: 's1', name: 'Triage', output: 'Looks fine' }],
          },
        }),
      ],
      onOpenIssue,
    );
    expect(screen.getByText('Which environment?')).toBeTruthy();
    expect(screen.getByText('Looks fine')).toBeTruthy();
    fireEvent.click(screen.getByTestId('run-flow-open-issue'));
    expect(onOpenIssue).toHaveBeenCalledWith('issue-1');
  });
});

describe('AgentTopology run of an unlisted agent', () => {
  it('shows a task of an agent the map does not list without a name', () => {
    const workflow: AgentWorkflowDto = {
      enabled: true,
      autonomy: 'balanced',
      finalReview: true,
      uncertaintyBehavior: 'ask',
      issueCreationBehavior: 'ask',
      defaultAction: 'allow',
      steps: [],
      rules: [],
    };
    const ghostRun: AgentRun = {
      id: 'run-ghost',
      issueId: 'issue-zzzzzzzz',
      agentId: 'ghost',
      status: 'running',
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
      startedAt: '2026-01-01',
      finishedAt: null,
    };
    render(
      <AgentTopology
        agents={[baseAgent]}
        issues={[]}
        runs={[ghostRun]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        workflow={workflow}
      />,
    );
    expect(screen.getByTestId('topology-run-run-ghost')).toHaveTextContent('#issue-zz');
  });
});

describe('workflow board edges', () => {
  const workflow: AgentWorkflowDto = {
    enabled: true,
    autonomy: 'balanced',
    finalReview: true,
    uncertaintyBehavior: 'ask',
    issueCreationBehavior: 'ask',
    defaultAction: 'allow',
    steps: [{ id: 'step-a', name: 'Plan', instructions: 'plan it' }],
    rules: [],
  };
  const toolNames = Object.fromEntries(
    [
      'all',
      'agents',
      'integrations',
      'brain',
      'issues',
      'pbi',
      'spec',
      'testplans',
      'design',
      'e2e',
      'releasenotes',
      'development',
      'integrationtests',
      'loadtests',
      'audit',
      'workspaces',
      'notifications',
    ].map((toolset) => [toolset, [`${toolset}_create`]]),
  ) as unknown as React.ComponentProps<typeof AgentWorkflowBoard>['toolNames'];

  function Host({ onWorkflow }: { readonly onWorkflow?: (next: AgentWorkflowDto) => void }) {
    const [value, setValue] = useState(workflow);
    return (
      <I18nProvider initialLocale="en-US">
        <AgentWorkflowBoard
          workflow={value}
          agents={[baseAgent]}
          isReadOnly={false}
          isDirty={false}
          toolNames={toolNames}
          providerOptions={[]}
          onChange={(next) => {
            setValue(next);
            onWorkflow?.(next);
          }}
          onSave={() => {}}
        />
      </I18nProvider>
    );
  }

  it('removes a rule from its canvas node', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-rule'));
    const ruleId = (onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.id;
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByTestId(`workflow-node-remove-${ruleId}`));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules).toEqual([]);
    expect(screen.queryByTestId(`workflow-node-${ruleId}`)).toBeNull();
  });

  it('describes a rule node whose rule is gone as an unnamed rule without details', () => {
    const t = ((key: string) => key) as Parameters<typeof describeWorkflowNode>[4];
    const view = describeWorkflowNode(
      { id: 'missing-rule', kind: 'rule', x: 0, y: 0 } as never,
      [],
      [],
      [],
      t,
    );
    expect(view.subtitle).toBe('');
    expect(view.title).toBe('agents.workflowRule');
  });

  it('frames the flow once even when the browser has no ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Host />);
    expect(screen.getByTestId('workflow-canvas')).toBeTruthy();
  });
});

void act;
