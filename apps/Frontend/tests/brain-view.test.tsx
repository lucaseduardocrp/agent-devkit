import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrainView } from '../src/features/brain/BrainView.js';
import { stripLeadingTitleHeading } from '../src/features/brain/markdown-parser.js';
import { ApiClient } from '../src/lib/api-client.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type { EffectiveAccess } from '../src/features/workspaces/workspace-types.js';

describe('BrainView', () => {
  it('creates a new document with a wikilink correlation', async () => {
    const client = new ApiClient();
    const target = {
      id: 'target',
      pageId: 'target',
      source: 'app://target',
      title: 'Target',
      content: 'Target',
      chunksCount: 1,
      totalCharacters: 6,
      updatedAt: 'now',
      isCustom: true,
    };
    const created = { ...target, id: 'created', pageId: 'created', title: 'Created' };
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 2, chunksCount: 2 });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([target]);
    vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
    vi.spyOn(client, 'createKnowledgeDocument').mockResolvedValue(created);
    const createRelation = vi
      .spyOn(client, 'createKnowledgeRelation')
      .mockResolvedValue([{ sourcePageId: 'created', targetPageId: 'target', createdAt: 'now' }]);
    const view = render(<BrainView apiClient={client} initialDocuments={[target]} />);

    fireEvent.click(view.getByTestId('btn-create-document'));
    fireEvent.change(view.getByTestId('input-document-title'), {
      target: { value: 'Created' },
    });
    const editor = view.getByTestId('textarea-document-content');
    fireEvent.change(editor, { target: { value: '[[', selectionStart: 2 } });
    fireEvent.click(view.getByRole('option', { name: 'Target' }));
    fireEvent.click(view.getByTestId('btn-save-document'));

    await waitFor(() => expect(createRelation).toHaveBeenCalledWith('created', 'target'));
  });

  it('inserts and persists multiple document correlations with wikilink autocomplete', async () => {
    const client = new ApiClient();
    const first = {
      id: 'first',
      pageId: 'first',
      source: 'app://first',
      title: 'First',
      content: '# First',
      chunksCount: 1,
      totalCharacters: 7,
      updatedAt: 'now',
      isCustom: true,
    };
    const second = { ...first, id: 'second', pageId: 'second', title: 'Second' };
    const third = { ...first, id: 'third', pageId: 'third', title: 'Third' };
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 3, chunksCount: 3 });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([first, second, third]);
    vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
    vi.spyOn(client, 'updateKnowledgeDocument').mockResolvedValue(first);
    const createRelation = vi
      .spyOn(client, 'createKnowledgeRelation')
      .mockResolvedValueOnce([{ sourcePageId: 'first', targetPageId: 'second', createdAt: 'now' }])
      .mockResolvedValue([
        { sourcePageId: 'first', targetPageId: 'second', createdAt: 'now' },
        { sourcePageId: 'first', targetPageId: 'third', createdAt: 'now' },
      ]);
    const view = render(<BrainView apiClient={client} initialDocuments={[first, second, third]} />);

    fireEvent.click(await view.findByTestId('tree-item-first'));
    fireEvent.click(view.getByTestId('btn-edit-document'));
    const editor = view.getByTestId('textarea-document-content');
    fireEvent.change(editor, { target: { value: 'Links: [[', selectionStart: 9 } });
    expect(
      view.getByRole('listbox', { name: 'Documentos para correlacionar' }),
    ).toBeInTheDocument();
    expect(view.queryByRole('option', { name: 'First' })).not.toBeInTheDocument();
    fireEvent.mouseDown(view.getByRole('option', { name: 'Second' }));
    fireEvent.click(view.getByRole('option', { name: 'Second' }));
    expect((editor as HTMLTextAreaElement).value).toBe('Links: [[Second]]');

    const nextValue = 'Links: [[Second]] e [[Thi';
    fireEvent.change(editor, {
      target: { value: nextValue, selectionStart: nextValue.length },
    });
    expect(view.queryByRole('option', { name: 'Second' })).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect((editor as HTMLTextAreaElement).value).toBe('Links: [[Second]] e [[Third]]');

    const missingValue = 'Links: [[Second]] e [[Third]] e [[Missing';
    fireEvent.change(editor, {
      target: { value: missingValue, selectionStart: missingValue.length },
    });
    expect(view.getByText('Nenhum documento encontrado.')).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: 'x' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(view.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: 'Enter' });

    fireEvent.click(view.getByTestId('btn-save-document'));
    await waitFor(() => expect(createRelation).toHaveBeenCalledTimes(2));
    expect(createRelation).toHaveBeenNthCalledWith(1, 'first', 'second');
    expect(createRelation).toHaveBeenNthCalledWith(2, 'first', 'third');
  });

  it('opens wikilinks and builds graph edges only from resolvable document links', async () => {
    const client = new ApiClient();
    const first = {
      id: 'app://local?title=First:doc-1',
      pageId: 'doc-1',
      source: 'app://local?title=First',
      title: 'First',
      content: '# First\n\n[[Second]] [[Second|Alias]] [[Missing]]',
      chunksCount: 1,
      totalCharacters: 7,
      updatedAt: '2026-09-15',
      isCustom: true,
    };
    const second = {
      ...first,
      id: 'app://local?title=Second:doc-2',
      pageId: 'doc-2',
      title: 'Second',
      content: '# Second\n\n[[First]]',
    };
    const third = {
      ...first,
      id: 'app://local?title=Third:doc-3',
      pageId: 'doc-3',
      title: 'Third',
      content: '# Third',
    };
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 3, chunksCount: 3 });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([first, second, third]);
    vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
    const view = render(<BrainView apiClient={client} initialDocuments={[first, second, third]} />);

    fireEvent.click(await view.findByTestId(`tree-item-${first.id}`));
    expect(view.queryByLabelText('Selecione um documento')).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Missing' }));
    expect(view.getByTestId('nav-title')).toHaveTextContent('First');
    fireEvent.click(view.getByRole('button', { name: 'Second' }));
    expect(view.getByTestId('nav-title')).toHaveTextContent('Second');
    fireEvent.click(view.getByTestId('view-btn-graph'));
    expect(view.getByText('3 notas · 1 conexões')).toBeInTheDocument();
    const firstNode = view.getByTestId(`graph-node-${first.id}`);
    fireEvent.click(firstNode);
    expect(view.getByTestId('nav-title')).toHaveTextContent('First');
    fireEvent.click(view.getByTestId('view-btn-graph'));
    fireEvent.click(view.getByTestId(`graph-node-${second.id}`));
    expect(view.getByTestId('nav-title')).toHaveTextContent('Second');
    view.unmount();
  });

  it('publishes a child document at the chosen Wiki path and keeps the local hierarchy', async () => {
    const client = new ApiClient();
    const native = {
      id: 'app://local?title=Note:doc-1',
      pageId: 'doc-1',
      source: 'app://local?title=Note',
      title: 'Note',
      content: '# Note',
      chunksCount: 1,
      totalCharacters: 6,
      updatedAt: '2026-09-14',
      isCustom: true,
    };
    const nativeChild = {
      ...native,
      id: 'app://local?title=Child&parentPageId=doc-1:doc-2',
      pageId: 'doc-2',
      source: 'app://local?title=Child&parentPageId=doc-1',
      title: 'Child',
      content: '# Child',
      parentPageId: 'doc-1',
    };
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([native, nativeChild]);
    vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 2, chunksCount: 2 });
    vi.spyOn(client, 'getKnowledgePushProviders').mockResolvedValue([
      {
        providerId: 'azure_devops_wiki',
        name: 'Azure DevOps Wiki',
        settings: { wikiIdentifier: 'wiki' },
      },
    ]);
    vi.spyOn(client, 'getKnowledgePushDestinations').mockResolvedValue([]);
    const push = vi.spyOn(client, 'pushKnowledgeDocument').mockResolvedValue({
      success: true,
      remoteUrl: 'https://dev.azure.com/wiki?pagePath=%2FDoc%201%2FDoc%203%2FChild',
      published: [],
    });
    const { getByTestId, findByTestId, findByRole } = render(
      <BrainView apiClient={client} initialDocuments={[native, nativeChild]} />,
    );
    fireEvent.click(await findByTestId(`tree-item-${nativeChild.id}`));
    fireEvent.click(getByTestId('btn-push-document'));
    const dialog = await findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Azure DevOps Wiki' });
    const path = within(dialog).getByLabelText<HTMLInputElement>('Caminho da pasta ou página pai');
    expect(path.value).toBe('/Note');
    fireEvent.change(path, { target: { value: '/Doc 1/Doc 3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fazer push' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('doc-2', {
        providerId: 'azure_devops_wiki',
        destination: { parentPath: '/Doc 1/Doc 3', wikiIdentifier: 'wiki' },
      }),
    );
    expect(getByTestId(`tree-item-${native.id}`)).toBeInTheDocument();
    expect(getByTestId(`tree-item-${nativeChild.id}`)).toBeInTheDocument();
    expect(getByTestId('sync-feedback').querySelector('a')).toHaveAttribute(
      'href',
      'https://dev.azure.com/wiki?pagePath=%2FDoc%201%2FDoc%203%2FChild',
    );
  });
  it('switches the push form to a Trello list and sends its destination', async () => {
    const client = new ApiClient();
    const document = {
      id: 'app://local?title=Note:doc-1',
      pageId: 'doc-1',
      source: 'app://local?title=Note',
      title: 'Note',
      content: '# Note',
      chunksCount: 1,
      totalCharacters: 6,
      updatedAt: '2026-09-14',
      isCustom: true,
    };
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([document]);
    vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 1, chunksCount: 1 });
    vi.spyOn(client, 'getKnowledgePushProviders').mockResolvedValue([
      { providerId: 'azure_devops_wiki', name: 'Azure DevOps Wiki', settings: {} },
      { providerId: 'trello', name: 'Trello', settings: { boardId: 'board-1' } },
    ]);
    vi.spyOn(client, 'getKnowledgePushDestinations').mockImplementation(async (providerId) =>
      providerId === 'trello' ? [{ id: 'list-1', label: 'Documentation' }] : [],
    );
    const push = vi.spyOn(client, 'pushKnowledgeDocument').mockResolvedValue({
      success: true,
      remoteUrl: 'https://trello.com/c/card',
    });
    const view = render(<BrainView apiClient={client} initialDocuments={[document]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${document.id}`));
    fireEvent.click(view.getByTestId('btn-push-document'));
    const dialog = await view.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Trello' });
    fireEvent.change(within(dialog).getByLabelText('Integração'), {
      target: { value: 'trello' },
    });
    await within(dialog).findByRole('option', { name: 'Documentation' });
    fireEvent.change(within(dialog).getByLabelText('Lista de destino'), {
      target: { value: 'list-1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fazer push' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('doc-1', {
        providerId: 'trello',
        destination: { listId: 'list-1' },
      }),
    );
  });
  it('creates a nested native subpage and shows pulled Wiki pages as a tree', async () => {
    const client = new ApiClient();
    const parent = {
      id: 'app://local?title=Parent:doc-parent',
      pageId: 'doc-parent',
      source: 'app://local?title=Parent',
      title: 'Parent',
      content: '# Parent',
      chunksCount: 1,
      totalCharacters: 8,
      updatedAt: '2026-09-14',
      isCustom: true,
    };
    const wikiRoot = {
      id: 'https://dev.azure.com/wiki?pagePath=%2FRoot:10',
      pageId: '10',
      source: 'https://dev.azure.com/wiki?pagePath=%2FRoot',
      pagePath: '/Root',
      title: 'Root',
      chunksCount: 1,
      totalCharacters: 4,
      updatedAt: '2026-09-14',
      isCustom: false,
    };
    const wikiChild = {
      ...wikiRoot,
      id: 'https://dev.azure.com/wiki?pagePath=%2FRoot%2FChild:11',
      pageId: '11',
      source: 'https://dev.azure.com/wiki?pagePath=%2FRoot%2FChild',
      pagePath: undefined,
      title: 'Child',
    };
    const wikiGrandchild = {
      ...wikiChild,
      id: 'https://dev.azure.com/wiki?pagePath=%2FRoot%2FChild%2FNested:12',
      pageId: '12',
      source: 'https://dev.azure.com/wiki?pagePath=%2FRoot%2FChild%2FNested',
      pagePath: undefined,
      title: 'Nested',
    };
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([
      parent,
      wikiRoot,
      wikiChild,
      wikiGrandchild,
    ]);
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 4, chunksCount: 4 });
    const create = vi.spyOn(client, 'createKnowledgeDocument').mockResolvedValue({
      ...parent,
      id: 'app://local?title=Sub:doc-sub',
      pageId: 'doc-sub',
      source: 'app://local?title=Sub&parentPageId=doc-parent',
      title: 'Sub',
    });
    const { findByTestId, getByTestId, getByPlaceholderText, queryByTestId } = render(
      <BrainView apiClient={client} />,
    );
    fireEvent.click(await findByTestId(`tree-item-${parent.id}`));
    fireEvent.click(getByTestId('btn-create-subpage'));
    fireEvent.change(getByPlaceholderText('Digite o título do documento...'), {
      target: { value: 'Sub' },
    });
    fireEvent.click(getByTestId('btn-save-document'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Sub', '', undefined, 'doc-parent'));
    expect(getByTestId('tree-item-app://local?title=Sub:doc-sub').style.paddingLeft).toBe('30px');
    expect(getByTestId(`tree-item-${wikiChild.id}`).style.paddingLeft).toBe('30px');
    expect(getByTestId(`tree-item-${wikiGrandchild.id}`).style.paddingLeft).toBe('50px');

    const nativeToggle = getByTestId(`tree-toggle-${parent.id}`);
    expect(nativeToggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(nativeToggle);
    expect(queryByTestId('tree-item-app://local?title=Sub:doc-sub')).not.toBeInTheDocument();
    expect(nativeToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(nativeToggle);
    expect(getByTestId('tree-item-app://local?title=Sub:doc-sub')).toBeInTheDocument();

    const wikiToggle = getByTestId(`tree-toggle-${wikiRoot.id}`);
    fireEvent.click(wikiToggle);
    expect(queryByTestId(`tree-item-${wikiChild.id}`)).not.toBeInTheDocument();
    expect(queryByTestId(`tree-item-${wikiGrandchild.id}`)).not.toBeInTheDocument();
    fireEvent.click(wikiToggle);
    expect(getByTestId(`tree-item-${wikiChild.id}`)).toBeInTheDocument();
  });
  it('pushes a native document and reports success and failures', async () => {
    const client = new ApiClient();
    const doc = {
      id: 'app://local:doc-1',
      pageId: 'doc-1',
      source: 'app://local?title=Note',
      title: 'Note',
      content: '# Note',
      chunksCount: 1,
      totalCharacters: 6,
      updatedAt: '2026-09-14',
      isCustom: true,
    };
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 1, chunksCount: 1 });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([doc]);
    vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
    vi.spyOn(client, 'getKnowledgePushProviders').mockResolvedValue([
      { providerId: 'azure_devops_wiki', name: 'Azure DevOps Wiki', settings: {} },
    ]);
    vi.spyOn(client, 'getKnowledgePushDestinations').mockResolvedValue([]);
    const push = vi
      .spyOn(client, 'pushKnowledgeDocument')
      .mockResolvedValueOnce({ success: true, remoteUrl: 'https://dev.azure.com/page' })
      .mockRejectedValueOnce(new Error('Azure unavailable'))
      .mockRejectedValueOnce('unknown');
    const { getByTestId, findByTestId, findByRole } = render(<BrainView apiClient={client} />);
    fireEvent.click(await findByTestId('tree-item-app://local:doc-1'));
    const button = getByTestId('btn-push-document');
    fireEvent.click(button);
    let dialog = await findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Azure DevOps Wiki' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fazer push' }));
    await waitFor(() =>
      expect(getByTestId('sync-feedback')).toHaveTextContent('Documento enviado'),
    );
    expect(getByTestId('sync-feedback').querySelector('a')).toHaveAttribute(
      'href',
      'https://dev.azure.com/page',
    );
    expect(push).toHaveBeenCalledWith('doc-1', {
      providerId: 'azure_devops_wiki',
      destination: { parentPath: '', wikiIdentifier: '' },
    });
    fireEvent.click(button);
    dialog = await findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Azure DevOps Wiki' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fazer push' }));
    await waitFor(() =>
      expect(getByTestId('sync-feedback')).toHaveTextContent('Azure unavailable'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fazer push' }));
    await waitFor(() =>
      expect(getByTestId('sync-feedback')).toHaveTextContent('Falha ao enviar documento'),
    );
  });
  it('renders default statistics cards, overview tab, and empty state when no documents are loaded', () => {
    const { getByTestId } = render(<BrainView />);
    expect(getByTestId('screen-brain')).toBeInTheDocument();
    expect(getByTestId('tab-brain-overview')).toBeInTheDocument();
    expect(getByTestId('card-documentos')).toHaveTextContent('34');
    expect(getByTestId('card-sync')).toHaveTextContent('Recente');
    expect(getByTestId('empty-documents')).toBeInTheDocument();
    expect(getByTestId('folder-view')).toBeInTheDocument();
    expect(getByTestId('folder-sidebar')).toBeInTheDocument();
  });

  it('handles empty query submission gracefully', () => {
    const { getByLabelText, getByRole, queryByTestId } = render(<BrainView />);
    const form = getByRole('button', { name: 'Executar busca' });

    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: '   ' },
    });
    fireEvent.click(form);

    expect(queryByTestId('search-results')).not.toBeInTheDocument();
  });

  it('handles search submission without apiClient', () => {
    const { getByLabelText, getByRole, getByTestId } = render(<BrainView />);

    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: 'azure test' },
    });
    fireEvent.click(getByRole('button', { name: 'Executar busca' }));

    expect(getByTestId('search-results')).toHaveTextContent(
      'Nenhum conteúdo correspondente foi encontrado.',
    );
  });

  it('performs search with apiClient and displays chunks', async () => {
    const client = new ApiClient();
    const history = vi
      .spyOn(client, 'getAuditHistory')
      .mockResolvedValue({ items: [], page: 1, total: 0, totalPages: 0 });
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
      documentsCount: 1,
      chunksCount: 1,
    });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([
      {
        id: 'doc-1',
        pageId: 'page-1',
        source: 'source-1',
        title: 'Documento Existente',
        chunksCount: 1,
        totalCharacters: 100,
        updatedAt: '2026-09-11T10:00:00.000Z',
      },
    ]);
    vi.spyOn(client, 'searchKnowledge').mockResolvedValue([
      {
        source: 'source-1',
        pageId: 'page-1',
        chunkIndex: 1,
        content: 'Este é um trecho do documento existente.',
        createdAt: '2026-09-11T10:00:00.000Z',
      },
      {
        source: 'azure-docs',
        pageId: 'overview',
        chunkIndex: 2,
        content: 'Este é um trecho relevante indexado no PostgreSQL.',
        createdAt: '2026-09-11T10:00:00.000Z',
      },
    ]);

    const { getByLabelText, getByRole, getByTestId, getByText, getAllByText } = render(
      <BrainView apiClient={client} defaultOwnerId="custom-owner" />,
    );

    // Wait for initial documents load
    await waitFor(() => {
      expect(getAllByText('Documento Existente').length).toBeGreaterThan(0);
    });

    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: 'relevante' },
    });
    fireEvent.click(getByRole('button', { name: 'Executar busca' }));

    await waitFor(() => {
      expect(getByTestId('search-results')).toBeInTheDocument();
    });

    expect(getAllByText('Documento Existente').length).toBeGreaterThan(0);
    expect(getByText('overview')).toBeInTheDocument();

    // Clicking search result item matching an existing document
    fireEvent.click(getByTestId('search-result-item-1'));
    expect(queryByResults()).not.toBeInTheDocument();
    expect(getByTestId('active-document-view')).toBeInTheDocument();
    expect(getByTestId('document-actions')).toHaveClass('justify-end');
    fireEvent.click(getByRole('button', { name: 'Ações' }));
    fireEvent.click(getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(history).toHaveBeenCalledWith(
        'document',
        1,
        expect.any(AbortSignal),
        JSON.stringify(['source-1', 'page-1']),
      ),
    );
    expect(getByTestId('active-document-view').querySelector('h1')).toHaveClass(
      '[overflow-wrap:anywhere]',
    );

    // Trigger search again to click fallback document item
    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: 'relevante' },
    });
    await waitFor(() => {
      expect(getByTestId('search-results')).toBeInTheDocument();
    });
    fireEvent.click(getByTestId('search-result-item-2'));
    expect(queryByResults()).not.toBeInTheDocument();

    // Trigger search again to test clear button in input
    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: 'relevante' },
    });
    await waitFor(() => {
      expect(getByTestId('search-results')).toBeInTheDocument();
    });
    const clearBtn = getByLabelText('Limpar');
    fireEvent.click(clearBtn);
    expect(queryByResults()).not.toBeInTheDocument();

    // Trigger search again to test clear button in results card
    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: 'relevante' },
    });
    fireEvent.click(getByRole('button', { name: 'Executar busca' }));
    await waitFor(() => {
      expect(getByTestId('search-results')).toBeInTheDocument();
    });
    fireEvent.click(within(getByTestId('search-results')).getByRole('button', { name: 'Limpar' }));
    expect(queryByResults()).not.toBeInTheDocument();

    function queryByResults() {
      return getByTestId('screen-brain').querySelector('[data-testid="search-results"]');
    }
  });

  it('opens fallback document when search result is clicked before documents are loaded', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockReturnValue(new Promise(() => {}));
    vi.spyOn(client, 'getKnowledgeDocuments').mockReturnValue(new Promise(() => {}));
    vi.spyOn(client, 'searchKnowledge').mockResolvedValue([
      {
        source: 'source-only',
        pageId: '',
        chunkIndex: 1,
        content: 'Trecho sem pageId.',
        createdAt: '2026-09-11T10:00:00.000Z',
      },
    ]);

    const { getByLabelText, getByRole, getByTestId, getByText } = render(
      <BrainView apiClient={client} />,
    );

    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: 'trecho' },
    });
    fireEvent.click(getByRole('button', { name: 'Executar busca' }));

    await waitFor(() => {
      expect(getByTestId('search-results')).toBeInTheDocument();
    });

    expect(getByText('source-only')).toBeInTheDocument();
    fireEvent.click(getByTestId('search-result-item-1'));
    expect(getByTestId('active-document-view')).toBeInTheDocument();
  });

  it('handles search errors (Error instance and unknown error)', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'searchKnowledge')
      .mockRejectedValueOnce(new Error('PostgreSQL timeout'))
      .mockRejectedValueOnce('String rejection');

    const { getByLabelText, getByRole, findByRole } = render(<BrainView apiClient={client} />);

    fireEvent.change(getByLabelText('Buscar conhecimento'), {
      target: { value: 'termo' },
    });
    fireEvent.click(getByRole('button', { name: 'Executar busca' }));

    const alert = await findByRole('alert');
    expect(alert).toHaveTextContent('PostgreSQL timeout');

    // Second failure
    fireEvent.click(getByRole('button', { name: 'Executar busca' }));
    await waitFor(() => {
      expect(getByRole('alert')).toHaveTextContent('Falha ao realizar busca de conhecimento.');
    });
  });

  it('loads knowledge stats and documents on mount and handles document interactions', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
      documentsCount: 2,
      chunksCount: 88,
    });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([
      {
        id: 'doc-real-1',
        pageId: '1',
        source: 'https://dev.azure.com/org/proj/wiki?pagePath=%2FManual',
        title: 'Manual do Usuário Extensivo para Todos os Agentes',
        chunksCount: 5,
        totalCharacters: 2500,
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
      {
        id: 'doc-real-2',
        pageId: '2',
        source: 'internal://knowledge/short',
        title: 'Guia Curto',
        chunksCount: 3,
        totalCharacters: 1500,
        updatedAt: '2026-09-11T13:00:00.000Z',
      },
    ]);

    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    const { getByTestId, getAllByText, queryByTestId } = render(<BrainView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('card-documentos')).toHaveTextContent('2');
      expect(getByTestId('card-sync')).toHaveTextContent('Recente');
      expect(
        getAllByText('Manual do Usuário Extensivo para Todos os Agentes').length,
      ).toBeGreaterThan(0);
      expect(getByTestId('card-sync')).toBeInTheDocument();
    });

    const item1 = getByTestId('document-item-doc-real-1');

    // Click external link icon button directly on item card
    const externalLinkBtn = item1.querySelector('button[title="Abrir fonte"]');
    expect(externalLinkBtn).not.toBeNull();
    fireEvent.click(externalLinkBtn!);
    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://dev.azure.com/org/proj/wiki?pagePath=%2FManual',
      '_blank',
      'noopener,noreferrer',
    );

    // Keyboard interactions on item1
    fireEvent.keyDown(item1, { key: 'Enter' });
    expect(windowOpenSpy).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(item1, { key: ' ' });
    expect(windowOpenSpy).toHaveBeenCalledTimes(3);

    fireEvent.keyDown(item1, { key: 'Escape' });
    expect(windowOpenSpy).toHaveBeenCalledTimes(3);

    // Click item1 to open active document view in center
    fireEvent.click(item1);
    expect(getByTestId('active-document-view')).toBeInTheDocument();
    expect(getByTestId('tab-active-doc')).toHaveTextContent(
      'Manual do Usuário Extensivo para Todos os Agentes',
    );

    // Click "Abrir no Azure DevOps" in active document view
    const activeView = getByTestId('active-document-view');
    const openInAzureBtn = activeView.querySelector('button[title="Abrir fonte"]');
    expect(openInAzureBtn).not.toBeNull();
    fireEvent.click(openInAzureBtn!);
    expect(windowOpenSpy).toHaveBeenCalledTimes(4);

    // Switch to graph view via view-btn-graph
    fireEvent.click(getByTestId('view-btn-graph'));
    expect(getByTestId('graph-view')).toBeInTheDocument();

    // Switch back to text view via toggle button
    fireEvent.click(getByTestId('view-btn-toggle-top'));
    expect(getByTestId('folder-view')).toBeInTheDocument();

    // Close active doc tab
    fireEvent.click(getByTestId('close-tab'));
    // Close remaining graph tab to return to default Welcome view
    fireEvent.click(getByTestId('close-tab'));
    expect(getByTestId('folder-view')).toBeInTheDocument();

    // Select second doc (non-HTTP source) via Enter key while item2 is mounted in Welcome
    const item2 = getByTestId('document-item-doc-real-2');
    fireEvent.keyDown(item2, { key: 'Enter' });
    expect(getByTestId('active-document-view')).toBeInTheDocument();
    expect(
      queryByTestId('active-document-view')?.querySelector('button[title="Abrir fonte"]'),
    ).toBeNull();
    expect(windowOpenSpy).toHaveBeenCalledTimes(4);

    // Close active tab and test clicking item2
    fireEvent.click(getByTestId('close-tab'));
    const item2Again = getByTestId('document-item-doc-real-2');
    fireEvent.click(item2Again);
    expect(getByTestId('active-document-view')).toBeInTheDocument();

    // Click overview tab to return to root
    fireEvent.click(getByTestId('tab-brain-overview'));
    expect(queryByTestId('active-document-view')).not.toBeInTheDocument();

    windowOpenSpy.mockRestore();
  });

  it('displays empty state when documents array is empty', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 0, chunksCount: 0 });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([]);

    const { getByTestId } = render(<BrainView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('empty-documents')).toBeInTheDocument();
    });
  });

  it('displays loading skeletons while initial documents are being fetched', async () => {
    let resolveDocs: (value: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveDocs = resolve;
    });

    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockReturnValue(
      pendingPromise as unknown as ReturnType<ApiClient['getKnowledgeStats']>,
    );
    vi.spyOn(client, 'getKnowledgeDocuments').mockReturnValue(
      pendingPromise as unknown as ReturnType<ApiClient['getKnowledgeDocuments']>,
    );

    const { getByTestId, queryByTestId } = render(<BrainView apiClient={client} />);

    expect(getByTestId('docs-loading-skeleton')).toBeInTheDocument();
    expect(getByTestId('sync-loading-skeleton')).toBeInTheDocument();

    resolveDocs([]);
    await waitFor(() => {
      expect(queryByTestId('docs-loading-skeleton')).not.toBeInTheDocument();
    });
  });

  it('handles stats and documents load rejection on mount gracefully', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockRejectedValue(new Error('Network error'));
    vi.spyOn(client, 'getKnowledgeDocuments').mockRejectedValue(new Error('Network error'));

    const { getByTestId } = render(<BrainView apiClient={client} />);

    // Should retain default card values once rejection finishes
    await waitFor(() => {
      expect(getByTestId('card-documentos')).toHaveTextContent('34');
      expect(getByTestId('card-sync')).toHaveTextContent('Recente');
    });
  });

  it('triggers knowledge synchronization successfully and updates stats and documents', async () => {
    const client = new ApiClient();
    const oldSource = 'https://dev.azure.com/wiki?pagePath=%2FDocumento';
    const newSource = 'app://local?title=Documento%20Sincronizado';
    const oldDocument = {
      id: `${oldSource}:doc1`,
      pageId: 'doc1',
      source: oldSource,
      title: 'Documento Sincronizado',
      content: '# Documento Sincronizado',
      chunksCount: 1,
      totalCharacters: 25,
      updatedAt: '2026-09-11T12:00:00.000Z',
    };
    const syncSpy = vi
      .spyOn(client, 'syncKnowledge')
      .mockResolvedValueOnce({
        success: true,
        provider: 'azure_devops_wiki',
        chunksCount: 25,
        archived: [{ pageId: 'doc1', oldSource, newSource }],
      })
      .mockResolvedValueOnce({
        success: true,
        provider: 'azure_devops_wiki',
        chunksCount: 1,
      });
    vi.spyOn(client, 'getKnowledgeStats')
      .mockResolvedValueOnce({ documentsCount: 0, chunksCount: 0 }) // on mount
      .mockResolvedValueOnce({ documentsCount: 1, chunksCount: 40 }) // after first sync
      .mockResolvedValueOnce({ documentsCount: 1, chunksCount: 1 }); // after second sync
    vi.spyOn(client, 'getKnowledgeDocuments')
      .mockResolvedValueOnce([oldDocument]) // on mount
      .mockResolvedValueOnce([
        {
          ...oldDocument,
          id: `${newSource}:doc1`,
          pageId: 'doc1',
          source: newSource,
          isCustom: true,
        },
      ]) // after first sync
      .mockResolvedValueOnce([
        {
          ...oldDocument,
          id: `${newSource}:doc1`,
          source: newSource,
          isCustom: true,
        },
      ]); // after second sync
    vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);

    const { getByTestId, findByTestId, queryByTestId, getByLabelText, getAllByText } = render(
      <BrainView apiClient={client} />,
    );

    fireEvent.click(await findByTestId(`tree-item-${oldDocument.id}`));
    const syncBtn = getByTestId('btn-sync-knowledge');
    fireEvent.click(syncBtn);

    expect(syncSpy).toHaveBeenCalledTimes(1);

    const feedback = await findByTestId('sync-feedback');
    expect(feedback).toHaveTextContent(
      'Documentos sincronizados com sucesso! 25 chunks indexados. 1 documento(s) preservado(s) em Notas da Aplicação.',
    );

    await waitFor(() => {
      expect(getAllByText('Documento Sincronizado').length).toBeGreaterThan(0);
      expect(getByTestId('tab-active-doc')).toHaveTextContent('Documento Sincronizado');
      expect(getByTestId(`tree-item-${newSource}:doc1`)).toBeInTheDocument();
    });
    fireEvent.click(getByTestId('tab-brain-overview'));
    expect(getByTestId('card-documentos')).toHaveTextContent('1');
    expect(getByTestId('card-sync')).toHaveTextContent('Agora mesmo');

    fireEvent.click(syncBtn);
    await waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(2));
    expect(await findByTestId('sync-feedback')).toHaveTextContent(
      'Documentos sincronizados com sucesso! 1 chunks indexados.',
    );

    // Close feedback
    const closeBtn = getByLabelText('Fechar aviso');
    fireEvent.click(closeBtn);
    expect(queryByTestId('sync-feedback')).not.toBeInTheDocument();
  });

  it('handles synchronization failures (Error instance and unknown rejection)', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 0, chunksCount: 0 });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([]);
    vi.spyOn(client, 'syncKnowledge')
      .mockRejectedValueOnce(new Error('Nenhum provedor ativo configurado.'))
      .mockRejectedValueOnce('Generic sync error');

    const { getByTestId, findByTestId } = render(<BrainView apiClient={client} />);

    const syncBtn = getByTestId('btn-sync-knowledge');
    fireEvent.click(syncBtn);

    let feedback = await findByTestId('sync-feedback');
    expect(feedback).toHaveTextContent('Nenhum provedor ativo configurado.');

    // Second click: unknown error
    fireEvent.click(syncBtn);
    feedback = await findByTestId('sync-feedback');
    expect(feedback).toHaveTextContent('Falha ao sincronizar documentos da Wiki.');
  });

  it('does nothing when sync button is clicked without apiClient', () => {
    const { getByTestId, queryByTestId } = render(<BrainView />);
    fireEvent.click(getByTestId('btn-sync-knowledge'));
    expect(queryByTestId('sync-feedback')).not.toBeInTheDocument();
  });

  it('does not update state when unmounted before stats and documents resolve', async () => {
    const client = new ApiClient();
    let resolvePromise!: (
      value: [{ documentsCount: number; chunksCount: number }, never[]],
    ) => void;
    const promise = new Promise<[{ documentsCount: number; chunksCount: number }, never[]]>(
      (resolve) => {
        resolvePromise = resolve;
      },
    );
    vi.spyOn(client, 'getKnowledgeStats').mockImplementation(() => promise.then(([s]) => s));
    vi.spyOn(client, 'getKnowledgeDocuments').mockImplementation(() => promise.then(([, d]) => d));

    const { unmount } = render(<BrainView apiClient={client} />);
    unmount();
    resolvePromise([{ documentsCount: 99, chunksCount: 999 }, []]);
  });

  it('supports graph view, node selection, switcher buttons, and tabs', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
      documentsCount: 3,
      chunksCount: 45,
    });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([
      {
        id: 'doc-node-1',
        pageId: '1',
        source: 'https://dev.azure.com/org/proj/wiki?pagePath=%2FDoc1',
        title: 'Arquitetura do Sistema',
        chunksCount: 6,
        totalCharacters: 3000,
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
      {
        id: 'doc-node-2',
        pageId: '2',
        source: 'https://dev.azure.com/org/proj/wiki?pagePath=%2FDoc2',
        title: 'Rotas de API e Swagger',
        chunksCount: 2,
        totalCharacters: 1200,
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
      {
        id: 'doc-node-3',
        pageId: '3',
        source: 'https://dev.azure.com/org/proj/wiki?pagePath=%2FDoc3',
        title: 'Módulo de Integração com Azure DevOps Services',
        chunksCount: 4,
        totalCharacters: 2000,
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
    ]);

    const { getByTestId, getByText, queryByTestId } = render(<BrainView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('card-documentos')).toHaveTextContent('3');
    });

    // Switch to Graph View via view-btn-graph
    fireEvent.click(getByTestId('view-btn-graph'));
    expect(getByTestId('graph-view')).toBeInTheDocument();
    expect(getByTestId('graph-canvas')).toBeInTheDocument();
    expect(getByTestId('tab-graph')).toBeInTheDocument();
    expect(getByTestId('nav-title')).toHaveTextContent('Visualização do grafo');

    // Click document node in SVG - opens doc and switches to text mode
    const node1 = getByTestId('graph-node-doc-node-1');
    fireEvent.click(node1);
    expect(getByTestId('folder-view')).toBeInTheDocument();
    expect(getByTestId('active-document-view')).toBeInTheDocument();

    // Toggle back to graph via add-tab (+)
    fireEvent.click(getByTestId('btn-add-tab'));
    expect(getByTestId('graph-view')).toBeInTheDocument();

    // Toggle back to text via top window control button
    fireEvent.click(getByTestId('view-btn-toggle-top'));
    expect(getByTestId('folder-view')).toBeInTheDocument();

    // Switch to graph again and click center Welcome node
    fireEvent.click(getByTestId('view-btn-graph'));
    fireEvent.click(getByTestId('graph-node-welcome'));
    expect(getByTestId('folder-view')).toBeInTheDocument();
    expect(queryByTestId('active-document-view')).not.toBeInTheDocument();

    // Click button on welcome note to switch to graph
    const toGraphBtn = getByText('Ver no Grafo →');
    fireEvent.click(toGraphBtn);
    expect(getByTestId('graph-view')).toBeInTheDocument();

    // Close tab while in graph view
    const closeGraphTab = getByTestId('close-tab');
    fireEvent.click(closeGraphTab);
    // Close the remaining doc tab to return to default Welcome view
    fireEvent.click(getByTestId('close-tab'));
    expect(getByTestId('folder-view')).toBeInTheDocument();
    expect(queryByTestId('active-document-view')).not.toBeInTheDocument();

    // Trigger sync via btn-sync-knowledge
    fireEvent.click(getByTestId('btn-sync-knowledge'));
  });

  it('supports vault tree interactions in left sidebar', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
      documentsCount: 1,
      chunksCount: 10,
    });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([
      {
        id: 'doc-tree-1',
        pageId: '1',
        source: 'https://dev.azure.com/org/proj/wiki?pagePath=%2FTree',
        title: 'Árvore de Notas',
        chunksCount: 2,
        totalCharacters: 900,
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
    ]);

    const { getByTestId, queryByTestId, getByTitle } = render(<BrainView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('tree-item-doc-tree-1')).toBeInTheDocument();
    });

    // Toggle folder collapse and expand
    const collapseBtn = getByTitle('Recolher / Expandir');
    fireEvent.click(collapseBtn);
    expect(queryByTestId('tree-item-doc-tree-1')).not.toBeInTheDocument();
    fireEvent.click(collapseBtn);
    expect(getByTestId('tree-item-doc-tree-1')).toBeInTheDocument();

    // Click item in vault tree
    fireEvent.click(getByTestId('tree-item-doc-tree-1'));
    expect(getByTestId('active-document-view')).toBeInTheDocument();

    // Click Welcome item in sidebar
    fireEvent.click(getByTestId('tab-brain-overview'));
    expect(queryByTestId('active-document-view')).not.toBeInTheDocument();

    // Click navigation back arrow
    fireEvent.click(getByTitle('Voltar para Welcome'));
    expect(queryByTestId('active-document-view')).not.toBeInTheDocument();

    // Click hidden view-btn-folder for completeness
    fireEvent.click(getByTestId('view-btn-folder'));
  });

  it('handles interactions when no real documents are loaded', () => {
    const { getByTestId } = render(<BrainView />);

    // Switch to graph view when documents is empty to cover null fallbacks
    fireEvent.click(getByTestId('view-btn-graph'));
    expect(getByTestId('graph-view')).toBeInTheDocument();

    fireEvent.click(getByTestId('graph-node-welcome'));
    expect(getByTestId('folder-view')).toBeInTheDocument();
  });

  it('supports opening N tabs simultaneously, reading full text, and closing tabs independently', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
      documentsCount: 2,
      chunksCount: 5,
    });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([
      {
        id: 'doc-alpha',
        pageId: '10',
        source: 'https://dev.azure.com/org/proj/wiki?pagePath=%2FAlpha',
        title: 'Documento Alpha Completo',
        content: 'Este é o conteúdo textual integral e completo do documento Alpha.',
        chunksCount: 1,
        totalCharacters: 65,
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
      {
        id: 'doc-beta',
        pageId: '20',
        source: 'https://dev.azure.com/org/proj/wiki?pagePath=%2FBeta',
        title: 'Documento Beta Detalhado',
        content: 'Conteúdo abrangente de documentação Beta para visualização.',
        chunksCount: 3,
        totalCharacters: 60,
        updatedAt: '2026-09-11T12:00:00.000Z',
      },
    ]);

    const { getByTestId, getByText, queryByTestId } = render(<BrainView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('tree-item-doc-alpha')).toBeInTheDocument();
      expect(getByTestId('tree-item-doc-beta')).toBeInTheDocument();
    });

    // Initially 0 tabs open (Welcome default view)
    expect(queryByTestId('tab-active-welcome')).not.toBeInTheDocument();
    expect(getByTestId('folder-view')).toBeInTheDocument();

    // Click Document Alpha in tree: opens tab 1
    fireEvent.click(getByTestId('tree-item-doc-alpha'));
    expect(getByTestId('active-document-view')).toBeInTheDocument();
    expect(
      getByText('Este é o conteúdo textual integral e completo do documento Alpha.'),
    ).toBeInTheDocument();

    // Click Document Alpha again while already open: keeps it open (covers return prev branch)
    fireEvent.click(getByTestId('tree-item-doc-alpha'));
    expect(getByTestId('active-document-view')).toBeInTheDocument();

    // Click Document Beta in tree: opens tab 2 (N tabs open simultaneously)
    fireEvent.click(getByTestId('tree-item-doc-beta'));
    expect(
      getByText('Conteúdo abrangente de documentação Beta para visualização.'),
    ).toBeInTheDocument();

    // Both Alpha and Beta tabs exist in tab bar
    expect(getByTestId('close-tab-doc-alpha')).toBeInTheDocument();
    expect(getByTestId('close-tab')).toBeInTheDocument(); // Beta is active tab

    // Wheel event on tab bar to scroll horizontally
    const tabsBar = getByTestId('brain-tabs-bar');
    fireEvent.wheel(tabsBar, { deltaY: 100 });
    fireEvent.wheel(tabsBar, { deltaY: 0 });

    // Switch back to Alpha by clicking its tab
    fireEvent.click(getByTestId('close-tab-doc-alpha').parentElement!);
    expect(
      getByText('Este é o conteúdo textual integral e completo do documento Alpha.'),
    ).toBeInTheDocument();

    // Active is Alpha. Close Beta tab (non-active tab closing branch)
    fireEvent.click(getByTestId('close-tab-doc-beta'));
    expect(queryByTestId('close-tab-doc-beta')).not.toBeInTheDocument();
    expect(getByTestId('close-tab')).toBeInTheDocument(); // Alpha is still active

    // Reopen Beta
    fireEvent.click(getByTestId('tree-item-doc-beta'));

    // Switch to Graph view while Beta is active
    fireEvent.click(getByTestId('view-btn-graph'));
    expect(getByTestId('graph-view')).toBeInTheDocument();

    // Toggle view mode while in graph with existing doc tabs via btn-add-tab (switches back to lastDocTab Beta)
    fireEvent.click(getByTestId('btn-add-tab'));
    expect(getByTestId('active-document-view')).toBeInTheDocument();

    // Close Alpha tab while Beta is active
    fireEvent.click(getByTestId('close-tab-doc-alpha'));

    // Close Beta tab (now graph is active)
    fireEvent.click(getByTestId('close-tab'));
    expect(getByTestId('graph-view')).toBeInTheDocument();

    // Close graph tab (all tabs closed -> returns to default Welcome view)
    fireEvent.click(getByTestId('close-tab'));
    expect(queryByTestId('active-document-view')).not.toBeInTheDocument();
    expect(queryByTestId('close-tab')).not.toBeInTheDocument();

    // Open graph tab directly from Welcome view
    fireEvent.click(getByTestId('view-btn-graph'));
    expect(getByTestId('graph-view')).toBeInTheDocument();
    // Toggle view mode while in graph and no doc tabs exist (falls back to null/Welcome)
    fireEvent.click(getByTestId('view-btn-graph'));
    expect(getByTestId('folder-view')).toBeInTheDocument();
    expect(queryByTestId('active-document-view')).not.toBeInTheDocument();
  });

  it('supports full document CRUD lifecycle (create, edit, delete) for app documents and deletion for external documents', async () => {
    const client = new ApiClient();
    const mockCustomDoc = {
      id: 'app://local:doc-custom-1',
      pageId: 'doc-custom-1',
      source: 'app://local?title=Minha%20Nota',
      title: 'Minha Nota',
      content: '# Minha Nota\n\nTexto customizado da aplicação.',
      chunksCount: 1,
      totalCharacters: 40,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };
    const mockExternalDoc = {
      id: 'doc-ext-1',
      pageId: 'ext-1',
      source: 'https://dev.azure.com/org/proj/_wiki',
      title: 'Wiki Externa',
      content: '# Wiki Externa',
      chunksCount: 1,
      totalCharacters: 14,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: false,
    };

    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
      documentsCount: 2,
      chunksCount: 2,
    });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([mockCustomDoc, mockExternalDoc]);

    const createSpy = vi.spyOn(client, 'createKnowledgeDocument').mockResolvedValue({
      id: 'app://local:doc-custom-2',
      pageId: 'doc-custom-2',
      source: 'app://local?title=Nota%20Nova',
      title: 'Nota Nova',
      content: '# Nota Nova',
      chunksCount: 1,
      totalCharacters: 11,
      updatedAt: '2026-09-12T12:05:00.000Z',
      isCustom: true,
    });

    const updateSpy = vi.spyOn(client, 'updateKnowledgeDocument').mockResolvedValue({
      ...mockCustomDoc,
      title: 'Minha Nota Editada',
      content: '# Minha Nota Editada\n\nConteúdo atualizado.',
    });

    const deleteSpy = vi.spyOn(client, 'deleteKnowledgeDocument').mockResolvedValue(undefined);

    const { getByTestId, queryByTestId, getByPlaceholderText } = render(
      <BrainView apiClient={client} />,
    );

    await waitFor(() => {
      expect(getByTestId('tree-item-app://local:doc-custom-1')).toBeInTheDocument();
      expect(getByTestId('tree-item-doc-ext-1')).toBeInTheDocument();
    });

    // 1. Create Document Flow
    fireEvent.click(getByTestId('btn-create-document'));
    expect(getByTestId('document-editor')).toBeInTheDocument();

    // Try saving empty title -> validation error
    fireEvent.click(getByTestId('btn-save-document'));
    expect(getByTestId('save-error-message')).toHaveTextContent(
      'O título do documento é obrigatório.',
    );

    // Enter title & content
    const titleInput = getByPlaceholderText('Digite o título do documento...');
    fireEvent.change(titleInput, { target: { value: 'Nota Nova' } });
    const contentTextarea = getByPlaceholderText(
      'Escreva o conteúdo do documento em formato Markdown...',
    );
    fireEvent.change(contentTextarea, { target: { value: '# Nota Nova' } });

    // Toggle preview inside editor
    fireEvent.click(getByTestId('btn-toggle-edit-preview'));
    expect(getByTestId('editor-preview-container')).toBeInTheDocument();
    fireEvent.click(getByTestId('btn-toggle-edit-preview'));

    // Save new document
    fireEvent.click(getByTestId('btn-save-document'));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith('Nota Nova', '# Nota Nova');
      expect(queryByTestId('document-editor')).not.toBeInTheDocument();
      expect(getByTestId('active-document-view')).toBeInTheDocument();
    });

    // 2. Edit Custom Document Flow
    fireEvent.click(getByTestId('tree-item-app://local:doc-custom-1'));
    expect(getByTestId('btn-edit-document')).toBeInTheDocument();

    // Start edit and cancel
    fireEvent.click(getByTestId('btn-edit-document'));
    expect(getByTestId('document-editor')).toBeInTheDocument();
    fireEvent.click(getByTestId('btn-cancel-edit'));
    expect(queryByTestId('document-editor')).not.toBeInTheDocument();

    // Start edit and save changes
    fireEvent.click(getByTestId('btn-edit-document'));
    fireEvent.change(getByPlaceholderText('Digite o título do documento...'), {
      target: { value: 'Minha Nota Editada' },
    });
    fireEvent.change(
      getByPlaceholderText('Escreva o conteúdo do documento em formato Markdown...'),
      {
        target: { value: '# Minha Nota Editada\n\nConteúdo atualizado.' },
      },
    );
    fireEvent.click(getByTestId('btn-save-document'));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        'doc-custom-1',
        'Minha Nota Editada',
        '# Minha Nota Editada\n\nConteúdo atualizado.',
      );
      expect(queryByTestId('document-editor')).not.toBeInTheDocument();
    });

    // 3. External Document: Edit button must NOT be present
    fireEvent.click(getByTestId('tree-item-doc-ext-1'));
    expect(queryByTestId('btn-edit-document')).not.toBeInTheDocument();
    expect(queryByTestId('btn-delete-document')).toHaveTextContent('Excluir apenas do app');
    expect(getByTestId('btn-copy-document')).toBeInTheDocument();

    // 4. Delete Flow (with modal confirmation)
    fireEvent.click(getByTestId('tree-item-app://local:doc-custom-1'));
    fireEvent.click(getByTestId('btn-delete-document'));
    expect(getByTestId('modal-confirm-delete')).toBeInTheDocument();

    // Cancel deletion
    fireEvent.click(getByTestId('btn-cancel-delete'));
    expect(queryByTestId('modal-confirm-delete')).not.toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();

    // Confirm deletion
    fireEvent.click(getByTestId('btn-delete-document'));
    fireEvent.click(getByTestId('btn-confirm-delete'));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('doc-custom-1', 'app://local?title=Minha%20Nota');
      expect(queryByTestId('modal-confirm-delete')).not.toBeInTheDocument();
    });
  });

  it('handles save and delete document errors gracefully', async () => {
    const client = new ApiClient();
    const mockDoc = {
      id: 'app://local:doc-err-1',
      pageId: 'doc-err-1',
      source: 'app://local',
      title: 'Nota Erro',
      chunksCount: 1,
      totalCharacters: 8,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };

    vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 1, chunksCount: 1 });
    vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([mockDoc]);
    vi.spyOn(client, 'createKnowledgeDocument').mockRejectedValue(
      new Error('Falha ao salvar no banco.'),
    );
    vi.spyOn(client, 'deleteKnowledgeDocument').mockRejectedValue(
      new Error('Falha ao deletar do banco.'),
    );

    const { getByTestId, getByPlaceholderText } = render(<BrainView apiClient={client} />);

    await waitFor(() => {
      expect(getByTestId('tree-item-app://local:doc-err-1')).toBeInTheDocument();
    });

    // Toggle app folder collapse and expansion
    const folderAppDocs = getByTestId('folder-app-docs');
    fireEvent.click(folderAppDocs);
    fireEvent.click(folderAppDocs);

    // Failed create with Error instance
    fireEvent.click(getByTestId('btn-create-document'));
    fireEvent.change(getByPlaceholderText('Digite o título do documento...'), {
      target: { value: 'Falha Titulo' },
    });
    fireEvent.click(getByTestId('btn-save-document'));

    await waitFor(() => {
      expect(getByTestId('save-error-message')).toHaveTextContent('Falha ao salvar no banco.');
    });

    // Failed create with non-Error reject
    vi.spyOn(client, 'createKnowledgeDocument').mockRejectedValueOnce('Falha desconhecida');
    fireEvent.click(getByTestId('btn-save-document'));
    await waitFor(() => {
      expect(getByTestId('save-error-message')).toHaveTextContent('Falha ao salvar documento.');
    });

    // Failed delete with Error instance
    fireEvent.click(getByTestId('btn-cancel-edit'));
    fireEvent.click(getByTestId('tree-item-app://local:doc-err-1'));

    // Edit doc without content and test preview with empty content and empty title fallback
    fireEvent.click(getByTestId('btn-edit-document'));
    fireEvent.change(getByPlaceholderText('Digite o título do documento...'), {
      target: { value: '' },
    });
    fireEvent.change(
      getByPlaceholderText('Escreva o conteúdo do documento em formato Markdown...'),
      {
        target: { value: '' },
      },
    );
    fireEvent.click(getByTestId('btn-toggle-edit-preview'));
    expect(getByTestId('editor-preview-container')).toHaveTextContent(
      'Nenhum conteúdo para pré-visualização.',
    );
    fireEvent.click(getByTestId('btn-toggle-edit-preview'));
    fireEvent.click(getByTestId('btn-cancel-edit'));

    // Delete with non-Error reject
    vi.spyOn(client, 'deleteKnowledgeDocument').mockRejectedValueOnce('Erro string');
    fireEvent.click(getByTestId('btn-delete-document'));
    fireEvent.click(getByTestId('btn-confirm-delete'));

    await waitFor(() => {
      expect(getByTestId('sync-feedback')).toHaveTextContent('Falha ao excluir documento.');
    });

    // Delete with Error instance
    fireEvent.click(getByTestId('btn-delete-document'));
    fireEvent.click(getByTestId('btn-confirm-delete'));

    await waitFor(() => {
      expect(getByTestId('sync-feedback')).toHaveTextContent('Falha ao deletar do banco.');
    });
  });

  it('handles create and delete when apiClient is not provided', () => {
    const mockDoc = {
      id: 'app://local:doc-no-client',
      pageId: 'doc-no-client',
      source: 'app://local',
      title: 'Nota Sem Client',
      chunksCount: 1,
      totalCharacters: 10,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };

    const { getByTestId, queryByTestId } = render(<BrainView initialDocuments={[mockDoc]} />);

    // Save without apiClient
    fireEvent.click(getByTestId('btn-create-document'));
    expect(getByTestId('document-editor')).toBeInTheDocument();
    fireEvent.click(getByTestId('btn-save-document'));
    expect(queryByTestId('save-error-message')).not.toBeInTheDocument();
    fireEvent.click(getByTestId('btn-cancel-edit'));

    // Delete without apiClient
    fireEvent.click(getByTestId('tree-item-app://local:doc-no-client'));
    fireEvent.click(getByTestId('btn-delete-document'));
    fireEvent.click(getByTestId('btn-confirm-delete'));
    expect(queryByTestId('sync-feedback')).not.toBeInTheDocument();
  });

  describe('stripLeadingTitleHeading helper', () => {
    it('returns content as-is when content or title is empty or missing', () => {
      expect(stripLeadingTitleHeading('')).toBe('');
      expect(stripLeadingTitleHeading('Some content', '')).toBe('Some content');
      expect(stripLeadingTitleHeading('Some content', undefined)).toBe('Some content');
    });

    it('returns content as-is when heading does not match title', () => {
      expect(stripLeadingTitleHeading('# Outro Titulo\n\nCorpo', 'Meu Titulo')).toBe(
        '# Outro Titulo\n\nCorpo',
      );
      expect(stripLeadingTitleHeading('Texto sem heading', 'Meu Titulo')).toBe('Texto sem heading');
    });

    it('strips leading # Title heading case-insensitively and removes leading newlines', () => {
      expect(
        stripLeadingTitleHeading('# Teste Batatinha\n\nConteúdo aqui.', 'teste batatinha'),
      ).toBe('Conteúdo aqui.');
      expect(stripLeadingTitleHeading('# Teste Batatinha', 'Teste Batatinha')).toBe('');
    });
  });

  it('strips leading title heading from textarea when starting edit of a document', () => {
    const mockDoc = {
      id: 'app://local:doc-with-heading',
      pageId: 'doc-with-heading',
      source: 'app://local',
      title: 'Nota Com Titulo',
      content: '# Nota Com Titulo\n\nTexto do corpo da nota.',
      chunksCount: 1,
      totalCharacters: 40,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };

    const { getByTestId } = render(<BrainView initialDocuments={[mockDoc]} />);

    fireEvent.click(getByTestId('tree-item-app://local:doc-with-heading'));
    fireEvent.click(getByTestId('btn-edit-document'));

    const textarea = getByTestId('textarea-document-content') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Texto do corpo da nota.');
  });

  it('does not display document synchronization metadata in the document header', () => {
    const mockDoc = {
      id: 'app://local:doc-native',
      pageId: 'doc-native',
      source: 'app://local',
      title: 'Minha Nota Nativa',
      content: '# Minha Nota Nativa\n\nConteúdo',
      chunksCount: 1,
      totalCharacters: 25,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };

    const { getByTestId, queryByText } = render(<BrainView initialDocuments={[mockDoc]} />);

    fireEvent.click(getByTestId('tree-item-app://local:doc-native'));
    expect(queryByText('Documento Nativo')).not.toBeInTheDocument();
    expect(queryByText('1 chunk · 25 caracteres')).not.toBeInTheDocument();
  });

  it('hides create, edit, and delete buttons when isReadOnly is true', () => {
    const mockDoc = {
      id: 'app://local:doc-readonly',
      pageId: 'doc-readonly',
      source: 'app://local',
      title: 'Nota Readonly',
      content: '# Nota Readonly\n\nConteúdo',
      chunksCount: 1,
      totalCharacters: 25,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };

    const { queryByTestId, getByTestId } = render(
      <BrainView initialDocuments={[mockDoc]} isReadOnly={true} />,
    );

    // Create button should not be present
    expect(queryByTestId('btn-create-document')).not.toBeInTheDocument();

    // Open document
    fireEvent.click(getByTestId('tree-item-app://local:doc-readonly'));

    // Edit and delete buttons should not be present
    expect(queryByTestId('btn-edit-document')).not.toBeInTheDocument();
    expect(queryByTestId('btn-delete-document')).not.toBeInTheDocument();
    // Synchronizing writes into the Brain, so a read-only member does not get it either
    expect(queryByTestId('btn-sync-knowledge')).not.toBeInTheDocument();
  });

  describe('workspace permissions', () => {
    const permissionDoc = {
      id: 'app://local:doc-permissions',
      pageId: 'doc-permissions',
      source: 'app://local?title=Nota%20Permissoes',
      title: 'Nota Permissoes',
      content: '# Nota Permissoes\n\nConteúdo',
      chunksCount: 1,
      totalCharacters: 25,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };

    function accessWith(modules: Partial<EffectiveAccess['modules']>): EffectiveAccess {
      return { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, ...modules } };
    }

    async function renderWithAccess(access: EffectiveAccess, isReadOnly = false) {
      const client = new ApiClient();
      vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
        documentsCount: 1,
        chunksCount: 1,
      });
      vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([permissionDoc]);
      vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
      vi.spyOn(client, 'getAgents').mockResolvedValue([]);
      const view = render(
        <PermissionsProvider access={access}>
          <BrainView
            apiClient={client}
            initialDocuments={[permissionDoc]}
            isReadOnly={isReadOnly}
          />
        </PermissionsProvider>,
      );
      fireEvent.click(await view.findByTestId(`tree-item-${permissionDoc.id}`));
      return view;
    }

    it('offers editing but not deleting to a member with brain edit access', async () => {
      const view = await renderWithAccess(accessWith({ brain: 'edit' }));

      expect(view.getByTestId('btn-create-document')).toBeInTheDocument();
      expect(view.getByTestId('btn-sync-knowledge')).toBeInTheDocument();
      expect(view.getByTestId('btn-edit-document')).toBeInTheDocument();
      expect(view.getByTestId('btn-push-document')).toBeInTheDocument();
      expect(view.queryByTestId('btn-delete-document')).not.toBeInTheDocument();
    });

    it('offers deleting to a member with brain delete access', async () => {
      const view = await renderWithAccess(accessWith({ brain: 'delete' }));

      expect(view.getByTestId('btn-delete-document')).toBeInTheDocument();
    });

    it('hides spec and test plan generation when those modules are not editable', async () => {
      const view = await renderWithAccess(accessWith({ specs: 'view', testplans: 'none' }));

      expect(view.queryByText('Criar Spec com Agent')).not.toBeInTheDocument();
      expect(view.queryByText('Gerar testes')).not.toBeInTheDocument();
      expect(view.getByTestId('btn-edit-document')).toBeInTheDocument();
    });

    it('follows the target module for cross-module flows even when the Brain is read-only', async () => {
      const view = await renderWithAccess(
        accessWith({ brain: 'view', specs: 'edit', testplans: 'edit' }),
        true,
      );

      expect(view.getByText('Criar Spec com Agent')).toBeInTheDocument();
      expect(view.getByText('Gerar testes')).toBeInTheDocument();
      expect(view.queryByTestId('btn-edit-document')).not.toBeInTheDocument();
      expect(view.queryByTestId('btn-push-document')).not.toBeInTheDocument();
      expect(view.queryByTestId('btn-delete-document')).not.toBeInTheDocument();
      expect(view.queryByTestId('btn-sync-knowledge')).not.toBeInTheDocument();
      expect(view.queryByTestId('btn-create-document')).not.toBeInTheDocument();
      // Asking the Brain only needs view access
      expect(view.getByRole('button', { name: 'Perguntar' })).toBeInTheDocument();
    });
  });

  it('does not render empty diagram / code blocks when indented lines or fenced blocks are empty', () => {
    const mockDoc = {
      id: 'app://local:doc-empty-diagram',
      pageId: 'doc-empty-diagram',
      source: 'app://local',
      title: 'Nota com Trecho Vazio',
      content: '# Documento\n\n```\n\n```\n\n    \n    \n\nTexto normal após bloco vazio.',
      chunksCount: 1,
      totalCharacters: 60,
      updatedAt: '2026-09-12T12:00:00.000Z',
      isCustom: true,
    };

    const { queryByText, getByTestId, getByText } = render(
      <BrainView initialDocuments={[mockDoc]} />,
    );

    fireEvent.click(getByTestId('tree-item-app://local:doc-empty-diagram'));

    expect(getByText('Texto normal após bloco vazio.')).toBeInTheDocument();
    expect(queryByText('diagrama / fluxo')).not.toBeInTheDocument();
  });
});
