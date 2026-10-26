import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiView } from '../src/features/pbi/PbiView.js';
import type { PbiItem, PbiLink } from '../src/features/pbi/pbi-types.js';
import type { FieldMappingTemplate } from '../src/features/field-mapping/types.js';
import { MediaProvider } from '../src/features/shared/media.js';

const root: PbiItem = {
  id: 'root',
  workspaceId: 'ws',
  parentId: null,
  kind: 'pbi',
  title: 'Release PBI',
  description: 'Deliver release',
  status: 'New',
  position: 1,
  sourceData: {},
  links: [],
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};
const card: PbiItem = {
  ...root,
  id: 'card',
  parentId: root.id,
  kind: 'card',
  title: 'Verify release',
  description: 'Check deployment',
  position: 2,
};
const azureLink: PbiLink = {
  id: 'azure-link',
  providerId: 'azure_devops',
  externalId: '46873',
  externalUrl: null,
  boardId: 'project',
  syncedAt: '2026-09-30T00:00:00.000Z',
};
const template: FieldMappingTemplate = {
  id: 'tpl-1',
  workspaceId: 'ws',
  name: 'Campos do Trello',
  entityType: 'pbi',
  providerId: 'trello',
  scope: '',
  itemType: '',
  rules: [],
  createdAt: '',
  updatedAt: '',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function mockClient() {
  const getPbiItems = vi.fn<() => Promise<PbiItem[]>>().mockResolvedValue([root, card]);
  return {
    getPbiItems,
    syncPbiChildren: vi.fn().mockImplementation(() => getPbiItems()),
    getPbiProviders: vi
      .fn()
      .mockResolvedValue([{ providerId: 'trello', settings: { boardId: 'board' } }]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    getWorkspaceMembers: vi.fn().mockResolvedValue([]),
    getPbiComments: vi.fn().mockResolvedValue([]),
    updatePbiItem: vi.fn().mockResolvedValue(root),
    pushPbiItem: vi.fn().mockResolvedValue({ item: root, warnings: [] }),
    getPbiPushContract: vi.fn().mockResolvedValue({
      providerId: 'trello',
      update: false,
      fields: [
        {
          key: 'list',
          label: 'List',
          required: true,
          options: [{ value: 'list-1', label: 'Doing' }],
          value: 'list-1',
          status: 'resolved',
        },
      ],
    }),
    getFieldMappingTemplates: vi.fn().mockResolvedValue([template]),
    getPbiFieldCatalog: vi.fn().mockResolvedValue([]),
    previewPbiFields: vi.fn().mockResolvedValue({ definitions: [], values: { Label: 'QA' } }),
    getPbiRelations: vi.fn().mockResolvedValue([]),
    createIssueFromPbi: vi.fn().mockResolvedValue({ id: 'issue' }),
    getMedia: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
    getAuditHistory: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
  };
}
type Api = ReturnType<typeof mockClient>;

function renderView(api: Api, workspaceId: string | null = 'ws', onOpenIssues?: () => void) {
  return render(
    <MediaProvider apiClient={api as unknown as ApiClient}>
      <PbiView
        apiClient={api as unknown as ApiClient}
        workspaceId={workspaceId}
        onOpenIssues={onOpenIssues}
      />
    </MediaProvider>,
  );
}
function openRowMenu(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `Ações: ${title}` }));
}
function dispatchPointer(target: EventTarget, type: string, clientX: number) {
  act(() => {
    target.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientX }));
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:shot'),
  });
});
afterEach(() => vi.restoreAllMocks());

describe('PbiView coverage gaps: preferences without a workspace', () => {
  it('keeps the title and actions columns when no stored column is valid', async () => {
    localStorage.setItem('adk:pbi-columns:ws', JSON.stringify(['unknown']));
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    expect(screen.queryByRole('columnheader', { name: /^Ordem/ })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Título/ })).toBeInTheDocument();
  });

  it('stores column choices and widths under the default key', async () => {
    renderView(mockClient(), null);
    await screen.findByText('Nenhum PBI ainda. Crie um ou faça Pull das integrações.');
    const handle = screen.getByRole('separator', { name: 'Colunas: Tipo' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(JSON.parse(localStorage.getItem('adk:pbi-column-widths:default')!)).toMatchObject({
      type: 232,
    });
    const title = screen.getByRole('separator', { name: 'Colunas: Título' });
    dispatchPointer(title, 'pointerdown', 100);
    dispatchPointer(window, 'pointermove', 110);
    dispatchPointer(window, 'pointerup', 110);
    expect(JSON.parse(localStorage.getItem('adk:pbi-column-widths:default')!)).toMatchObject({
      title: 430,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Colunas' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Área' }));
    expect(JSON.parse(localStorage.getItem('adk:pbi-columns:default')!)).not.toContain('area');
  });
});

