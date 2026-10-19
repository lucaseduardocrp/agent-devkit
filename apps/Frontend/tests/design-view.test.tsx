import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, type DesignProjectDto } from '../src/lib/api-client.js';
import { DesignView } from '../src/features/design/DesignView.js';

const project: DesignProjectDto = {
  id: 'landing-123',
  provider: 'github',
  title: 'Landing',
  agentId: '11111111-1111-4111-8111-111111111111',
  updatedAt: '2026-09-17T10:00:00.000Z',
  files: [
    {
      name: 'index.html',
      language: 'html',
      content: '<html><head></head><body><main>Olá</main></body></html>',
    },
    { name: 'styles.css', language: 'css', content: 'main { color: red; }' },
    { name: 'script.js', language: 'javascript', content: 'document.body.dataset.ready = "true";' },
  ],
  messages: [
    { role: 'assistant', content: 'Protótipo criado.', createdAt: '2026-09-17T10:00:00.000Z' },
  ],
};

function client() {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignProviders').mockResolvedValue(['github']);
  vi.spyOn(api, 'getDesignProjects').mockResolvedValue([project]);
  vi.spyOn(api, 'getDesignSystems').mockResolvedValue([]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([
    {
      id: project.agentId,
      workspaceId: 'ws',
      name: 'Designer',
      slug: 'designer',
      description: '',
      instructions: '',
      role: 'CUSTOM',
      model: '',
      temperature: 0.2,
      isSystem: false,
      createdAt: '',
      updatedAt: '',
    },
  ]);
  return api;
}

describe('DesignView', () => {
  it('loads repository projects, previews, edits, chats and exports code', async () => {
    const api = client();
    const update = vi.spyOn(api, 'updateDesignFiles').mockResolvedValue(project);
    const chat = vi.spyOn(api, 'chatDesignProject').mockResolvedValue({
      ...project,
      messages: [
        ...project.messages,
        { role: 'user', content: 'Ajuste', createdAt: '2026-09-17T10:01:00.000Z' },
      ],
    });
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: /Landing/ }));
    expect(screen.getByTitle('Preview de Landing')).toHaveAttribute('sandbox', 'allow-scripts');
    fireEvent.click(screen.getByRole('button', { name: /Código/ }));
    fireEvent.change(screen.getByLabelText('Código de index.html'), {
      target: { value: '<html>Editado</html>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('landing-123', expect.any(Array), 'github'),
    );
    fireEvent.change(screen.getByLabelText('Mensagem para o agente'), {
      target: { value: 'Ajuste' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Enviar/ }));
    await waitFor(() =>
      expect(chat).toHaveBeenCalledWith('landing-123', 'Ajuste', 'github', project.agentId, []),
    );
    fireEvent.click(screen.getByRole('button', { name: /Exportar/ }));
    expect(createUrl).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir preview em nova página' }));
    expect(open).toHaveBeenCalledWith('blob:test', '_blank', 'noopener,noreferrer');
  });

  it('creates a repository-backed project and disables creation without a provider', async () => {
    const api = client();
    vi.mocked(api.getDesignSystems).mockResolvedValue([
      { id: 'aurora', name: 'Aurora', content: 'x'.repeat(25000), updatedAt: '' },
    ]);
    const create = vi.spyOn(api, 'createDesignProject').mockResolvedValue(project);
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    await screen.findByRole('button', { name: /Landing/ });
    fireEvent.change(screen.getByLabelText('Nome do projeto'), { target: { value: 'Nova UI' } });
    fireEvent.change(screen.getByLabelText('Design System'), { target: { value: 'aurora' } });
    fireEvent.change(screen.getByLabelText('Descreva o protótipo'), {
      target: { value: 'Crie uma landing page' },
    });
    fireEvent.change(screen.getByLabelText('Adicionar imagens'), {
      target: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] },
    });
    await screen.findByAltText('reference.png');
    fireEvent.click(screen.getByRole('button', { name: /Criar com agente/ }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'github',
          title: 'Nova UI',
          prompt: 'Crie uma landing page',
          designSystemId: 'aurora',
          images: [expect.objectContaining({ mimeType: 'image/png' })],
        }),
      ),
    );
  });

  it('previews and automatically saves an HTML Design System after generation', async () => {
    const api = client();
    vi.spyOn(api, 'generateDesignSystem').mockResolvedValue({
      content: '<!doctype html><html><body><h1>System</h1></body></html>',
    });
    const save = vi.spyOn(api, 'saveDesignSystem').mockResolvedValue({
      id: 'system-123',
      name: 'Aurora',
      content: '<!doctype html><html><body><h1>System</h1></body></html>',
      updatedAt: '',
    });
    render(<DesignView apiClient={api} activeWorkspaceId="ws" />);
    await screen.findByRole('button', { name: /Landing/ });
    fireEvent.click(screen.getByRole('button', { name: 'Design Systems' }));
    fireEvent.change(screen.getByLabelText('Nome do Design System'), {
      target: { value: 'Aurora' },
    });
    fireEvent.change(screen.getByLabelText('Descrição do Design System'), {
      target: { value: 'Minimalista' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Gerar HTML com agente/ }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('github', expect.objectContaining({ name: 'Aurora' })),
    );
    expect(screen.getByTitle('Preview do Design System')).toHaveAttribute(
      'sandbox',
      'allow-scripts',
    );
    expect(screen.queryByLabelText('HTML do Design System')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Código' }));
    expect(screen.getByLabelText('HTML do Design System')).toBeInTheDocument();
    expect(screen.queryByTitle('Preview do Design System')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pré-visualização' }));
    expect(screen.getByTitle('Preview do Design System')).toBeInTheDocument();
  });
});
