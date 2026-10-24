import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHubPanel } from '../src/features/agents/AgentHubPanel.js';
import type { CustomAgentDto, HubAgentCatalogDto } from '../src/features/agents/agent-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const catalog: HubAgentCatalogDto = {
  generatedAt: '2026-10-23T12:00:00Z',
  agents: [
    {
      name: 'qa-test-designer',
      description: 'Writes traceable test cases.',
      overview: '',
      category: 'qa',
      role: 'QA',
      temperature: 0.1,
      tags: ['bdd'],
      toolsets: [],
      author: 'ADK',
      version: '1.0.0',
      license: 'MIT',
      tier: 'official',
      status: 'available',
    },
    {
      name: 'technical-writer',
      description: 'Documents features in the Brain.',
      overview: '',
      category: 'documentation',
      role: 'DOCUMENTATION',
      tags: [],
      toolsets: [],
      author: 'ADK',
      version: '1.1.0',
      license: 'MIT',
      tier: 'official',
      status: 'update-available',
      installed: { agentId: 'agent-writer', name: 'Technical writer', version: '1.0.0' },
    },
  ],
  plugins: [
    {
      name: 'jira-qa',
      title: 'Jira QA',
      description: 'Jira agents.',
      version: '2.0.0',
      maintainer: 'acme',
      tier: 'community',
      license: 'MIT',
      repo: 'https://github.com/acme/adk-jira',
      sha: 'a'.repeat(40),
      agents: [
        { name: 'jira-reviewer', status: 'available' },
        { name: 'jira-triager', status: 'available' },
      ],
    },
  ],
  skills: [
    {
      name: 'test-design',
      description: 'Designs test cases.',
      category: 'qa',
      tags: ['qa'],
      version: '1.2.0',
      author: 'ADK',
      tier: 'official',
      revision: 'new',
    },
  ],
};