describe('PbiView coverage gaps: rows and search', () => {
  it('links sources without a known name and keeps whole subtrees when searching', async () => {
    const api = mockClient();
    // The card comes before its PBI; both match the search.
    api.getPbiItems.mockResolvedValue([
      card,
      {
        ...root,
        links: [
          {
            ...azureLink,
            providerId: 'gitlab' as never,
            externalUrl: 'https://gitlab.test/issues/9',
          },
        ],
      },
    ]);
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    expect(screen.getByRole('link', { name: 'gitlab' })).toHaveAttribute(
      'href',
      'https://gitlab.test/issues/9',
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'release' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Verify release' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Release PBI' })).toBeInTheDocument();
  });

  it('creates an issue without opening the issues view', async () => {
    const api = mockClient();
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Criar issue de' }));
    expect(await screen.findByText('Issue criada a partir do PBI.')).toBeInTheDocument();
    expect(api.createIssueFromPbi).toHaveBeenCalledWith('root');
  });

  it('opens the issues view after creating an issue', async () => {
    const onOpenIssues = vi.fn();
    renderView(mockClient(), 'ws', onOpenIssues);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Criar issue de' }));
    await waitFor(() => expect(onOpenIssues).toHaveBeenCalled());
  });

  it('closes the filter name dialog with Escape', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'release' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome do filtro' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Nome do filtro' })).not.toBeInTheDocument();
  });

  it('pushes a card with a field template', async () => {
    const api = mockClient();
    renderView(api);
    await screen.findByRole('button', { name: 'Verify release' });
    openRowMenu('Verify release');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    // Cancelling closes the dialog without pushing.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openRowMenu('Verify release');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    const dialog = screen.getByRole('dialog');
    const editor = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    fireEvent.change(await within(editor).findByRole('combobox', { name: 'Template salvo' }), {
      target: { value: 'tpl-1' },
    });
    const submit = within(dialog).getByRole('button', { name: 'Fazer push' });
    await waitFor(() => expect(submit).toHaveProperty('disabled', false));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.pushPbiItem).toHaveBeenCalledWith('card', {
        providerId: 'trello',
        fields: { list: 'list-1' },
        templateId: 'tpl-1',
      }),
    );
  });
});

describe('PbiView coverage gaps: item editor', () => {
  it('opens items without description or state as an empty backlog item', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      { ...root, description: undefined, status: undefined } as unknown as PbiItem,
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Descrição' }).innerHTML).toBe('');
    expect(within(dialog).getByRole('combobox', { name: 'Estado' })).toHaveProperty(
      'value',
      'backlog',
    );
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Estado' }), {
      target: { value: 'Active' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.updatePbiItem).toHaveBeenCalledWith(
        'root',
        expect.objectContaining({ status: 'Active', description: '' }),
      ),
    );
  });

  it('keeps safe images with their text and drops unsafe ones', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      {
        ...root,
        description:
          '<p>Shot <img src="https://cdn.test/a.png" alt="Screen" title="Home" onerror="x()">' +
          '<img src="javascript:alert(1)" alt="bad"></p>',
      },
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const editor = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Descrição' });
    const images = editor.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute('alt', 'Screen');
    expect(images[0]).toHaveAttribute('title', 'Home');
    expect(images[0]).not.toHaveAttribute('onerror');
  });

  it('inserts an attached image into the description and saves it', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      {
        ...root,
        attachments: [
          {
            id: 'a1',
            name: 'shot.png',
            kind: 'image',
            mimeType: 'image/png',
            size: 3,
            scope: 'pbi',
            source: 'adk',
            url: '/attachments/files/a1',
          },
        ],
      },
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inserir no texto: shot.png' }));
    expect(
      within(dialog).getByRole('textbox', { name: 'Descrição' }).querySelector('img'),
    ).toHaveAttribute('alt', 'shot.png');
    // The file stays in the text after the attachment itself is removed.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover anexo: shot.png' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.updatePbiItem).toHaveBeenCalledWith(
        'root',
        expect.objectContaining({
          description: expect.stringContaining('src="/attachments/files/a1"'),
          attachments: [],
        }),
      ),
    );
  });

  it('shows comment failures that are not errors', async () => {
    const api = mockClient();
    api.getPbiComments.mockRejectedValue('down');
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'Não foi possível carregar os comentários.',
      ),
    ).toBeInTheDocument();
  });

  it('ignores cards synced after the item was closed', async () => {
    const api = mockClient();
    const linked: PbiItem = { ...root, links: [azureLink] };
    api.getPbiItems.mockResolvedValue([linked]);
    const sync = deferred<PbiItem[]>();
    api.syncPbiChildren.mockReturnValue(sync.promise);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    await waitFor(() => expect(api.syncPbiChildren).toHaveBeenCalledWith('root'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    await act(async () => sync.resolve([linked, card]));
    expect(screen.queryByRole('button', { name: 'Verify release' })).not.toBeInTheDocument();
  });

  it('lists the known cards instead of a sync error', async () => {
    const api = mockClient();
    const linked: PbiItem = { ...root, links: [azureLink] };
    api.getPbiItems.mockResolvedValue([linked, card]);
    api.syncPbiChildren.mockRejectedValue(new Error('Azure offline'));
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(api.syncPbiChildren).toHaveBeenCalled());
    await waitFor(() =>
      expect(within(dialog).queryByText('Sincronizando cards...')).not.toBeInTheDocument(),
    );
    expect(within(dialog).queryByText('Azure offline')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Verify release')).toBeInTheDocument();
  });
});
