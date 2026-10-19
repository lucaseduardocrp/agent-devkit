import { fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  IntegrationConfigModal,
  type IntegrationCardItem,
} from '../src/features/connect/IntegrationConfigModal.js';
import { ConnectView } from '../src/features/connect/ConnectView.js';
import {
  ApiClient,
  type IntegrationCategory,
  type UserIntegrationDto,
} from '../src/lib/api-client.js';

function item(providerId: string, name: string, category: IntegrationCategory): IntegrationCardItem {
  return {
    id: providerId,
    providerId,
    category,
    name,
    desc: `${name} provider`,
    icon: 'ti-plug',
    iconBg: 'var(--surface-0)',
    iconColor: 'var(--text-primary)',
    status: 'not-configured',
  };
}

function savedConfig(
  providerId: string,
  category: IntegrationCategory,
  settings: Record<string, unknown>,
): UserIntegrationDto {
  return {
    id: `int-${providerId}`,
    category,
    providerId,
    isEnabled: true,
    settings,
    hasSecret: false,
    maskedSecret: null,
    updatedAt: '2026-09-11T12:00:00Z',
  } as UserIntegrationDto;
}

function renderModal(integration: IntegrationCardItem, currentConfig?: UserIntegrationDto) {
  const client = new ApiClient();
  const save = vi
    .spyOn(client, 'saveIntegration')
    .mockImplementation((category, providerId, input) =>
      Promise.resolve(
        savedConfig(providerId, category as IntegrationCategory, input.settings ?? {}),
      ),
    );
  const onClose = vi.fn();
  const view = render(
    <IntegrationConfigModal
      isOpen
      onClose={onClose}
      integration={integration}
      currentConfig={currentConfig}
      apiClient={client}
      onSaveSuccess={vi.fn()}
      onDeleteSuccess={vi.fn()}
    />,
  );
  return { view, save, onClose };
}

function fill(view: RenderResult, values: Record<string, string>) {
  for (const [label, value] of Object.entries(values))
    fireEvent.change(view.getByLabelText(label), { target: { value } });
}

interface ProviderCase {
  readonly integration: IntegrationCardItem;
  readonly values: Record<string, string>;
  readonly settings: Record<string, string>;
  readonly hint?: string;
}

