import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  newRequest,
  type ApiCollection,
  type ApiCollectionSummary,
  type ApiFolder,
} from '../src/features/apitests/api-test-types.js';
import {
  CollectionsSidebar,
  type SidebarActions,
} from '../src/features/apitests/integration/CollectionsSidebar.js';

const login = { ...newRequest('Login'), url: '/login' };
const grpc = newRequest('Stream', 'grpc');
const folder: ApiFolder = { id: 'f1', type: 'folder', name: 'Admin', items: [login] };
const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [],
  auth: { type: 'none' },
  source: { kind: 'custom-kind' },
  updatedAt: '',
  items: [folder, grpc],
};
const empty: ApiCollection = { ...collection, id: 'c2', name: 'Empty', items: [] };
const summary = (id: string, name: string): ApiCollectionSummary => ({
  id,
  name,
  description: '',
  source: { kind: 'custom-kind' },
  requestCount: 0,
  updatedAt: '',
});

function actionsMock(): SidebarActions {
  return {
    onToggle: vi.fn(),
    onOpenRequest: vi.fn(),
    onNewRequest: vi.fn(),
    onNewFolder: vi.fn(),
    onRun: vi.fn(),
    onSettings: vi.fn(),
    onFolderSettings: vi.fn(),
    onRenameCollection: vi.fn(),
    onRename: vi.fn(),
    onClone: vi.fn(),
    onDelete: vi.fn(),
  };
}

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof CollectionsSidebar>> = {},
  actions = actionsMock(),
) {
  render(
    <CollectionsSidebar
      summaries={[summary('c1', 'Orders API'), summary('c2', 'Empty'), summary('c3', 'Slow')]}
      loaded={{ c1: collection, c2: empty }}
      expanded={new Set(['c1', 'c2', 'c3', 'f1'])}
      activeRequestId={null}
      dirtyIds={new Set()}
      filter=""
      readOnly={false}
      onFilter={vi.fn()}
      onNewCollection={vi.fn()}
      onImport={vi.fn()}
      onGenerate={vi.fn()}
      actions={actions}
      {...overrides}
    />,
  );
  return actions;
}

const pick = (trigger: string, item: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
};

