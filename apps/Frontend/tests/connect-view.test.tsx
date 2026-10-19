import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectView } from '../src/features/connect/ConnectView.js';
import { ApiClient, type UserIntegrationDto } from '../src/lib/api-client.js';

describe('ConnectView', () => {
  it('renders only implemented integrations grouped by category', () => {
    const { getByTestId, getByText, getByRole, queryByText } = render(<ConnectView />);
    expect(getByTestId('screen-connect')).toBeInTheDocument();
    expect(getByText('Azure DevOps')).toBeInTheDocument();
    expect(queryByText('Azure Boards')).not.toBeInTheDocument();
    expect(getByTestId('conn-card-jira').querySelector('i')).toHaveClass('ti-ticket');
    expect(getByText('GitHub')).toBeInTheDocument();
    expect(getByRole('heading', { name: 'Conhecimento' })).toBeInTheDocument();
    expect(getByRole('heading', { name: 'Inteligência artificial' })).toBeInTheDocument();
    expect(getByRole('heading', { name: 'Gestão de projetos' })).toBeInTheDocument();
    expect(queryByText('PostgreSQL (Neon)')).not.toBeInTheDocument();
    expect(queryByText('Slack')).not.toBeInTheDocument();
    expect(queryByText('SharePoint')).not.toBeInTheDocument();
    expect(queryByText('REST API')).not.toBeInTheDocument();
  });

  it('toggles integration status on click from connected to disconnected and back', () => {
    const { getByTestId } = render(<ConnectView />);
    const azureCard = getByTestId('conn-card-azure');

    expect(azureCard).toHaveClass('connected');
    expect(azureCard).toHaveTextContent('Conectado');

    // Click to disconnect
    fireEvent.click(azureCard);
    expect(azureCard).not.toHaveClass('connected');
    expect(azureCard).toHaveTextContent('Desconectado');

    // Click again to reconnect
    fireEvent.click(azureCard);
    expect(azureCard).toHaveClass('connected');
    expect(azureCard).toHaveTextContent('Conectado');
  });

  it('toggles disconnected integration to connected on Enter key press', () => {
    const { getByTestId } = render(<ConnectView />);
    const githubCard = getByTestId('conn-card-github');

    expect(githubCard).toHaveTextContent('Desconectado');

    // Non-enter key does nothing
    fireEvent.keyDown(githubCard, { key: 'Escape' });
    expect(githubCard).toHaveTextContent('Desconectado');

    // Enter key connects
    fireEvent.keyDown(githubCard, { key: 'Enter' });
    expect(githubCard).toHaveTextContent('Conectado');
  });

  it('toggles not-configured integration to connected', () => {
    const { getByTestId } = render(<ConnectView />);
    const restCard = getByTestId('conn-card-wiki-js');

    expect(restCard).toHaveTextContent('Não configurado');

    fireEvent.click(restCard);
    expect(restCard).toHaveTextContent('Conectado');
  });

  it('filters integration sections using category tabs', () => {
    const { getByTestId, queryByTestId, getByRole } = render(<ConnectView />);

    fireEvent.click(getByRole('tab', { name: /Inteligência artificial/ }));
    expect(getByTestId('conn-card-gemini')).toBeInTheDocument();
    expect(queryByTestId('conn-card-azure')).not.toBeInTheDocument();
    expect(queryByTestId('conn-card-github')).not.toBeInTheDocument();

    fireEvent.click(getByRole('tab', { name: /Gestão de projetos/ }));
    expect(getByTestId('conn-card-github')).toBeInTheDocument();
    expect(queryByTestId('conn-card-gemini')).not.toBeInTheDocument();

    fireEvent.click(getByRole('tab', { name: /Todas/ }));
    expect(getByTestId('conn-card-azure')).toBeInTheDocument();
    expect(getByTestId('conn-card-github')).toBeInTheDocument();
  });

  it('loads existing user integrations from apiClient and updates statuses', async () => {
    const client = new ApiClient();
    const mockIntegrations = [
      {
        id: 'i-az',
        category: 'KNOWLEDGE' as const,
        providerId: 'azure_devops_wiki',
        isEnabled: true,
        settings: { organization: 'az-org' },
        hasSecret: true,
        maskedSecret: '••••••••',
        updatedAt: '2026-09-11T12:00:00Z',
      },
      {
        id: 'i-gh',
        category: 'PROJECT_MANAGEMENT' as const,
        providerId: 'github_projects',
        isEnabled: false,
        settings: { owner: 'gh-owner' },
        hasSecret: false,
        maskedSecret: null,
        updatedAt: '2026-09-11T12:00:00Z',
      },
    ];
    vi.spyOn(client, 'getIntegrations').mockResolvedValue(mockIntegrations);

    const { getByTestId, findByLabelText } = render(<ConnectView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('conn-card-azure')).toHaveTextContent('Conectado');
      expect(getByTestId('conn-card-github')).toHaveTextContent('Desconectado');
      expect(getByTestId('conn-card-wiki-js')).toHaveTextContent('Não configurado');
    });

    expect(await findByLabelText('Credenciais criptografadas ativas')).toBeInTheDocument();
  });

  it('opens config modal on card click, saves changes, and updates card status', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    vi.spyOn(client, 'saveIntegration').mockResolvedValue({
      id: 'i-new',
      category: 'KNOWLEDGE',
      providerId: 'wiki_js',
      isEnabled: true,
      settings: { baseUrl: 'https://wiki.corp' },
      hasSecret: true,
      maskedSecret: '••••••••',
      updatedAt: '2026-09-11T12:00:00Z',
    });

    const { getByTestId, getByLabelText, getByRole, queryByTestId } = render(
      <ConnectView apiClient={client} />,
    );

    await waitFor(() => {
      expect(getByTestId('conn-card-wiki-js')).toHaveTextContent('Não configurado');
    });

    // Click Wiki.js card to open modal
    fireEvent.click(getByTestId('conn-card-wiki-js'));
    expect(queryByTestId('integration-modal')).toBeInTheDocument();

    // Fill and save
    fireEvent.change(getByLabelText('URL Base do Wiki.js'), {
      target: { value: 'https://wiki.corp' },
    });
    fireEvent.click(getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(queryByTestId('integration-modal')).not.toBeInTheDocument();
      expect(getByTestId('conn-card-wiki-js')).toHaveTextContent('Conectado');
    });
  });

  it('deletes configuration from modal and reverts card to not-configured', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([
      {
        id: 'i-del',
        category: 'KNOWLEDGE',
        providerId: 'wiki_js',
        isEnabled: true,
        settings: {},
        hasSecret: false,
        maskedSecret: null,
        updatedAt: '2026-09-11T12:00:00Z',
      },
    ]);
    vi.spyOn(client, 'deleteIntegration').mockResolvedValue();

    const { getByTestId, getByRole, queryByTestId } = render(<ConnectView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('conn-card-wiki-js')).toHaveTextContent('Conectado');
    });

    fireEvent.click(getByTestId('conn-card-wiki-js'));
    expect(queryByTestId('integration-modal')).toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: 'Desconectar' }));

    await waitFor(() => {
      expect(queryByTestId('integration-modal')).not.toBeInTheDocument();
      expect(getByTestId('conn-card-wiki-js')).toHaveTextContent('Não configurado');
    });
  });

  it('triggers onRequireAuth when unauthenticated user clicks an integration card', () => {
    const onRequireAuth = vi.fn();
    const { getByTestId } = render(
      <ConnectView
        apiClient={new ApiClient()}
        isAuthenticated={false}
        onRequireAuth={onRequireAuth}
      />,
    );

    fireEvent.click(getByTestId('conn-card-azure'));
    expect(onRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('gracefully handles getIntegrations failure and keeps default cards', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockRejectedValue(new Error('Network error'));

    const { getByTestId } = render(<ConnectView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('screen-connect')).toBeInTheDocument();
    });
  });

  it('updates card status to disconnected when saved as disabled', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    vi.spyOn(client, 'saveIntegration').mockResolvedValue({
      id: 'i-disabled',
      category: 'LLM',
      providerId: 'gemini',
      isEnabled: false,
      settings: { model: 'gemini-1.5-flash' },
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-09-11T12:00:00Z',
    });

    const { getByTestId, getByRole, getByLabelText } = render(<ConnectView apiClient={client} />);

    fireEvent.click(getByTestId('conn-card-gemini'));
    fireEvent.click(getByLabelText('Ativar esta integração no adk'));
    fireEvent.click(getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(getByTestId('conn-card-gemini')).toHaveTextContent('Desconectado');
    });
  });

  it('handles unmounting safely before getIntegrations resolves', () => {
    const client = new ApiClient();
    let resolvePromise: (val: readonly UserIntegrationDto[]) => void = () => {};
    vi.spyOn(client, 'getIntegrations').mockImplementation(
      () =>
        new Promise((res) => {
          resolvePromise = res;
        }),
    );

    const { unmount } = render(<ConnectView apiClient={client} />);
    unmount();
    expect(() => resolvePromise([])).not.toThrow();
  });

  it('opens modal directly when unauthenticated but onRequireAuth is not provided', () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);

    const { getByTestId, queryByTestId } = render(
      <ConnectView apiClient={client} isAuthenticated={false} />,
    );

    fireEvent.click(getByTestId('conn-card-azure'));
    expect(queryByTestId('integration-modal')).toBeInTheDocument();
  });

  it('lists integrations as read-only status tiles when canManageIntegrations is false', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);

    const { getByTestId, queryByTestId, queryByRole } = render(
      <ConnectView apiClient={client} canManageIntegrations={false} />,
    );

    await waitFor(() => expect(client.getIntegrations).toHaveBeenCalled());
    const card = getByTestId('conn-card-azure');
    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabindex');
    expect(card).not.toHaveClass('cursor-pointer');
    expect(card).toHaveTextContent('Não configurado');
    expect(queryByRole('button', { name: /^Azure DevOps:/ })).not.toBeInTheDocument();

    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(queryByTestId('integration-modal')).not.toBeInTheDocument();
  });

  it('does not toggle offline integrations when canManageIntegrations is false', () => {
    const { getByTestId } = render(<ConnectView canManageIntegrations={false} />);
    const azureCard = getByTestId('conn-card-azure');
    fireEvent.click(azureCard);
    expect(azureCard).toHaveClass('connected');
  });

  it('closes an open configuration when the member loses edit access', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);

    const view = render(<ConnectView apiClient={client} />);
    fireEvent.click(view.getByTestId('conn-card-azure'));
    expect(view.getByTestId('integration-modal')).toBeInTheDocument();

    view.rerender(<ConnectView apiClient={client} canManageIntegrations={false} />);
    expect(view.queryByTestId('integration-modal')).not.toBeInTheDocument();
    await waitFor(() => expect(client.getIntegrations).toHaveBeenCalled());
  });

  it('renders loading skeleton cards when isLoading is true', () => {
    const { getByTestId, queryByTestId } = render(<ConnectView isLoading={true} />);
    expect(getByTestId('integrations-loading-skeleton')).toBeInTheDocument();
    expect(queryByTestId('conn-card-azure')).not.toBeInTheDocument();
  });
});
