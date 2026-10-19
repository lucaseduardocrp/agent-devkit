import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignView } from '../src/features/design/DesignView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { DesignProjectDto } from '../src/lib/api-client.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const PROJECT: DesignProjectDto = {
  id: 'landing-123',
  provider: 'github',
  title: 'Landing',
  agentId: AGENT_ID,
  updatedAt: '2026-09-17T10:00:00.000Z',
  files: [
    { name: 'index.html', language: 'html', content: '<html><body>Olá</body></html>' },
    { name: 'styles.css', language: 'css', content: 'body { color: red; }' },
  ],
  messages: [
    { role: 'assistant', content: 'Protótipo criado.', createdAt: '2026-09-17T10:00:00.000Z' },
  ],
};

function agent() {
  return {
    id: AGENT_ID,
    workspaceId: 'ws',
    name: 'Designer',
    slug: 'designer',
    description: '',
    instructions: '',
    role: 'CUSTOM' as const,
    model: '',
    temperature: 0.2,
    isSystem: false,
    createdAt: '',
    updatedAt: '',
  };
}

function client(options: { projects?: readonly DesignProjectDto[] } = {}) {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignProviders').mockResolvedValue(['github']);
  vi.spyOn(api, 'getDesignProjects').mockResolvedValue([...(options.projects ?? [PROJECT])]);
  vi.spyOn(api, 'getDesignSystems').mockResolvedValue([]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([agent()]);
  return api;
}

function view(api: ApiClient, isReadOnly = false) {
  return render(<DesignView apiClient={api} activeWorkspaceId="ws" isReadOnly={isReadOnly} />);
}

afterEach(() => vi.restoreAllMocks());

describe('DesignView loading', () => {
  it('reports a provider whose project listing failed', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProjects').mockRejectedValue(new Error('The token expired.'));
    const ui = view(api);

    expect(await ui.findByText('The token expired.')).toBeInTheDocument();
  });

  it('renders the empty project list when the workspace has none', async () => {
    const ui = view(client({ projects: [] }));
    expect(await ui.findByText('Nenhum protótipo criado.')).toBeInTheDocument();
  });

  it('keeps the design systems empty when they cannot be loaded', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignSystems').mockRejectedValue(new Error('offline'));
    const ui = view(api);

    await ui.findByText('Landing');
    fireEvent.click(ui.getByRole('button', { name: /Design Systems/ }));
    expect(ui.getByRole('button', { name: 'Novo template' })).toBeInTheDocument();
  });
});

describe('DesignView prototype creation', () => {
  function fill(ui: ReturnType<typeof view>) {
    fireEvent.change(ui.getByLabelText('Nome do projeto'), { target: { value: ' Landing ' } });
    fireEvent.change(ui.getByLabelText('Descreva o protótipo'), {
      target: { value: ' A hero section ' },
    });
  }

  it('keeps the action disabled until the name and the prompt are filled', async () => {
    const ui = view(client());
    await ui.findByText('Landing');
    const create = () => ui.getByRole('button', { name: /Criar com agente/ }) as HTMLButtonElement;

    expect(create().disabled).toBe(true);
    fireEvent.change(ui.getByLabelText('Nome do projeto'), { target: { value: 'Landing' } });
    expect(create().disabled).toBe(true);
    fireEvent.change(ui.getByLabelText('Descreva o protótipo'), { target: { value: 'A hero' } });
    expect(create().disabled).toBe(false);
  });

  it('creates a prototype with the trimmed name and prompt', async () => {
    const api = client();
    const create = vi.spyOn(api, 'createDesignProject').mockResolvedValue(PROJECT);
    const ui = view(api);

    await ui.findByText('Landing');
    fill(ui);
    fireEvent.click(ui.getByRole('button', { name: /Criar com agente/ }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Landing',
          prompt: 'A hero section',
          provider: 'github',
          agentId: AGENT_ID,
        }),
      ),
    );
    expect((await ui.findAllByText('Protótipo criado.')).length).toBeGreaterThan(0);
  });

  it('reports a failed creation', async () => {
    const api = client();
    vi.spyOn(api, 'createDesignProject').mockRejectedValue(new Error('The agent is unavailable.'));
    const ui = view(api);

    await ui.findByText('Landing');
    fill(ui);
    fireEvent.click(ui.getByRole('button', { name: /Criar com agente/ }));

    expect(await ui.findByText('The agent is unavailable.')).toBeInTheDocument();
  });

  it('withholds creation from a read-only member', async () => {
    const ui = view(client(), true);
    await ui.findByText('Landing');

    expect(ui.queryByLabelText('Nome do projeto')).toBeNull();
    expect(ui.queryByRole('button', { name: /Criar com agente/ })).toBeNull();
    expect(ui.queryByRole('button', { name: /Novo protótipo/ })).toBeNull();
  });
});

