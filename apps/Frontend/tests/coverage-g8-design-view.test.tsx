import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignView } from '../src/features/design/DesignView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { DesignProjectDto, DesignSystemDto } from '../src/lib/api-client.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

function project(overrides: Partial<DesignProjectDto> = {}): DesignProjectDto {
  return {
    id: 'landing-123',
    provider: 'github',
    title: 'Landing',
    agentId: AGENT_ID,
    updatedAt: '2026-09-17T10:00:00.000Z',
    files: [{ name: 'index.html', language: 'html', content: '<html><body>Olá</body></html>' }],
    messages: [
      { role: 'assistant', content: 'Protótipo criado.', createdAt: '2026-09-17T10:00:00.000Z' },
    ],
    ...overrides,
  };
}

function agent(id: string, name: string) {
  return {
    id,
    workspaceId: 'ws',
    name,
    slug: name.toLowerCase(),
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

const CORE: DesignSystemDto = {
  id: 'system-1',
  name: 'Core',
  content: '<p>x</p>',
  updatedAt: '2026-09-17T10:00:00Z',
};

function client(
  options: {
    projects?: readonly DesignProjectDto[];
    systems?: readonly DesignSystemDto[];
    agents?: ReturnType<typeof agent>[];
  } = {},
) {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignProviders').mockResolvedValue(['github']);
  vi.spyOn(api, 'getDesignProjects').mockResolvedValue([...(options.projects ?? [project()])]);
  vi.spyOn(api, 'getDesignSystems').mockResolvedValue([...(options.systems ?? [])]);
  vi.spyOn(api, 'getAgents').mockResolvedValue(
    options.agents ?? [agent(AGENT_ID, 'Designer'), agent(OTHER_AGENT_ID, 'Reviewer')],
  );
  vi.spyOn(api, 'getDesignRepositories').mockResolvedValue({ repositories: [], warnings: [] });
  vi.spyOn(api, 'getDesignSettings').mockResolvedValue(null);
  return api;
}

function view(api: ApiClient) {
  return render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
}

function imageFile(name = 'shot.png', type = 'image/png'): File {
  return new File(['x'], name, { type });
}

function srcdoc(ui: ReturnType<typeof render>): string {
  return ui.container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
}

function codeMode(ui: ReturnType<typeof render>) {
  fireEvent.click(
    within(ui.getByRole('group', { name: 'Modo de visualização' })).getByRole('button', {
      name: 'Código',
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DesignView preview document', () => {
  it('inlines the stylesheets and scripts of the project that the page references', async () => {
    const html = [
      '<html><head>',
      '<link rel="stylesheet" href="./css/site.css?v=1">',
      '<link rel="stylesheet" href="other/theme.css">',
      '<link rel="stylesheet" href="https://cdn.example.com/lib.css">',
      '<link rel="stylesheet" href="missing.css">',
      '<link rel="stylesheet">',
      '</head><body>',
      '<script src="js/app.js"></script>',
      '<script defer src="folder/util.js#top"></script>',
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<script src="gone.js"></script>',
      '</body></html>',
    ].join('');
    const api = client({
      projects: [
        project({
          files: [
            { name: 'index.html', language: 'html', content: html },
            { name: 'assets/css/site.css', language: 'css', content: '.site{}' },
            { name: 'styles/theme.css', language: 'css', content: '.theme{}' },
            { name: 'extra.css', language: 'css', content: '.extra{}' },
            { name: 'src/js/app.js', language: 'js', content: 'window.app=1;' },
            { name: 'lib/util.js', language: 'js', content: 'window.util=1;' },
            { name: 'loose.js', language: 'js', content: 'window.loose=1;' },
          ],
        }),
      ],
    });
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));

    const doc = srcdoc(ui);
    expect(doc).toContain('<style>\n.site{}\n</style>');
    expect(doc).toContain('<style>\n.theme{}\n</style>');
    expect(doc).toContain('https://cdn.example.com/lib.css');
    expect(doc).not.toContain('missing.css');
    expect(doc).toContain('<script>\nwindow.app=1;\n</script>');
    expect(doc).toContain('<script defer>\nwindow.util=1;\n</script>');
    expect(doc).toContain('<script src="https://cdn.example.com/lib.js"></script>');
    expect(doc).toContain('<script src="gone.js"></script>');
    // Files the page does not reference are still added, once.
    expect(doc).toContain('.extra{}');
    expect(doc).toContain('window.loose=1;');
    expect(doc.match(/window\.app=1;/g)).toHaveLength(1);
  });
});

describe('DesignView loading', () => {
  it('ignores a systems answer that arrives after the view is gone', async () => {
    const api = client();
    let resolve!: (value: DesignSystemDto[]) => void;
    vi.spyOn(api, 'getDesignSystems').mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    const ui = view(api);
    await waitFor(() => expect(api.getDesignSystems).toHaveBeenCalled());
    ui.unmount();
    await act(async () => {
      resolve([]);
      await Promise.resolve();
    });
  });

  it('falls back to the generic message when listing fails without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProjects').mockRejectedValue('boom');
    const ui = view(api);
    expect(await ui.findByText('Falha ao carregar protótipos.')).toBeInTheDocument();
  });

  it('falls back to the loading message when the providers fail without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProviders').mockRejectedValue('boom');
    const ui = view(api);
    expect(await ui.findByText('Falha ao carregar Design.')).toBeInTheDocument();
  });

  it('dismisses a toast', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProviders').mockRejectedValue(new Error('Sem conexão.'));
    const ui = view(api);
    await ui.findByText('Sem conexão.');
    fireEvent.click(ui.getByRole('button', { name: 'Fechar notificação' }));
    await waitFor(() => expect(ui.queryByText('Sem conexão.')).toBeNull());
  });
});

