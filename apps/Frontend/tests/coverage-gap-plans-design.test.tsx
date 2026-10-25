import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, type DesignProjectDto } from '../src/lib/api-client.js';
import { DesignView } from '../src/features/design/DesignView.js';

const agentId = '11111111-1111-4111-8111-111111111111';

const project: DesignProjectDto = {
  id: 'landing-123',
  provider: 'github',
  title: 'Landing',
  agentId,
  updatedAt: '2026-09-17T10:00:00.000Z',
  files: [
    { name: 'index.html', language: 'html', content: '<main>Olá</main>' },
    { name: 'styles.css', language: 'css', content: 'main { color: red; }' },
  ],
  messages: [
    { role: 'assistant', content: 'Protótipo criado.', createdAt: '2026-09-17T10:00:00.000Z' },
  ],
};

const agent = {
  id: agentId,
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

function client(
  options: {
    providers?: ('github' | 'azure')[];
    projects?: DesignProjectDto[];
    agents?: (typeof agent)[];
  } = {},
) {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignProviders').mockResolvedValue(options.providers ?? ['github']);
  vi.spyOn(api, 'getDesignProjects').mockResolvedValue(options.projects ?? [project]);
  vi.spyOn(api, 'getDesignSystems').mockResolvedValue([]);
  vi.spyOn(api, 'getAgents').mockResolvedValue(options.agents ?? [agent]);
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DesignView coverage gaps', () => {
  it('inlines local stylesheets and scripts in the preview and leaves external ones', async () => {
    const html = [
      '<html><head>',
      '<link rel="stylesheet" href="./css/main.css?v=1">',
      '<link rel="stylesheet" href="theme.css">',
      '<link rel="stylesheet" href="other/reset.css">',
      '<link rel="stylesheet" href="missing.css">',
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      '<link rel="stylesheet">',
      '</head><body>',
      '<script type="module" src="./js/app.js#x"></script>',
      '<script src="util.js"></script>',
      '<script src="c/vendor.js"></script>',
      '<script src="nope.js"></script>',
      '<script src="https://cdn.example.com/lib.js"></script>',
      '</body></html>',
    ].join('');
    const rich: DesignProjectDto = {
      ...project,
      files: [
        { name: 'index.html', language: 'html', content: html },
        { name: 'css/main.css', language: 'css', content: '.main{}' },
        { name: 'src/theme.css', language: 'css', content: '.theme{}' },
        { name: 'assets/x/reset.css', language: 'css', content: '.reset{}' },
        { name: 'loose.css', language: 'css', content: '.loose{}' },
        { name: 'js/app.js', language: 'javascript', content: 'window.app=1' },
        { name: 'lib/util.js', language: 'javascript', content: 'window.util=1' },
        { name: 'a/b/vendor.js', language: 'javascript', content: 'window.vendor=1' },
        { name: 'extra.js', language: 'javascript', content: 'window.extra=1' },
      ],
    };
    render(<DesignView apiClient={client({ projects: [rich] })} activeWorkspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /Landing/ }));
    const doc = screen.getByTitle('Preview de Landing').getAttribute('srcdoc') ?? '';
    expect(doc).toContain('<style>\n.main{}\n</style>');
    expect(doc).toContain('<style>\n.theme{}\n</style>');
    expect(doc).toContain('<style>\n.reset{}\n</style>');
    expect(doc).toContain('<style>\n.loose{}\n</style>');
    expect(doc).not.toContain('missing.css');
    expect(doc).toContain('href="https://cdn.example.com/x.css"');
    expect(doc).toContain('<link rel="stylesheet">');
    expect(doc).toContain('<script type="module">\nwindow.app=1\n</script>');
    expect(doc).toContain('<script>\nwindow.util=1\n</script>');
    expect(doc).toContain('<script>\nwindow.vendor=1\n</script>');
    expect(doc).toContain('<script src="nope.js"></script>');
    expect(doc).toContain('<script src="https://cdn.example.com/lib.js"></script>');
    expect(doc).toContain('<script>\nwindow.extra=1\n</script>');
  });

  it('falls back to GitHub when no provider is configured', async () => {
    const api = client({ providers: [] });
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    expect(await screen.findByRole('option', { name: 'Configure uma integração' })).toBeTruthy();
    expect(api.getDesignSystems).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Criar com agente/ }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('selects the first agent when the project agent no longer exists', async () => {
    const api = client({ projects: [{ ...project, agentId: 'unknown', files: [] }] });
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /Landing/ }));
    expect((document.getElementById('design-chat-agent') as HTMLSelectElement).value).toBe(agentId);
    fireEvent.click(screen.getByRole('button', { name: 'Código' }));
    const code = screen.getByLabelText(/^Código des*$/);
    expect((code as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(code, { target: { value: 'x' } });
    expect((code as HTMLTextAreaElement).value).toBe('');
  });

  it('uses no agent when none exist and pulls a project without files', async () => {
    const api = client({ agents: [] });
    const pull = vi.spyOn(api, 'getDesignProject').mockResolvedValue({ ...project, files: [] });
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /Landing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Código' }));
    fireEvent.click(screen.getByRole('button', { name: 'styles.css' }));
    fireEvent.click(screen.getByRole('button', { name: /Pull/ }));
    await waitFor(() => expect(pull).toHaveBeenCalledWith('landing-123', 'github'));
    expect(await screen.findByLabelText(/^Código des*$/)).toBeInTheDocument();
  });

  it('sends image-only chat messages and renders images sent to the agent', async () => {
    const api = client();
    const chat = vi.spyOn(api, 'chatDesignProject').mockResolvedValue({
      ...project,
      messages: [
        ...project.messages,
        {
          role: 'user',
          content: 'Veja',
          createdAt: '2026-09-17T10:01:00.000Z',
          images: [{ mimeType: 'image/png', data: 'aGk=' }],
        },
      ],
    });
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /Landing/ }));
    const input = document.getElementById('design-chat-images') as HTMLInputElement;
    fireEvent.change(input, { target: { files: null } });
    fireEvent.change(input, {
      target: { files: [new File(['img'], 'shot.png', { type: 'image/png' })] },
    });
    await screen.findByAltText('shot.png');
    fireEvent.click(screen.getByRole('button', { name: /Enviar/ }));
    await waitFor(() =>
      expect(chat).toHaveBeenCalledWith(
        'landing-123',
        'Analise as imagens anexadas e atualize o design.',
        'github',
        agentId,
        [expect.objectContaining({ mimeType: 'image/png' })],
      ),
    );
    const sent = await screen.findByAltText('Imagem enviada ao agente');
    expect(sent).toHaveAttribute('src', 'data:image/png;base64,aGk=');
  });

  it('reports image read failures from the file reader', async () => {
    const api = client();
    class FailingReader {
      error: Error | null = null;
      result: unknown = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(file: File) {
        if (file.name === 'error.png') {
          this.onerror?.();
        } else {
          this.result = new ArrayBuffer(1);
          this.onload?.();
        }
      }
    }
    vi.stubGlobal('FileReader', FailingReader);
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent | Error) => rejections.push(event);
    process.on('unhandledRejection', onRejection);
    try {
      render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
      await screen.findByRole('button', { name: /Landing/ });
      const input = screen.getByLabelText('Adicionar imagens');
      fireEvent.change(input, { target: { files: null } });
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'error.png', { type: 'image/png' })] },
      });
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'buffer.png', { type: 'image/png' })] },
      });
      await waitFor(() => expect(rejections).toHaveLength(2));
      expect(String(rejections[0])).toContain('Unable to read image.');
      expect(String(rejections[1])).toContain('Unable to read image.');
      expect(screen.queryByAltText('error.png')).toBeNull();
    } finally {
      process.off('unhandledRejection', onRejection);
      vi.unstubAllGlobals();
    }
  });

  it('saves a Design System from the prototype form and shows non-Error failures', async () => {
    const api = client();
    const save = vi
      .spyOn(api, 'saveDesignSystem')
      .mockRejectedValueOnce('boom')
      .mockResolvedValueOnce({ id: 'core', name: 'Core', content: '<html>', updatedAt: '' });
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    await screen.findByRole('button', { name: /Landing/ });
    fireEvent.change(screen.getByLabelText('Nome do Design System'), { target: { value: 'Core' } });
    fireEvent.change(screen.getByLabelText('HTML do Design System'), {
      target: { value: '<html>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar Design System' }));
    expect(await screen.findByText('Falha ao salvar Design System.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar notificação' }));
    expect(screen.queryByText('Falha ao salvar Design System.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar Design System' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('option', { name: 'Core' })).toBeInTheDocument();
  });

  it('shows the fallback message when Design System generation rejects with a non-Error', async () => {
    const api = client();
    vi.spyOn(api, 'generateDesignSystem').mockRejectedValue('nope');
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    await screen.findByRole('button', { name: /Landing/ });
    fireEvent.click(screen.getByRole('button', { name: /Design Systems/ }));
    fireEvent.change(screen.getByLabelText('Descrição do Design System'), {
      target: { value: 'Tons azuis' },
    });
    fireEvent.change(screen.getByLabelText('Agente'), { target: { value: agentId } });
    fireEvent.click(screen.getByRole('button', { name: /Gerar HTML/ }));
    expect(await screen.findByText('Falha ao gerar Design System.')).toBeInTheDocument();
  });

  it('reports prototype deletion failures with and without Error instances', async () => {
    const api = client();
    const remove = vi
      .spyOn(api, 'deleteDesignProject')
      .mockRejectedValueOnce(new Error('Sem permissão'))
      .mockRejectedValueOnce('x');
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /Landing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir projeto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByText('Sem permissão')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByText('Falha ao excluir protótipo.')).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByText('Excluir protótipo?')).toBeNull();
  });

  it('ignores the initial load after unmounting', async () => {
    const api = client();
    let resolveAgents: (value: (typeof agent)[]) => void = () => undefined;
    vi.mocked(api.getAgents).mockReturnValue(
      new Promise((resolve) => {
        resolveAgents = resolve;
      }),
    );
    const view = render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    view.unmount();
    resolveAgents([agent]);
    await waitFor(() => expect(api.getDesignSystems).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Landing/ })).toBeNull();
  });

  it('switches repository and agents and opens the Design System preview', async () => {
    const api = client({ providers: ['github', 'azure'] });
    const second = { ...agent, id: '22222222-2222-4222-8222-222222222222', name: 'Second' };
    vi.mocked(api.getAgents).mockResolvedValue([agent, second]);
    const save = vi
      .spyOn(api, 'saveDesignSystem')
      .mockRejectedValue(new Error('Repositório indisponível'));
    vi.spyOn(api, 'generateDesignSystem').mockRejectedValue(new Error('Modelo indisponível'));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:system');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    await screen.findAllByRole('button', { name: /Landing/ });
    const providerSelect = document.getElementById('design-provider') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'azure' } });
    expect(providerSelect.value).toBe('azure');
    const agentSelect = document.getElementById('design-agent') as HTMLSelectElement;
    fireEvent.change(agentSelect, { target: { value: second.id } });
    expect(agentSelect.value).toBe(second.id);
    fireEvent.change(screen.getByLabelText('Nome do Design System'), { target: { value: 'Core' } });
    fireEvent.change(screen.getByLabelText('HTML do Design System'), {
      target: { value: '<html>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar Design System' }));
    expect(await screen.findByText('Repositório indisponível')).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith('azure', expect.objectContaining({ name: 'Core' }));

    fireEvent.click(screen.getByRole('button', { name: /Design Systems/ }));
    fireEvent.change(screen.getByLabelText('Descrição do Design System'), {
      target: { value: 'Tons azuis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Gerar HTML/ }));
    expect(await screen.findByText('Modelo indisponível')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir preview em nova página' }));
    expect(open).toHaveBeenCalledWith('blob:system', '_blank', 'noopener,noreferrer');

    fireEvent.click(screen.getAllByRole('button', { name: /Landing/ })[0]!);
    const chatAgent = document.getElementById('design-chat-agent') as HTMLSelectElement;
    fireEvent.change(chatAgent, { target: { value: second.id } });
    expect(chatAgent.value).toBe(second.id);
  });
});