describe('DesignView chat and code', () => {
  async function opened(api: ApiClient) {
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    return ui;
  }

  it('sends a chat message and clears the box', async () => {
    const api = client();
    const chat = vi.spyOn(api, 'chatDesignProject').mockResolvedValue(PROJECT);
    const ui = await opened(api);

    fireEvent.change(ui.getByLabelText('Mensagem para o agente'), {
      target: { value: ' Make it blue ' },
    });
    fireEvent.click(ui.getByRole('button', { name: /Enviar/ }));

    await waitFor(() =>
      expect(chat).toHaveBeenCalledWith('landing-123', 'Make it blue', 'github', AGENT_ID, []),
    );
    await waitFor(() =>
      expect((ui.getByLabelText('Mensagem para o agente') as HTMLTextAreaElement).value).toBe(''),
    );
  });

  it('reports a failed chat', async () => {
    const api = client();
    vi.spyOn(api, 'chatDesignProject').mockRejectedValue(new Error('The model timed out.'));
    const ui = await opened(api);

    fireEvent.change(ui.getByLabelText('Mensagem para o agente'), { target: { value: 'Blue' } });
    fireEvent.click(ui.getByRole('button', { name: /Enviar/ }));

    expect(await ui.findByText('The model timed out.')).toBeInTheDocument();
  });

  it('keeps send disabled without a message or an image', async () => {
    const ui = await opened(client());
    expect((ui.getByRole('button', { name: /Enviar/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits a file and pushes the code', async () => {
    const api = client();
    const push = vi.spyOn(api, 'updateDesignFiles').mockResolvedValue(PROJECT);
    const ui = await opened(api);

    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.change(ui.getByLabelText('Código de index.html'), {
      target: { value: '<html>edited</html>' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Push' }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        'landing-123',
        expect.arrayContaining([
          expect.objectContaining({ name: 'index.html', content: '<html>edited</html>' }),
        ]),
        'github',
      ),
    );
    expect(await ui.findByText('Código salvo.')).toBeInTheDocument();
  });

  it('reports a failed push', async () => {
    const api = client();
    vi.spyOn(api, 'updateDesignFiles').mockRejectedValue(new Error('The branch is protected.'));
    const ui = await opened(api);

    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'Push' }));

    expect(await ui.findByText('The branch is protected.')).toBeInTheDocument();
  });

  it('switches between the project files', async () => {
    const ui = await opened(client());

    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'styles.css' }));

    expect(ui.getByLabelText('Código de styles.css')).toBeInTheDocument();
  });

  it('downloads the open file and the whole prototype', async () => {
    const createUrl = vi.fn(() => 'blob:file');
    const revokeUrl = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, {
        createObjectURL: createUrl,
        revokeObjectURL: revokeUrl,
      }),
    );
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const ui = await opened(client());

      fireEvent.click(ui.getByRole('button', { name: /Exportar/ }));
      expect(anchorClick).toHaveBeenCalledTimes(1);

      fireEvent.click(
        within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
          name: 'Código',
        }),
      );
      fireEvent.click(ui.getByRole('button', { name: 'Baixar arquivo' }));
      expect(anchorClick).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the preview in a new window and revokes the url when it is blocked', async () => {
    const createUrl = vi.fn(() => 'blob:preview');
    const revokeUrl = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, {
        createObjectURL: createUrl,
        revokeObjectURL: revokeUrl,
      }),
    );
    const open = vi.fn().mockReturnValue(null);
    vi.stubGlobal('open', open);
    try {
      const ui = await opened(client());
      fireEvent.click(ui.getByRole('button', { name: 'Abrir preview em nova página' }));

      expect(open).toHaveBeenCalledOnce();
      expect(revokeUrl).toHaveBeenCalledWith('blob:preview');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('DesignView non-Error failures', () => {
  async function opened(api: ApiClient) {
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    return ui;
  }

  it('falls back to the generic message when creation rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'createDesignProject').mockRejectedValue('boom');
    const ui = view(api);

    await ui.findByText('Landing');
    fireEvent.change(ui.getByLabelText('Nome do projeto'), { target: { value: 'Landing' } });
    fireEvent.change(ui.getByLabelText('Descreva o protótipo'), { target: { value: 'A hero' } });
    fireEvent.click(ui.getByRole('button', { name: /Criar com agente/ }));

    expect(await ui.findByText('Falha ao criar protótipo.')).toBeInTheDocument();
  });

  it('falls back to the generic message when the chat rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'chatDesignProject').mockRejectedValue('boom');
    const ui = await opened(api);

    fireEvent.change(ui.getByLabelText('Mensagem para o agente'), { target: { value: 'Blue' } });
    fireEvent.click(ui.getByRole('button', { name: /Enviar/ }));

    expect(await ui.findByText('Falha ao atualizar protótipo.')).toBeInTheDocument();
  });

  it('falls back to the generic message when the push rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'updateDesignFiles').mockRejectedValue('boom');
    const ui = await opened(api);

    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'Push' }));

    expect(await ui.findByText('Falha ao salvar código.')).toBeInTheDocument();
  });

  it('falls back to the generic message when the pull rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProject').mockRejectedValue('boom');
    const ui = await opened(api);

    fireEvent.click(ui.getByRole('button', { name: 'Pull' }));

    expect(await ui.findByText('Falha ao fazer pull.')).toBeInTheDocument();
  });

  it('falls back to the generic message when loading the projects rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProjects').mockRejectedValue('boom');
    const ui = view(api);

    expect(await ui.findByText('Falha ao carregar protótipos.')).toBeInTheDocument();
  });
});

