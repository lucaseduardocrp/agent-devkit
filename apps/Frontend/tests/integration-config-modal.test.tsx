import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  IntegrationConfigModal,
  type IntegrationCardItem,
} from '../src/features/connect/IntegrationConfigModal.js';
import { ApiClient, type UserIntegrationDto } from '../src/lib/api-client.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';

describe('IntegrationConfigModal', () => {
  const azItem: IntegrationCardItem = {
    id: 'azure',
    providerId: 'azure_devops_wiki',
    category: 'KNOWLEDGE',
    name: 'Azure DevOps',
    desc: 'Wikis corporativos',
    icon: 'ti-brand-azure',
    iconBg: 'var(--bg-accent)',
    iconColor: 'var(--text-accent)',
    status: 'connected',
  };

  const ghItem: IntegrationCardItem = {
    id: 'github',
    providerId: 'github_projects',
    category: 'PROJECT_MANAGEMENT',
    name: 'GitHub',
    desc: 'Issues e wikis',
    icon: 'ti-brand-github',
    iconBg: 'var(--bg-pro)',
    iconColor: 'var(--text-pro)',
    status: 'disconnected',
  };

  const wikiItem: IntegrationCardItem = {
    id: 'wiki-js',
    providerId: 'wiki_js',
    category: 'KNOWLEDGE',
    name: 'Wiki.js',
    desc: 'Self-hosted wiki',
    icon: 'ti-book',
    iconBg: 'var(--bg-accent)',
    iconColor: 'var(--text-accent)',
    status: 'not-configured',
  };

  const geminiItem: IntegrationCardItem = {
    id: 'gemini',
    providerId: 'gemini',
    category: 'LLM',
    name: 'Google Gemini',
    desc: 'Modelos Gemini',
    icon: 'ti-sparkles',
    iconBg: 'var(--bg-warning)',
    iconColor: 'var(--text-warning)',
    status: 'not-configured',
  };

  const ollamaItem: IntegrationCardItem = {
    id: 'ollama',
    providerId: 'ollama',
    category: 'LLM',
    name: 'Ollama',
    desc: 'Modelos locais',
    icon: 'ti-cpu',
    iconBg: 'var(--surface-0)',
    iconColor: 'var(--text-primary)',
    status: 'not-configured',
  };

  const restItem: IntegrationCardItem = {
    id: 'rest-api',
    providerId: 'rest_api',
    category: 'CI_CD',
    name: 'REST API',
    desc: 'Endpoint genérico',
    icon: 'ti-api',
    iconBg: 'var(--surface-0)',
    iconColor: 'var(--text-muted)',
    status: 'not-configured',
  };

  it('renders nothing when isOpen is false', () => {
    const { queryByTestId } = render(
      <IntegrationConfigModal
        isOpen={false}
        onClose={vi.fn()}
        integration={azItem}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );
    expect(queryByTestId('integration-modal')).not.toBeInTheDocument();
  });

  it('renders Azure DevOps specific fields and handles save', async () => {
    const client = new ApiClient();
    const mockSaved: UserIntegrationDto = {
      id: 'int-1',
      category: 'KNOWLEDGE',
      providerId: 'azure_devops_wiki',
      isEnabled: true,
      settings: { organization: 'my-org', project: 'my-proj' },
      hasSecret: true,
      maskedSecret: '••••••••',
      updatedAt: '2026-09-11T12:00:00Z',
    };
    vi.spyOn(client, 'saveIntegration').mockResolvedValue(mockSaved);
    const onSaveSuccess = vi.fn();
    const onClose = vi.fn();

    const { getByLabelText, getByRole } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={onClose}
        integration={azItem}
        apiClient={client}
        onSaveSuccess={onSaveSuccess}
        onDeleteSuccess={vi.fn()}
      />,
    );

    fireEvent.change(getByLabelText('Organização Azure DevOps'), {
      target: { value: 'my-org' },
    });
    fireEvent.change(getByLabelText('Projeto'), { target: { value: 'my-proj' } });
    fireEvent.change(getByLabelText('Identificador da Wiki (necessário se houver mais de uma)'), {
      target: { value: 'wiki-1' },
    });
    fireEvent.change(getByLabelText('Chave de Acesso / Token / Segredo'), {
      target: { value: 'pat-secret' },
    });
    fireEvent.click(getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(client.saveIntegration).toHaveBeenCalledWith('KNOWLEDGE', 'azure_devops_wiki', {
        isEnabled: true,
        settings: { organization: 'my-org', project: 'my-proj', wikiIdentifier: 'wiki-1' },
        secret: 'pat-secret',
      });
      expect(onSaveSuccess).toHaveBeenCalledWith(mockSaved);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('renders GitHub Projects fields and pre-fills existing configuration', () => {
    const existingConfig: UserIntegrationDto = {
      id: 'int-gh',
      category: 'PROJECT_MANAGEMENT',
      providerId: 'github_projects',
      isEnabled: false,
      settings: { owner: 'existing-org', repo: 'existing-repo', portNumber: 8080 },
      hasSecret: true,
      maskedSecret: '••••••••',
      updatedAt: '2026-09-11T12:00:00Z',
    };

    const { getByLabelText, getByRole, getByText } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={ghItem}
        currentConfig={existingConfig}
        apiClient={new ApiClient()}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );

    const ownerInput = getByLabelText('Proprietário / Organização GitHub');
    const repoInput = getByLabelText('Repositório / Projeto');

    expect((ownerInput as HTMLInputElement).value).toBe('existing-org');
    expect((repoInput as HTMLInputElement).value).toBe('existing-repo');

    fireEvent.change(ownerInput, { target: { value: 'updated-org' } });
    fireEvent.change(repoInput, { target: { value: 'updated-repo' } });
    expect((ownerInput as HTMLInputElement).value).toBe('updated-org');
    expect((repoInput as HTMLInputElement).value).toBe('updated-repo');

    expect((getByLabelText('Ativar esta integração no adk') as HTMLInputElement).checked).toBe(
      false,
    );
    expect(getByText(/Segredo já configurado/i)).toBeInTheDocument();
    expect(getByRole('button', { name: 'Desconectar' })).toBeInTheDocument();
  });

  it('renders Wiki.js, Gemini, Ollama, and generic REST fields and updates their values', () => {
    const { getByLabelText: getWikiLabel, unmount: unmountWiki } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={wikiItem}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );
    const wikiInput = getWikiLabel('URL Base do Wiki.js');
    expect(wikiInput).toBeInTheDocument();
    fireEvent.change(wikiInput, { target: { value: 'https://wiki.corp' } });
    expect((wikiInput as HTMLInputElement).value).toBe('https://wiki.corp');
    unmountWiki();

    const { getByLabelText: getGeminiLabel, unmount: unmountGemini } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={geminiItem}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );
    const geminiInput = getGeminiLabel('Modelo Gemini');
    expect(geminiInput).toBeInTheDocument();
    expect((geminiInput as HTMLSelectElement).value).toBe('gemini-3.8-flash');
    fireEvent.change(geminiInput, { target: { value: 'gemini-3.7-flash' } });
    expect((geminiInput as HTMLSelectElement).value).toBe('gemini-3.7-flash');
    unmountGemini();

    const { getByLabelText: getOllamaLabel, unmount: unmountOllama } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={ollamaItem}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );
    const ollamaUrl = getOllamaLabel('URL do Ollama');
    const ollamaModel = getOllamaLabel('Modelo Ollama');
    fireEvent.change(ollamaUrl, { target: { value: 'http://ollama.local:11434' } });
    fireEvent.change(ollamaModel, { target: { value: 'mistral' } });
    expect((ollamaUrl as HTMLInputElement).value).toBe('http://ollama.local:11434');
    expect((ollamaModel as HTMLInputElement).value).toBe('mistral');
    unmountOllama();

    const { getByLabelText: getRestLabel } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={restItem}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );
    const restInput = getRestLabel('Endpoint / URL de Conexão');
    expect(restInput).toBeInTheDocument();
    fireEvent.change(restInput, { target: { value: 'https://api.external.com' } });
    expect((restInput as HTMLInputElement).value).toBe('https://api.external.com');
  });

  it('preserves a configured model outside the catalog as a custom model', () => {
    const existingConfig: UserIntegrationDto = {
      id: 'int-gemini',
      category: 'LLM',
      providerId: 'gemini',
      isEnabled: true,
      settings: { model: 'gemini-private-preview' },
      hasSecret: true,
      maskedSecret: '••••••••',
      updatedAt: '2026-09-11T12:00:00Z',
    };

    const { getByLabelText } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={geminiItem}
        currentConfig={existingConfig}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );

    expect((getByLabelText('Modelo Gemini') as HTMLSelectElement).value).toBe('__custom_model__');
    expect((getByLabelText('ID personalizado do modelo') as HTMLInputElement).value).toBe(
      'gemini-private-preview',
    );
  });

  it('runs connectivity probe on click and displays success, error instance, or string error', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'testIntegration')
      .mockResolvedValueOnce({ ok: true, message: 'Azure DevOps connected.' })
      .mockRejectedValueOnce(new Error('Connection timed out'))
      .mockRejectedValueOnce('Network error string');

    const { getByRole, findByText } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={azItem}
        apiClient={client}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );

    const testBtn = getByRole('button', { name: 'Testar Conexão' });

    // Success probe
    fireEvent.click(testBtn);
    expect(await findByText('Azure DevOps connected.')).toBeInTheDocument();

    // Failure probe with Error
    fireEvent.click(testBtn);
    expect(await findByText('Connection timed out')).toBeInTheDocument();

    // Failure probe with string
    fireEvent.click(testBtn);
    expect(await findByText('Falha ao testar conexão.')).toBeInTheDocument();
  });

  it('handles save error and delete error with Error and string throws', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'saveIntegration')
      .mockRejectedValueOnce(new Error('Failed to save to database'))
      .mockRejectedValueOnce('String save error');
    vi.spyOn(client, 'deleteIntegration')
      .mockRejectedValueOnce(new Error('Failed to delete'))
      .mockRejectedValueOnce('String delete error');

    const existingConfig: UserIntegrationDto = {
      id: 'int-1',
      category: 'KNOWLEDGE',
      providerId: 'azure_devops_wiki',
      isEnabled: true,
      settings: {},
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-09-11T12:00:00Z',
    };

    const { getByRole, findByText, getByLabelText } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={azItem}
        currentConfig={existingConfig}
        apiClient={client}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );

    // Toggle enabled checkbox
    const enableCheckbox = getByLabelText('Ativar esta integração no adk');
    fireEvent.click(enableCheckbox);
    expect((enableCheckbox as HTMLInputElement).checked).toBe(false);

    // Save with Error
    fireEvent.click(getByRole('button', { name: 'Salvar' }));
    expect(await findByText('Failed to save to database')).toBeInTheDocument();

    // Save with string throw
    fireEvent.click(getByRole('button', { name: 'Salvar' }));
    expect(await findByText('Falha ao salvar integração.')).toBeInTheDocument();

    // Delete with Error
    fireEvent.click(getByRole('button', { name: 'Desconectar' }));
    expect(await findByText('Failed to delete')).toBeInTheDocument();

    // Delete with string throw
    fireEvent.click(getByRole('button', { name: 'Desconectar' }));
    expect(await findByText('Falha ao remover integração.')).toBeInTheDocument();
  });

  it('does nothing when apiClient is omitted on probe, save, or delete', () => {
    const existingConfig: UserIntegrationDto = {
      id: 'int-1',
      category: 'KNOWLEDGE',
      providerId: 'azure_devops_wiki',
      isEnabled: true,
      settings: {},
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-09-11T12:00:00Z',
    };

    const { getByRole } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={vi.fn()}
        integration={azItem}
        currentConfig={existingConfig}
        apiClient={undefined}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );

    expect(() => fireEvent.click(getByRole('button', { name: 'Testar Conexão' }))).not.toThrow();
    expect(() => fireEvent.click(getByRole('button', { name: 'Salvar' }))).not.toThrow();
    expect(() => fireEvent.click(getByRole('button', { name: 'Desconectar' }))).not.toThrow();
  });

  it('deletes integration successfully and closes on Escape', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'deleteIntegration').mockResolvedValue();
    const onDeleteSuccess = vi.fn();
    const onClose = vi.fn();

    const existingConfig: UserIntegrationDto = {
      id: 'int-1',
      category: 'KNOWLEDGE',
      providerId: 'azure_devops_wiki',
      isEnabled: true,
      settings: {},
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-09-11T12:00:00Z',
    };

    const { getByRole, getByLabelText } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={onClose}
        integration={azItem}
        currentConfig={existingConfig}
        apiClient={client}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={onDeleteSuccess}
      />,
    );

    fireEvent.click(getByRole('button', { name: 'Desconectar' }));
    await waitFor(() => {
      expect(client.deleteIntegration).toHaveBeenCalledWith('KNOWLEDGE', 'azure_devops_wiki');
      expect(onDeleteSuccess).toHaveBeenCalledWith('KNOWLEDGE', 'azure_devops_wiki');
      expect(onClose).toHaveBeenCalled();
    });

    fireEvent.click(getByLabelText('Fechar modal de integração'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('offers configure and test but not disconnect without delete access on integrations', () => {
    const existingConfig: UserIntegrationDto = {
      id: 'int-1',
      category: 'KNOWLEDGE',
      providerId: 'azure_devops_wiki',
      isEnabled: true,
      settings: {},
      hasSecret: true,
      maskedSecret: '••••••••',
      updatedAt: '2026-09-11T12:00:00Z',
    };
    const access = {
      ...FULL_ACCESS,
      modules: { ...FULL_ACCESS.modules, integrations: 'edit' as const },
    };

    const { getByRole, queryByRole } = render(
      <PermissionsProvider access={access}>
        <IntegrationConfigModal
          isOpen={true}
          onClose={vi.fn()}
          integration={azItem}
          currentConfig={existingConfig}
          apiClient={new ApiClient()}
          onSaveSuccess={vi.fn()}
          onDeleteSuccess={vi.fn()}
        />
      </PermissionsProvider>,
    );

    expect(getByRole('button', { name: 'Salvar' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Testar Conexão' })).toBeInTheDocument();
    expect(queryByRole('button', { name: 'Desconectar' })).not.toBeInTheDocument();
  });

  it('renders read-only view when isReadOnly is true', () => {
    const onClose = vi.fn();
    const { getByText, getByRole, queryByRole } = render(
      <IntegrationConfigModal
        isOpen={true}
        onClose={onClose}
        integration={azItem}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
        isReadOnly={true}
      />,
    );

    expect(getByText('Apenas leitura. Modificações desabilitadas.')).toBeInTheDocument();
    expect(queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();
    expect(queryByRole('button', { name: 'Testar Conexão' })).not.toBeInTheDocument();

    const closeBtn = getByRole('button', { name: 'Fechar' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