describe('DesignView opening and updating projects', () => {
  it('selects no agent when the agents are gone', async () => {
    const ui = view(client({ agents: [] }));
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    expect(ui.getByRole('combobox', { name: 'Agente' })).toBeTruthy();
    expect((ui.getByRole('combobox', { name: 'Agente' }) as HTMLSelectElement).value).toBe('');
  });

  it('opens a project with the agent that created it and lets the member change it', async () => {
    const api = client({ projects: [project({ agentId: OTHER_AGENT_ID })] });
    const chat = vi.spyOn(api, 'chatDesignProject').mockResolvedValue(project());
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    const select = ui.getByLabelText('Agente') as HTMLSelectElement;
    expect(select.value).toBe(OTHER_AGENT_ID);

    fireEvent.change(select, { target: { value: AGENT_ID } });
    fireEvent.change(ui.getByLabelText('Mensagem para o agente'), { target: { value: 'Blue' } });
    fireEvent.click(ui.getByRole('button', { name: /Enviar/ }));
    await waitFor(() =>
      expect(chat).toHaveBeenCalledWith('landing-123', 'Blue', 'github', AGENT_ID, []),
    );
  });

  it('shows the first file when the pulled project drops the open one', async () => {
    const api = client({
      projects: [
        project({
          files: [
            { name: 'index.html', language: 'html', content: '<p>a</p>' },
            { name: 'extra.css', language: 'css', content: 'b{}' },
          ],
        }),
      ],
    });
    vi.spyOn(api, 'getDesignProject').mockResolvedValue(
      project({ files: [{ name: 'home.html', language: 'html', content: '<p>home</p>' }] }),
    );
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    codeMode(ui);
    fireEvent.click(ui.getByRole('button', { name: 'extra.css' }));
    fireEvent.click(ui.getByRole('button', { name: /Pull/ }));
    expect(await ui.findByLabelText('Código de home.html')).toBeInTheDocument();
  });

  it('keeps working on a pulled project without files', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProject').mockResolvedValue(project({ files: [] }));
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    fireEvent.click(ui.getByRole('button', { name: /Pull/ }));
    expect(await ui.findByText('Versão do repositório carregada.')).toBeInTheDocument();
    expect(ui.getByText('0 arquivos')).toBeInTheDocument();
  });
});

