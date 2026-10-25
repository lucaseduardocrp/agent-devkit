import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ApiCollection,
  ApiCollectionSummary,
  ApiFolder,
  ApiRequestSpec,
} from '../src/features/apitests/api-test-types.js';
import {
  CollectionsSidebar,
  type SidebarActions,
} from '../src/features/apitests/integration/CollectionsSidebar.js';

const req = (id: string, name: string): ApiRequestSpec => ({
  id,
  type: 'request',
  name,
  method: 'GET',
  url: '/',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
});

const folder: ApiFolder = {
  id: 'f1',
  type: 'folder',
  name: 'Admin',
  items: [req('r2', 'List users')],
};
const getUser = req('r1', 'Get user');

const summary = (id: string, name: string): ApiCollectionSummary =>
  ({
    id,
    name,
    description: '',
    requestCount: 0,
    updatedAt: '',
  }) as unknown as ApiCollectionSummary;
const collection = (id: string, name: string, items: ApiCollection['items']): ApiCollection =>
  ({ id, name, items, variables: [], auth: { type: 'none' } }) as unknown as ApiCollection;

function actions(): { [K in keyof SidebarActions]: ReturnType<typeof vi.fn> } {
  return {
    onToggle: vi.fn(),
    onOpenRequest: vi.fn(),
    onNewRequest: vi.fn(),
    onNewFolder: vi.fn(),
    onRun: vi.fn(),
    onSettings: vi.fn(),
    onRenameCollection: vi.fn(),
    onRename: vi.fn(),
    onClone: vi.fn(),
    onDelete: vi.fn(),
  };
}

function renderSidebar(
  props: Partial<React.ComponentProps<typeof CollectionsSidebar>> & {
    actions: SidebarActions;
  },
) {
  const extra = {
    onFilter: vi.fn(),
    onNewCollection: vi.fn(),
    onImport: vi.fn(),
    onGenerate: vi.fn(),
  };
  render(
    <CollectionsSidebar
      summaries={[summary('c1', 'Users'), summary('c2', 'Orders'), summary('c3', 'Empty')]}
      loaded={{
        c1: collection('c1', 'Users', [getUser, folder]),
        c2: collection('c2', 'Orders', [req('r9', 'Create order')]),
        c3: collection('c3', 'Empty', []),
      }}
      expanded={new Set(['c1', 'c3', 'f1'])}
      activeRequestId="r1"
      dirtyIds={new Set(['r1'])}
      filter=""
      readOnly={false}
      {...extra}
      {...props}
    />,
  );
  return extra;
}

/** Opens the row menu named after `name` and clicks the item `label`. */
function menu(name: string, label: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: `Ações de ${name}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

describe('CollectionsSidebar', () => {
  it('runs every action of the collection, folder and request menus', () => {
    const spies = actions();
    const extra = renderSidebar({ actions: spies });

    menu('Users', /Nova requisição/);
    expect(spies.onNewRequest).toHaveBeenLastCalledWith('c1', null);
    menu('Users', /Nova pasta/);
    expect(spies.onNewFolder).toHaveBeenLastCalledWith('c1', null);
    menu('Users', /Executar/);
    expect(spies.onRun).toHaveBeenLastCalledWith('c1', null);
    menu('Users', /Renomear/);
    expect(spies.onRenameCollection).toHaveBeenCalledWith('c1');
    menu('Users', /Configurações/);
    expect(spies.onSettings).toHaveBeenCalledWith('c1');
    menu('Users', /Excluir coleção/);
    expect(spies.onDelete).toHaveBeenLastCalledWith('c1', null);

    menu('Admin', /Nova requisição/);
    expect(spies.onNewRequest).toHaveBeenLastCalledWith('c1', 'f1');
    menu('Admin', /Nova pasta/);
    expect(spies.onNewFolder).toHaveBeenLastCalledWith('c1', 'f1');

    menu('Get user', /Executar/);
    expect(spies.onRun).toHaveBeenLastCalledWith('c1', 'r1');
    menu('Get user', /Renomear/);
    expect(spies.onRename).toHaveBeenCalledWith('c1', getUser);
    menu('Get user', /Clonar/);
    expect(spies.onClone).toHaveBeenCalledWith('c1', getUser);
    menu('Get user', /^Excluir$/);
    expect(spies.onDelete).toHaveBeenLastCalledWith('c1', getUser);

    // Rows open and toggle; the unsaved request is marked.
    fireEvent.click(screen.getByTestId('tree-request-List users'));
    expect(spies.onOpenRequest).toHaveBeenCalledWith('c1', 'r2');
    fireEvent.click(screen.getByRole('button', { name: 'Admin' }));
    expect(spies.onToggle).toHaveBeenCalledWith('f1');
    expect(screen.getByLabelText('Alterações não salvas')).toBeTruthy();
    expect(screen.getByText('Nenhuma requisição ainda.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Buscar requisições'), { target: { value: 'x' } });
    expect(extra.onFilter).toHaveBeenCalledWith('x');
    fireEvent.click(screen.getByTestId('new-collection'));
    expect(extra.onNewCollection).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Importar Postman/ }));
    expect(extra.onImport).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar com IA' }));
    expect(extra.onGenerate).toHaveBeenCalled();
  });

  it('hides the collections without matches while searching, and opens folders that match', () => {
    renderSidebar({ actions: actions(), filter: ' list ', expanded: new Set(['c1', 'c2']) });
    expect(screen.queryByTestId('collection-Orders')).toBeNull();
    expect(screen.queryByTestId('collection-Empty')).toBeNull();
    expect(screen.getByTestId('tree-request-List users')).toBeTruthy();
    // A collection still loading stays listed.
    expect(screen.getByTestId('collection-Users')).toBeTruthy();
  });

  it('toggles a collection and shows a closed folder without its requests', () => {
    const spies = actions();
    renderSidebar({ actions: spies, expanded: new Set(['c1']) });
    expect(screen.queryByTestId('tree-request-List users')).toBeNull();
    const admin = screen.getByRole('button', { name: 'Admin' });
    expect(admin.querySelector('.ti-folder')).toBeTruthy();
    fireEvent.click(screen.getByTestId('collection-Orders'));
    expect(spies.onToggle).toHaveBeenCalledWith('c2');
  });

  it('shows a skeleton for a collection still loading', () => {
    render(
      <CollectionsSidebar
        summaries={[summary('c1', 'Users')]}
        loaded={{}}
        expanded={new Set(['c1'])}
        activeRequestId={null}
        dirtyIds={new Set()}
        filter="any"
        readOnly
        onFilter={vi.fn()}
        onNewCollection={vi.fn()}
        onImport={vi.fn()}
        onGenerate={vi.fn()}
        actions={actions()}
      />,
    );
    expect(screen.getByRole('status', { name: 'Carregando...' })).toBeTruthy();
    expect(screen.queryByTestId('new-collection')).toBeNull();
  });

  it('leaves read-only members only the settings of a collection', () => {
    const spies = actions();
    renderSidebar({ actions: spies, readOnly: true });
    fireEvent.click(screen.getByRole('button', { name: 'Ações de Users' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Configurações']);
    expect(screen.queryByRole('button', { name: 'Ações de Get user' })).toBeNull();
  });

  it('offers to create or import the first collection', () => {
    const extra = renderSidebar({ actions: actions(), summaries: [] });
    fireEvent.click(screen.getByTestId('create-first'));
    expect(extra.onNewCollection).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Importar coleção' }));
    expect(extra.onImport).toHaveBeenCalled();
    const tree = screen.getByRole('tree');
    expect(within(tree).queryByRole('treeitem')).toBeNull();
  });
});
