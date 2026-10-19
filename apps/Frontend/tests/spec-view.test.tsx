import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpecView } from '../src/features/spec/SpecView.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/I18nContext.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type {
  EffectiveAccess,
  ModuleAccessMap,
} from '../src/features/workspaces/workspace-types.js';

const template = {
  id: 't1',
  workspaceId: 'w1',
  name: 'Base',
  sections: [
    { id: 'objective', title: 'Objetivo', required: true },
    { id: 'impact', title: 'Impacto', required: false },
  ],
  createdAt: '',
  updatedAt: '',
};
const spec = {
  id: 's1',
  workspaceId: 'w1',
  templateId: 't1',
  agentId: 'a1',
  title: 'Login',
  sections: [
    { templateSectionId: 'objective', title: 'Objetivo', content: 'Permitir acesso' },
    { templateSectionId: 'impact', title: 'Impacto', content: 'Permissões' },
  ],
  messages: [{ id: 'm1', role: 'assistant' as const, content: 'Revise permissões', createdAt: '' }],
  createdAt: '',
  updatedAt: '',
};
const agent = {
  id: 'a1',
  workspaceId: 'w1',
  name: 'Analista',
  slug: 'analista',
  description: '',
  instructions: '',
  role: 'DOCUMENTATION' as const,
  model: '',
  temperature: 0.2,
  isSystem: false,
  createdAt: '',
  updatedAt: '',
};
const unlinkedSpec = {
  ...spec,
  id: 's-unlinked',
  title: 'Sem vínculos',
  templateId: undefined,
  agentId: undefined,
};
const childSpec = {
  ...spec,
  id: 's-child',
  parentId: 's1',
  title: 'Permissões do login',
};

function clientWithData() {
  const client = new ApiClient();
  vi.spyOn(client, 'getSpecTemplates').mockResolvedValue([template]);
  vi.spyOn(client, 'getSpecifications').mockResolvedValue([spec, childSpec, unlinkedSpec]);
  vi.spyOn(client, 'getAgents').mockResolvedValue([agent]);
  return client;
}