describe('DesignView system generation', () => {
  async function onSystems(api: ApiClient) {
    const ui = view(api);
    await ui.findByText('Landing');
    fireEvent.click(ui.getByRole('button', { name: /Design Systems/ }));
    return ui;
  }

  it('generates and saves a template from a description', async () => {
    const api = client();
    const generate = vi
      .spyOn(api, 'generateDesignSystem')
      .mockResolvedValue({ content: '<html>tokens</html>' });
    const save = vi.spyOn(api, 'saveDesignSystem').mockResolvedValue({
      id: 'system-1',
      name: 'A calm palette',
      content: '<html>tokens</html>',
      updatedAt: '2026-09-17T10:00:00.000Z',
    });
    const ui = await onSystems(api);

    fireEvent.change(ui.getByLabelText('Descrição do Design System'), {
      target: { value: 'A calm palette' },
    });
    fireEvent.click(ui.getByRole('button', { name: /Gerar HTML com agente/ }));

    await waitFor(() => expect(generate).toHaveBeenCalled());
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(await ui.findByText('Template HTML gerado e salvo no repositório.')).toBeInTheDocument();
  });

  it('reports a generation that rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'generateDesignSystem').mockRejectedValue('boom');
    const ui = await onSystems(api);

    fireEvent.change(ui.getByLabelText('Descrição do Design System'), {
      target: { value: 'A calm palette' },
    });
    fireEvent.click(ui.getByRole('button', { name: /Gerar HTML com agente/ }));

    expect(await ui.findByText('Falha ao gerar Design System.')).toBeInTheDocument();
  });

  it('reports a template save that rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'saveDesignSystem').mockRejectedValue('boom');
    const ui = await onSystems(api);

    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo do Design System' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.change(ui.getByLabelText('Nome do Design System'), { target: { value: 'Core' } });
    fireEvent.change(ui.getByLabelText('HTML do Design System'), { target: { value: '<html>' } });
    fireEvent.click(ui.getByRole('button', { name: 'Salvar template' }));

    expect(await ui.findByText('Falha ao salvar Design System.')).toBeInTheDocument();
  });
});

describe('DesignView loading edge cases', () => {
  it('handles a workspace with no connected provider', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProviders').mockResolvedValue([]);
    const getSystems = vi.spyOn(api, 'getDesignSystems');
    const ui = view(api);

    expect(await ui.findByText('Nenhum protótipo criado.')).toBeInTheDocument();
    expect(getSystems).not.toHaveBeenCalled();
  });

  it('handles a workspace with no agent', async () => {
    const api = client();
    vi.spyOn(api, 'getAgents').mockResolvedValue([]);
    const ui = view(api);

    await ui.findByText('Landing');
    fireEvent.change(ui.getByLabelText('Nome do projeto'), { target: { value: 'Landing' } });
    fireEvent.change(ui.getByLabelText('Descreva o protótipo'), { target: { value: 'A hero' } });
    expect(
      (ui.getByRole('button', { name: /Criar com agente/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reports a provider listing that fails outright', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProviders').mockRejectedValue('boom');
    const ui = view(api);

    expect(await ui.findByText('Falha ao carregar Design.')).toBeInTheDocument();
  });

  it('opens a prototype whose agent is no longer available', async () => {
    const api = client({
      projects: [{ ...PROJECT, agentId: 'removed-agent', files: [] }],
    });
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));

    expect(ui.getByRole('heading', { level: 1, name: 'Landing' })).toBeInTheDocument();
  });

  it('keeps the selected file when a refreshed prototype still contains it', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProject').mockResolvedValue(PROJECT);
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'styles.css' }));
    fireEvent.click(ui.getByRole('button', { name: 'Pull' }));

    await waitFor(() => expect(ui.getByLabelText('Código de styles.css')).toBeInTheDocument());
  });

  it('falls back to the first file when the refreshed prototype dropped the open one', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProject').mockResolvedValue({
      ...PROJECT,
      files: [{ name: 'app.tsx', language: 'tsx', content: 'export {}' }],
    });
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'Pull' }));

    await waitFor(() => expect(ui.getByLabelText('Código de app.tsx')).toBeInTheDocument());
  });
});
