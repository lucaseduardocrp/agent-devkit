import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignView } from '../src/features/design/DesignView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { DesignProjectDto, DesignSystemDto } from '../src/lib/api-client.js';

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

function system(overrides: Partial<DesignSystemDto> = {}): DesignSystemDto {
  return {
    id: 'system-1',
    name: 'Core',
    content: '<html><body>tokens</body></html>',
    updatedAt: '2026-09-17T10:00:00.000Z',
    ...overrides,
  };
}

function client(options: { systems?: readonly DesignSystemDto[] } = {}) {
  const api = new ApiClient();
  vi.spyOn(api, 'getDesignProviders').mockResolvedValue(['github']);
  vi.spyOn(api, 'getDesignProjects').mockResolvedValue([PROJECT]);
  vi.spyOn(api, 'getDesignSystems').mockResolvedValue([...(options.systems ?? [])]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([
    {
      id: AGENT_ID,
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

function view(api: ApiClient, isReadOnly = false) {
  return render(<DesignView apiClient={api} activeWorkspaceId="ws" isReadOnly={isReadOnly} />);
}

function imageFile(name = 'shot.png', type = 'image/png', size = 1_000): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

afterEach(() => vi.restoreAllMocks());

describe('DesignView design systems', () => {
  async function onSystems(api: ApiClient) {
    const ui = view(api);
    await ui.findByText('Landing');
    fireEvent.click(ui.getByRole('button', { name: /Design Systems/ }));
    fireEvent.click(
      within(ui.getByRole('group', { name: 'Modo do Design System' })).getByRole('button', {
        name: 'Código',
      }),
    );
    return ui;
  }

  it('opens a saved system for editing and clears the form for a new one', async () => {
    const ui = await onSystems(client({ systems: [system()] }));

    fireEvent.click(ui.getByRole('button', { name: 'Core' }));
    expect((ui.getByLabelText('Nome do Design System') as HTMLInputElement).value).toBe('Core');

    fireEvent.click(ui.getByRole('button', { name: 'Novo template' }));
    expect((ui.getByLabelText('Nome do Design System') as HTMLInputElement).value).toBe('');
  });

  it('saves a system and selects it', async () => {
    const api = client();
    const save = vi.spyOn(api, 'saveDesignSystem').mockResolvedValue(system({ name: 'Tokens' }));
    const ui = await onSystems(api);

    fireEvent.change(ui.getByLabelText('Nome do Design System'), { target: { value: ' Tokens ' } });
    fireEvent.change(ui.getByLabelText('HTML do Design System'), {
      target: { value: ' <html></html> ' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Salvar template' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('github', {
        id: undefined,
        name: 'Tokens',
        content: '<html></html>',
      }),
    );
    expect(await ui.findByRole('button', { name: 'Tokens' })).toBeInTheDocument();
  });

  it('keeps the save button disabled until both fields are filled', async () => {
    const ui = await onSystems(client());
    const save = () => ui.getByRole('button', { name: 'Salvar template' }) as HTMLButtonElement;

    expect(save().disabled).toBe(true);
    fireEvent.change(ui.getByLabelText('Nome do Design System'), { target: { value: 'Tokens' } });
    expect(save().disabled).toBe(true);
    fireEvent.change(ui.getByLabelText('HTML do Design System'), { target: { value: '<html>' } });
    expect(save().disabled).toBe(false);
  });

  it('deletes the system being edited', async () => {
    const api = client({ systems: [system()] });
    const remove = vi.spyOn(api, 'deleteDesignSystem').mockResolvedValue();
    const ui = await onSystems(api);

    fireEvent.click(ui.getByRole('button', { name: 'Core' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('system-1', 'github'));
    expect(await ui.findByText('Design System excluído.')).toBeInTheDocument();
    await waitFor(() =>
      expect((ui.getByLabelText('Nome do Design System') as HTMLInputElement).value).toBe(''),
    );
  });

  it('offers no delete action for an unsaved system', async () => {
    const ui = await onSystems(client({ systems: [system()] }));
    expect(ui.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
  });
});

describe('DesignView reference images', () => {
  it('attaches, previews, and removes an image on the creation form', async () => {
    const ui = view(client());
    await ui.findByText('Landing');

    const input = ui.getByLabelText('Adicionar imagens', { selector: 'input' });
    fireEvent.change(input, { target: { files: [imageFile()] } });

    const remove = await ui.findByRole('button', { name: 'Remover imagem shot.png' });
    expect(ui.getByAltText('shot.png')).toBeInTheDocument();

    fireEvent.click(remove);
    await waitFor(() =>
      expect(ui.queryByRole('button', { name: 'Remover imagem shot.png' })).not.toBeInTheDocument(),
    );
  });

  it('rejects an unsupported type and an oversized file', async () => {
    const ui = view(client());
    await ui.findByText('Landing');
    const input = ui.getByLabelText('Adicionar imagens', { selector: 'input' });

    fireEvent.change(input, { target: { files: [imageFile('notes.pdf', 'application/pdf')] } });
    expect(
      await ui.findByText('Selecione apenas imagens PNG, JPEG, WebP ou GIF de até 5 MB.'),
    ).toBeInTheDocument();

    fireEvent.change(input, {
      target: { files: [imageFile('huge.png', 'image/png', 6 * 1024 * 1024)] },
    });
    expect(
      await ui.findByText('Selecione apenas imagens PNG, JPEG, WebP ou GIF de até 5 MB.'),
    ).toBeInTheDocument();
  });

  it('refuses more than four images', async () => {
    const ui = view(client());
    await ui.findByText('Landing');

    fireEvent.change(ui.getByLabelText('Adicionar imagens', { selector: 'input' }), {
      target: {
        files: [
          imageFile('a.png'),
          imageFile('b.png'),
          imageFile('c.png'),
          imageFile('d.png'),
          imageFile('e.png'),
        ],
      },
    });

    expect(await ui.findByText('Você pode anexar no máximo 4 imagens.')).toBeInTheDocument();
  });

  it('attaches an image to a chat message and refuses more than four', async () => {
    const ui = view(client());
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));

    const chatInput = await ui.findByLabelText('Adicionar imagens', { selector: 'input' });
    fireEvent.change(chatInput, { target: { files: [imageFile('chat.png')] } });
    expect(await ui.findByAltText('chat.png')).toBeInTheDocument();

    fireEvent.change(chatInput, {
      target: {
        files: [imageFile('b.png'), imageFile('c.png'), imageFile('d.png'), imageFile('e.png')],
      },
    });
    expect(await ui.findByText('Você pode anexar no máximo 4 imagens.')).toBeInTheDocument();
  });

  it('rejects an unsupported chat attachment', async () => {
    const ui = view(client());
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));

    fireEvent.change(await ui.findByLabelText('Adicionar imagens', { selector: 'input' }), {
      target: { files: [imageFile('notes.pdf', 'application/pdf')] },
    });

    expect(
      await ui.findByText('Selecione apenas imagens PNG, JPEG, WebP ou GIF de até 5 MB.'),
    ).toBeInTheDocument();
  });
});

describe('DesignView project actions', () => {
  async function opened(api: ApiClient) {
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: /Landing/ }));
    return ui;
  }

  it('pulls the repository version of the prototype', async () => {
    const api = client();
    const pull = vi
      .spyOn(api, 'getDesignProject')
      .mockResolvedValue({ ...PROJECT, title: 'Landing v2' });
    const ui = await opened(api);

    fireEvent.click(ui.getByRole('button', { name: 'Pull' }));

    await waitFor(() => expect(pull).toHaveBeenCalledWith('landing-123', 'github'));
    expect(await ui.findByText('Versão do repositório carregada.')).toBeInTheDocument();
  });

  it('reports a failed pull', async () => {
    const api = client();
    vi.spyOn(api, 'getDesignProject').mockRejectedValue(new Error('The branch is gone.'));
    const ui = await opened(api);

    fireEvent.click(ui.getByRole('button', { name: 'Pull' }));

    expect(await ui.findByText('The branch is gone.')).toBeInTheDocument();
  });

  it('returns to the creation form from the sidebar', async () => {
    const ui = await opened(client());

    fireEvent.click(ui.getByRole('button', { name: /Novo protótipo/ }));

    expect(
      await ui.findByLabelText('Adicionar imagens', { selector: 'input' }),
    ).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: 'Pull' })).not.toBeInTheDocument();
  });

  it('opens the delete confirmation for the selected prototype', async () => {
    const api = client();
    const remove = vi.spyOn(api, 'deleteDesignProject').mockResolvedValue();
    const ui = await opened(api);

    fireEvent.click(ui.getByRole('button', { name: 'Excluir projeto' }));
    const dialog = ui.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('landing-123', 'github'));
  });

  it('cancels the delete confirmation', async () => {
    const api = client();
    const remove = vi.spyOn(api, 'deleteDesignProject').mockResolvedValue();
    const ui = await opened(api);

    fireEvent.click(ui.getByRole('button', { name: 'Excluir projeto' }));
    fireEvent.click(within(ui.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(ui.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });
});
