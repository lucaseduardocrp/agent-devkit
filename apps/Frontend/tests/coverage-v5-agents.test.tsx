import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentModal } from '../src/features/agents/AgentModal.js';
import { AgentSkillsField } from '../src/features/agents/AgentSkillsField.js';
import { AgentsView } from '../src/features/agents/AgentsView.js';
import type { CustomAgentDto, HubSkillDto } from '../src/features/agents/agent-types.js';
import { ApiClient } from '../src/lib/api-client.js';

const agent = (id: string, name: string, slug: string): CustomAgentDto => ({
  id,
  workspaceId: 'ws-1',
  name,
  slug,
  description: `${name} description`,
  instructions: '# Do it',
  role: 'QA',
  model: 'gemini-2.5-flash',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const skill = (name: string): HubSkillDto =>
  ({ name, description: `${name} skill`, version: '1.0.0', revision: 'r1' }) as HubSkillDto;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentModal hub skills', () => {
  it('ignores a skills catalog that arrives after the modal closed', async () => {
    let resolve: (list: readonly HubSkillDto[]) => void = () => {};
    const loadHubSkills = vi.fn(
      () =>
        new Promise<readonly HubSkillDto[]>((done) => {
          resolve = done;
        }),
    );
    const view = render(
      <AgentModal isOpen onClose={vi.fn()} onSave={vi.fn()} loadHubSkills={loadHubSkills} />,
    );
    view.rerender(
      <AgentModal
        isOpen={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
        loadHubSkills={loadHubSkills}
      />,
    );
    await act(async () => resolve([skill('test-design')]));
    expect(view.container.innerHTML).toBe('');
  });
});

describe('AgentSkillsField', () => {
  it('drops a removed skill from the refresh queue and ignores the empty option', () => {
    const onChange = vi.fn();
    const onRefreshChange = vi.fn();
    const view = render(
      <AgentSkillsField
        value={['test-design']}
        onChange={onChange}
        refresh={['test-design', 'edge-hunter']}
        onRefreshChange={onRefreshChange}
        attached={[]}
        catalog={[skill('test-design'), skill('edge-hunter')]}
        catalogError={false}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: /test-design/ }));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(onRefreshChange).toHaveBeenCalledWith(['edge-hunter']);

    onChange.mockClear();
    fireEvent.change(document.getElementById('agent-skill-add')!, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('AgentsView', () => {
  let client: ApiClient;
  beforeEach(() => {
    client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([
      agent('agent-qa', 'QA Engineer', 'qa-engineer'),
      agent('agent-doc', 'Doc Specialist', 'doc-specialist'),
    ]);
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    vi.spyOn(client, 'deleteAgent').mockResolvedValue({ success: true });
    vi.spyOn(client, 'getIssues').mockResolvedValue([]);
    vi.spyOn(client, 'getAgentRuns').mockResolvedValue([]);
  });

  it('keeps the selected agent when another one is deleted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    await view.findByTestId('agent-card-doc-specialist');
    fireEvent.click(view.getByTestId('test-agent-btn-qa-engineer'));
    fireEvent.click(view.getByTestId('tab-catalog'));
    fireEvent.click(view.getByLabelText('Excluir agente Doc Specialist'));
    await waitFor(() => expect(client.deleteAgent).toHaveBeenCalledWith('agent-doc'));
    fireEvent.click(view.getByTestId('tab-playground'));
    expect(view.getByTestId('playground-view-panel')).toBeInTheDocument();
  });

  it('refreshes the map every ten seconds without a workspace header', async () => {
    const setWorkspaceId = vi.spyOn(client, 'setWorkspaceId');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const view = render(<AgentsView apiClient={client} />);
    await waitFor(() => expect(client.getAgents).toHaveBeenCalledOnce());
    fireEvent.click(view.getByTestId('tab-map'));
    await waitFor(() => expect(client.getIssues).toHaveBeenCalledOnce());

    const call = setIntervalSpy.mock.calls.find(([, delay]) => delay === 10_000);
    await act(async () => (call?.[0] as () => void)());
    await waitFor(() => expect(client.getIssues).toHaveBeenCalledTimes(2));
    expect(setWorkspaceId).not.toHaveBeenCalled();
  });
});
