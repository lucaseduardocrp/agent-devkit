import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainView } from '../src/features/brain/BrainView.js';
import { ApiClient, type KnowledgeDocumentDto } from '../src/lib/api-client.js';
import type { CustomAgentDto, ExecuteAgentResponse } from '../src/features/agents/agent-types.js';

const appDoc: KnowledgeDocumentDto = {
  id: 'app://local?title=Alpha:a',
  pageId: 'a',
  source: 'app://local?title=Alpha',
  title: 'Alpha',
  content: '# Alpha\n\nBody',
  chunksCount: 1,
  totalCharacters: 10,
  updatedAt: 'now',
  isCustom: true,
};
const otherDoc: KnowledgeDocumentDto = {
  ...appDoc,
  id: 'app://local?title=Beta:b',
  pageId: 'b',
  source: 'app://local?title=Beta',
  title: 'Beta',
};
const externalDoc: KnowledgeDocumentDto = {
  id: 'ext',
  pageId: 'e',
  source: 'https://dev.azure.com/org/_wiki/External',
  title: 'External',
  content: '# External\n\nRemote text',
  chunksCount: 1,
  totalCharacters: 10,
  updatedAt: 'now',
  isCustom: false,
};

function createClient(
  documents: readonly KnowledgeDocumentDto[] = [appDoc, otherDoc, externalDoc],
) {
  const client = new ApiClient();
  vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
    documentsCount: documents.length,
    chunksCount: documents.length,
  });
  vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([...documents]);
  vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([
    { sourcePageId: 'e', targetPageId: 'a', createdAt: 'now' },
  ]);
  vi.spyOn(client, 'getAgents').mockResolvedValue([
    { id: 'writer', name: 'Writer' } as CustomAgentDto,
  ]);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrainView document links', () => {
  it('adds links, reports failures, opens linked documents and copies external ones', async () => {
    const client = createClient();
    const createRelation = vi
      .spyOn(client, 'createKnowledgeRelation')
      .mockResolvedValueOnce([
        { sourcePageId: 'e', targetPageId: 'a', createdAt: 'now' },
        { sourcePageId: 'a', targetPageId: 'b', createdAt: 'now' },
      ])
      .mockRejectedValueOnce(new Error('Relation exists'))
      .mockRejectedValueOnce('offline');
    const view = render(
      <BrainView apiClient={client} initialDocuments={[appDoc, otherDoc, externalDoc]} />,
    );
    fireEvent.click(await view.findByTestId(`tree-item-${appDoc.id}`));

    const links = view.getByLabelText('Links do documento');
    await within(links).findByRole('button', { name: 'External' });
    const select = view.getByLabelText('Documento para vincular') as HTMLSelectElement;
    expect(within(select).queryByRole('option', { name: 'Alpha' })).toBeNull();
    const addLink = view.getByRole('button', { name: 'Adicionar link' });
    expect((addLink as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'b' } });
    fireEvent.click(addLink);
    await waitFor(() =>
      expect(view.getByTestId('sync-feedback')).toHaveTextContent('Link adicionado ao documento.'),
    );
    expect(createRelation).toHaveBeenCalledWith('a', 'b');
    expect(select.value).toBe('');
    expect(within(links).getByRole('button', { name: 'Beta' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'b' } });
    fireEvent.click(addLink);
    await waitFor(() =>
      expect(view.getByTestId('sync-feedback')).toHaveTextContent('Relation exists'),
    );
    fireEvent.click(addLink);
    await waitFor(() =>
      expect(view.getByTestId('sync-feedback')).toHaveTextContent('Falha ao adicionar link.'),
    );

    fireEvent.click(within(links).getByRole('button', { name: 'External' }));
    await waitFor(() =>
      expect(view.getAllByTestId('tab-active-doc').map((tab) => tab.textContent)).toEqual([
        expect.stringContaining('Alpha') as string,
        expect.stringContaining('External') as string,
      ]),
    );
    expect(view.queryByTestId('btn-edit-document')).toBeNull();

    fireEvent.click(view.getByTestId('btn-copy-document'));
    expect((view.getByTestId('input-document-title') as HTMLInputElement).value).toBe('External');
    expect((view.getByTestId('textarea-document-content') as HTMLTextAreaElement).value).toBe(
      'Remote text',
    );
  });

  it('describes the deletion of an application document without the external warning', async () => {
    const client = createClient();
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${appDoc.id}`));
    fireEvent.click(view.getByTestId('btn-delete-document'));
    const modal = view.getByTestId('modal-confirm-delete');
    expect(modal).toHaveTextContent('Alpha');
    expect(modal.textContent).not.toMatch(/apenas do app|externa|origem/i);
    fireEvent.click(view.getByTestId('btn-cancel-delete'));
    expect(view.queryByTestId('modal-confirm-delete')).toBeNull();
  });
});

describe('BrainView documentation assistant', () => {
  it('chats with the selected agent, handles failures and inserts the reply', async () => {
    const client = createClient();
    const reply = { content: '## Suggestion' } as ExecuteAgentResponse;
    const execute = vi
      .spyOn(client, 'executeAgent')
      .mockResolvedValueOnce(reply)
      .mockRejectedValueOnce(new Error('Model offline'))
      .mockRejectedValueOnce('down');
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    fireEvent.click(view.getByTestId('btn-create-document'));
    const sidebar = view.getByTestId('brain-agent-sidebar');
    const agentSelect = within(sidebar).getByLabelText('Selecionar um agente');
    await within(agentSelect).findByRole('option', { name: 'Writer' });
    fireEvent.change(agentSelect, { target: { value: 'writer' } });

    const editor = view.getByTestId('textarea-document-content') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Intro', selectionStart: 5 } });
    const prompt = within(sidebar).getByLabelText(/Peça para criar/);
    const send = within(sidebar).getByRole('button', { name: 'Ações' });

    fireEvent.change(prompt, { target: { value: '  Write an overview  ' } });
    fireEvent.click(send);
    expect(await within(sidebar).findByText('Suggestion')).toBeInTheDocument();
    expect(within(sidebar).getByText('Write an overview')).toBeInTheDocument();
    expect(execute).toHaveBeenCalledWith(
      'writer',
      expect.objectContaining({
        useKnowledge: true,
        prompt: expect.stringContaining('Título: Sem título') as string,
      }),
    );

    fireEvent.change(view.getByTestId('input-document-title'), { target: { value: 'Guide' } });
    fireEvent.change(prompt, { target: { value: 'Improve it' } });
    fireEvent.click(send);
    expect(await within(sidebar).findByRole('alert')).toHaveTextContent('Model offline');
    const secondPrompt = execute.mock.calls[1]![1].prompt;
    expect(secondPrompt).toContain('Título: Guide');
    expect(secondPrompt).toContain('Assistente: ## Suggestion');

    fireEvent.change(prompt, { target: { value: 'Again' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(within(sidebar).getByRole('alert')).toHaveTextContent(
        'Não foi possível consultar o agente.',
      ),
    );

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Inserir no documento' }));
    expect(editor.value).toBe('Intro\n\n## Suggestion');

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Limpar contexto da conversa' }));
    expect(within(sidebar).queryByText('Suggestion')).toBeNull();
    expect(within(sidebar).queryByRole('alert')).toBeNull();
  });

  it('inserts the reply at the end of an empty document', async () => {
    const client = createClient();
    vi.spyOn(client, 'executeAgent').mockResolvedValue({
      content: 'Generated text',
    } as ExecuteAgentResponse);
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    fireEvent.click(view.getByTestId('btn-create-document'));
    const sidebar = view.getByTestId('brain-agent-sidebar');
    const agentSelect = within(sidebar).getByLabelText('Selecionar um agente');
    await within(agentSelect).findByRole('option', { name: 'Writer' });
    fireEvent.change(agentSelect, { target: { value: 'writer' } });
    fireEvent.change(within(sidebar).getByLabelText(/Peça para criar/), {
      target: { value: 'Draft' },
    });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Ações' }));
    fireEvent.click(await within(sidebar).findByRole('button', { name: 'Inserir no documento' }));
    expect((view.getByTestId('textarea-document-content') as HTMLTextAreaElement).value).toBe(
      'Generated text',
    );
  });
});

describe('BrainView research sidebar', () => {
  it('asks the Brain with conversation history, reports failures, clears and minimizes', async () => {
    const client = createClient();
    const query = vi
      .spyOn(client, 'queryBrain')
      .mockResolvedValueOnce({ content: 'Brain **answer**', agentName: 'Brain' })
      .mockRejectedValueOnce(new Error('Brain offline'))
      .mockRejectedValueOnce('down');
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    const sidebar = view.getByTestId('brain-research-sidebar');
    const prompt = within(sidebar).getByLabelText('Pergunte algo sobre o Brain…');

    fireEvent.change(prompt, { target: { value: 'What is Alpha?' } });
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(prompt, { key: 'a' });
    expect(query).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(await within(sidebar).findByText('answer')).toBeInTheDocument();
    expect(query).toHaveBeenNthCalledWith(1, 'What is Alpha?', undefined);

    fireEvent.change(prompt, { target: { value: 'More?' } });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Perguntar' }));
    expect(await within(sidebar).findByRole('alert')).toHaveTextContent('Brain offline');
    expect(query.mock.calls[1]![1]).toBe('Usuário: What is Alpha?\n\nAgente: Brain **answer**');

    fireEvent.change(prompt, { target: { value: 'Last' } });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Perguntar' }));
    await waitFor(() =>
      expect(within(sidebar).getByRole('alert')).toHaveTextContent(
        'Não foi possível consultar o Brain.',
      ),
    );

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Limpar contexto da pesquisa' }));
    expect(within(sidebar).queryByText('answer')).toBeNull();
    expect(within(sidebar).queryByRole('alert')).toBeNull();

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Minimizar pesquisa no Brain' }));
    expect(view.queryByTestId('brain-research-sidebar')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Abrir pesquisa no Brain' }));
    expect(view.getByTestId('brain-research-sidebar')).toBeInTheDocument();
  });
});

describe('BrainView publishing', () => {
  it('renames the open tab to the published document', async () => {
    const client = createClient([appDoc]);
    const published = { ...appDoc, id: 'published-id', title: 'Alpha (Wiki)' };
    vi.spyOn(client, 'getKnowledgePushProviders').mockResolvedValue([
      { providerId: 'azure_devops_wiki', name: 'Azure DevOps Wiki', settings: {} },
    ]);
    vi.spyOn(client, 'getKnowledgePushDestinations').mockResolvedValue([]);
    vi.spyOn(client, 'pushKnowledgeDocument').mockImplementation(() => {
      vi.mocked(client.getKnowledgeDocuments).mockResolvedValue([published]);
      return Promise.resolve({
        success: true as const,
        remoteUrl: 'https://wiki/alpha',
        published: [{ oldId: appDoc.id, newId: 'published-id', remoteUrl: 'https://wiki/alpha' }],
      });
    });
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${appDoc.id}`));
    fireEvent.click(view.getByTestId('btn-push-document'));
    const dialog = await view.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Azure DevOps Wiki' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fazer push' }));
    await waitFor(() =>
      expect(view.getByTestId('tab-active-doc')).toHaveTextContent('Alpha (Wiki)'),
    );
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