describe('DesignView code editor without files', () => {
  it('shows an empty editor and downloads nothing for a project without files', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    const ui = view(client({ projects: [project({ files: [] })] }));
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    codeMode(ui);
    const editor = ui.getByLabelText('Código de') as HTMLTextAreaElement;
    expect(editor.value).toBe('');
    fireEvent.change(editor, { target: { value: '<p>x</p>' } });
    fireEvent.click(ui.getByRole('button', { name: 'Baixar arquivo' }));
    expect(createUrl).not.toHaveBeenCalled();
  });
});

describe('DesignView messages and images', () => {
  it('shows the images sent along with a message', async () => {
    const api = client({
      projects: [
        project({
          messages: [
            {
              role: 'user',
              content: 'Like this',
              createdAt: '2026-09-17T10:00:00.000Z',
              images: [{ mimeType: 'image/png', data: 'AAAA' }],
            },
          ],
        }),
      ],
    });
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    const image = ui.getByAltText('Imagem enviada ao agente') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('ignores a file selection without files', async () => {
    const ui = view(client());
    await ui.findByText('Landing');
    const input = ui.container.querySelector('#design-prototype-images') as HTMLInputElement;
    fireEvent.change(input, { target: { files: null } });
    expect(ui.queryByTestId('design-prototype-images-previews')).toBeNull();

    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    const chatInput = ui.container.querySelector('#design-chat-images') as HTMLInputElement;
    fireEvent.change(chatInput, { target: { files: null } });
    expect(ui.queryByLabelText('Imagens anexadas')).toBeNull();
  });

  it('sends only the images when the message is empty', async () => {
    const api = client();
    const chat = vi.spyOn(api, 'chatDesignProject').mockResolvedValue(project());
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    const chatInput = ui.container.querySelector('#design-chat-images') as HTMLInputElement;
    fireEvent.change(chatInput, { target: { files: [imageFile('chat.png')] } });
    await ui.findByAltText('chat.png');
    fireEvent.click(ui.getByRole('button', { name: /Enviar/ }));
    await waitFor(() =>
      expect(chat).toHaveBeenCalledWith(
        'landing-123',
        'Analise as imagens anexadas e atualize o design.',
        'github',
        AGENT_ID,
        [expect.objectContaining({ mimeType: 'image/png' })],
      ),
    );
  });

  describe('unreadable images', () => {
    /** The view reads images without a catch, so the rejection surfaces as unhandled. */
    async function withUnreadableImage(reader: new () => unknown) {
      const seen: unknown[] = [];
      const previous = process.listeners('unhandledRejection');
      process.removeAllListeners('unhandledRejection');
      process.on('unhandledRejection', (reason) => seen.push(reason));
      vi.stubGlobal('FileReader', reader);
      try {
        const ui = view(client());
        await ui.findByText('Landing');
        fireEvent.change(
          ui.container.querySelector('#design-prototype-images') as HTMLInputElement,
          { target: { files: [imageFile()] } },
        );
        await waitFor(() => expect(seen).toHaveLength(1));
        expect(ui.queryByTestId('design-prototype-images-previews')).toBeNull();
        return seen[0];
      } finally {
        process.removeAllListeners('unhandledRejection');
        for (const listener of previous) process.on('unhandledRejection', listener);
      }
    }

    it('rejects with the error of the reader', async () => {
      const failure = new Error('disk gone');
      class FailingReader {
        error: Error | null = failure;
        onerror: (() => void) | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          queueMicrotask(() => this.onerror?.());
        }
      }
      expect(await withUnreadableImage(FailingReader)).toBe(failure);
    });

    it('rejects with a generic error when the reader gives none', async () => {
      class SilentReader {
        error: Error | null = null;
        onerror: (() => void) | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          queueMicrotask(() => this.onerror?.());
        }
      }
      expect(await withUnreadableImage(SilentReader)).toEqual(
        new Error('Não foi possível ler a imagem.'),
      );
    });

    it('rejects a result that is not text', async () => {
      class BinaryReader {
        result: ArrayBuffer = new ArrayBuffer(1);
        error: Error | null = null;
        onerror: (() => void) | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          queueMicrotask(() => this.onload?.());
        }
      }
      expect(await withUnreadableImage(BinaryReader)).toEqual(
        new Error('Não foi possível ler a imagem.'),
      );
    });
  });
});