describe('IntegrationConfigModal provider forms', () => {
  it.each<ProviderCase>([
    {
      integration: item('azure_devops', 'Azure Boards', 'PROJECT_MANAGEMENT'),
      values: { Organização: 'contoso', Projeto: 'Payments' },
      settings: { organization: 'contoso', project: 'Payments' },
    },
    {
      integration: item('trello', 'Trello', 'PROJECT_MANAGEMENT'),
      values: { 'API key': 'trello-key', 'Board ID': 'board-42' },
      settings: { apiKey: 'trello-key', boardId: 'board-42' },
    },
    {
      integration: item('jira', 'Jira', 'PROJECT_MANAGEMENT'),
      values: {
        'URL do Jira Cloud': 'https://contoso.atlassian.net',
        Email: 'qa@contoso.com',
        'Chave do projeto': 'PAY',
      },
      settings: { baseUrl: 'https://contoso.atlassian.net', email: 'qa@contoso.com', projectKey: 'PAY' },
    },
    {
      integration: item('testrail', 'TestRail', 'PROJECT_MANAGEMENT'),
      values: { 'URL do TestRail': 'https://contoso.testrail.io', 'Usuário (email)': 'qa@contoso.com' },
      settings: { baseUrl: 'https://contoso.testrail.io', username: 'qa@contoso.com' },
      hint: 'Informe a API key do TestRail no campo de credencial.',
    },
    {
      integration: item('xray', 'Xray', 'PROJECT_MANAGEMENT'),
      values: {
        'Client ID': 'client-1',
        'Chave do projeto Jira': 'PAY',
        'URL da API do Xray (região, opcional)': 'https://eu.xray.cloud.getxray.app',
        'URL do Jira (opcional, para links)': 'https://contoso.atlassian.net',
      },
      settings: {
        clientId: 'client-1',
        projectKey: 'PAY',
        baseUrl: 'https://eu.xray.cloud.getxray.app',
        jiraBaseUrl: 'https://contoso.atlassian.net',
      },
      hint: 'Informe o client secret da API key do Xray no campo de credencial.',
    },
  ])('saves the $integration.name connection fields', async ({ integration, values, settings, hint }) => {
    const { view, save, onClose } = renderModal(integration);

    expect(view.queryByLabelText('Endpoint / URL de Conexão')).not.toBeInTheDocument();
    if (hint) expect(view.getByText(hint)).toBeInTheDocument();
    fill(view, values);
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('PROJECT_MANAGEMENT', integration.providerId, {
        isEnabled: true,
        settings,
        secret: undefined,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('saves the design repository and branch of an Azure DevOps wiki', async () => {
    const { view, save } = renderModal(item('azure_devops_wiki', 'Azure DevOps', 'KNOWLEDGE'));

    const branch = view.getByLabelText('Branch') as HTMLInputElement;
    expect(branch.value).toBe('main');
    fill(view, { 'Repositório Git para Design': 'design-system', Branch: 'develop' });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('KNOWLEDGE', 'azure_devops_wiki', {
        isEnabled: true,
        settings: { repository: 'design-system', branch: 'develop' },
        secret: undefined,
      }),
    );
  });

  it('saves the GitHub project number and branch', async () => {
    const { view, save } = renderModal(item('github_projects', 'GitHub', 'PROJECT_MANAGEMENT'));

    fill(view, {
      'Proprietário / Organização GitHub': 'contoso',
      'Número do projeto': '7',
      Branch: 'release',
    });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('PROJECT_MANAGEMENT', 'github_projects', {
        isEnabled: true,
        settings: { owner: 'contoso', projectNumber: '7', branch: 'release' },
        secret: undefined,
      }),
    );
  });

  it('switches a cloud model to a custom ID and back to the catalog', async () => {
    const { view, save } = renderModal(item('openai', 'OpenAI', 'LLM'));
    const model = view.getByLabelText('Modelo OpenAI') as HTMLSelectElement;
    expect(model.value).toBe('gpt-5.1');
    expect(view.queryByLabelText('ID personalizado do modelo')).not.toBeInTheDocument();

    fireEvent.change(model, { target: { value: '__custom_model__' } });
    const custom = view.getByLabelText('ID personalizado do modelo') as HTMLInputElement;
    expect(custom.value).toBe('');
    fireEvent.change(custom, { target: { value: 'gpt-5.1-codex' } });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('LLM', 'openai', {
        isEnabled: true,
        settings: { model: 'gpt-5.1-codex' },
        secret: undefined,
      }),
    );

    fireEvent.change(model, { target: { value: 'gpt-5-mini' } });
    expect(model.value).toBe('gpt-5-mini');
    expect(view.queryByLabelText('ID personalizado do modelo')).not.toBeInTheDocument();
  });

  it('accepts a custom installed Ollama model and keeps one already configured', async () => {
    const { view, save } = renderModal(item('ollama', 'Ollama', 'LLM'));
    const model = view.getByLabelText('Modelo Ollama') as HTMLSelectElement;

    fireEvent.change(model, { target: { value: '__custom_model__' } });
    expect(model.value).toBe('__custom_model__');
    const custom = view.getByLabelText('ID personalizado do modelo') as HTMLInputElement;
    expect(custom.value).toBe('');
    fireEvent.change(custom, { target: { value: 'meu-modelo:latest' } });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('LLM', 'ollama', {
        isEnabled: true,
        settings: { model: 'meu-modelo:latest' },
        secret: undefined,
      }),
    );
    view.unmount();

    const configured = renderModal(
      item('ollama', 'Ollama', 'LLM'),
      savedConfig('ollama', 'LLM', { model: 'phi4:latest', baseUrl: 'http://gpu:11434' }),
    );
    expect((configured.view.getByLabelText('Modelo Ollama') as HTMLSelectElement).value).toBe(
      '__custom_model__',
    );
    expect(
      (configured.view.getByLabelText('ID personalizado do modelo') as HTMLInputElement).value,
    ).toBe('phi4:latest');
    expect((configured.view.getByLabelText('URL do Ollama') as HTMLInputElement).value).toBe(
      'http://gpu:11434',
    );
  });
});

describe('ConnectView configuration modal', () => {
  it('shows the catalog description of providers without a translated one', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    const view = render(<ConnectView apiClient={client} />);
    await waitFor(() => expect(client.getIntegrations).toHaveBeenCalled());

    fireEvent.click(view.getByTestId('conn-card-trello'));

    const modal = await view.findByTestId('integration-modal');
    expect(modal).toHaveTextContent('Listas e cards do Trello');
    expect(view.getByLabelText('Board ID')).toBeInTheDocument();
  });
});
