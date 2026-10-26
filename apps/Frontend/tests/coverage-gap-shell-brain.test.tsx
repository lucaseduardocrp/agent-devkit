import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainView } from '../src/features/brain/BrainView.js';
import { MediaProvider } from '../src/features/shared/media.js';
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
const diagram = {
  id: 'att-1',
  name: 'diagrama.png',
  kind: 'image' as const,
  scope: 'brain' as const,
  source: 'url' as const,
  url: 'https://example.com/diagrama.png',
};

function createClient() {
  const client = new ApiClient();
  vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 1, chunksCount: 1 });
  vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([appDoc]);
  vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
  vi.spyOn(client, 'getAgents').mockResolvedValue([]);
  vi.spyOn(client, 'getDocumentAttachments').mockResolvedValue([diagram]);
  return client;
}

afterEach(() => vi.restoreAllMocks());

async function editAlpha(client: ApiClient) {
  render(
    <MediaProvider apiClient={client}>
      <BrainView apiClient={client} initialDocuments={[appDoc]} />
    </MediaProvider>,
  );
  fireEvent.click(await screen.findByTestId(`tree-item-${appDoc.id}`));
  await waitFor(() => expect(client.getDocumentAttachments).toHaveBeenCalledWith('a'));
  expect(await screen.findByRole('button', { name: 'Baixar: diagrama.png' })).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('btn-edit-document'));
  return screen.getByTestId<HTMLTextAreaElement>('textarea-document-content');
}

describe('BrainView attachments while editing', () => {
  it('inserts an attachment in the text and saves the changed attachments', async () => {
    const client = createClient();
    const update = vi
      .spyOn(client, 'updateKnowledgeDocument')
      .mockImplementation(async (_pageId, title, content) => ({ ...appDoc, title, content }));
    const saveAttachments = vi.spyOn(client, 'saveDocumentAttachments').mockResolvedValue([]);
    const editor = await editAlpha(client);
    expect(editor.value).toBe('Body');

    fireEvent.click(screen.getByRole('button', { name: 'Inserir no texto: diagrama.png' }));
    expect(editor.value).toBe('Body\n\n![diagrama.png](https://example.com/diagrama.png)\n');
    fireEvent.click(screen.getByRole('button', { name: 'Remover anexo: diagrama.png' }));
    expect(screen.queryByRole('button', { name: 'Remover anexo: diagrama.png' })).toBeNull();

    fireEvent.click(screen.getByTestId('btn-save-document'));
    await waitFor(() => expect(saveAttachments).toHaveBeenCalledWith('a', []));
    expect(update).toHaveBeenCalledWith(
      'a',
      'Alpha',
      'Body\n\n![diagrama.png](https://example.com/diagrama.png)\n',
    );
  });

  it('inserts an attachment into an empty document without a leading blank line', async () => {
    const client = createClient();
    const editor = await editAlpha(client);
    fireEvent.change(editor, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inserir no texto: diagrama.png' }));
    expect(editor.value).toBe('![diagrama.png](https://example.com/diagrama.png)\n');
  });

  it('inserts a picked image into the text', async () => {
    const client = createClient();
    const editor = await editAlpha(client);
    const input = screen.getByTestId<HTMLInputElement>('input-document-image');
    const file = new File(['png'], 'tela.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(editor.value).toContain('tela.png'));
  });
});