describe('CollectionsSidebar menus', () => {
  it('runs every action of the collection menu', () => {
    const actions = renderSidebar();
    pick('Ações de Orders API', 'Nova requisição');
    expect(actions.onNewRequest).toHaveBeenCalledWith('c1', null);
    pick('Ações de Orders API', 'Nova pasta');
    expect(actions.onNewFolder).toHaveBeenCalledWith('c1', null);
    pick('Ações de Orders API', 'Executar');
    expect(actions.onRun).toHaveBeenCalledWith('c1', null);
    pick('Ações de Orders API', 'Renomear');
    expect(actions.onRenameCollection).toHaveBeenCalledWith('c1');
    pick('Ações de Orders API', 'Configurações');
    expect(actions.onSettings).toHaveBeenCalledWith('c1');
    pick('Ações de Orders API', 'Excluir coleção');
    expect(actions.onDelete).toHaveBeenCalledWith('c1', null);
  });

  it('runs every action of the folder menu', () => {
    const actions = renderSidebar();
    pick('Ações de Admin', 'Nova requisição');
    expect(actions.onNewRequest).toHaveBeenCalledWith('c1', 'f1');
    pick('Ações de Admin', 'Nova pasta');
    expect(actions.onNewFolder).toHaveBeenCalledWith('c1', 'f1');
    pick('Ações de Admin', 'Configurações');
    expect(actions.onFolderSettings).toHaveBeenCalledWith('c1', 'f1');
    pick('Ações de Admin', 'Executar');
    expect(actions.onRun).toHaveBeenCalledWith('c1', 'f1');
    pick('Ações de Admin', 'Renomear');
    expect(actions.onRename).toHaveBeenCalledWith('c1', folder);
    pick('Ações de Admin', 'Clonar');
    expect(actions.onClone).toHaveBeenCalledWith('c1', folder);
    pick('Ações de Admin', 'Excluir');
    expect(actions.onDelete).toHaveBeenCalledWith('c1', folder);
  });

  it('runs the actions of a request menu, which has no folder entries', () => {
    const actions = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Ações de Login' }));
    expect(screen.queryByRole('menuitem', { name: 'Nova pasta' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Executar' }));
    expect(actions.onRun).toHaveBeenCalledWith('c1', login.id);
  });

  it('toggles, opens requests and offers the first request of an empty collection', () => {
    const actions = renderSidebar();
    fireEvent.click(screen.getByTestId('collection-Orders API'));
    expect(actions.onToggle).toHaveBeenCalledWith('c1');
    fireEvent.click(screen.getByTestId('tree-request-Login'));
    expect(actions.onOpenRequest).toHaveBeenCalledWith('c1', login.id);
    fireEvent.click(screen.getByTestId('empty-new-request'));
    expect(actions.onNewRequest).toHaveBeenCalledWith('c2', null);
    expect(screen.getByRole('status', { name: /Carregando/ })).toBeTruthy();
  });
});

describe('CollectionsSidebar filter and read-only', () => {
  it('hides the collections without a match and finds requests by protocol', () => {
    renderSidebar({ filter: 'grpc' });
    expect(screen.getByTestId('collection-Orders API')).toBeTruthy();
    expect(screen.queryByTestId('collection-Empty')).toBeNull();
    expect(screen.getByTestId('tree-request-Stream')).toBeTruthy();
  });

  it('keeps menus read-only: no creation, no empty-state button', () => {
    renderSidebar({ readOnly: true });
    fireEvent.click(screen.getByRole('button', { name: 'Ações de Orders API' }));
    expect(screen.queryByRole('menuitem', { name: 'Nova requisição' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Configurações' })).toBeTruthy();
    expect(screen.queryByTestId('empty-new-request')).toBeNull();
  });
});

describe('CollectionsSidebar states', () => {
  it('marks the open and the unsaved request, toggles folders and filters by typing', () => {
    const onFilter = vi.fn();
    const actions = renderSidebar({
      activeRequestId: login.id,
      dirtyIds: new Set([login.id]),
      onFilter,
    });
    expect(
      screen
        .getByTestId('tree-request-Login')
        .closest('[role="treeitem"]')!
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByLabelText('Alterações não salvas')).toBeTruthy();
    fireEvent.click(screen.getByText('Admin'));
    expect(actions.onToggle).toHaveBeenCalledWith('f1');
    fireEvent.change(screen.getByLabelText('Buscar requisições'), { target: { value: 'log' } });
    expect(onFilter).toHaveBeenCalledWith('log');
  });

  it('shows a folder closed unless it is expanded or a filter is typed', () => {
    renderSidebar({ expanded: new Set(['c1']) });
    expect(screen.queryByTestId('tree-request-Login')).toBeNull();
    expect(
      screen.getByText('Admin').closest('[role="treeitem"]')!.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('shows the header buttons and the first-collection prompt of an empty workspace', () => {
    const onNewCollection = vi.fn();
    const onImport = vi.fn();
    const onGenerate = vi.fn();
    renderSidebar({ summaries: [], onNewCollection, onImport, onGenerate });
    fireEvent.click(screen.getByTestId('new-collection'));
    fireEvent.click(screen.getByTestId('create-first'));
    fireEvent.click(screen.getByRole('button', { name: 'Importar coleção' }));
    expect(onNewCollection).toHaveBeenCalledTimes(2);
    expect(onImport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Gerar com IA' }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('shows nothing to create in a read-only workspace without collections', () => {
    renderSidebar({ summaries: [], readOnly: true });
    expect(screen.queryByTestId('create-first')).toBeNull();
    expect(screen.queryByTestId('new-collection')).toBeNull();
  });
});