describe('SpecView', () => {
  it('opens history for only the selected Spec or template from its actions menu', async () => {
    const client = clientWithData();
    const load = vi
      .spyOn(client, 'getAuditHistory')
      .mockResolvedValue({ items: [], page: 1, total: 0, totalPages: 0 });
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    fireEvent.click(await view.findByRole('button', { name: 'Login' }));
    expect(view.queryByRole('button', { name: 'Histórico' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith('specification', 1, expect.any(AbortSignal), 's1'),
    );
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith('template', 1, expect.any(AbortSignal), 't1'),
    );
  });
  it('deletes the selected template after confirmation', async () => {
    const client = clientWithData();
    const deleteTemplate = vi.spyOn(client, 'deleteSpecTemplate').mockResolvedValue();
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    await view.findByRole('heading', { name: 'Nova especificação' });
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir template' }));
    const dialog = view.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Base');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith('t1'));
    expect(await view.findByText('Template excluído com sucesso.')).toBeInTheDocument();
  });

  it('clears a template from the previous workspace before deletion can be requested', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getSpecTemplates')
      .mockResolvedValueOnce([template])
      .mockResolvedValueOnce([]);
    vi.spyOn(client, 'getSpecifications').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    const deleteTemplate = vi.spyOn(client, 'deleteSpecTemplate').mockResolvedValue();
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);

    await view.findByRole('heading', { name: 'Nova especificação' });
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    expect(view.getByRole('button', { name: 'Excluir template' })).toBeInTheDocument();

    view.rerender(<SpecView apiClient={client} activeWorkspaceId="w2" />);

    await waitFor(() => expect(client.getSpecTemplates).toHaveBeenCalledTimes(2));
    expect(view.queryByRole('button', { name: 'Excluir template' })).not.toBeInTheDocument();
    expect(view.queryByText('Base')).not.toBeInTheDocument();
    expect(deleteTemplate).not.toHaveBeenCalled();
  });

  it('separates pages and completes template, saved Spec, chat, and export journeys', async () => {
    const client = clientWithData();
    vi.spyOn(client, 'saveSpecTemplate').mockResolvedValue({ ...template, name: 'Produto' });
    vi.spyOn(client, 'saveSpecification').mockResolvedValue({ ...spec, title: 'Login v2' });
    vi.spyOn(client, 'chatSpecification').mockResolvedValue({
      ...spec,
      messages: [
        ...spec.messages,
        { id: 'm2', role: 'user' as const, content: 'Ajude', createdAt: '' },
      ],
    });
    vi.spyOn(client, 'exportSpecification').mockResolvedValue('# Login');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:spec');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    expect(view.getByTestId('spec-loading-skeleton')).toBeInTheDocument();
    expect(await view.findByRole('heading', { name: 'Nova especificação' })).toBeInTheDocument();
    expect(view.getByTestId('spec-navigation-sidebar').style.maxWidth).toBe('100%');
    expect(view.getByTestId('spec-agent-sidebar').querySelector('[role="separator"]')).toHaveClass(
      'left-0',
    );

    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    expect(view.getByRole('heading', { name: 'Configurações' })).toBeInTheDocument();
    expect(view.queryByLabelText('Colaboração com Agent')).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Criar nova' }));
    expect(view.getByRole('heading', { name: 'Nova especificação' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    expect(view.getByLabelText('Nome do template')).toHaveAttribute('readonly');
    expect(view.getByText('Título')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Editar' }));
    fireEvent.change(view.getByLabelText('Nome do template'), { target: { value: 'Produto' } });
    fireEvent.change(view.getByLabelText('Seção 1'), { target: { value: 'Meta' } });
    fireEvent.click(view.getByRole('button', { name: 'Adicionar seção' }));
    fireEvent.click(view.getAllByRole('button', { name: 'Remover' })[1]!);
    fireEvent.click(view.getByRole('button', { name: 'Salvar template' }));
    await waitFor(() =>
      expect(client.saveSpecTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't1', name: 'Produto' }),
      ),
    );

    fireEvent.click(view.getByRole('button', { name: 'Login' }));
    expect(view.getByLabelText('Título')).toHaveAttribute('readonly');
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Editar' }));
    fireEvent.change(view.getByLabelText('Título'), {
      target: { value: 'Login v2' },
    });
    fireEvent.change(view.getByDisplayValue('Permitir acesso'), {
      target: { value: 'Novo conteúdo' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Salvar especificação' }));
    await waitFor(() =>
      expect(client.saveSpecification).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's1', title: 'Login v2' }),
      ),
    );
    fireEvent.change(view.getByRole('combobox', { name: 'Colaboração com Agent' }), {
      target: { value: '' },
    });
    const emptyAgentSend = view.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    emptyAgentSend.disabled = false;
    fireEvent.click(emptyAgentSend);
    fireEvent.change(view.getByRole('combobox', { name: 'Colaboração com Agent' }), {
      target: { value: 'a1' },
    });
    const emptySend = view.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    emptySend.disabled = false;
    fireEvent.click(emptySend);
    fireEvent.change(view.getByLabelText('Mensagem para o Agent'), { target: { value: 'Ajude' } });
    fireEvent.change(view.getByRole('combobox', { name: 'Colaboração com Agent' }), {
      target: { value: '' },
    });
    fireEvent.change(view.getByRole('combobox', { name: 'Colaboração com Agent' }), {
      target: { value: 'a1' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(client.chatSpecification).toHaveBeenCalledWith('s1', 'a1', 'Ajude'));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Exportar .md' }));
    await waitFor(() => expect(client.exportSpecification).toHaveBeenCalledWith('s1'));
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    expect(view.queryByRole('button', { name: 'Exportar .md' })).not.toBeInTheDocument();
    expect(view.queryByText('Login')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Sem vínculos' }));
    expect(
      (view.getByRole('combobox', { name: 'Colaboração com Agent' }) as HTMLSelectElement).value,
    ).toBe('');
    view.rerender(<SpecView apiClient={client} activeWorkspaceId="w2" />);
    await waitFor(() => expect(client.getSpecTemplates).toHaveBeenCalledTimes(2));
  });

  it('creates new records and applies a selected template', async () => {
    const client = clientWithData();
    vi.spyOn(client, 'saveSpecTemplate').mockResolvedValue({
      ...template,
      id: 't2',
      name: 'Novo template',
    });
    vi.spyOn(client, 'saveSpecification').mockResolvedValue({
      ...spec,
      id: 's2',
      agentId: undefined,
    });
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    await view.findByRole('button', { name: 'Login' });
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Nova especificação' }));
    fireEvent.change(view.getByLabelText('Template'), { target: { value: '' } });
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Nova especificação' }));
    fireEvent.click(view.getByRole('button', { name: 'Salvar especificação' }));
    await waitFor(() =>
      expect(client.saveSpecification).toHaveBeenCalledWith(
        expect.objectContaining({ id: undefined, templateId: undefined }),
      ),
    );
    fireEvent.change(view.getByLabelText('Template'), { target: { value: 't1' } });
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Novo template' }));
    fireEvent.change(view.getByLabelText('Seção 1'), { target: { value: 'Problema' } });
    fireEvent.click(view.getByRole('button', { name: 'Salvar template' }));
    await waitFor(() =>
      expect(client.saveSpecTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: undefined }),
      ),
    );
    fireEvent.change(view.getByLabelText('Template para editar'), { target: { value: 't1' } });
  });

  it('automatically saves a draft before asking an Agent for help', async () => {
    const client = clientWithData();
    const savedDraft = { ...spec, id: 's-draft', title: 'Nova especificação' };
    const appliedDraft = {
      ...savedDraft,
      title: 'Login seguro',
      sections: [
        { templateSectionId: 'objective', title: 'Objetivo', content: 'Autenticar usuários' },
        { templateSectionId: 'impact', title: 'Impacto', content: 'Proteção de acesso' },
      ],
    };
    vi.spyOn(client, 'saveSpecification')
      .mockResolvedValueOnce(savedDraft)
      .mockResolvedValueOnce(appliedDraft);
    vi.spyOn(client, 'chatSpecification').mockResolvedValue({
      ...savedDraft,
      proposal: {
        title: 'Login seguro',
        sections: [
          { templateSectionId: 'objective', content: 'Autenticar usuários' },
          { templateSectionId: 'impact', content: 'Proteção de acesso' },
        ],
      },
      messages: [
        { id: 'm-user', role: 'user' as const, content: 'Ajude a escrever', createdAt: '' },
        {
          id: 'm-agent',
          role: 'assistant' as const,
          content: '## Proposta\n\nVamos estruturar.',
          createdAt: '',
        },
      ],
    });
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);

    await view.findByRole('button', { name: 'Login' });
    fireEvent.change(view.getByRole('combobox', { name: /Agent/ }), {
      target: { value: 'a1' },
    });
    fireEvent.change(view.getByLabelText(/Mensagem.*Agent/), {
      target: { value: 'Ajude a escrever' },
    });
    const send = view.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(() =>
      expect(client.saveSpecification).toHaveBeenCalledWith(
        expect.objectContaining({ id: undefined, agentId: 'a1' }),
      ),
    );
    expect(client.chatSpecification).toHaveBeenCalledWith('s-draft', 'a1', 'Ajude a escrever');
    expect(await view.findByRole('heading', { name: 'Proposta' })).toBeInTheDocument();
    expect(client.saveSpecification).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: 'Confirmar e preencher a Spec' }));
    await waitFor(() => expect(client.saveSpecification).toHaveBeenCalledTimes(2));
    expect(client.saveSpecification).toHaveBeenLastCalledWith(
      expect.objectContaining({ sections: appliedDraft.sections }),
    );
    expect(view.getByLabelText('Título')).toHaveAttribute('value', 'Login seguro');
    expect(view.getByRole('region', { name: 'Objetivo' })).toHaveTextContent('Autenticar usuários');
  });

  it('keeps an Agent proposal pending when confirmation fails', async () => {
    const client = clientWithData();
    vi.spyOn(client, 'chatSpecification').mockResolvedValue({
      ...spec,
      proposal: {
        sections: [{ templateSectionId: 'objective', content: 'Objetivo revisado' }],
      },
    });
    vi.spyOn(client, 'saveSpecification').mockRejectedValue(new Error('Não foi possível aplicar'));
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);

    fireEvent.click(await view.findByRole('button', { name: 'Login' }));
    fireEvent.change(view.getByLabelText(/Mensagem.*Agent/), { target: { value: 'Concluir' } });
    fireEvent.click(view.getByRole('button', { name: 'Enviar' }));
    fireEvent.click(await view.findByRole('button', { name: 'Confirmar e preencher a Spec' }));

    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível aplicar');
    expect(view.getByRole('button', { name: 'Confirmar e preencher a Spec' })).toBeInTheDocument();
  });

  it('rejects an empty Agent proposal instead of reporting a false success', async () => {
    const client = clientWithData();
    const save = vi.spyOn(client, 'saveSpecification');
    vi.spyOn(client, 'chatSpecification').mockResolvedValue({
      ...spec,
      proposal: {
        title: ` ${spec.title} `,
        sections: [
          { templateSectionId: 'objective', content: spec.sections[0]!.content },
          { templateSectionId: 'unknown', content: 'Não deve ser aplicado' },
        ],
      },
    });
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);

    fireEvent.click(await view.findByRole('button', { name: 'Login' }));
    fireEvent.change(view.getByLabelText(/Mensagem.*Agent/), { target: { value: 'Concluir' } });
    fireEvent.click(view.getByRole('button', { name: 'Enviar' }));
    fireEvent.click(await view.findByRole('button', { name: 'Confirmar e preencher a Spec' }));

    expect(await view.findByRole('alert')).toHaveTextContent(
      'A proposta do Agent não alterou nenhum campo da especificação.',
    );
    expect(save).not.toHaveBeenCalled();
    expect(
      view.queryByRole('button', { name: 'Confirmar e preencher a Spec' }),
    ).not.toBeInTheDocument();
  });

  it('protects templates for non-managers and renders empty states', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getSpecTemplates').mockResolvedValue([]);
    vi.spyOn(client, 'getSpecifications').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    const view = render(
      <SpecView apiClient={client} activeWorkspaceId="w1" canManageTemplates={false} />,
    );
    expect(await view.findByText('Nenhuma especificação salva.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    expect(view.getByText('Apenas gestores podem personalizar templates.')).toBeInTheDocument();
    expect(
      view.queryByText('Nenhuma especificação salva neste workspace.'),
    ).not.toBeInTheDocument();
  });

  it('surfaces load and action failures', async () => {
    const loadClient = new ApiClient();
    vi.spyOn(loadClient, 'getSpecTemplates').mockRejectedValue(new Error('Carga indisponível'));
    vi.spyOn(loadClient, 'getSpecifications').mockResolvedValue([]);
    vi.spyOn(loadClient, 'getAgents').mockResolvedValue([]);
    const failed = render(<SpecView apiClient={loadClient} activeWorkspaceId="w1" />);
    expect(await failed.findByRole('alert')).toHaveTextContent('Carga indisponível');
    failed.unmount();

    const client = clientWithData();
    vi.spyOn(client, 'saveSpecTemplate').mockRejectedValue('template');
    vi.spyOn(client, 'saveSpecification').mockRejectedValue(new Error('Spec indisponível'));
    vi.spyOn(client, 'chatSpecification').mockRejectedValue(new Error('Chat indisponível'));
    vi.spyOn(client, 'exportSpecification').mockRejectedValue('export');
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    await view.findByRole('button', { name: 'Login' });
    fireEvent.click(view.getByRole('button', { name: 'Salvar especificação' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Spec indisponível');
    fireEvent.click(view.getByRole('button', { name: 'Login' }));
    fireEvent.change(view.getByLabelText('Mensagem para o Agent'), { target: { value: 'Oi' } });
    fireEvent.click(view.getByRole('button', { name: 'Enviar' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Chat indisponível');
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Exportar .md' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Falha ao exportar especificação.');
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Editar' }));
    fireEvent.click(view.getByRole('button', { name: 'Salvar template' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Falha ao salvar template.');
  });

  it('does not load without a workspace', () => {
    const client = new ApiClient();
    const view = render(<SpecView apiClient={client} activeWorkspaceId={null} />);
    expect(view.getByTestId('screen-spec')).toBeInTheDocument();
    const send = view.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    send.disabled = false;
    fireEvent.click(send);
  });

  it('deletes saved specifications with confirmation and reports failures', async () => {
    const client = clientWithData();
    const deletion = vi.spyOn(client, 'deleteSpecification').mockResolvedValue();
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    await view.findByRole('button', { name: 'Login' });
    fireEvent.click(view.getByRole('button', { name: 'Login' }));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }),
    );
    expect(deletion).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(deletion).toHaveBeenCalledWith('s1'));
    expect(view.getByRole('status')).toHaveTextContent('Especificação excluída com sucesso.');
    fireEvent.click(view.getByRole('button', { name: 'Fechar notificação' }));
    expect(view.queryByRole('status')).not.toBeInTheDocument();

    deletion.mockRejectedValueOnce(new Error('Não foi possível excluir'));
    fireEvent.click(view.getByRole('button', { name: 'Sem vínculos' }));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível excluir');
  });

  it('renders a collapsible hierarchy and creates a subspecification', async () => {
    const client = clientWithData();
    vi.spyOn(client, 'saveSpecification').mockImplementation(async (input) => ({
      ...childSpec,
      ...input,
      id: 's-new-child',
      parentId: input.parentId,
    }));
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);

    expect(await view.findByRole('button', { name: 'Permissões do login' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Recolher Login' }));
    expect(view.queryByRole('button', { name: 'Permissões do login' })).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Expandir Login' }));
    fireEvent.click(view.getByRole('button', { name: 'Login' }));
    fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
    fireEvent.click(view.getByRole('button', { name: 'Nova subespecificação' }));
    fireEvent.click(view.getByRole('button', { name: 'Salvar especificação' }));

    await waitFor(() =>
      expect(client.saveSpecification).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 's1', title: 'Nova subespecificação' }),
      ),
    );
  });

  it('renders the complete feature in English', async () => {
    const client = clientWithData();
    const view = render(
      <I18nProvider initialLocale="en-US">
        <SpecView apiClient={client} activeWorkspaceId="w1" />
      </I18nProvider>,
    );

    expect(await view.findByRole('heading', { name: 'New specification' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Collapse Login' })).toBeInTheDocument();
    expect(view.getByRole('combobox', { name: 'Agent collaboration' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    expect(view.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(view.getByLabelText('Template name')).toHaveAttribute('readonly');
  });
});

it('renders specification Markdown and preserves its source when editing', async () => {
  const client = clientWithData();
  const markdown =
    '## Security\n\n- **HTTPS** required\n\n| Status | Meaning |\n| --- | --- |\n| 400 | Invalid input |';
  vi.mocked(client.getSpecifications).mockResolvedValue([
    { ...spec, sections: [{ ...spec.sections[0]!, content: markdown }, spec.sections[1]!] },
  ]);
  const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
  fireEvent.click(await view.findByRole('button', { name: 'Login' }));
  expect(view.getByRole('region', { name: 'Objetivo' })).toHaveTextContent('HTTPS required');
  expect(view.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
  expect(view.getByRole('table')).toHaveTextContent('Invalid input');
  expect(view.queryByRole('textbox', { name: 'Objetivo' })).not.toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: 'A\u00e7\u00f5es' }));
  fireEvent.click(view.getByRole('button', { name: 'Editar' }));
  expect((view.getByRole('textbox', { name: 'Objetivo' }) as HTMLTextAreaElement).value).toBe(
    markdown,
  );
});

it('clears chat and pending proposals in the Spec screen without changing completed fields', async () => {
  const client = clientWithData();
  vi.spyOn(client, 'clearSpecificationMessages').mockResolvedValue({ ...spec, messages: [] });
  const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
  fireEvent.click(await view.findByRole('button', { name: 'Login' }));
  expect(view.getByText('Revise permissões')).toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: 'Ações' }));
  fireEvent.click(view.getByRole('button', { name: 'Limpar contexto' }));
  fireEvent.click(within(view.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(view.queryByText('Revise permissões')).not.toBeInTheDocument());
  expect(view.getByRole('region', { name: 'Objetivo' })).toHaveTextContent('Permitir acesso');
  fireEvent.click(view.getByRole('button', { name: 'Ações' }));
  expect(
    (view.getByRole('button', { name: 'Limpar contexto' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(view.getByRole('button', { name: 'Criar documento no Brain' })).toBeInTheDocument();
});

const accessWith = (modules: ModuleAccessMap): EffectiveAccess => ({
  ...FULL_ACCESS,
  modules: { ...FULL_ACCESS.modules, ...modules },
});

describe('SpecView permissions', () => {
  it('shows viewers a saved specification with no write, chat or delete controls', async () => {
    const client = clientWithData();
    vi.mocked(client.getSpecifications).mockResolvedValue([
      { ...spec, proposal: { sections: [{ templateSectionId: 'objective', content: 'Novo' }] } },
    ]);
    const view = render(
      <PermissionsProvider access={accessWith({ specs: 'view', testplans: 'view' })}>
        <SpecView apiClient={client} activeWorkspaceId="w1" isReadOnly />
      </PermissionsProvider>,
    );
    expect(await view.findByDisplayValue('Login')).toHaveAttribute('readonly');
    expect(view.getByRole('region', { name: 'Objetivo' })).toHaveTextContent('Permitir acesso');
    expect(view.getByText('Revise permissões')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Criar nova' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Salvar especificação' })).not.toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Colaboração com Agent' })).not.toBeInTheDocument();
    expect(view.queryByLabelText('Mensagem para o Agent')).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
    expect(
      view.queryByRole('button', { name: 'Confirmar e preencher a Spec' }),
    ).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    expect(view.getByRole('button', { name: 'Exportar .md' })).toBeInTheDocument();
    for (const name of [
      'Editar',
      'Nova subespecificação',
      'Nova especificação',
      'Excluir',
      'Limpar contexto',
      'Criar documento no Brain',
      'Gerar testes',
    ])
      expect(view.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('tells viewers when there is no specification to read', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getSpecTemplates').mockResolvedValue([template]);
    vi.spyOn(client, 'getSpecifications').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" isReadOnly />);
    await waitFor(() => expect(view.getAllByText('Nenhuma especificação salva.')).toHaveLength(2));
    expect(view.queryByRole('heading', { name: 'Nova especificação' })).not.toBeInTheDocument();
    expect(view.queryByLabelText('Título')).not.toBeInTheDocument();
  });

  it('lets viewers with Test Plans write access generate tests from a specification', async () => {
    const client = clientWithData();
    const view = render(
      <PermissionsProvider access={accessWith({ specs: 'view', testplans: 'edit' })}>
        <SpecView apiClient={client} activeWorkspaceId="w1" isReadOnly />
      </PermissionsProvider>,
    );
    await view.findByDisplayValue('Login');
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    expect(view.getByRole('button', { name: 'Gerar testes' })).toBeInTheDocument();
  });

  it('keeps editing but hides deletion for editors without delete access', async () => {
    const client = clientWithData();
    const view = render(
      <PermissionsProvider access={accessWith({ specs: 'edit', testplans: 'none' })}>
        <SpecView apiClient={client} activeWorkspaceId="w1" />
      </PermissionsProvider>,
    );
    fireEvent.click(await view.findByRole('button', { name: 'Login' }));
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    expect(view.getByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Nova subespecificação' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Gerar testes' })).not.toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Criar nova' })).toBeInTheDocument();
    expect(view.getByLabelText('Mensagem para o Agent')).toBeInTheDocument();
  });
});

it('hides the new write actions for viewers and publication without Brain write permission', async () => {
  const client = clientWithData();
  const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" isReadOnly />);
  fireEvent.click(await view.findByRole('button', { name: 'Login' }));
  expect(view.queryByRole('button', { name: 'Limpar contexto' })).not.toBeInTheDocument();
  expect(view.queryByRole('button', { name: 'Criar documento no Brain' })).not.toBeInTheDocument();
  view.rerender(<SpecView apiClient={client} activeWorkspaceId="w1" canPublishToBrain={false} />);
  expect(view.queryByRole('button', { name: 'Criar documento no Brain' })).not.toBeInTheDocument();
});
