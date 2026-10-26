import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomAgentDto, ExecuteAgentResponse } from '../src/features/agents/agent-types.js';
import { BrainView } from '../src/features/brain/BrainView.js';
import { ApiClient, type KnowledgeDocumentDto } from '../src/lib/api-client.js';

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
const externalDoc: KnowledgeDocumentDto = {
  id: 'ext',
  pageId: 'e',
  source: 'https://dev.azure.com/org/_wiki/External',
  title: 'External',
  chunksCount: 1,
  totalCharacters: 10,
  updatedAt: 'now',
  isCustom: false,
};

function createClient(documents: readonly KnowledgeDocumentDto[]) {
  const client = new ApiClient();
  vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
    documentsCount: documents.length,
    chunksCount: documents.length,
  });
  vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([...documents]);
  vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
  vi.spyOn(client, 'getAgents').mockResolvedValue([
    { id: 'writer', name: 'Writer' } as CustomAgentDto,
  ]);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrainView external documents', () => {
  it('copies an external document without loaded content into an empty draft', async () => {
    const client = createClient([externalDoc]);
    const view = render(<BrainView apiClient={client} initialDocuments={[externalDoc]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${externalDoc.id}`));
    fireEvent.click(view.getByTestId('btn-copy-document'));
    expect((view.getByTestId('input-document-title') as HTMLInputElement).value).toBe('External');
    expect((view.getByTestId('textarea-document-content') as HTMLTextAreaElement).value).toBe('');
  });

  it('warns that deleting an external document keeps the original at its source', async () => {
    const client = createClient([externalDoc]);
    const view = render(<BrainView apiClient={client} initialDocuments={[externalDoc]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${externalDoc.id}`));
    fireEvent.click(view.getByTestId('btn-delete-document'));
    const modal = view.getByTestId('modal-confirm-delete');
    expect(modal).toHaveTextContent('External');
    expect(modal).toHaveTextContent('O original no Azure será preservado.');
  });
});

describe('BrainView assistants', () => {
  it('does not ask the Brain when Enter is pressed on an empty question', async () => {
    const client = createClient([appDoc]);
    const query = vi.spyOn(client, 'queryBrain');
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    const sidebar = view.getByTestId('brain-research-sidebar');
    const prompt = within(sidebar).getByLabelText('Pergunte algo sobre o Brain…');
    fireEvent.change(prompt, { target: { value: '   ' } });
    fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(query).not.toHaveBeenCalled();
    expect(within(sidebar).queryByRole('alert')).toBeNull();
  });

  it('appends the reply to the end of the draft while the preview is shown', async () => {
    const client = createClient([appDoc]);
    vi.spyOn(client, 'executeAgent').mockResolvedValue({
      content: 'Generated text',
    } as ExecuteAgentResponse);
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    fireEvent.click(view.getByTestId('btn-create-document'));
    fireEvent.change(view.getByTestId('textarea-document-content'), {
      target: { value: 'Intro', selectionStart: 0 },
    });
    const sidebar = view.getByTestId('brain-agent-sidebar');
    const agentSelect = within(sidebar).getByLabelText('Selecionar um agente');
    await within(agentSelect).findByRole('option', { name: 'Writer' });
    fireEvent.change(agentSelect, { target: { value: 'writer' } });
    fireEvent.change(within(sidebar).getByLabelText(/Peça para criar/), {
      target: { value: 'Draft' },
    });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Ações' }));
    const insert = await within(sidebar).findByRole('button', { name: 'Inserir no documento' });

    fireEvent.click(view.getByTestId('btn-toggle-edit-preview'));
    expect(view.getByTestId('editor-preview-container')).toBeInTheDocument();
    fireEvent.click(insert);
    fireEvent.click(view.getByTestId('btn-toggle-edit-preview'));
    expect((view.getByTestId('textarea-document-content') as HTMLTextAreaElement).value).toBe(
      'Intro\n\nGenerated text',
    );
  });

  it('keeps the request when the API client is no longer available', async () => {
    const client = createClient([appDoc]);
    const execute = vi.spyOn(client, 'executeAgent');
    const view = render(<BrainView apiClient={client} initialDocuments={[appDoc]} />);
    fireEvent.click(view.getByTestId('btn-create-document'));
    const sidebar = view.getByTestId('brain-agent-sidebar');
    const agentSelect = within(sidebar).getByLabelText('Selecionar um agente');
    await within(agentSelect).findByRole('option', { name: 'Writer' });
    fireEvent.change(agentSelect, { target: { value: 'writer' } });
    const prompt = within(sidebar).getByLabelText<HTMLTextAreaElement>(/Peça para criar/);
    fireEvent.change(prompt, { target: { value: 'Draft' } });

    view.rerender(<BrainView initialDocuments={[appDoc]} />);
    fireEvent.click(
      within(view.getByTestId('brain-agent-sidebar')).getByRole('button', { name: 'Ações' }),
    );
    await waitFor(() => expect(prompt.value).toBe('Draft'));
    expect(execute).not.toHaveBeenCalled();
  });
});
