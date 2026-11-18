import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  IntegrationConfigModal,
  type IntegrationCardItem,
} from '../src/features/connect/IntegrationConfigModal.js';
import {
  ApiClient,
  type AgentChatHandlers,
  type LlmCliAvailability,
  type UserIntegrationDto,
} from '../src/lib/api-client.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import { getLlmModelCatalog } from '../src/features/connect/llm-model-catalog.js';

const claudeItem: IntegrationCardItem = {
  id: 'claude',
  providerId: 'claude',
  category: 'LLM',
  name: 'Anthropic Claude',
  desc: 'Modelos Claude',
  icon: 'ti-sparkles',
  iconBg: 'var(--bg-warning)',
  iconColor: 'var(--text-warning)',
  status: 'not-configured',
};

const ollamaItem: IntegrationCardItem = { ...claudeItem, id: 'ollama', providerId: 'ollama' };

const installed: LlmCliAvailability = {
  enabled: true,
  providers: {
    claude: {
      id: 'claude',
      label: 'Claude',
      command: 'claude',
      installed: true,
      version: '2.1.318 (Claude Code)',
    },
  },
};

async function renderModal(
  item: IntegrationCardItem,
  client: ApiClient,
  currentConfig?: UserIntegrationDto,
) {
  const view = render(
    <PermissionsProvider access={FULL_ACCESS}>
      <IntegrationConfigModal
        isOpen
        onClose={vi.fn()}
        integration={item}
        apiClient={client}
        currentConfig={currentConfig}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />
    </PermissionsProvider>,
  );
  // The CLI status loads in an effect: let it settle before the test looks at the modal.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

describe('IntegrationConfigModal in AI CLI mode', () => {
  it('offers API key or AI CLI for providers that have a CLI, with the API key by default', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(installed);
    const view = await renderModal(claudeItem, client);

    const apiKey = view.getByRole('radio', { name: /Chave de API/ });
    const cli = view.getByRole('radio', { name: /CLI de IA/ });
    expect(apiKey).toHaveAttribute('aria-checked', 'true');
    expect(cli).toHaveAttribute('aria-checked', 'false');
    expect(view.getByLabelText('Chave de Acesso / Token / Segredo')).toBeInTheDocument();
  });

  it('replaces the key and model fields with the CLI status, and saves without a secret', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(installed);
    const save = vi.spyOn(client, 'saveIntegration').mockResolvedValue({
      id: 'x',
      category: 'LLM',
      providerId: 'claude',
      isEnabled: true,
      settings: { authMode: 'cli' },
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const view = await renderModal(claudeItem, client);

    fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));

    expect(view.queryByLabelText('Chave de Acesso / Token / Segredo')).not.toBeInTheDocument();
    expect(view.queryByLabelText(/^Modelo/, { selector: '#cfg-cloud-model' })).toBeNull();
    expect(
      await view.findByText(/Claude 2\.1\.318 \(Claude Code\) encontrada no servidor/),
    ).toBeInTheDocument();

    fireEvent.change(view.getByLabelText('Modelo da CLI'), {
      target: { value: 'claude-sonnet-5-5' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const [, , payload] = save.mock.calls[0]!;
    expect(payload.secret).toBeUndefined();
    expect(payload.settings).toMatchObject({ authMode: 'cli', cliModel: 'claude-sonnet-5-5' });
  });

  it('starts in CLI mode when the integration was saved that way', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(installed);
    const view = await renderModal(claudeItem, client, {
      id: 'x',
      category: 'LLM',
      providerId: 'claude',
      isEnabled: true,
      settings: { authMode: 'cli' },
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(view.getByRole('radio', { name: /CLI de IA/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('offers only the catalog models, with the CLI default first and no free text', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(installed);
    const view = await renderModal(claudeItem, client);
    fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));

    const select = view.getByLabelText('Modelo da CLI') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    const options = Array.from(select.options);
    expect(options[0]).toMatchObject({ value: '', textContent: 'Padrão da CLI' });
    expect(options.map((option) => option.value).slice(1)).toEqual(
      getLlmModelCatalog('claude')!.models.map((model) => model.id),
    );
    expect(select.value).toBe('');
  });

  it('keeps a saved model that the catalog no longer lists, instead of changing it silently', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getLlmClis').mockResolvedValue(installed);
    const view = await renderModal(claudeItem, client, {
      id: 'x',
      category: 'LLM',
      providerId: 'claude',
      isEnabled: true,
      settings: { authMode: 'cli', cliModel: 'claude-legacy-1' },
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const select = view.getByLabelText('Modelo da CLI') as HTMLSelectElement;
    expect(select.value).toBe('claude-legacy-1');
    expect(Array.from(select.options).map((option) => option.value)).toContain('claude-legacy-1');
  });

  it('explains when CLIs are off on the server or the CLI is not installed', async () => {
    const off = new ApiClient();
    vi.spyOn(off, 'getLlmClis').mockResolvedValue({ enabled: false, providers: {} });
    const offView = await renderModal(claudeItem, off);
    fireEvent.click(offView.getByRole('radio', { name: /CLI de IA/ }));
    expect(await offView.findByText(/ADK_LLM_CLI=true/)).toBeInTheDocument();
    offView.unmount();

    const missing = new ApiClient();
    vi.spyOn(missing, 'getLlmClis').mockResolvedValue({
      enabled: true,
      providers: {
        claude: { id: 'claude', label: 'Claude', command: 'claude', installed: false },
      },
    });
    const missingView = await renderModal(claudeItem, missing);
    fireEvent.click(missingView.getByRole('radio', { name: /CLI de IA/ }));
    expect(await missingView.findByText(/não está instalada/)).toBeInTheDocument();
  });

  it('still lets the user save when the CLI status cannot be read, and accepts a CLI with no version', async () => {
    const broken = new ApiClient();
    vi.spyOn(broken, 'getLlmClis').mockRejectedValue(new Error('offline'));
    const brokenView = await renderModal(claudeItem, broken);
    fireEvent.click(brokenView.getByRole('radio', { name: /CLI de IA/ }));
    expect(await brokenView.findByLabelText('Modelo da CLI')).toBeInTheDocument();
    expect(brokenView.queryByRole('status')).not.toBeInTheDocument();
    brokenView.unmount();

    const bare = new ApiClient();
    vi.spyOn(bare, 'getLlmClis').mockResolvedValue({
      enabled: true,
      providers: {
        claude: { id: 'claude', label: 'Claude', command: 'claude', installed: true },
      },
    });
    const bareView = await renderModal(claudeItem, bare);
    fireEvent.click(bareView.getByRole('radio', { name: /CLI de IA/ }));
    expect(await bareView.findByText(/encontrada no servidor/)).toBeInTheDocument();
    fireEvent.click(bareView.getByRole('radio', { name: /Chave de API/ }));
    expect(bareView.getByLabelText('Chave de Acesso / Token / Segredo')).toBeInTheDocument();
  });

  describe('when the CLI runs in the Bridge', () => {
    const bridge = (overrides: Partial<LlmCliAvailability> = {}): LlmCliAvailability => ({
      enabled: true,
      transport: 'bridge',
      providers: {
        claude: {
          id: 'claude',
          label: 'Claude',
          command: 'claude',
          installed: true,
          version: '2.1.318 (Claude Code)',
          hint: 'Run `claude setup-token` on your computer.',
        },
      },
      ...overrides,
    });
    const saved = {
      id: 'x',
      category: 'LLM',
      providerId: 'claude',
      isEnabled: true,
      settings: { authMode: 'cli' },
      hasSecret: true,
      maskedSecret: '••••••••',
      updatedAt: '2026-01-01T00:00:00Z',
    } as const;

    it('asks for the token that signs the CLI in, with where to get it, and saves it', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(bridge());
      const save = vi.spyOn(client, 'saveIntegration').mockResolvedValue(saved);
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));

      expect(view.getByText(/executa a Claude na Bridge/)).toBeInTheDocument();
      expect(await view.findByText(/encontrada no servidor/)).toBeInTheDocument();
      const token = view.getByLabelText('Token da CLI');
      expect(token).toHaveAttribute('type', 'password');
      expect(view.getByText(/Guardado cifrado pelo ADK/)).toHaveTextContent(
        'Run `claude setup-token` on your computer.',
      );
      expect(view.queryByLabelText('Chave de Acesso / Token / Segredo')).not.toBeInTheDocument();

      fireEvent.change(token, { target: { value: 'sk-ant-oat-token' } });
      fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      const [, , payload] = save.mock.calls[0]!;
      expect(payload.secret).toBe('sk-ant-oat-token');
      expect(payload.settings).toMatchObject({ authMode: 'cli' });
    });

    it('keeps the saved token when the field is left empty', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(bridge());
      const view = await renderModal(claudeItem, client, { ...saved });
      const token = view.getByLabelText('Token da CLI');
      expect(token.getAttribute('placeholder')).toMatch(/manter/i);
    });

    it('works with a CLI that gives no hint', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(
        bridge({
          providers: {
            claude: { id: 'claude', label: 'Claude', command: 'claude', installed: true },
          },
        }),
      );
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      expect(view.getByText(/Guardado cifrado pelo ADK/).textContent).not.toContain('setup-token');
    });

    it('says the CLI is missing from the Bridge, not from the API machine', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(
        bridge({
          providers: {
            claude: { id: 'claude', label: 'Claude', command: 'claude', installed: false },
          },
        }),
      );
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      expect(await view.findByText(/não está instalada na Bridge/)).toBeInTheDocument();
    });

    it('shows why the Bridge could not be asked', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(
        bridge({ providers: {}, error: 'The Bridge could not be reached.' }),
      );
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      expect(await view.findByText('The Bridge could not be reached.')).toBeInTheDocument();
      // The token can still be typed: the Bridge may be back by the time it is used.
      expect(view.getByLabelText('Token da CLI')).toBeInTheDocument();
    });
  });

  describe('the ADK tools (MCP) of the CLI', () => {
    const saved = {
      id: 'x',
      category: 'LLM',
      providerId: 'claude',
      isEnabled: true,
      settings: { authMode: 'cli' },
      hasSecret: false,
      maskedSecret: null,
      updatedAt: '2026-01-01T00:00:00Z',
    } as const;

    it('are on by default in the standard profile, with nothing to set up, and can be limited to reading', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue({ ...installed, mcp: true });
      const save = vi.spyOn(client, 'saveIntegration').mockResolvedValue(saved);
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));

      const select = view.getByLabelText('Ferramentas do ADK para a CLI') as HTMLSelectElement;
      expect(select.value).toBe('standard');
      expect(Array.from(select.options).map((option) => option.value)).toEqual([
        'standard',
        'read',
        'full',
        'off',
      ]);
      expect(view.getByText(/Não há nada para configurar/)).toBeInTheDocument();
      // The recommended choice carries no warning.
      expect(view.queryByRole('alert')).not.toBeInTheDocument();

      fireEvent.change(select, { target: { value: 'read' } });
      fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(save.mock.calls[0]![2].settings).toMatchObject({ authMode: 'cli', mcpAccess: 'read' });
    });

    it('warn, in plain words, when full access is chosen, and only then', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue({ ...installed, mcp: true });
      const save = vi.spyOn(client, 'saveIntegration').mockResolvedValue(saved);
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      const select = view.getByLabelText('Ferramentas do ADK para a CLI');

      fireEvent.change(select, { target: { value: 'full' } });
      const warning = view.getByRole('alert');
      expect(warning).toHaveTextContent(/apagar dados/);
      expect(warning).toHaveTextContent(/chaves de integração/);

      fireEvent.change(select, { target: { value: 'read' } });
      expect(view.queryByRole('alert')).not.toBeInTheDocument();

      fireEvent.change(select, { target: { value: 'full' } });
      fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(save.mock.calls[0]![2].settings).toMatchObject({ mcpAccess: 'full' });
    });

    it('show the saved choice', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue({ ...installed, mcp: true });
      const view = await renderModal(claudeItem, client, {
        ...saved,
        settings: { authMode: 'cli', mcpAccess: 'off' },
      });
      expect(
        (view.getByLabelText('Ferramentas do ADK para a CLI') as HTMLSelectElement).value,
      ).toBe('off');
    });

    it('say when the server cannot offer them', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue({ ...installed, mcp: false });
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      expect(view.getByText(/não têm ADK_MCP_URL|não tem ADK_MCP_URL/)).toBeInTheDocument();
    });
  });

  describe('accounts of the CLI', () => {
    const local: LlmCliAvailability = { ...installed, transport: 'local' };
    const work = {
      name: 'work',
      loginCommand: 'cmd /c "set CLAUDE_CONFIG_DIR=C:\\p&& claude /login"',
    };

    it('are picked from a list, with the default login first, and saved by name', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
      vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work]);
      const save = vi.spyOn(client, 'saveIntegration').mockResolvedValue({
        id: 'x',
        category: 'LLM',
        providerId: 'claude',
        isEnabled: true,
        settings: {},
        hasSecret: false,
        maskedSecret: null,
        updatedAt: '2026-01-01T00:00:00Z',
      });
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));

      const select = await view.findByLabelText('Conta da CLI');
      expect((select as HTMLSelectElement).value).toBe('');
      expect(view.queryByRole('textbox', { name: /pasta|folder/i })).toBeNull();
      await waitFor(() => expect(view.getByRole('option', { name: 'work' })).toBeInTheDocument());

      // Only the accounts the person created are listed: "new account" is a button, not an option.
      expect(view.queryByRole('option', { name: /Nova conta/ })).toBeNull();
      expect(view.getByRole('button', { name: 'Nova conta' })).toBeInTheDocument();

      fireEvent.change(select, { target: { value: 'work' } });
      // The sign-in command stays hidden until the link is clicked.
      expect(view.queryByText(work.loginCommand)).toBeNull();
      fireEvent.click(view.getByRole('button', { name: 'Mostrar comando de login' }));
      expect(view.getByText(work.loginCommand)).toBeInTheDocument();
      fireEvent.click(view.getByRole('button', { name: 'Ocultar comando de login' }));
      expect(view.queryByText(work.loginCommand)).toBeNull();

      // Picking another account closes the command again.
      fireEvent.click(view.getByRole('button', { name: 'Mostrar comando de login' }));
      fireEvent.change(select, { target: { value: '' } });
      expect(view.queryByText(work.loginCommand)).toBeNull();
      fireEvent.change(select, { target: { value: 'work' } });
      expect(view.queryByText(work.loginCommand)).toBeNull();

      fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(save.mock.calls[0]![2].settings).toMatchObject({
        authMode: 'cli',
        cliProfile: 'work',
      });
    });

    it('creates an account from a name, validates it first, and selects it', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
      vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([]);
      const create = vi.spyOn(client, 'createLlmCliProfile').mockResolvedValue(work);
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));

      await view.findByLabelText('Conta da CLI');
      fireEvent.click(view.getByRole('button', { name: 'Nova conta' }));
      const name = view.getByRole('textbox', { name: /Nome da conta/ });
      fireEvent.change(name, { target: { value: '../x' } });
      fireEvent.click(view.getByRole('button', { name: 'Criar' }));
      expect(await view.findByRole('alert')).toHaveTextContent(/letras, números/);
      expect(create).not.toHaveBeenCalled();

      fireEvent.change(name, { target: { value: 'work' } });
      fireEvent.click(view.getByRole('button', { name: 'Criar' }));
      await waitFor(() => expect(create).toHaveBeenCalledWith('claude', 'work'));
      expect(((await view.findByLabelText('Conta da CLI')) as HTMLSelectElement).value).toBe(
        'work',
      );
      // A new account is signed in once, so its command is shown right after it is created.
      expect(view.getByText(work.loginCommand)).toBeInTheDocument();
    });

    it('deletes the selected account after a confirmation and falls back to the default login', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
      vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work]);
      const remove = vi.spyOn(client, 'deleteLlmCliProfile').mockResolvedValue(undefined);
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      const select = (await view.findByLabelText('Conta da CLI')) as HTMLSelectElement;

      // Nothing to delete while the default login is selected.
      expect(view.queryByRole('button', { name: 'Excluir conta' })).toBeNull();
      await waitFor(() => expect(view.getByRole('option', { name: 'work' })).toBeInTheDocument());
      fireEvent.change(select, { target: { value: 'work' } });

      // Cancelling leaves the account alone.
      fireEvent.click(view.getByRole('button', { name: 'Excluir conta' }));
      fireEvent.click(
        within(view.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }),
      );
      expect(remove).not.toHaveBeenCalled();
      expect(view.queryByRole('alertdialog')).toBeNull();

      fireEvent.click(view.getByRole('button', { name: 'Excluir conta' }));
      fireEvent.click(
        within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir conta' }),
      );
      await waitFor(() => expect(remove).toHaveBeenCalledWith('claude', 'work'));
      await waitFor(() => expect(view.queryByRole('option', { name: 'work' })).toBeNull());
      expect(select.value).toBe('');
      expect(view.queryByRole('button', { name: 'Excluir conta' })).toBeNull();
    });

    it('keeps the account and says so when it cannot be deleted', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
      vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work]);
      vi.spyOn(client, 'deleteLlmCliProfile').mockRejectedValueOnce(new Error('Disk is busy'));
      vi.spyOn(client, 'deleteLlmCliProfile').mockRejectedValueOnce('nope');
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      const select = (await view.findByLabelText('Conta da CLI')) as HTMLSelectElement;
      await waitFor(() => expect(view.getByRole('option', { name: 'work' })).toBeInTheDocument());
      fireEvent.change(select, { target: { value: 'work' } });

      for (const message of ['Disk is busy', /Não foi possível excluir/]) {
        fireEvent.click(view.getByRole('button', { name: 'Excluir conta' }));
        fireEvent.click(
          within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir conta' }),
        );
        expect(await view.findByRole('alert')).toHaveTextContent(message);
        expect(select.value).toBe('work');
      }
    });

    it('can cancel the creation of an account', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue(local);
      vi.spyOn(client, 'getLlmCliProfiles').mockResolvedValue([work]);
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      await view.findByLabelText('Conta da CLI');

      fireEvent.click(view.getByRole('button', { name: 'Nova conta' }));
      expect((view.getByRole('button', { name: 'Nova conta' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
      expect(view.queryByRole('textbox', { name: /Nome da conta/ })).toBeNull();
      expect((view.getByRole('button', { name: 'Nova conta' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it('are not offered when the CLI runs in the Bridge, or for Gemini', async () => {
      const client = new ApiClient();
      vi.spyOn(client, 'getLlmClis').mockResolvedValue({ ...installed, transport: 'bridge' });
      const list = vi.spyOn(client, 'getLlmCliProfiles');
      const view = await renderModal(claudeItem, client);
      fireEvent.click(view.getByRole('radio', { name: /CLI de IA/ }));
      expect(view.queryByLabelText('Conta da CLI')).toBeNull();
      expect(list).not.toHaveBeenCalled();
    });
  });

  it('does not offer a CLI for providers without one', async () => {
    const client = new ApiClient();
    const status = vi.spyOn(client, 'getLlmClis');
    const view = await renderModal(ollamaItem, client);
    expect(view.queryByRole('radio', { name: /CLI de IA/ })).not.toBeInTheDocument();
    expect(status).not.toHaveBeenCalled();
  });
});

describe('ApiClient chat streaming', () => {
  function sseResponse(chunks: string[], init: { ok?: boolean; status?: number } = {}): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return { ok: init.ok ?? true, status: init.status ?? 200, body } as Response;
  }

  function handlers() {
    const seen = {
      start: undefined as unknown,
      deltas: [] as string[],
      done: undefined as unknown,
    };
    const errors: Error[] = [];
    const fns: AgentChatHandlers = {
      onStart: (start) => (seen.start = start),
      onDelta: (text) => seen.deltas.push(text),
      onDone: (done) => (seen.done = done),
      onError: (error) => errors.push(error),
    };
    return { seen, errors, fns };
  }

  const event = (name: string, data: unknown) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

  it('delivers deltas as they arrive, even when an event is split across network chunks', async () => {
    const full = event('delta', { text: 'Olá, ' });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          event('start', { provider: 'Claude CLI', agent: { id: 'a', name: 'QA', role: 'QA' } }),
          full.slice(0, 12),
          full.slice(12),
          ': keep-alive\n\n',
          event('delta', { text: 'mundo' }),
          event('done', { result: 'Olá, mundo', provider: 'Claude CLI' }),
        ]),
      );
    const client = new ApiClient({ fetcher });
    const { seen, errors, fns } = handlers();

    await client.streamAgentChat('agent 1', { prompt: 'oi', history: [] }, fns);

    expect(String(fetcher.mock.calls[0]![0])).toBe('http://localhost:3000/agents/agent%201/chat');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toEqual({
      prompt: 'oi',
      history: [],
    });
    expect(seen.start).toMatchObject({ provider: 'Claude CLI' });
    expect(seen.deltas).toEqual(['Olá, ', 'mundo']);
    expect(seen.done).toMatchObject({ result: 'Olá, mundo' });
    expect(errors).toEqual([]);
  });

  it('reports an error event from the server', async () => {
    const client = new ApiClient({
      fetcher: vi
        .fn()
        .mockResolvedValue(
          sseResponse([event('error', { code: 'LLM_CLI_NOT_INSTALLED', message: 'CLI missing' })]),
        ),
    });
    const { errors, fns, seen } = handlers();
    await client.streamAgentChat('a', { prompt: 'oi' }, fns);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('CLI missing');
    expect(seen.done).toBeUndefined();
  });

  it('reports a stream that closes before the answer is complete', async () => {
    const client = new ApiClient({
      fetcher: vi.fn().mockResolvedValue(sseResponse([event('delta', { text: 'Olá' })])),
    });
    const { errors, fns } = handlers();
    await client.streamAgentChat('a', { prompt: 'oi' }, fns);
    expect(errors).toHaveLength(1);
  });

  it('does not report an aborted stream as a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new ApiClient({
      fetcher: vi.fn().mockResolvedValue(sseResponse([])),
    });
    const { errors, fns } = handlers();
    await client.streamAgentChat('a', { prompt: 'oi' }, fns, controller.signal);
    expect(errors).toEqual([]);
  });

  it('rejects with the API error when the chat cannot start', async () => {
    const client = new ApiClient({
      fetcher: vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ code: 'AGENT_NOT_FOUND', message: 'Agent not found.' }),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response),
    });
    const { fns } = handlers();
    await expect(client.streamAgentChat('a', { prompt: 'oi' }, fns)).rejects.toThrow();
  });

  it('skips malformed events and falls back to default texts for incomplete ones', async () => {
    const client = new ApiClient({
      fetcher: vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: delta\ndata: {not json\n\n',
            event('start', { provider: 'p', agent: { id: 'a', name: 'QA', role: 'QA' } }),
            event('delta', {}),
            event('error', {}),
          ]),
        ),
    });
    const deltas: string[] = [];
    const errors: Error[] = [];
    // No onStart handler on purpose: a caller may only care about the text.
    await client.streamAgentChat(
      'a',
      { prompt: 'oi' },
      {
        onDelta: (text) => deltas.push(text),
        onDone: () => undefined,
        onError: (e) => errors.push(e),
      },
    );
    expect(deltas).toEqual(['']);
    expect(errors.map((error) => error.message)).toEqual(['The agent failed.']);
  });

  it('fails when the response has no body', async () => {
    const client = new ApiClient({
      fetcher: vi.fn().mockResolvedValue({ ok: true, status: 200, body: null } as Response),
    });
    const { fns } = handlers();
    await expect(client.streamAgentChat('a', { prompt: 'oi' }, fns)).rejects.toThrow();
  });

  it('rejects when the CLI status request fails', async () => {
    const client = new ApiClient({
      fetcher: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ code: 'FORBIDDEN', message: 'No access.' }),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response),
    });
    await expect(client.getLlmClis()).rejects.toThrow();
  });

  it('deletes an account of a CLI by name, and reports a refusal', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'LLM_CLI_PROFILE_INVALID', message: 'Invalid name' } }),
      } as Response);
    const client = new ApiClient({ fetcher });

    await client.deleteLlmCliProfile('claude', 'my work');
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'http://localhost:3000/integrations/llm/claude/profiles/my%20work',
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });

    await expect(client.deleteLlmCliProfile('claude', '..')).rejects.toThrow();
  });

  it('asks which provider CLIs the server can use', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => installed } as Response);
    const client = new ApiClient({ fetcher });
    expect(await client.getLlmClis()).toEqual(installed);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://localhost:3000/integrations/llm/clis');
  });
});