describe('DesignView repository settings', () => {
  it('reloads the projects after the repository is saved', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignRepositories').mockResolvedValue({
      repositories: [{ id: '42', provider: 'azure', name: 'acme/protos', defaultBranch: 'main' }],
      warnings: [],
    });
    vi.spyOn(api, 'getDesignBranches').mockResolvedValue([{ name: 'main', isDefault: true }]);
    vi.spyOn(api, 'saveDesignSettings').mockResolvedValue({
      provider: 'azure',
      repositoryId: '42',
      repositoryName: 'acme/protos',
      branch: 'main',
    });
    const ui = view(api);
    await ui.findByText('Landing');
    await waitFor(() =>
      expect(ui.getByLabelText('Repositório').querySelectorAll('option').length).toBe(2),
    );
    fireEvent.change(ui.getByLabelText('Repositório'), { target: { value: 'azure:42' } });
    await waitFor(() =>
      expect((ui.getByLabelText('Branch') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.click(ui.getByRole('button', { name: /Salvar repositório/ }));
    await waitFor(() => expect(api.getDesignProviders).toHaveBeenCalledTimes(2));
  });

  it('reports a repository error as a toast', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignRepositories').mockRejectedValue(new Error('No access.'));
    const ui = view(api);
    expect(await ui.findByText('No access.')).toBeInTheDocument();
  });
});

describe('DesignView creation form', () => {
  it('changes the agent and design system, then creates the prototype', async () => {
    const api = client({ systems: [CORE] });
    const created = vi.spyOn(api, 'createDesignProject').mockResolvedValue(project());
    const ui = view(api);
    await ui.findByText('Landing');
    await waitFor(() => expect(ui.getAllByRole('option', { name: 'Core' }).length).toBe(1));
    fireEvent.change(ui.container.querySelector('#design-agent') as HTMLSelectElement, {
      target: { value: OTHER_AGENT_ID },
    });
    fireEvent.change(ui.container.querySelector('#design-system') as HTMLSelectElement, {
      target: { value: 'system-1' },
    });
    fireEvent.change(ui.getByLabelText('Nome do projeto'), { target: { value: 'Home' } });
    fireEvent.change(ui.getByLabelText('Descreva o protótipo'), { target: { value: 'A hero' } });
    fireEvent.click(ui.getByRole('button', { name: /Criar com agente/ }));
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: OTHER_AGENT_ID, designSystemId: 'system-1' }),
      ),
    );
  });

  it('saves a design system from the advanced fields of the form', async () => {
    const api = client();
    const save = vi.spyOn(api, 'saveDesignSystem').mockResolvedValue({
      id: 'system-2',
      name: 'Tokens',
      content: '<p>tokens</p>',
      updatedAt: '2026-09-17T10:00:00Z',
    });
    const ui = view(api);
    await ui.findByText('Landing');
    const saveButton = () => ui.getByRole('button', { name: 'Salvar Design System' });
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(ui.getByLabelText('Nome do Design System'), { target: { value: 'Tokens' } });
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(ui.getByLabelText('HTML do Design System'), {
      target: { value: '<p>tokens</p>' },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('github', {
        id: undefined,
        name: 'Tokens',
        content: '<p>tokens</p>',
      }),
    );
  });
});

