import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHubPanel } from '../src/features/agents/AgentHubPanel.js';
import { AgentModal } from '../src/features/agents/AgentModal.js';
import { AgentSkillsField } from '../src/features/agents/AgentSkillsField.js';
import { AgentTopology } from '../src/features/agents/AgentTopology.js';
import { HubSkillsPanel } from '../src/features/agents/HubSkillsPanel.js';
import {
  MAX_AGENT_SKILLS,
  type CustomAgentDto,
  type HubAgentCatalogDto,
  type HubSkillDto,
} from '../src/features/agents/agent-types.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const skill = (name: string, extra: Partial<HubSkillDto> = {}): HubSkillDto => ({
  name,
  description: `${name} description`,
  category: 'qa',
  version: '2.0.0',
  author: 'ADK',
  tier: 'official',
  revision: 'rev-new',
  ...extra,
});

const agent = (id: string, name: string, extra: Partial<CustomAgentDto> = {}): CustomAgentDto => ({
  id,
  workspaceId: 'ws',
  name,
  slug: id,
  description: '',
  instructions: 'Do it',
  role: 'QA',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...extra,
});

describe('AgentModal model validation', () => {
  it('rejects a model whose AI integration was disabled while the modal was open', () => {
    const onSave = vi.fn();
    const models = [{ providerId: 'openai', providerLabel: 'OpenAI', model: 'gpt-5-mini' }];
    const view = render(
      <AgentModal isOpen onClose={vi.fn()} onSave={onSave} availableLlmModels={models} />,
    );
    fireEvent.change(document.getElementById('agent-name')!, { target: { value: 'Bot' } });
    fireEvent.change(document.getElementById('agent-instructions')!, {
      target: { value: '# Do things' },
    });
    fireEvent.change(document.getElementById('agent-model')!, {
      target: { value: 'gpt-5-mini' },
    });
    view.rerender(<AgentModal isOpen onClose={vi.fn()} onSave={onSave} availableLlmModels={[]} />);
    fireEvent.click(view.getByRole('button', { name: 'Criar Agente' }));
    expect(
      view.getByText('Selecione um modelo de uma integração de IA ativa.'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rejects switching an edited agent to a model that is no longer active', () => {
    const onSave = vi.fn();
    const models = [{ providerId: 'openai', providerLabel: 'OpenAI', model: 'gpt-5-mini' }];
    const editing = agent('a1', 'Legacy', { model: 'legacy-model' });
    const view = render(
      <AgentModal
        isOpen
        onClose={vi.fn()}
        onSave={onSave}
        initialData={editing}
        availableLlmModels={models}
      />,
    );
    fireEvent.change(document.getElementById('agent-model')!, {
      target: { value: 'gpt-5-mini' },
    });
    view.rerender(<AgentModal isOpen onClose={vi.fn()} onSave={onSave} initialData={editing} />);
    fireEvent.submit(document.getElementById('agent-name')!.closest('form')!);
    expect(
      view.getByText('Selecione um modelo de uma integração de IA ativa.'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('AgentSkillsField', () => {
  it('un-queues a refresh, truncates long descriptions and reports the catalog error', () => {
    const onRefreshChange = vi.fn();
    const long = 'x'.repeat(120);
    const view = render(
      <AgentSkillsField
        value={['test-design']}
        onChange={vi.fn()}
        refresh={['test-design']}
        onRefreshChange={onRefreshChange}
        attached={[{ name: 'test-design', description: '', version: '1.0.0', revision: 'old' }]}
        catalog={[skill('test-design'), skill('edge-hunter', { description: long })]}
        catalogError={true}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Atualiza ao salvar' }));
    expect(onRefreshChange).toHaveBeenCalledWith([]);
    expect(view.getByRole('option', { name: `edge-hunter — ${'x'.repeat(90)}…` })).toBeTruthy();
    expect(
      view.getByText('Não foi possível carregar as skills do ADK Hub agora.'),
    ).toBeInTheDocument();
  });

  it('disables adding once the agent reached the skill limit', () => {
    const names = Array.from({ length: MAX_AGENT_SKILLS }, (_, i) => `s${i}`);
    const view = render(
      <AgentSkillsField
        value={names}
        onChange={vi.fn()}
        refresh={[]}
        onRefreshChange={vi.fn()}
        attached={[]}
        catalog={[...names.map((name) => skill(name)), skill('extra')]}
        catalogError={false}
      />,
    );
    expect(view.getByText(`Limite de ${MAX_AGENT_SKILLS} skills por agente.`)).toBeInTheDocument();
    expect(document.getElementById('agent-skill-add')).toHaveProperty('disabled', true);
  });
});

describe('AgentTopology run states', () => {
  const issue = { id: 'issue-1', number: 7, title: 'Known issue' } as Issue;
  const run = (id: string, agentId: string, status: AgentRun['status'], extra = {}) =>
    ({ id, issueId: 'issue-unknown-123', agentId, status, mode: 'server', ...extra }) as AgentRun;

  it('shows waiting and queued agents, orphan runs and issues not loaded', () => {
    const view = render(
      <AgentTopology
        agents={[agent('a1', 'Waiter'), agent('a2', 'Queuer')]}
        issues={[issue]}
        runs={[
          run('r1', 'a1', 'waiting_review'),
          run('r2', 'a2', 'queued', { issueId: 'issue-1' }),
          run('r3', 'ghost', 'running'),
        ]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(view.getByRole('button', { name: 'Waiter: Aguardando você' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Queuer: Na fila' })).toBeInTheDocument();
    expect(view.getByTestId('topology-run-r1')).toHaveTextContent('Aguardando decisão');
    expect(view.getByTestId('topology-run-r1')).toHaveTextContent('#issue-un');
    expect(view.getByTestId('topology-run-r1')).toHaveTextContent('Servidor');
    expect(view.getByTestId('topology-run-r2')).toHaveTextContent('Issue na fila');
    expect(view.getByTestId('topology-run-r2')).toHaveTextContent('#7 Known issue');
    expect(view.queryByTestId('run-edge-r3')).toBeNull();
    expect(view.getByTestId('run-edge-r1')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Waiter: Aguardando você' }));
    expect(view.getByTestId('topology-selection')).toHaveTextContent('Sem descrição cadastrada.');
  });
});

describe('HubSkillsPanel', () => {
  const setup = (agents: readonly CustomAgentDto[], skills: readonly HubSkillDto[]) => {
    const run = vi.fn(async (_key: string, _title: string, op: () => Promise<unknown>) => {
      await op();
    });
    const updateAgentSkills = vi.fn(() => Promise.resolve({}));
    const view = render(
      <HubSkillsPanel
        skills={skills}
        agents={agents}
        isReadOnly={false}
        busy={null}
        run={run}
        updateAgentSkills={updateAgentSkills}
      />,
    );
    return { run, updateAgentSkills, view };
  };

  it('labels tiers, hides the hub link for built-in skills and tolerates missing tags', () => {
    const { view } = setup(
      [],
      [skill('native', { tier: 'built-in' }), skill('shared', { tier: 'community', tags: ['a'] })],
    );
    const native = view.getByTestId('hub-skill-native');
    expect(native).toHaveTextContent('Nativa');
    expect(within(native).queryByText('Ver no ADK Hub')).toBeNull();
    const shared = view.getByTestId('hub-skill-shared');
    expect(shared).toHaveTextContent('Comunidade');
    expect(shared).toHaveTextContent('#a');
    expect(within(shared).getByText('Ver no ADK Hub')).toBeInTheDocument();
  });

  it('explains there are no agents to assign and closes on cancel', () => {
    const { run, view } = setup([], [skill('lonely')]);
    fireEvent.click(view.getByTestId('hub-skill-assign-lonely'));
    const dialog = view.getByRole('dialog');
    expect(dialog).toHaveTextContent('Crie ou instale um agente para associar esta skill.');
    expect(within(dialog).getByRole('button', { name: 'Salvar' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks agents at the skill limit, saves nothing unchanged and adds to agents without skills', async () => {
    const full = agent('full', 'Full', {
      skills: Array.from({ length: MAX_AGENT_SKILLS }, (_, i) => ({
        name: `s${i}`,
        description: '',
        version: '1',
        revision: 'r',
      })),
    });
    const bare = agent('bare', 'Bare');
    const { run, updateAgentSkills, view } = setup([full, bare], [skill('test-design')]);

    fireEvent.click(view.getByTestId('hub-skill-assign-test-design'));
    let dialog = view.getByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: /Full/ })).toHaveProperty('disabled', true);
    expect(dialog).toHaveTextContent(`Já usa ${MAX_AGENT_SKILLS} skills, o limite`);
    expect(dialog).toHaveTextContent('0 skills');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId('hub-skill-assign-test-design'));
    dialog = view.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Bare/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(updateAgentSkills).toHaveBeenCalledWith('bare', { skills: ['test-design'] }),
    );
  });
});

describe('AgentHubPanel edge states', () => {
  const baseAgent = {
    overview: '',
    category: 'qa',
    role: 'QA' as const,
    tags: [],
    toolsets: [],
    author: 'ADK',
    version: '1.0.0',
    license: 'MIT',
  };
  const catalog: HubAgentCatalogDto = {
    generatedAt: '2026-10-23T12:00:00Z',
    agents: [
      {
        ...baseAgent,
        name: 'verified-agent',
        description: 'Verified one',
        tier: 'verified',
        status: 'installed',
        installed: { agentId: 'x', name: 'Verified', version: '1.0.0' },
      },
      {
        ...baseAgent,
        name: 'orphan-update',
        description: 'Update without local copy',
        tier: 'official',
        status: 'update-available',
      },
    ],
    plugins: [
      {
        name: 'no-version',
        title: 'No Version',
        description: 'Plugin without version.',
        maintainer: 'acme',
        tier: 'community',
        license: 'MIT',
        repo: 'https://example.com',
        sha: 'abcdef1234567890',
        agents: [{ name: 'only', status: 'available' }],
      },
    ],
    skills: [skill('untagged')],
  };

  const setup = (overrides: Record<string, unknown> = {}) => {
    const api = {
      listHubAgents: vi.fn(() => Promise.resolve(catalog)),
      installHubAgent: vi.fn(() => Promise.resolve([])),
      updateHubAgent: vi.fn(() => Promise.resolve({})),
      updateAgent: vi.fn(() => Promise.resolve({})),
      ...overrides,
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
  };

  it('shows installed and verified agents, short plugin shas and skips updates without a copy', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { api, view } = setup();
    const verified = await view.findByTestId('hub-agent-verified-agent');
    expect(verified).toHaveTextContent('Verificado');
    expect(verified).toHaveTextContent('Instalado');
    expect(view.getByTestId('hub-plugin-no-version')).toHaveTextContent('abcdef12');
    fireEvent.click(view.getByTestId('hub-update-orphan-update'));
    expect(confirm).not.toHaveBeenCalled();
    expect(api.updateHubAgent).not.toHaveBeenCalled();
  });

  it('shows empty states for agents and skills searches', async () => {
    const { view } = setup();
    await view.findByTestId('hub-agent-verified-agent');
    fireEvent.change(view.getByPlaceholderText('Buscar agentes do hub...'), {
      target: { value: 'nothing-matches' },
    });
    expect(view.getByText('Nenhum agente do hub corresponde a esses filtros.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Skills' }));
    expect(view.getByText('Nenhuma skill do hub corresponde à busca.')).toBeInTheDocument();
  });

  it('falls back to generic messages for unexplained failures', async () => {
    const { view } = setup({ listHubAgents: vi.fn(() => Promise.reject(new Error(''))) });
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar o ADK Hub agora.',
    );
  });

  it('reports a non-Error install failure as text', async () => {
    const { view } = setup({ installHubAgent: vi.fn().mockRejectedValue('quota exceeded') });
    fireEvent.click(await view.findByTestId('hub-install-no-version/only'));
    expect(await view.findByRole('alert')).toHaveTextContent('quota exceeded');
  });
});