function setup(isReadOnly = false, agents: readonly CustomAgentDto[] = []) {
  const api = {
    listHubAgents: vi.fn(() => Promise.resolve(catalog)),
    installHubAgent: vi.fn(() => Promise.resolve([])),
    updateHubAgent: vi.fn(() => Promise.resolve({})),
    updateAgent: vi.fn(() => Promise.resolve({})),
  };
  const onChanged = vi.fn();
  const view = render(
    <AgentHubPanel
      apiClient={api as unknown as ApiClient}
      isReadOnly={isReadOnly}
      getRoleLabel={(role) => role}
      agents={agents}
      onChanged={onChanged}
    />,
  );
  return { api, onChanged, view };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentHubPanel', () => {
  it('lists hub agents and plugin subagents with their install state', async () => {
    const { view } = setup();
    await view.findByTestId('hub-agent-qa-test-designer');
    expect(view.getByTestId('hub-install-qa-test-designer')).toBeInTheDocument();
    expect(view.getByTestId('hub-update-technical-writer')).toHaveTextContent(
      'Atualizar para 1.1.0',
    );
    expect(view.getByTestId('hub-plugin-jira-qa')).toHaveTextContent('jira-reviewer');
    expect(view.getByRole('button', { name: 'Instalar todos' })).toBeInTheDocument();
  });

  it('installs a hub agent, a plugin subagent or a whole plugin and refreshes', async () => {
    const { api, onChanged, view } = setup();
    fireEvent.click(await view.findByTestId('hub-install-qa-test-designer'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.installHubAgent).toHaveBeenLastCalledWith({ name: 'qa-test-designer' });

    fireEvent.click(view.getByTestId('hub-install-jira-qa/jira-reviewer'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(api.installHubAgent).toHaveBeenLastCalledWith({
      plugin: 'jira-qa',
      name: 'jira-reviewer',
    });

    fireEvent.click(view.getByRole('button', { name: 'Instalar todos' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
    expect(api.installHubAgent).toHaveBeenLastCalledWith({ plugin: 'jira-qa' });
    expect(api.listHubAgents).toHaveBeenCalledTimes(4);
  });

  it('updates only after confirmation', async () => {
    const { api, view } = setup();
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    fireEvent.click(await view.findByTestId('hub-update-technical-writer'));
    expect(api.updateHubAgent).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId('hub-update-technical-writer'));
    await waitFor(() => expect(api.updateHubAgent).toHaveBeenCalledWith('agent-writer'));
    expect(confirm.mock.calls[0]?.[0]).toContain('Technical writer');
  });

  it('switches between agents and skills, filters by text, and shows errors from the API', async () => {
    const { api, view } = setup();
    await view.findByTestId('hub-agent-qa-test-designer');
    expect(view.queryByRole('button', { name: 'DOCUMENTATION' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Skills' }));
    expect(view.queryByTestId('hub-agent-qa-test-designer')).toBeNull();
    expect(view.queryByTestId('hub-plugin-jira-qa')).toBeNull();
    expect(view.getByTestId('hub-skill-test-design')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Agentes' }));
    fireEvent.change(view.getByPlaceholderText('Buscar agentes do hub...'), {
      target: { value: 'jira' },
    });
    expect(view.queryByTestId('hub-agent-qa-test-designer')).toBeNull();
    expect(view.getByTestId('hub-plugin-jira-qa')).toBeInTheDocument();

    api.installHubAgent.mockRejectedValueOnce(new Error('Este agente já está instalado.'));
    fireEvent.click(view.getByTestId('hub-install-jira-qa/jira-triager'));
    expect(await view.findByRole('alert')).toHaveTextContent('Este agente já está instalado.');
  });

  it('assigns a skill to agents, takes it away, and updates outdated copies', async () => {
    const agent = (id: string, name: string, skills: CustomAgentDto['skills']) =>
      ({ id, name, skills }) as CustomAgentDto;
    const agents = [
      agent('a1', 'QA', [
        { name: 'test-design', description: '', version: '0.9.0', revision: 'old' },
      ]),
      agent('a2', 'Writer', [
        { name: 'edge-hunter', description: '', version: '1.0.0', revision: 'e' },
      ]),
    ];
    const { api, onChanged, view } = setup(false, agents);
    fireEvent.click(await view.findByRole('button', { name: 'Skills' }));
    const card = view.getByTestId('hub-skill-test-design');
    expect(card).toHaveTextContent('QA');
    expect(card).not.toHaveTextContent('Writer');

    fireEvent.click(view.getByTestId('hub-skill-assign-test-design'));
    const dialog = view.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /QA/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Writer/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updateAgent).toHaveBeenCalledWith('a1', { skills: [] });
    expect(api.updateAgent).toHaveBeenCalledWith('a2', {
      skills: ['edge-hunter', 'test-design'],
    });

    fireEvent.click(view.getByRole('button', { name: 'Atualizar para 1.2.0 nos agentes' }));
    await waitFor(() =>
      expect(api.updateAgent).toHaveBeenLastCalledWith('a1', { refreshSkills: ['test-design'] }),
    );
  });

  it('shows what is installed but offers no actions to read-only members', async () => {
    const { view } = setup(true);
    await view.findByTestId('hub-agent-qa-test-designer');
    expect(view.queryByTestId('hub-install-qa-test-designer')).toBeNull();
    expect(view.queryByTestId('hub-update-technical-writer')).toBeNull();
    expect(view.queryByRole('button', { name: 'Instalar todos' })).toBeNull();
  });

  it('offers a retry when the hub cannot be loaded', async () => {
    const api = {
      listHubAgents: vi
        .fn()
        .mockRejectedValueOnce(new Error('Não foi possível acessar o ADK Hub.'))
        .mockResolvedValueOnce(catalog),
    };
    const view = render(
      <AgentHubPanel
        apiClient={api as unknown as ApiClient}
        isReadOnly={false}
        getRoleLabel={(role) => role}
        onChanged={vi.fn()}
      />,
    );
    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível acessar o ADK Hub.');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByTestId('hub-agent-qa-test-designer')).toBeInTheDocument();
  });
});