describe('DesignView design systems', () => {
  async function onSystems(api: ApiClient) {
    const ui = view(api);
    await ui.findByText('Landing');
    fireEvent.click(ui.getByRole('button', { name: /Design Systems/ }));
    return ui;
  }

  it('changes the agent that generates a system', async () => {
    const api = client();
    const generate = vi
      .spyOn(api, 'generateDesignSystem')
      .mockResolvedValue({ content: '<p>generated</p>' });
    vi.spyOn(api, 'saveDesignSystem').mockResolvedValue({
      id: 's',
      name: 'Dark UI',
      content: '<p>generated</p>',
      updatedAt: '2026-09-17T10:00:00Z',
    });
    const ui = await onSystems(api);
    fireEvent.change(ui.container.querySelector('#design-system-agent') as HTMLSelectElement, {
      target: { value: OTHER_AGENT_ID },
    });
    fireEvent.change(ui.getByLabelText('Descrição do Design System'), {
      target: { value: 'Dark UI' },
    });
    fireEvent.click(ui.getByRole('button', { name: /Gerar HTML com agente/ }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(OTHER_AGENT_ID, 'Dark UI', []));
  });

  it('opens the preview of the system in a new page', async () => {
    const open = vi.fn().mockReturnValue({});
    vi.stubGlobal('open', open);
    const ui = await onSystems(client({ systems: [CORE] }));
    fireEvent.click(ui.getByRole('button', { name: 'Core' }));
    fireEvent.click(ui.getByRole('button', { name: 'Abrir preview em nova página' }));
    expect(open).toHaveBeenCalledOnce();
  });

  it('falls back to the generic message when saving fails without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'saveDesignSystem').mockRejectedValue('boom');
    const ui = await onSystems(api);
    fireEvent.change(ui.getByLabelText('Nome do Design System'), { target: { value: 'Tokens' } });
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo do Design System' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.change(ui.getByLabelText('HTML do Design System'), { target: { value: '<p>x</p>' } });
    fireEvent.click(ui.getByRole('button', { name: 'Salvar template' }));
    expect(await ui.findByText('Falha ao salvar Design System.')).toBeInTheDocument();
  });

  it('reports why saving a system failed', async () => {
    const api = client();
    vi.spyOn(api, 'saveDesignSystem').mockRejectedValue(new Error('Repository is read-only.'));
    const ui = await onSystems(api);
    fireEvent.change(ui.getByLabelText('Nome do Design System'), { target: { value: 'Tokens' } });
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo do Design System' })).getByRole('button', {
        name: 'Código',
      }),
    );
    fireEvent.change(ui.getByLabelText('HTML do Design System'), { target: { value: '<p>x</p>' } });
    fireEvent.click(ui.getByRole('button', { name: 'Salvar template' }));
    expect(await ui.findByText('Repository is read-only.')).toBeInTheDocument();
  });

  it('reports why generating a system failed', async () => {
    const api = client();
    vi.spyOn(api, 'generateDesignSystem').mockRejectedValue(new Error('The model is busy.'));
    const ui = await onSystems(api);
    fireEvent.change(ui.getByLabelText('Descrição do Design System'), {
      target: { value: 'Dark UI' },
    });
    fireEvent.click(ui.getByRole('button', { name: /Gerar HTML com agente/ }));
    expect(await ui.findByText('The model is busy.')).toBeInTheDocument();
  });

  it('falls back to the generic message when generating fails without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'generateDesignSystem').mockRejectedValue('boom');
    const ui = await onSystems(api);
    fireEvent.change(ui.getByLabelText('Descrição do Design System'), {
      target: { value: 'Dark UI' },
    });
    fireEvent.click(ui.getByRole('button', { name: /Gerar HTML com agente/ }));
    expect(await ui.findByText('Falha ao gerar Design System.')).toBeInTheDocument();
  });
});

describe('DesignView deleting a prototype', () => {
  async function confirmDeletion(api: ApiClient) {
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir projeto' }));
    const dialog = await ui.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    return ui;
  }

  it('reports a failed deletion', async () => {
    const api = client();
    vi.spyOn(api, 'deleteDesignProject').mockRejectedValue(new Error('Branch is protected.'));
    const ui = await confirmDeletion(api);
    expect(await ui.findByText('Branch is protected.')).toBeInTheDocument();
  });

  it('falls back to the generic message when the deletion fails without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'deleteDesignProject').mockRejectedValue('boom');
    const ui = await confirmDeletion(api);
    expect(await ui.findByText('Falha ao excluir protótipo.')).toBeInTheDocument();
  });
});
