import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eExploration } from '../src/features/e2e/E2eExploration.js';
import { E2eRunView } from '../src/features/e2e/E2eRunView.js';
import { E2eView } from '../src/features/e2e/E2eView.js';
import { MAP_CARD, layoutActionMap } from '../src/features/e2e/e2e-run-layout.js';
import type { ApiClient } from '../src/lib/api-client.js';
import { extractPdfText } from '../src/lib/pdf-text.js';
import { MediaProvider } from '../src/features/shared/media.js';
import { pickRepository } from './helpers/pick-repository.js';
import {
  e2eImagePath,
  isExplorationActive,
  type E2eActionMap,
  type E2eCreationDetail,
  type E2eExploration as Exploration,
  type E2eMapPage,
  type E2eTestStatus,
  type E2eTestSummary,
} from '../src/features/e2e/e2e-types.js';

// The PDF reader needs a browser worker; its own test covers it.
vi.mock('../src/lib/pdf-text.js', () => ({ extractPdfText: vi.fn() }));

const REPOSITORY_NAMES = { 'github:42': 'acme/app' };

const asClient = (client: object) => client as unknown as ApiClient;

function test(id: string, status: E2eTestStatus, overrides: Partial<E2eTestSummary> = {}) {
  return {
    id,
    creationId: 'c1',
    position: 1,
    code: 'TC001',
    title: `Test ${id}`,
    description: '',
    steps: [],
    priority: 'high',
    category: 'Checkout',
    scriptPath: null,
    beforeRunInstructions: null,
    afterRunInstructions: null,
    scriptInstructions: null,
    status,
    error: null,
    analysis: null,
    verdict: null,
    durationMs: null,
    attempts: 1,
    hasVideo: false,
    externalCase: null,
    stepResults: [],
    createdAt: '2026-10-09T14:02:00Z',
    updatedAt: '2026-10-09T14:02:00Z',
    lastRunAt: null,
    ...overrides,
  } satisfies E2eTestSummary;
}

function run(overrides: Partial<E2eCreationDetail> = {}): E2eCreationDetail {
  return {
    id: 'c1',
    agentId: 'a1',
    name: 'Promo codes',
    mode: 'frontend',
    scope: 'codebase',
    baseUrl: 'https://storefront.example',
    path: '/',
    username: null,
    hasPassword: false,
    prdFileNames: [],
    repository: null,
    reporting: null,
    lastReport: null,
    status: 'completed',
    error: null,
    createdAt: '2026-10-09T14:02:00Z',
    updatedAt: '2026-10-09T14:02:00Z',
    finishedAt: '2026-10-09T14:10:00Z',
    tests: [
      test('t1', 'passed'),
      test('t2', 'failed', { category: null }),
      test('t3', 'error', { category: null }),
    ],
    prd: 'PRD',
    diff: null,
    instructions: null,
    ...overrides,
  };
}

function page(id: string, overrides: Partial<E2eMapPage> = {}): E2eMapPage {
  return {
    id,
    path: `/${id}`,
    title: `Title ${id}`,
    image: { testId: 't1', index: 1 },
    testIds: ['t1'],
    touches: 2,
    failedTestIds: [],
    elements: [],
    ...overrides,
  };
}

const checkout = page('checkout', {
  testIds: ['t1', 't2'],
  failedTestIds: ['t2'],
  elements: [
    {
      id: 'e1',
      kind: 'field',
      name: 'Address',
      box: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
      image: { testId: 't1', index: 3 },
      touches: [
        { testId: 't1', step: 4, action: 'type', value: '18 Harbour Lane' },
        { testId: 't2', step: 4, action: 'type', value: '18 Harbour Lane' },
        { testId: 't2', step: 5, action: 'click', value: null },
        { testId: 'removed', step: 1, action: 'hover', value: null },
      ],
    },
    {
      id: 'e2',
      kind: 'button',
      name: '',
      box: null,
      image: { testId: 't1', index: 4 },
      touches: [{ testId: 't1', step: 1, action: 'press', value: null }],
    },
    { id: 'e3', kind: 'link', name: 'Help', box: null, image: null, touches: [] },
  ],
});

const map: E2eActionMap = {
  pages: [page('home'), checkout, page('cart', { image: null }), page('orphan', { testIds: [] })],
  edges: [
    { from: null, to: 'home', testIds: ['t1', 't2'] },
    { from: 'home', to: 'checkout', testIds: ['t1', 't2'] },
    { from: 'home', to: 'cart', testIds: ['t1'] },
    { from: 'gone', to: 'cart', testIds: ['t1'] },
    { from: 'home', to: 'gone', testIds: ['t1'] },
  ],
  tests: [
    { id: 't1', status: 'passed', path: ['home', 'checkout', 'home', 'cart'], live: null },
    { id: 't2', status: 'failed', path: ['home', 'checkout'], live: null },
    { id: 't3', status: 'error', path: [], live: null },
  ],
};

function runApi(creation: E2eCreationDetail = run(), actions: E2eActionMap = map) {
  return {
    getE2eCreation: vi.fn().mockResolvedValue(creation),
    getE2eActionMap: vi.fn().mockResolvedValue(actions),
    // Given as the implementation, so it outlives the restoring of the mocks that ends each test.
    getE2eImage: vi.fn(() => Promise.resolve(new Blob(['img']))),
  };
}

/**
 * Runs the callback of the screen's refresh interval, as if its time had passed. The interval
 * is found by its period: the testing library polls with intervals of its own.
 */
async function tick(
  spy: { readonly mock: { readonly calls: readonly unknown[][] } },
  everyMs: number,
) {
  const call = spy.mock.calls.filter((item) => item[1] === everyMs).at(-1)!;
  await act(async () => {
    (call[0] as () => void)();
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:image', revokeObjectURL: () => undefined }),
  );
});
afterEach(() => vi.restoreAllMocks());

/** Picks an option of a searchable select: its list is drawn on the page, not inside the field. */
async function pickSaved(root: ReturnType<typeof within>, label: string, option: string) {
  fireEvent.focus(root.getByRole('combobox', { name: label }));
  fireEvent.click(await within(document.body).findByRole('option', { name: option }));
}

describe('layoutActionMap', () => {
  it('places pages in the column of the earliest moment a test got to them', () => {
    const layout = layoutActionMap(map);
    const at = (id: string) => layout.nodes.find((node) => node.page.id === id)!;
    const column = MAP_CARD.width + MAP_CARD.gapX;
    // The page no test path goes through shares the first column with the home page.
    expect(at('home').x).toBe(MAP_CARD.startWidth);
    expect(at('orphan').x).toBe(MAP_CARD.startWidth);
    expect(at('checkout').x).toBe(MAP_CARD.startWidth + column);
    // Reached at the fourth stop of its test: columns without pages are closed up.
    expect(at('cart').x).toBe(MAP_CARD.startWidth + 2 * column);
    expect(at('home').y).toBe(0);
    expect(at('orphan').y).toBe(MAP_CARD.height + MAP_CARD.gapY);
    // Shorter columns are centred on the tallest one.
    expect(at('checkout').y).toBe((MAP_CARD.height + MAP_CARD.gapY) / 2);
    expect(layout.width).toBe(MAP_CARD.startWidth + 3 * column);
    expect(layout.height).toBe(2 * MAP_CARD.height + MAP_CARD.gapY);

    // Edges to or from pages that are not on the map are left out.
    expect(layout.edges.map((edge) => [edge.id, edge.failed])).toEqual([
      ['>home', false],
      ['home>checkout', true],
      ['home>cart', false],
    ]);
    expect(layout.edges[0]!.d.startsWith(`M ${layout.start.x} ${layout.start.y} C`)).toBe(true);
  });

  it('lays out an empty map', () => {
    expect(layoutActionMap({ pages: [], edges: [], tests: [] })).toMatchObject({
      nodes: [],
      edges: [],
      width: MAP_CARD.startWidth,
      height: MAP_CARD.height,
    });
  });
});

describe('E2eRunView', () => {
  const props = {
    creationId: 'c1',
    onBack: vi.fn(),
    onOpenTest: vi.fn(),
    onOpenExploration: vi.fn(),
    onEdit: vi.fn(),
    onDeleted: vi.fn(),
  };

  it('shows the progress of a finished run, its tests by feature area and the map', async () => {
    const client = runApi();
    const onBack = vi.fn();
    const onOpenExploration = vi.fn();
    const view = render(
      <E2eRunView
        {...props}
        apiClient={asClient(client)}
        onBack={onBack}
        onOpenExploration={onOpenExploration}
      />,
    );
    expect(view.queryByRole('status')).toBeNull();
    expect(await view.findByText('3 testes em storefront.example')).toBeInTheDocument();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Promo codes ·');
    const status = view.getByRole('status');
    expect(status).toHaveTextContent('Execução finalizada');
    expect(status).toHaveTextContent('3/3');
    expect(status).not.toHaveTextContent('em andamento');

    // Tests are grouped by feature area; those without one come under "other".
    const groups = view.getAllByRole('button', { expanded: true });
    expect(groups.map((group) => group.textContent)).toEqual(['Checkout', 'Outros testes']);
    expect(view.getByRole('button', { name: 'Abrir teste Test t1' })).toHaveTextContent(
      '3 páginas',
    );
    expect(view.getByRole('button', { name: 'Abrir teste Test t3' })).toHaveTextContent(
      '0 páginas',
    );
    fireEvent.click(groups[1]!);
    expect(view.queryByRole('button', { name: 'Abrir teste Test t2' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Outros testes', expanded: false }));
    expect(view.getByRole('button', { name: 'Abrir teste Test t2' })).toBeInTheDocument();

    fireEvent.change(view.getByLabelText('Filtrar testes'), { target: { value: 'failed' } });
    expect(view.queryByRole('button', { name: 'Abrir teste Test t1' })).toBeNull();
    expect(view.getByRole('button', { name: 'Abrir teste Test t3' })).toBeInTheDocument();
    fireEvent.change(view.getByLabelText('Filtrar testes'), { target: { value: 'passed' } });
    expect(view.queryByRole('button', { name: 'Abrir teste Test t2' })).toBeNull();
    fireEvent.change(view.getByLabelText('Filtrar testes'), { target: { value: 'all' } });

    // The map: one card per page, with what happened there.
    const card = view.getByRole('button', { name: 'Abrir página /checkout' });
    expect(card).toHaveTextContent('1 falharam aqui · 2 testes · 2 interações');
    expect(view.getByRole('button', { name: 'Abrir página /home' })).not.toHaveTextContent(
      'falharam',
    );
    expect(view.getByText('início · 3')).toBeInTheDocument();
    expect(await view.findByAltText('Página /checkout')).toBeInTheDocument();
    expect(view.queryByAltText('Página /cart')).toBeNull();
    expect(client.getE2eImage).toHaveBeenCalledWith(
      e2eImagePath.trail({ testId: 't1', index: 1 }, 'page'),
      expect.any(AbortSignal),
    );

    // Hovering (or focusing) a test traces its way on the map.
    const edges = () => Array.from(view.container.querySelectorAll('path'));
    expect(edges().map((edge) => edge.getAttribute('data-traced'))).toEqual([
      'false',
      'false',
      'false',
    ]);
    fireEvent.mouseEnter(view.getByRole('button', { name: 'Abrir teste Test t2' }));
    expect(edges().map((edge) => edge.getAttribute('data-traced'))).toEqual([
      'true',
      'true',
      'false',
    ]);
    expect(view.getByRole('button', { name: 'Abrir página /cart' })).toHaveAttribute(
      'data-traced',
      'false',
    );
    expect(card).toHaveAttribute('data-traced', 'true');
    fireEvent.mouseLeave(view.getByRole('button', { name: 'Abrir teste Test t2' }));
    fireEvent.focus(view.getByRole('button', { name: 'Abrir teste Test t1' }));
    expect(edges().every((edge) => edge.getAttribute('data-traced') === 'true')).toBe(true);
    fireEvent.blur(view.getByRole('button', { name: 'Abrir teste Test t1' }));
    expect(edges().every((edge) => edge.getAttribute('data-traced') === 'false')).toBe(true);

    fireEvent.click(view.getByRole('button', { name: 'Abrir teste Test t1' }));
    expect(props.onOpenTest).toHaveBeenLastCalledWith('t1');
    fireEvent.click(view.getByRole('button', { name: /Exploração do site/ }));
    expect(onOpenExploration).toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('opens a page of the map, then an element with what the tests did to it', async () => {
    const client = runApi();
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Abrir página /cart' }));
    const empty = view.getByTestId('e2e-run-page-panel');
    expect(empty).toHaveTextContent('Elementos em /cart');
    expect(empty).toHaveTextContent('Nenhum elemento foi tocado nesta página.');
    expect(view.getByRole('button', { name: 'Abrir página /cart' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(view.getByRole('button', { name: 'Abrir página /checkout' }));
    expect(view.getByRole('button', { name: 'Abrir elemento Address' })).toHaveTextContent('×4');
    // An element without a name is called by its kind.
    fireEvent.click(view.getByRole('button', { name: 'Abrir elemento button' }));
    let panel = view.getByTestId('e2e-run-element-panel');
    expect(panel).toHaveTextContent('1 testes interagiram');
    expect(panel).toHaveTextContent('Tecla pressionada');
    expect(await within(panel).findByAltText('Elemento button na página')).toBeInTheDocument();
    expect(view.queryByTestId('e2e-run-element-box')).toBeNull();
    expect(within(panel).queryByText('Valores digitados')).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: /Elementos em/ }));
    fireEvent.click(view.getByRole('button', { name: 'Abrir elemento Help' }));
    expect(view.getByTestId('e2e-run-element-panel').querySelector('img')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: /Elementos em/ }));

    fireEvent.click(view.getByRole('button', { name: 'Abrir elemento Address' }));
    panel = view.getByTestId('e2e-run-element-panel');
    expect(panel).toHaveTextContent('Elemento em /checkout');
    expect(panel).toHaveTextContent('2 testes interagiram');
    expect(panel).toHaveTextContent('Digitado');
    expect(panel).toHaveTextContent('Clicado');
    expect(panel).not.toHaveTextContent('Mouse sobre');
    expect(panel).toHaveTextContent('Interações3');
    expect(within(panel).getByText('18 Harbour Lane').parentElement).toHaveTextContent('×2');
    const box = view.getByTestId('e2e-run-element-box');
    expect(box.style.left).toBe('10%');
    expect(box.style.width).toBe('50%');
    // Touches of a test that is no longer in the run are left out.
    const touches = within(panel).getAllByRole('button', { name: /Test t/ });
    expect(touches.map((item) => item.textContent)).toEqual([
      'Test t1#4',
      'Test t2#4',
      'Test t2#5',
    ]);
    fireEvent.click(touches[1]!);
    expect(props.onOpenTest).toHaveBeenLastCalledWith('t2');

    fireEvent.click(within(panel).getByRole('button', { name: /Elementos em/ }));
    fireEvent.click(
      within(view.getByTestId('e2e-run-page-panel')).getByRole('button', { name: /Testes/ }),
    );
    expect(view.getByLabelText('Filtrar testes')).toBeInTheDocument();
  });

  it('shows a skeleton shaped like the run while it loads', async () => {
    const view = render(<E2eRunView {...props} apiClient={asClient(runApi())} />);
    expect(view.getByTestId('e2e-run-skeleton')).toBeInTheDocument();
    await view.findByText('início · 3');
    expect(view.queryByTestId('e2e-run-skeleton')).toBeNull();
  });

  describe('three-dot menu of the run', () => {
    const menuApi = (creation: E2eCreationDetail = run()) => ({
      ...runApi(creation),
      rerunE2eCreation: vi.fn().mockResolvedValue(undefined),
      cancelE2eCreation: vi.fn().mockResolvedValue(undefined),
      deleteE2eCreation: vi.fn().mockResolvedValue(undefined),
      pullE2eCreation: vi.fn().mockResolvedValue({ linked: 2, imported: 1, missing: 0 }),
      getTestManagementProviders: vi.fn().mockResolvedValue([]),
    });
    const open = async (view: ReturnType<typeof render>) => {
      fireEvent.click(await view.findByRole('button', { name: 'Ações' }));
      return within(await view.findByRole('menu'));
    };

    it('offers the options of a run, with delete in red', async () => {
      const client = menuApi(
        run({
          repository: { provider: 'github', id: '42', name: 'acme/app', branch: 'main', path: '' },
        }),
      );
      const onEdit = vi.fn();
      const view = render(<E2eRunView {...props} apiClient={asClient(client)} onEdit={onEdit} />);
      const menu = await open(view);
      expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'Editar',
        'Pull dos scripts',
        'Gestão de testes',
        'Importar test cases',
        'Excluir execução',
      ]);
      expect(menu.getByRole('menuitem', { name: 'Excluir execução' })).toHaveAttribute(
        'data-destructive',
      );

      fireEvent.click(menu.getByRole('menuitem', { name: 'Editar' }));
      expect(onEdit).toHaveBeenCalledOnce();
      // The page has its own button for the exploration, so the menu does not repeat it.
      expect(menu.queryByRole('menuitem', { name: 'Exploração do site' })).toBeNull();

      // Running everything again is a button of the page, not an option of the menu.
      expect(menu.queryByRole('menuitem', { name: 'Executar todos novamente' })).toBeNull();
      fireEvent.click(view.getByRole('button', { name: 'Executar todos novamente' }));
      await waitFor(() => expect(client.rerunE2eCreation).toHaveBeenCalledWith('c1'));
      expect(await view.findByText(/Execução reiniciada/)).toBeTruthy();
      await waitFor(() => expect(client.getE2eCreation).toHaveBeenCalledTimes(2));
    });

    it('pulls the scripts and tells the result', async () => {
      const client = menuApi(
        run({
          repository: { provider: 'github', id: '42', name: 'acme/app', branch: 'main', path: '' },
        }),
      );
      const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
      fireEvent.click((await open(view)).getByRole('menuitem', { name: 'Pull dos scripts' }));
      await waitFor(() => expect(client.pullE2eCreation).toHaveBeenCalledWith('c1'));
      expect(await view.findByText(/Promo codes: 2 script/)).toBeInTheDocument();
    });

    it('reports an action that failed', async () => {
      const client = menuApi();
      client.rerunE2eCreation.mockRejectedValue(new Error('Worker offline'));
      const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
      fireEvent.click(await view.findByRole('button', { name: 'Executar todos novamente' }));
      expect(await view.findByRole('alert')).toHaveTextContent('Worker offline');
    });

    it('cancels a run in progress instead of offering to edit or run it again', async () => {
      const client = menuApi(run({ status: 'running' }));
      const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
      const menu = await open(view);
      expect(menu.queryByRole('menuitem', { name: 'Editar' })).toBeNull();
      expect(menu.queryByRole('menuitem', { name: 'Executar todos novamente' })).toBeNull();
      expect(view.queryByRole('button', { name: 'Executar todos novamente' })).toBeNull();
      fireEvent.click(menu.getByRole('menuitem', { name: 'Cancelar execução' }));
      await waitFor(() => expect(client.cancelE2eCreation).toHaveBeenCalledWith('c1'));
    });

    it('deletes the run after confirming and leaves the page', async () => {
      const client = menuApi();
      const onDeleted = vi.fn();
      const view = render(
        <E2eRunView {...props} apiClient={asClient(client)} onDeleted={onDeleted} />,
      );
      fireEvent.click((await open(view)).getByRole('menuitem', { name: 'Excluir execução' }));
      fireEvent.click(
        within(await view.findByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
      );
      await waitFor(() => expect(client.deleteE2eCreation).toHaveBeenCalledWith('c1'));
      await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    });

    it('stays on the page when the run cannot be deleted', async () => {
      const client = menuApi();
      client.deleteE2eCreation.mockRejectedValue(new Error('Forbidden'));
      const onDeleted = vi.fn();
      const view = render(
        <E2eRunView {...props} apiClient={asClient(client)} onDeleted={onDeleted} />,
      );
      fireEvent.click((await open(view)).getByRole('menuitem', { name: 'Excluir execução' }));
      fireEvent.click(
        within(await view.findByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
      );
      expect(await view.findByRole('alert')).toHaveTextContent('Forbidden');
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('opens the test management and import dialogs', async () => {
      const client = menuApi();
      const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
      fireEvent.click((await open(view)).getByRole('menuitem', { name: 'Gestão de testes' }));
      expect(await view.findByRole('dialog')).toBeInTheDocument();
    });

    it('has no menu for a viewer', async () => {
      const view = render(<E2eRunView {...props} isReadOnly apiClient={asClient(runApi())} />);
      await view.findByText('início · 3');
      expect(view.queryByRole('button', { name: 'Ações' })).toBeNull();
    });
  });

  it('resizes the tests panel by dragging or with the arrow keys, within its limits', async () => {
    const view = render(<E2eRunView {...props} apiClient={asClient(runApi())} />);
    await view.findByText('início · 3');
    const handle = view.getByRole('separator', { name: 'Redimensionar o painel de testes' });
    const panel = () =>
      (handle.nextElementSibling as HTMLElement).style.getPropertyValue('--run-panel-width');
    expect(panel()).toBe('320px');

    // Only the primary button starts a drag. The container is 1000px wide and the map keeps at
    // least 320px of it, so the panel is as wide as the pointer is far from the right edge.
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 1000, right: 1000 } as DOMRect);
    // jsdom has no PointerEvent: the gestures are mouse events with the pointer event names.
    const pointer = (type: string, target: Element | Window, init: MouseEventInit = {}) =>
      fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    pointer('pointerdown', handle, { button: 2 });
    expect(document.body.style.cursor).toBe('');
    pointer('pointerdown', handle, { button: 0 });
    expect(document.body.style.cursor).toBe('col-resize');
    pointer('pointermove', window, { clientX: 500 });
    expect(panel()).toBe('500px');
    pointer('pointermove', window, { clientX: -5000 });
    expect(panel()).toBe('680px');
    pointer('pointermove', window, { clientX: 990 });
    expect(panel()).toBe('240px');
    pointer('pointerup', window);
    expect(document.body.style.cursor).toBe('');
    pointer('pointermove', window, { clientX: 500 });
    expect(panel()).toBe('240px');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel()).toBe('256px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel()).toBe('240px');
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(panel()).toBe('240px');

    // In a very wide window the panel stops at its own largest size.
    rect.mockReturnValue({ width: 5000, right: 5000 } as DOMRect);
    pointer('pointerdown', handle, { button: 0 });
    pointer('pointermove', window, { clientX: 1000 });
    expect(panel()).toBe('720px');
    pointer('pointerup', window);
    rect.mockRestore();
  });

  it('zooms the map in and out within its limits', async () => {
    const view = render(<E2eRunView {...props} apiClient={asClient(runApi())} />);
    await view.findByText('início · 3');
    const scaled = () =>
      (view.getByTestId('e2e-run-map').firstElementChild!.firstElementChild as HTMLElement).style
        .transform;
    expect(scaled()).toBe('scale(1)');
    fireEvent.click(view.getByRole('button', { name: 'Aproximar' }));
    fireEvent.click(view.getByRole('button', { name: 'Aproximar' }));
    expect(scaled()).toBe('scale(1.5)');
    expect(view.getByRole('button', { name: 'Aproximar' })).toHaveAttribute('disabled');
    fireEvent.click(view.getByRole('button', { name: 'Restaurar zoom' }));
    fireEvent.click(view.getByRole('button', { name: 'Afastar' }));
    fireEvent.click(view.getByRole('button', { name: 'Afastar' }));
    expect(scaled()).toBe('scale(0.5)');
    expect(view.getByRole('button', { name: 'Afastar' })).toHaveAttribute('disabled');
  });

  it('follows a run in progress: counts, what each test is doing and its browser', async () => {
    const creation = run({
      status: 'running',
      mode: 'backend',
      error: 'O navegador caiu.',
      tests: [
        test('t1', 'running'),
        test('t2', 'generating'),
        test('t3', 'pending'),
        test('t4', 'passed'),
        test('t5', 'cancelled'),
      ],
    });
    const live = { step: 2, action: 'click' as const, kind: 'button', name: 'Save' };
    const client = runApi(creation, {
      pages: [],
      edges: [],
      tests: [{ id: 't1', status: 'running', path: [], live }],
    });
    client.getE2eImage.mockRejectedValue(new Error('no frame yet'));
    const interval = vi.spyOn(window, 'setInterval');
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    const status = await view.findByText('Executando');
    expect(status.parentElement).toHaveTextContent('2 em andamento · 1 na fila');
    expect(view.getByText('1/5')).toBeInTheDocument();
    expect(view.getByRole('alert')).toHaveTextContent('O navegador caiu.');
    expect(view.queryByRole('button', { name: /Exploração do site/ })).toBeNull();
    expect(view.getByText(/O mapa é preenchido conforme os testes rodam/)).toBeInTheDocument();
    // What the running test is doing right now.
    expect(view.getAllByRole('status')[1]).toHaveTextContent(
      'Test t1Passo 2 · Clicar em button "Save"',
    );

    await tick(interval, 3000);
    expect(client.getE2eCreation).toHaveBeenCalledTimes(2);

    fireEvent.click(view.getByRole('tab', { name: 'Navegadores' }));
    expect(view.getByText('5 navegadores, um teste em cada')).toBeInTheDocument();
    const tile = (id: string) => view.getByRole('button', { name: `Abrir teste Test ${id}` });
    // No frame yet: the running test says its browser is opening.
    await waitFor(() => expect(tile('t1')).toHaveTextContent('Abrindo o navegador'));
    expect(tile('t1')).toHaveTextContent('Passo 2 · Clicar em button "Save"');
    expect(client.getE2eImage).toHaveBeenCalledWith('tests/t1/live', expect.any(AbortSignal));
    expect(tile('t2')).toHaveTextContent('Abrindo o navegador');
    expect(tile('t3')).toHaveTextContent('Aguardando um navegador');
    expect(tile('t4')).toHaveTextContent('Pass');
    expect(tile('t5')).not.toHaveTextContent('navegador');
    fireEvent.click(tile('t3'));
    expect(props.onOpenTest).toHaveBeenLastCalledWith('t3');

    client.getE2eImage.mockResolvedValue(new Blob(['frame']));
    await tick(interval, 3000);
    expect(await view.findByAltText('Navegador de Test t1')).toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: 'Ações do agente' }));
    expect(view.getByLabelText('Filtrar testes')).toBeInTheDocument();

    // Polling stops with the run.
    const cleared = vi.spyOn(window, 'clearInterval');
    client.getE2eCreation.mockResolvedValue(run({ tests: [] }));
    await tick(interval, 3000);
    await waitFor(() => expect(view.getByText('Execução finalizada')).toBeInTheDocument());
    expect(cleared).toHaveBeenCalled();
    expect(view.getByText('0/0')).toBeInTheDocument();
  });

  it('covers a finished test with the last screenshot of its evidence', async () => {
    const step = (position: number, hasScreenshot: boolean) => ({
      position,
      title: `Step ${position}`,
      status: 'passed' as const,
      durationMs: 10,
      error: null,
      hasScreenshot,
    });
    const creation = run({
      tests: [
        test('t1', 'passed', { stepResults: [step(1, true), step(2, true), step(3, false)] }),
        test('t2', 'passed'),
      ],
    });
    const client = runApi(creation);
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('tab', { name: 'Navegadores' }));
    expect(await view.findByAltText('Navegador de Test t1')).toBeInTheDocument();
    expect(client.getE2eImage).toHaveBeenCalledWith(
      'tests/t1/steps/2/screenshot',
      expect.any(AbortSignal),
    );
    expect(view.getByRole('button', { name: 'Abrir teste Test t2' })).toHaveTextContent('Pass');
  });

  it('reports a run that cannot be loaded and tries again', async () => {
    const client = runApi();
    client.getE2eCreation.mockRejectedValueOnce(new Error('Execução não encontrada.'));
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    expect(await view.findByRole('alert')).toHaveTextContent('Execução não encontrada.');
    client.getE2eActionMap.mockRejectedValueOnce('offline');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Não foi possível carregar a execução.'),
    );
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByText('Execução finalizada')).toBeInTheDocument();
  });
});

function exploration(overrides: Partial<Exploration> = {}): Exploration {
  return {
    status: 'ready',
    startedAt: '2026-11-11T08:00:00.000Z',
    updatedAt: '2026-11-11T08:01:10.000Z',
    signedInMs: 35_000,
    finishedAt: '2026-11-11T08:02:00.000Z',
    error: null,
    hasLiveFrame: false,
    pages: [
      {
        index: 1,
        url: 'https://storefront.example/',
        title: 'Issues',
        summary: 'App · Issues',
        elements: ['Filters', 'New issue'],
        hasScreenshot: true,
      },
      {
        index: 2,
        url: 'https://storefront.example/inbox',
        title: 'Inbox',
        summary: 'App · Inbox',
        elements: [],
        hasScreenshot: false,
      },
    ],
    log: [
      { atMs: 0, action: 'navigate', target: 'https://storefront.example/', result: 'Sign in' },
      { atMs: 35_000, action: 'sign_in', target: 'qa@example.com', result: 'Issues' },
      { atMs: 36_000, action: 'click', target: 'Inbox', result: null },
    ],
    ...overrides,
  };
}

function exploreApi(state: Exploration | null, creation: E2eCreationDetail = run()) {
  return {
    getE2eCreation: vi.fn().mockResolvedValue(creation),
    getE2eExploration: vi.fn().mockResolvedValue(state),
    exploreE2eCreation: vi
      .fn()
      .mockResolvedValue(exploration({ status: 'exploring', pages: [], log: [] })),
    getE2eImage: vi.fn(() => Promise.resolve(new Blob(['img']))),
    // What the context picker of the instructions modal lists.
    searchPbiItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    searchIssues: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
    searchKnowledgeDocuments: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
    // The agents the instructions modal offers to explore with.
    getAgents: vi.fn().mockResolvedValue([]),
  };
}

const agentDto = (id: string, name: string, skills: string[] = []) => ({
  id,
  name,
  skills: skills.map((skill) => ({ name: skill, description: '', version: '1', revision: 'r' })),
});

describe('E2eExploration', () => {
  const props = { creationId: 'c1', onBack: vi.fn(), onOpenRun: vi.fn() };

  it('tells whether an exploration is in progress', () => {
    expect(isExplorationActive(null)).toBe(false);
    expect(isExplorationActive(exploration())).toBe(false);
    expect(isExplorationActive(exploration({ status: 'signing_in' }))).toBe(true);
    expect(isExplorationActive(exploration({ status: 'exploring' }))).toBe(true);
  });

  it('explains in the log why the agent stayed signed out or stopped', async () => {
    const client = exploreApi(
      exploration({
        log: [
          { atMs: 0, action: 'note', target: 'sign_in_no_account', result: null },
          { atMs: 1_000, action: 'note', target: 'stopped_no_targets:3', result: null },
          { atMs: 2_000, action: 'note', target: 'a_code_from_a_newer_version', result: null },
          {
            atMs: 3_000,
            action: 'type',
            target: 'Search = report',
            result: 'Files',
            reason: 'Filtrar pelo nome do arquivo',
          },
          { atMs: 4_000, action: 'press', target: 'Escape', result: null },
          {
            atMs: 5_000,
            action: 'note',
            target: 'agent_done:4',
            result: null,
            reason: 'Tudo coberto',
          },
          {
            atMs: 6_000,
            action: 'note',
            target: 'agent_failed:0',
            result: null,
            reason: 'Sem LLM',
          },
          { atMs: 7_000, action: 'note', target: 'agent_stuck:2', result: null },
          { atMs: 8_000, action: 'note', target: 'agent_unavailable', result: null },
        ],
      }),
    );
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    await view.findByText('Visão geral de storefront.example');
    fireEvent.click(view.getByRole('tab', { name: /Log ao vivo/ }));
    const panel = view.getByRole('tabpanel');
    expect(panel).toHaveTextContent('não tem conta de teste');
    expect(panel).toHaveTextContent('não restaram itens de menu, abas ou links para clicar');
    expect(panel).toHaveTextContent('(3 cliques)');
    // A code this version does not know is shown as it is.
    expect(panel).toHaveTextContent('a_code_from_a_newer_version');
    // What the AI agent did, with the reason it gave.
    expect(panel).toHaveTextContent('digitar Search = report');
    expect(panel).toHaveTextContent('Filtrar pelo nome do arquivo');
    expect(panel).toHaveTextContent('pressionar Escape');
    expect(panel).toHaveTextContent('O agente terminou de explorar após 4 ações.');
    expect(panel).toHaveTextContent('Tudo coberto');
    expect(panel).toHaveTextContent('não conseguiu decidir o próximo passo após 0 ações');
    expect(panel).toHaveTextContent('Sem LLM');
    expect(panel).toHaveTextContent('repetindo a mesma ação (2 ações feitas)');
    expect(panel).toHaveTextContent('em outro computador');
  });

  it('replays what the agent did, step by step, with where it was and why', async () => {
    const client = exploreApi(
      exploration({
        log: [
          { atMs: 0, action: 'navigate', target: 'https://storefront.example/', result: 'Sign in' },
          {
            atMs: 5_000,
            action: 'click',
            target: 'Inbox',
            result: 'Inbox',
            reason: 'Abrir a caixa de entrada',
            hasScreenshot: true,
            url: 'https://storefront.example/inbox?tab=new',
            worker: 2,
          },
          { atMs: 6_000, action: 'scroll', target: 'down', result: null },
          {
            atMs: 7_000,
            action: 'click',
            target: 'Home',
            result: 'Issues',
            hasScreenshot: true,
            url: 'not a url',
          },
          {
            atMs: 8_000,
            action: 'press',
            target: 'Escape',
            result: null,
            hasScreenshot: true,
            url: 'https://storefront.example/',
          },
          // A step the browser could not name the address of.
          { atMs: 9_000, action: 'type', target: 'Search = x', result: null, hasScreenshot: true },
        ],
      }),
    );
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    expect(await view.findByText('O que o agente fez')).toBeInTheDocument();
    // Only the actions that kept a picture are steps; the position is the one in the log.
    expect(view.getByTestId('e2e-player-counter')).toHaveTextContent('1 / 4');
    await waitFor(() =>
      expect(client.getE2eImage).toHaveBeenCalledWith(
        e2eImagePath.explorationStep('c1', 2),
        expect.any(AbortSignal),
      ),
    );
    expect(client.getE2eImage).toHaveBeenCalledWith(
      e2eImagePath.explorationStep('c1', 5),
      expect.any(AbortSignal),
    );
    expect(await view.findByTestId('e2e-player-image')).toHaveAttribute(
      'alt',
      'Captura do passo 2',
    );
    // The address of the step, without the protocol, and what the agent did and why.
    expect(view.getByTestId('e2e-player-address')).toHaveTextContent(
      'storefront.example/inbox?tab=new',
    );
    expect(view.getByTestId('e2e-player-note')).toHaveTextContent(
      'Navegador 2clicar Inbox — Abrir a caixa de entrada',
    );
    fireEvent.click(view.getByRole('button', { name: 'Próximo passo' }));
    // An address that cannot be read is shown as it is; no browser number for a single browser.
    expect(view.getByTestId('e2e-player-address')).toHaveTextContent('not a url');
    expect(view.getByTestId('e2e-player-note')).not.toHaveTextContent('Navegador');
    // The start page of the site is shown as its host only.
    fireEvent.click(view.getByRole('button', { name: 'Próximo passo' }));
    expect(view.getByTestId('e2e-player-address').textContent).toBe('storefront.example');
    // The exploration has no recording: only the steps.
    expect(view.getByRole('button', { name: 'Vídeo da execução' })).toHaveProperty(
      'disabled',
      true,
    );
    // The captured pages are still there under the replay.
    expect(view.getByText('Páginas capturadas')).toBeInTheDocument();
  });

  it('shows what the agent captured, its log and opens the planned run', async () => {
    const client = exploreApi(exploration());
    const onOpenRun = vi.fn();
    const onBack = vi.fn();
    const view = render(
      <E2eExploration
        {...props}
        apiClient={asClient(client)}
        onOpenRun={onOpenRun}
        onBack={onBack}
      />,
    );
    expect(await view.findByText('Visão geral de storefront.example')).toBeInTheDocument();
    const steps = within(view.getByRole('list', { name: 'Etapas da exploração' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((step) => [step.textContent, step.getAttribute('data-state')])).toEqual([
      ['Login feito · 35s', 'done'],
      ['Explorar', 'done'],
      ['3 testes planejados', 'done'],
    ]);
    expect(view.getByText('Páginas capturadas').textContent).toContain('2');
    expect(await view.findByAltText('Página Issues')).toBeInTheDocument();
    expect(view.queryByAltText('Página Inbox')).toBeNull();
    expect(client.getE2eImage).toHaveBeenCalledWith(
      e2eImagePath.explorationPage('c1', 1),
      expect.any(AbortSignal),
    );

    const panel = view.getByRole('tabpanel');
    expect(panel).toHaveTextContent('App · Issues');
    expect(within(panel).getByText('New issue')).toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: /Log ao vivo/ }));
    const entries = within(view.getByRole('tabpanel')).getAllByRole('listitem');
    expect(entries.map((entry) => entry.textContent)).toEqual([
      '+0msnavegar https://storefront.example/→ Sign in',
      '+35slogin qa@example.com→ Issues',
      '+36sclicar Inbox',
    ]);
    fireEvent.click(view.getByRole('tab', { name: /Páginas encontradas/ }));
    expect(view.getByRole('tabpanel')).toHaveTextContent('App · Inbox');

    fireEvent.click(view.getByRole('button', { name: /Casos de Testes/ }));
    expect(onOpenRun).toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('follows the agent live while it signs in and explores, then plans the tests', async () => {
    const waiting = run({ status: 'planning', tests: [] });
    const client = exploreApi(
      exploration({ status: 'signing_in', signedInMs: null, finishedAt: null, pages: [], log: [] }),
      waiting,
    );
    const interval = vi.spyOn(window, 'setInterval');
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    expect(await view.findByText(/Fazendo login em storefront.example/)).toBeInTheDocument();
    const states = () =>
      within(view.getByRole('list', { name: 'Etapas da exploração' }))
        .getAllByRole('listitem')
        .map((step) => [step.textContent, step.getAttribute('data-state')]);
    expect(states()).toEqual([
      ['Login', 'active'],
      ['Explorar', 'todo'],
      ['Planejar testes', 'todo'],
    ]);
    expect(view.getByText('Aguardando o navegador do agente…')).toBeInTheDocument();
    expect(view.getByText('Acompanhando o agente · passo 0')).toBeInTheDocument();
    expect(view.getByRole('tabpanel')).toHaveTextContent('Nenhuma página capturada ainda.');
    fireEvent.click(view.getByRole('tab', { name: /Log ao vivo/ }));
    expect(view.getByRole('tabpanel')).toHaveTextContent('Nada feito ainda.');
    // Nothing to start or open while the agent works.
    expect(view.queryByRole('button', { name: /Explorar de novo/ })).toBeNull();
    // The test cases are one click away even while the agent works.
    expect(view.getByRole('button', { name: /Casos de Testes/ })).toBeInTheDocument();

    client.getE2eExploration.mockResolvedValue(
      exploration({ status: 'exploring', finishedAt: null, hasLiveFrame: true }),
    );
    await tick(interval, 1500);
    expect(await view.findByText(/Explorando storefront.example/)).toBeInTheDocument();
    expect(view.getByText('1m 10s')).toBeInTheDocument();
    expect(states()).toEqual([
      ['Login feito · 35s', 'done'],
      ['Explorar', 'active'],
      ['Planejar testes', 'todo'],
    ]);
    expect(await view.findByAltText('Navegador do agente')).toBeInTheDocument();
    expect(client.getE2eImage).toHaveBeenCalledWith(
      e2eImagePath.explorationLive('c1'),
      expect.any(AbortSignal),
    );

    // Explored: the run goes on to plan its tests, and this page keeps following it.
    client.getE2eExploration.mockResolvedValue(exploration());
    await tick(interval, 1500);
    await waitFor(() => expect(states()[2]).toEqual(['Planejar testes', 'active']));
    const cleared = vi.spyOn(window, 'clearInterval');
    client.getE2eCreation.mockResolvedValue(run());
    await tick(interval, 1500);
    await waitFor(() => expect(states()[2]).toEqual(['3 testes planejados', 'done']));
    expect(cleared).toHaveBeenCalled();
  });

  it('starts an exploration for a run that has none and reports failures', async () => {
    const client = exploreApi(null, run({ tests: [] }));
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    expect(await view.findByText('Explorar storefront.example')).toBeInTheDocument();
    expect(view.getByText('O agente ainda não explorou esta aplicação.')).toBeInTheDocument();
    expect(view.queryByRole('tablist')).toBeNull();
    expect(view.queryByText(/Login/)).toBeNull();

    client.exploreE2eCreation.mockRejectedValueOnce(new Error('Execução em andamento.'));
    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    expect(await view.findByRole('alert')).toHaveTextContent('Execução em andamento.');
    client.exploreE2eCreation.mockRejectedValueOnce('offline');
    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Não foi possível concluir a ação.'),
    );
    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    expect(await view.findByText(/Explorando storefront.example/)).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('collects what to explore in a modal opened from the instructions button', async () => {
    const client = exploreApi(null, run({ tests: [] }));
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    // The Markdown editor of the description, whose source is where the text is typed.
    const source = () => {
      fireEvent.click(view.getByTestId('editor-mode-code'));
      return view.getByTestId('e2e-explore-description-code') as HTMLTextAreaElement;
    };
    // The field only exists inside the modal.
    expect(view.queryByTestId('e2e-explore-description')).toBeNull();
    const open = await view.findByRole('button', { name: /Instruções da exploração/ });
    expect(view.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();

    fireEvent.click(open);
    expect(view.getByRole('dialog')).toBeInTheDocument();
    expect(view.getByText('O que explorar (opcional)')).toBeInTheDocument();
    // The agent reads text only: there is no way to add a picture to the description.
    expect(view.queryByTestId('input-document-image')).toBeNull();
    // The lists of context stand alone, without an explanation above them.
    expect(view.queryByText(/O agente lê o que você escolher/)).toBeNull();
    fireEvent.change(source(), { target: { value: 'descartado' } });
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();

    fireEvent.click(open);
    expect(source().value).toBe('');
    fireEvent.change(source(), { target: { value: '  Só as telas de cobrança  ' } });
    fireEvent.click(view.getByRole('button', { name: /Salvar/ }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('img', { name: 'Instruções definidas' })).toBeInTheDocument();
    // Reopening starts from what was saved.
    fireEvent.click(open);
    expect(source().value).toBe('  Só as telas de cobrança  ');
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));

    client.exploreE2eCreation.mockResolvedValueOnce(
      exploration({ status: 'exploring', description: 'Só as telas de cobrança' }),
    );
    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    await waitFor(() =>
      expect(client.exploreE2eCreation).toHaveBeenCalledWith('c1', {
        description: 'Só as telas de cobrança',
      }),
    );
    expect(await view.findByText('Escopo: Só as telas de cobrança')).toBeInTheDocument();
    // While the agent works, the button is not offered.
    expect(view.queryByRole('button', { name: /Instruções da exploração/ })).toBeNull();
  });

  it('does not save a description longer than the API takes, and says so', async () => {
    const client = exploreApi(null, run({ tests: [] }));
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: /Instruções da exploração/ }));
    fireEvent.click(view.getByTestId('editor-mode-code'));
    const source = view.getByTestId('e2e-explore-description-code');
    const save = view.getByRole('button', { name: /Salvar/ }) as HTMLButtonElement;

    expect(view.queryByRole('alert')).toBeNull();
    fireEvent.change(source, { target: { value: 'x'.repeat(2001) } });
    expect(view.getByRole('alert')).toHaveTextContent(
      'Texto longo demais: a descrição aceita até 2000 caracteres.',
    );
    expect(save.disabled).toBe(true);
    // Spaces around the text are not sent, so they do not count.
    fireEvent.change(source, { target: { value: `  ${'x'.repeat(2000)}  ` } });
    expect(view.queryByRole('alert')).toBeNull();
    expect(save.disabled).toBe(false);
  });

  it('chooses PBIs, issues and Brain documents as context and explores with them', async () => {
    const client = exploreApi(null, run({ tests: [] }));
    client.searchPbiItems.mockResolvedValue({
      items: [
        {
          id: 'p1',
          title: 'Filtro de arquivos',
          status: 'Active',
          links: [{ providerId: 'azure_devops', externalId: '48325', externalUrl: null }],
        },
        { id: 'p2', title: 'Outro item', status: 'New', links: [] },
      ],
      total: 2,
    });
    client.searchIssues.mockResolvedValue({
      issues: [{ id: 'i1', number: 7, title: 'Download falha', status: 'todo' }],
      total: 1,
    });
    client.searchKnowledgeDocuments.mockResolvedValue({
      documents: [
        { id: 'src:page', title: 'Regras de download', provider: 'azure_devops' },
        { id: 'x', title: 'Documento solto' },
      ],
      total: 2,
    });
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    const open = await view.findByRole('button', { name: /Instruções da exploração/ });
    const pick = async (list: string, option: RegExp) => {
      fireEvent.focus(await view.findByRole('combobox', { name: list }));
      fireEvent.click(await view.findByRole('option', { name: option }));
    };

    // A choice that is cancelled is forgotten.
    fireEvent.click(open);
    await pick('PBIs', /Filtro de arquivos/);
    expect(view.getByRole('option', { name: /#48325 · Active/ })).toBeInTheDocument();
    expect(view.getByRole('option', { name: /Outro item/ })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));
    expect(view.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();
    fireEvent.click(open);
    expect(await view.findByRole('combobox', { name: 'PBIs' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Remover/ })).toBeNull();

    await pick('PBIs', /Filtro de arquivos/);
    await pick('Issues', /#7 · Download falha/);
    await pick('Documentos do Brain', /Regras de download/);
    expect(view.getByRole('option', { name: /azure_devops/ })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Salvar/ }));
    // Only context was chosen, and the button still says something is set.
    expect(view.getByRole('img', { name: 'Instruções definidas' })).toBeInTheDocument();

    // Reopening starts from what was saved.
    fireEvent.click(open);
    expect(
      await view.findByRole('button', {
        name: 'Remover Download falha'.replace('Download', '#7 · Download'),
      }),
    ).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));

    client.exploreE2eCreation.mockResolvedValueOnce(
      exploration({
        status: 'exploring',
        context: [
          { kind: 'pbi', id: 'p1', title: 'Filtro de arquivos' },
          { kind: 'issue', id: 'i1', title: 'Download falha' },
        ],
      }),
    );
    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    await waitFor(() =>
      expect(client.exploreE2eCreation).toHaveBeenCalledWith('c1', {
        context: [
          { kind: 'pbi', id: 'p1' },
          { kind: 'issue', id: 'i1' },
          { kind: 'brain', id: 'src:page' },
        ],
      }),
    );
    expect(
      await view.findByText('Contexto: Filtro de arquivos · Download falha'),
    ).toBeInTheDocument();
  });

  it("chooses the agent that explores and shows its skills, sending only one other than the run's", async () => {
    const client = exploreApi(null, run({ tests: [] }));
    client.getAgents.mockResolvedValue([
      agentDto('a1', 'QA Padrão'),
      agentDto('a2', 'Explorador', ['test-design', 'accessibility']),
    ]);
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    const open = await view.findByRole('button', { name: /Instruções da exploração/ });
    fireEvent.click(open);

    // It starts on the agent of the run, which has no skills to list.
    const select = (await view.findByLabelText('Agente')) as HTMLSelectElement;
    expect(select.value).toBe('a1');
    expect(view.queryByText(/^Skills:/)).toBeNull();
    expect(client.getAgents).toHaveBeenCalledTimes(1);

    // Another agent brings its skills along; a choice that is cancelled is forgotten.
    fireEvent.change(select, { target: { value: 'a2' } });
    expect(view.getByText('Skills: test-design, accessibility')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));
    expect(view.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();
    fireEvent.click(open);
    expect(((await view.findByLabelText('Agente')) as HTMLSelectElement).value).toBe('a1');

    fireEvent.change(view.getByLabelText('Agente'), { target: { value: 'a2' } });
    fireEvent.click(view.getByRole('button', { name: /Salvar/ }));
    // Only the agent was chosen, and the button still says something is set.
    expect(view.getByRole('img', { name: 'Instruções definidas' })).toBeInTheDocument();
    // The list is not loaded again when reopened, and the choice is what was saved.
    fireEvent.click(open);
    expect(((await view.findByLabelText('Agente')) as HTMLSelectElement).value).toBe('a2');
    expect(client.getAgents).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));

    client.exploreE2eCreation.mockResolvedValueOnce(
      exploration({ status: 'exploring', agent: { id: 'a2', name: 'Explorador' } }),
    );
    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    await waitFor(() =>
      expect(client.exploreE2eCreation).toHaveBeenCalledWith('c1', { agentId: 'a2' }),
    );
    expect(await view.findByText('Agente: Explorador')).toBeInTheDocument();
  });

  it('goes back to the agent of the run when it is picked again, and sends no agent', async () => {
    const client = exploreApi(null, run({ tests: [] }));
    client.getAgents.mockResolvedValue([agentDto('a1', 'QA Padrão'), agentDto('a2', 'Explorador')]);
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    const open = await view.findByRole('button', { name: /Instruções da exploração/ });
    const save = () => fireEvent.click(view.getByRole('button', { name: /Salvar/ }));

    fireEvent.click(open);
    fireEvent.change(await view.findByLabelText('Agente'), { target: { value: 'a2' } });
    save();
    expect(view.getByRole('img', { name: 'Instruções definidas' })).toBeInTheDocument();
    fireEvent.click(open);
    fireEvent.change(await view.findByLabelText('Agente'), { target: { value: 'a1' } });
    save();
    expect(view.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();

    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    await waitFor(() => expect(client.exploreE2eCreation).toHaveBeenCalledWith('c1', {}));
  });

  it('shows the first agent when the one of the run is gone, and offers none when they cannot be loaded', async () => {
    const gone = exploreApi(null, run({ tests: [] }));
    gone.getAgents.mockResolvedValue([agentDto('a2', 'Explorador'), agentDto('a3', 'Outro')]);
    const first = render(<E2eExploration {...props} apiClient={asClient(gone)} />);
    fireEvent.click(await first.findByRole('button', { name: /Instruções da exploração/ }));
    expect(((await first.findByLabelText('Agente')) as HTMLSelectElement).value).toBe('a2');
    // What the select shows is what is sent.
    fireEvent.click(first.getByRole('button', { name: /Salvar/ }));
    fireEvent.click(first.getByRole('button', { name: /Explorar site/ }));
    await waitFor(() =>
      expect(gone.exploreE2eCreation).toHaveBeenCalledWith('c1', { agentId: 'a2' }),
    );
    first.unmount();

    const offline = exploreApi(null, run({ tests: [] }));
    offline.getAgents.mockRejectedValue(new Error('offline'));
    const second = render(<E2eExploration {...props} apiClient={asClient(offline)} />);
    fireEvent.click(await second.findByRole('button', { name: /Instruções da exploração/ }));
    await waitFor(() => expect(offline.getAgents).toHaveBeenCalled());
    // The rest of the instructions still work without the choice of agent.
    expect(await second.findByRole('combobox', { name: 'PBIs' })).toBeInTheDocument();
    expect(second.queryByLabelText('Agente')).toBeNull();
    fireEvent.click(second.getByRole('button', { name: /Salvar/ }));
    expect(second.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();
    // Leaving the page while the agents load does not update it.
    second.unmount();
  });

  it('keeps the other lists of context when one of them cannot be loaded', async () => {
    const client = exploreApi(null, run({ tests: [] }));
    client.searchIssues.mockRejectedValue(new Error('offline'));
    client.searchPbiItems.mockResolvedValue({
      items: [{ id: 'p1', title: 'Filtro de arquivos', status: 'Active', links: [] }],
      total: 1,
    });
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: /Instruções da exploração/ }));
    // The list that failed says so when opened; the others still work, and the one that is empty says so.
    fireEvent.focus(await view.findByRole('combobox', { name: 'Issues' }));
    expect(await view.findByText('Não foi possível carregar a lista.')).toBeInTheDocument();
    fireEvent.blur(view.getByRole('combobox', { name: 'Issues' }));
    fireEvent.focus(await view.findByRole('combobox', { name: 'PBIs' }));
    fireEvent.click(view.getByRole('option', { name: /Filtro de arquivos/ }));
    fireEvent.focus(view.getByRole('combobox', { name: 'Documentos do Brain' }));
    expect(view.getByText('Nada para escolher aqui ainda.')).toBeInTheDocument();
    // Leaving the page while the lists load does not update it.
    view.unmount();
  });

  it('keeps the script in the database only, with no choice of repository', async () => {
    const repository = {
      provider: 'github' as const,
      id: '42',
      name: 'acme/app',
      branch: 'main',
      path: '',
    };
    const client = exploreApi(null, run({ tests: [], repository }));
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: /Instruções da exploração/ }));
    expect(view.queryByLabelText('Salvar o roteiro em')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: /Salvar/ }));
    fireEvent.click(view.getByRole('button', { name: /Explorar site/ }));
    await waitFor(() => expect(client.exploreE2eCreation).toHaveBeenCalledWith('c1', {}));
    view.unmount();

    // Why the finished script was not saved.
    const shown = render(
      <E2eExploration
        {...props}
        apiClient={asClient(
          exploreApi(
            exploration({ status: 'ready', savedTo: null, saveError: 'branch is protected' }),
          ),
        )}
      />,
    );
    expect(
      await shown.findByText('Não foi possível salvar o roteiro: branch is protected'),
    ).toBeInTheDocument();
    shown.unmount();
  });

  it('explains a failed exploration and lets it be tried again, except for viewers and API runs', async () => {
    const failed = exploration({
      status: 'failed',
      signedInMs: null,
      error: 'Aplicação inacessível.',
    });
    const view = render(<E2eExploration {...props} apiClient={asClient(exploreApi(failed))} />);
    expect(
      await view.findByText('Não foi possível explorar storefront.example'),
    ).toBeInTheDocument();
    expect(view.getByText('Aplicação inacessível.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: /Explorar de novo/ })).toBeInTheDocument();
    view.unmount();

    const silent = render(
      <E2eExploration
        {...props}
        isReadOnly
        apiClient={asClient(exploreApi(exploration({ status: 'failed', error: null })))}
      />,
    );
    await silent.findByText('Não foi possível explorar storefront.example');
    expect(silent.queryByRole('button', { name: /Explorar de novo/ })).toBeNull();
    silent.unmount();

    const api = render(
      <E2eExploration
        {...props}
        apiClient={asClient(exploreApi(null, run({ mode: 'backend' })))}
      />,
    );
    await api.findByText('Explorar storefront.example');
    expect(api.queryByRole('button', { name: /Explorar site/ })).toBeNull();
  });

  it('reports an exploration that cannot be loaded and tries again', async () => {
    const client = exploreApi(exploration());
    client.getE2eExploration.mockRejectedValueOnce(new Error('Sem acesso.'));
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    expect(await view.findByRole('alert')).toHaveTextContent('Sem acesso.');
    client.getE2eCreation.mockRejectedValueOnce('offline');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent(
        'Não foi possível carregar as execuções E2E.',
      ),
    );
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByText('Visão geral de storefront.example')).toBeInTheDocument();
  });
});

describe('E2eView with the run, exploration and environment screens', () => {
  function viewApi() {
    const creation = run();
    const { tests, prd: _prd, diff: _diff, instructions: _instructions, ...summary } = creation;
    return {
      ...runApi(creation),
      ...exploreApi(exploration(), creation),
      getE2eRunners: vi.fn().mockResolvedValue([]),
      getE2eCreations: vi.fn().mockResolvedValue([{ ...summary, tests, passed: 1, total: 3 }]),
      getE2eEnvironments: vi.fn().mockResolvedValue([]),
      getAgents: vi.fn().mockResolvedValue([{ id: 'a1', name: 'QA', role: 'QA' }]),
      getE2eRepositories: vi.fn().mockResolvedValue({
        repositories: [{ id: '42', provider: 'github', name: 'acme/app', defaultBranch: 'main' }],
        warnings: [],
      }),
      getE2eBranches: vi.fn().mockResolvedValue([{ name: 'main', isDefault: true }]),
      createE2eCreation: vi.fn(),
      getE2eTestVideoUrl: vi.fn().mockResolvedValue(null),
      getE2eTest: vi.fn().mockResolvedValue({
        ...test('t1', 'passed'),
        logs: null,
        creation: {
          id: 'c1',
          name: 'Promo codes',
          mode: 'frontend',
          baseUrl: 'https://storefront.example',
          path: '/',
          status: 'completed',
        },
      }),
    };
  }

  it('opens a run from its name, a test from the run and comes back the same way', async () => {
    const view = render(<E2eView apiClient={asClient(viewApi())} />);
    fireEvent.click(await view.findByRole('button', { name: 'Promo codes' }));
    expect(await view.findByTestId('e2e-run-view')).toBeInTheDocument();
    fireEvent.click(await view.findByRole('button', { name: 'Abrir teste Test t1' }));
    await waitFor(() => expect(view.queryByTestId('e2e-run-view')).toBeNull());
    fireEvent.click(await view.findByRole('button', { name: /Voltar/ }));
    // Back to the run it was opened from, not to the list.
    expect(await view.findByTestId('e2e-run-view')).toBeInTheDocument();

    fireEvent.click(await view.findByRole('button', { name: /Exploração do site/ }));
    expect(await view.findByTestId('e2e-exploration')).toBeInTheDocument();
    fireEvent.click(await view.findByRole('button', { name: /Casos de Testes/ }));
    expect(await view.findByTestId('e2e-run-view')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    expect(await view.findByTestId('e2e-view')).toBeInTheDocument();
  });

  it('opens the exploration of a run from its menu and the environments from the header', async () => {
    const view = render(<E2eView apiClient={asClient(viewApi())} />);
    await view.findByRole('button', { name: 'Promo codes' });
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(await view.findByRole('menuitem', { name: /Exploração do site/ }));
    expect(await view.findByTestId('e2e-exploration')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));

    fireEvent.click(await view.findByRole('button', { name: /Ambientes/ }));
    expect(await view.findByTestId('e2e-environments')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    expect(await view.findByTestId('e2e-view')).toBeInTheDocument();
  });

  it('opens the page of a new run, which waits for the user instead of exploring', async () => {
    const client = viewApi();
    const { tests: _tests, prd: _prd, diff: _diff, instructions: _i, ...summary } = run();
    client.createE2eCreation.mockResolvedValue({
      ...summary,
      id: 'c9',
      status: 'draft',
      tests: [],
    });
    const view = render(<E2eView apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: /Nova execução/ }));
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('a1'),
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'new run' } });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'PRD' } });
    await pickRepository(REPOSITORY_NAMES, 'github:42');
    await waitFor(() =>
      expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.change(view.getByLabelText('URL base'), { target: { value: 'https://example.com' } });
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(await view.findByTestId('e2e-run-view')).toBeInTheDocument();
    expect(client.getE2eCreation).toHaveBeenCalledWith('c9');
    expect(client.createE2eCreation).toHaveBeenCalledWith(
      expect.objectContaining({ start: false }),
    );
    // Nothing is explored until the user asks.
    expect(client.getE2eExploration).not.toHaveBeenCalled();
  });
});

describe('E2eExploration code tab', () => {
  const props = { creationId: 'c1', onBack: vi.fn(), onOpenRun: vi.fn() };
  const GENERATED = 'test("Exploration of Run", async ({ page }) => {});\n';

  function codeApi(overrides: Record<string, unknown> = {}) {
    return {
      ...exploreApi(exploration()),
      getE2eExplorationCode: vi.fn().mockResolvedValue({ code: GENERATED, edited: false }),
      saveE2eExplorationCode: vi.fn(),
      ...overrides,
    };
  }

  async function openCode(client: ReturnType<typeof codeApi>, extra: object = {}) {
    const view = render(<E2eExploration {...props} {...extra} apiClient={asClient(client)} />);
    await view.findByText('Visão geral de storefront.example');
    fireEvent.click(view.getByRole('tab', { name: /Code/ }));
    return view;
  }

  it('shows the code of a finished exploration instead of the overview', async () => {
    const client = codeApi();
    const view = await openCode(client);
    await waitFor(() =>
      expect(view.getByTestId('e2e-exploration-code')).toHaveTextContent('Exploration of Run'),
    );
    expect(client.getE2eExplorationCode).toHaveBeenCalledWith('c1');
    expect(view.queryByText('Páginas capturadas')).not.toBeInTheDocument();
    expect(view.queryByText('Editado por você')).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: /Resumo/ }));
    expect(view.getByText('Páginas capturadas')).toBeInTheDocument();
  });

  it('edits the code and saves it, or gives up', async () => {
    const client = codeApi();
    const view = await openCode(client);
    fireEvent.click(await view.findByRole('button', { name: 'Editar código' }));
    const editor = view.getByLabelText('Código da exploração') as HTMLTextAreaElement;
    expect(editor.value).toBe(GENERATED);
    // Nothing changed, nothing to save.
    expect(
      (view.getByRole('button', { name: 'Salvar código' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByLabelText('Código da exploração')).not.toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Editar código' }));
    fireEvent.change(view.getByLabelText('Código da exploração'), {
      target: { value: '// mine' },
    });
    client.saveE2eExplorationCode.mockResolvedValueOnce({ code: '// mine', edited: true });
    fireEvent.click(view.getByRole('button', { name: 'Salvar código' }));
    expect(await view.findByText('Código salvo.')).toBeInTheDocument();
    expect(client.saveE2eExplorationCode).toHaveBeenCalledWith('c1', '// mine');
    expect(view.getByTestId('e2e-exploration-code')).toHaveTextContent('// mine');
    expect(view.getByText('Editado por você')).toBeInTheDocument();
  });

  it('saves with Ctrl+S only when something changed', async () => {
    const client = codeApi();
    const view = await openCode(client);
    fireEvent.click(await view.findByRole('button', { name: 'Editar código' }));
    const editor = view.getByLabelText('Código da exploração');
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    expect(client.saveE2eExplorationCode).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: '// ctrl' } });
    client.saveE2eExplorationCode.mockResolvedValueOnce({ code: '// ctrl', edited: true });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    expect(await view.findByText('Código salvo.')).toBeInTheDocument();
    expect(client.saveE2eExplorationCode).toHaveBeenCalledWith('c1', '// ctrl');
  });

  it('keeps the draft when the code cannot be saved', async () => {
    const client = codeApi();
    const view = await openCode(client);
    fireEvent.click(await view.findByRole('button', { name: 'Editar código' }));
    fireEvent.change(view.getByLabelText('Código da exploração'), { target: { value: 'x' } });
    client.saveE2eExplorationCode.mockRejectedValueOnce(new Error('Sem permissão.'));
    fireEvent.click(view.getByRole('button', { name: 'Salvar código' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Sem permissão.');
    expect((view.getByLabelText('Código da exploração') as HTMLTextAreaElement).value).toBe('x');
    client.saveE2eExplorationCode.mockRejectedValueOnce('offline');
    fireEvent.click(view.getByRole('button', { name: 'Salvar código' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Não foi possível salvar o código.'),
    );
  });

  it('goes back to the generated code', async () => {
    const client = codeApi({
      getE2eExplorationCode: vi.fn().mockResolvedValue({ code: '// mine', edited: true }),
    });
    const view = await openCode(client);
    client.saveE2eExplorationCode.mockResolvedValueOnce({ code: GENERATED, edited: false });
    fireEvent.click(await view.findByRole('button', { name: 'Restaurar código gerado' }));
    expect(await view.findByText('Código salvo.')).toBeInTheDocument();
    expect(client.saveE2eExplorationCode).toHaveBeenCalledWith('c1', '');
    expect(view.getByTestId('e2e-exploration-code')).toHaveTextContent('Exploration of Run');
    expect(view.queryByRole('button', { name: 'Restaurar código gerado' })).toBeNull();
  });

  it('hides the restore button while editing', async () => {
    const client = codeApi({
      getE2eExplorationCode: vi.fn().mockResolvedValue({ code: '// mine', edited: true }),
    });
    const view = await openCode(client);
    fireEvent.click(await view.findByRole('button', { name: 'Editar código' }));
    expect(view.queryByRole('button', { name: 'Restaurar código gerado' })).toBeNull();
  });

  it('reports a code that cannot be loaded and tries again', async () => {
    const client = codeApi();
    client.getE2eExplorationCode.mockRejectedValueOnce(new Error('Sem acesso.'));
    const view = await openCode(client);
    expect(await view.findByRole('alert')).toHaveTextContent('Sem acesso.');
    expect(view.queryByRole('button', { name: 'Editar código' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByText(/Exploration of Run/)).toBeInTheDocument();
    client.getE2eExplorationCode.mockRejectedValueOnce('offline');
    fireEvent.click(view.getByRole('tab', { name: /Resumo/ }));
    fireEvent.click(view.getByRole('tab', { name: /Code/ }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Não foi possível carregar o código.'),
    );
  });

  it('says so when there is no code, and does not let a viewer edit it', async () => {
    const client = codeApi({
      getE2eExplorationCode: vi.fn().mockResolvedValue({ code: '  ', edited: false }),
    });
    const view = await openCode(client, { isReadOnly: true });
    expect(await view.findByText('Esta exploração ainda não tem código.')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Editar código' })).toBeNull();
  });

  it('lets the code of the exploration of the Source be edited too', async () => {
    const view = await openCode(codeApi(), { following: true });
    await view.findByText(/Exploration of Run/);
    expect(view.getByRole('button', { name: 'Editar código' })).toBeInTheDocument();
  });

  it('has no code tab while the agent is exploring', async () => {
    const client = codeApi();
    client.getE2eExploration.mockResolvedValue(exploration({ status: 'exploring' }));
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    await view.findByText('Ao vivo');
    expect(view.queryByRole('tab', { name: /Code/ })).toBeNull();
    expect(client.getE2eExplorationCode).not.toHaveBeenCalled();
  });
});

describe('E2eExploration video', () => {
  const props = { creationId: 'c1', onBack: vi.fn(), onOpenRun: vi.fn() };
  const shot = (atMs: number, worker?: number) => ({
    atMs,
    action: 'click' as const,
    target: 'Inbox',
    result: 'Inbox',
    hasScreenshot: true,
    url: 'https://storefront.example/inbox',
    ...(worker ? { worker } : {}),
  });
  let created = 0;
  beforeEach(() => {
    created = 0;
    // Pictures of the steps are object URLs too: only the recordings are told apart.
    URL.createObjectURL = vi.fn((blob: Blob) =>
      blob.type.startsWith('video') ? `blob:${blob.type}` : `blob:image-${++created}`,
    );
    URL.revokeObjectURL = vi.fn();
  });

  it('plays the recording of the exploration, which opens first', async () => {
    const client = {
      ...exploreApi(
        exploration({
          log: [shot(1)],
          videos: [{ worker: 1, mimeType: 'video/mp4' }],
        }),
      ),
      getE2eExplorationVideo: vi.fn().mockResolvedValue(new Blob(['v'], { type: 'video/mp4' })),
    };
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    const video = (await view.findByTestId('e2e-video')) as HTMLVideoElement;
    expect(video.src).toBe('blob:video/mp4');
    expect(client.getE2eExplorationVideo).toHaveBeenCalledWith('c1', 1, expect.any(AbortSignal));
    // One browser needs no choice of which one to watch.
    expect(view.queryByRole('group', { name: 'Gravação do navegador' })).toBeNull();
    // The steps are one click away.
    fireEvent.click(view.getByRole('button', { name: 'Passos (capturas de tela)' }));
    expect(await view.findByTestId('e2e-player-image')).toBeInTheDocument();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video/mp4');
  });

  it('chooses which browser to watch when several explored', async () => {
    const client = {
      ...exploreApi(
        exploration({
          log: [shot(1, 1), shot(2, 2)],
          videos: [
            { worker: 1, mimeType: 'video/mp4' },
            { worker: 2, mimeType: 'video/webm' },
          ],
        }),
      ),
      getE2eExplorationVideo: vi.fn((_id: string, worker: number) =>
        Promise.resolve(new Blob(['v'], { type: worker === 1 ? 'video/mp4' : 'video/webm' })),
      ),
    };
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    await view.findByTestId('e2e-video');
    const choice = view.getByRole('group', { name: 'Gravação do navegador' });
    expect(within(choice).getByRole('button', { name: 'Navegador 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(choice).getByRole('button', { name: 'Navegador 2' }));
    await waitFor(() =>
      expect(client.getE2eExplorationVideo).toHaveBeenCalledWith('c1', 2, expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect((view.getByTestId('e2e-video') as HTMLVideoElement).src).toBe('blob:video/webm'),
    );
    expect(within(choice).getByRole('button', { name: 'Navegador 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('says when the recording cannot be loaded, and has no video without one', async () => {
    const client = {
      ...exploreApi(
        exploration({ log: [shot(1)], videos: [{ worker: 1, mimeType: 'video/mp4' }] }),
      ),
      getE2eExplorationVideo: vi.fn().mockRejectedValue(new Error('gone')),
    };
    const view = render(<E2eExploration {...props} apiClient={asClient(client)} />);
    expect(await view.findByText('Não foi possível carregar o vídeo.')).toBeInTheDocument();
    view.unmount();

    const plain = render(
      <E2eExploration
        {...props}
        apiClient={asClient(exploreApi(exploration({ log: [shot(1)] })))}
      />,
    );
    await plain.findByTestId('e2e-player-counter');
    expect(plain.queryByTestId('e2e-video')).toBeNull();
    expect(
      (plain.getByRole('button', { name: 'Vídeo da execução' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

/** The Markdown source of the PRD field, where the text is typed. */
const prdSource = (view: ReturnType<typeof render>) => {
  fireEvent.click(view.getByTestId('editor-mode-code'));
  return view.getByTestId('e2e-generate-editor-code') as HTMLTextAreaElement;
};
/** Writes the PRD as Markdown. */
const write = (view: ReturnType<typeof render>, markdown: string) =>
  fireEvent.change(prdSource(view), { target: { value: markdown } });

/** jsdom's File cannot be read as text. */
const doc = (name: string, content: string, size = content.length) =>
  ({ name, size, text: async () => content }) as unknown as File;

describe('E2eRunView generating tests', () => {
  const props = {
    creationId: 'c1',
    onBack: vi.fn(),
    onOpenTest: vi.fn(),
    onOpenExploration: vi.fn(),
    onEdit: vi.fn(),
    onDeleted: vi.fn(),
  };
  const suites = [
    { id: 's1', name: 'Checkout', parentId: undefined },
    { id: 's2', name: 'Payment', parentId: 's1' },
  ];
  const plans = [
    {
      id: 'p1',
      title: 'Plano de pagamento',
      suiteId: 's2',
      plans: [
        { title: 'Pagar com cartão', metadata: { caseId: 'k1' } },
        { title: 'Pagar com pix', metadata: { caseId: 'k2' } },
      ],
    },
  ];
  function generateApi(creation: E2eCreationDetail) {
    return {
      ...runApi(creation),
      generateE2eTests: vi.fn().mockResolvedValue(undefined),
      getTestSuites: vi.fn().mockResolvedValue(suites),
      getAllSavedTestPlans: vi.fn().mockResolvedValue(plans),
    };
  }
  const empty = () => run({ tests: [], status: 'draft' });

  it('offers to generate the tests of a run that waits for the user', async () => {
    const client = generateApi(empty());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    const dialog = within(await view.findByTestId('e2e-generate-dialog'));
    // Two tabs only; the PRD is where it starts.
    expect(dialog.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['PRD', 'Test Plan']);
    expect(dialog.getByRole('tab', { name: 'PRD' })).toHaveAttribute('aria-selected', 'true');
    // Nothing to plan from until a file is attached or the PRD is written.
    const submit = dialog.getByRole('button', { name: 'Gerar' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    write(view, '  Login com e-mail e senha.  ');
    const loads = client.getE2eCreation.mock.calls.length;
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.generateE2eTests).toHaveBeenCalledWith('c1', {
        prd: 'Login com e-mail e senha.',
        prdFileNames: [],
      }),
    );
    await waitFor(() => expect(view.queryByTestId('e2e-generate-dialog')).toBeNull());
    expect(client.getE2eCreation.mock.calls.length).toBeGreaterThan(loads);
  });

  it('writes the PRD in the Markdown editor, with its images shown in the text', async () => {
    const client = generateApi(empty());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    await view.findByTestId('e2e-generate-editor');
    write(view, '### Login\n\nCom **senha**.\n\n![print](/attachments/files/abc)');
    // The formatted view shows the image where it was put.
    fireEvent.click(view.getByTestId('editor-mode-formatted'));
    expect(view.getByTestId('e2e-generate-editor-formatted').querySelector('img')).not.toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Gerar' }));
    await waitFor(() =>
      expect(client.generateE2eTests).toHaveBeenCalledWith('c1', {
        prd: '### Login\n\nCom **senha**.\n\n![print](/attachments/files/abc)',
        prdFileNames: [],
      }),
    );
  });

  it('puts pasted and dropped images in the text and uploads them when generating', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:print'), revokeObjectURL: vi.fn() });
    const stored = (id: string) => ({
      id,
      name: `${id}.png`,
      kind: 'image',
      scope: 'e2e',
      source: 'adk',
      url: `/attachments/files/${id}`,
    });
    const client = {
      ...generateApi(empty()),
      uploadAttachment: vi
        .fn()
        .mockResolvedValueOnce(stored('u1'))
        .mockResolvedValueOnce(stored('u2')),
      deleteAttachment: vi.fn().mockResolvedValue(undefined),
    };
    const view = render(
      <MediaProvider apiClient={asClient(client)}>
        <E2eRunView {...props} apiClient={asClient(client)} />
      </MediaProvider>,
    );
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    await view.findByTestId('e2e-generate-editor');
    const field = prdSource(view);
    const png = (name: string) => new File(['x'], name, { type: 'image/png' });
    fireEvent.paste(field, { clipboardData: { files: [png('a.png')] } });
    fireEvent.drop(field, { dataTransfer: { files: [png('b.png')] } });
    // Both are placed in the text, as drafts until the tests are generated.
    expect(field.value).toMatch(/!\[a\.png\]\(\/attachments\/drafts\/.+!\[b\.png\]/s);
    fireEvent.click(view.getByRole('button', { name: 'Gerar' }));
    await waitFor(() => expect(client.generateE2eTests).toHaveBeenCalled());
    const sent = (client.generateE2eTests.mock.calls[0]![1] as { prd: string }).prd;
    expect(sent).toContain('![a.png](/attachments/files/u1)');
    expect(sent).toContain('![b.png](/attachments/files/u2)');
    expect(client.uploadAttachment).toHaveBeenCalledWith('e2e', expect.any(File));
  });

  it('plans from attached documents, PDF included, together with the written text', async () => {
    vi.mocked(extractPdfText).mockResolvedValueOnce('Texto do PDF');
    const client = generateApi(empty());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    const input = await view.findByTestId('e2e-generate-file-input');
    const big = doc('enorme.md', 'x', 3_000_000);
    fireEvent.change(input, {
      target: {
        files: [doc('regras.md', '# Regras'), doc('spec.pdf', '%PDF'), big],
      },
    });
    expect(await view.findByText('regras.md')).toBeInTheDocument();
    expect(view.getByText('spec.pdf')).toBeInTheDocument();
    // A file that cannot be read is said, not attached.
    expect(view.getByRole('alert')).toHaveTextContent('Não foi possível ler o arquivo enorme.md.');
    // The same file attached again replaces the earlier one.
    fireEvent.change(input, { target: { files: [doc('regras.md', '# Novo')] } });
    await waitFor(() => expect(view.getAllByText('regras.md')).toHaveLength(1));
    write(view, 'Extra');
    fireEvent.click(view.getByRole('button', { name: 'Gerar' }));
    await waitFor(() =>
      expect(client.generateE2eTests).toHaveBeenCalledWith('c1', {
        prd: '# spec.pdf\n\nTexto do PDF\n\n---\n\n# regras.md\n\n# Novo\n\n---\n\nExtra',
        prdFileNames: ['spec.pdf', 'regras.md'],
      }),
    );
  });

  it('removes an attached document, drops files onto the area and rejects a PRD too long', async () => {
    const client = generateApi(empty());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    const zone = await view.findByTestId('e2e-generate-dropzone');
    fireEvent.dragOver(zone);
    // Closing the file dialog without choosing anything changes nothing.
    fireEvent.change(await view.findByTestId('e2e-generate-file-input'), {
      target: { files: null },
    });
    fireEvent.dragLeave(zone);
    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [doc('a.md', 'a'.repeat(500_001))] } });
    expect(await view.findByText('a.md')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Remover a.md' }));
    expect(view.queryByText('a.md')).toBeNull();
    fireEvent.drop(zone, { dataTransfer: { files: [doc('b.md', 'a'.repeat(500_001))] } });
    await view.findByText('b.md');
    fireEvent.click(view.getByRole('button', { name: 'Gerar' }));
    expect(await view.findByRole('alert')).toHaveTextContent('O PRD é grande demais');
    expect(client.generateE2eTests).not.toHaveBeenCalled();
    // The picker also opens the file dialog.
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(view.getByRole('button', { name: /Selecione seu documento/ }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('keeps the dialog open and says why when the tests cannot be generated', async () => {
    const client = generateApi(empty());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    await view.findByTestId('e2e-generate-editor');
    write(view, 'PRD');
    client.generateE2eTests.mockRejectedValueOnce(new Error('Já em execução.'));
    fireEvent.click(await view.findByRole('button', { name: 'Gerar' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Já em execução.');
    client.generateE2eTests.mockRejectedValueOnce('offline');
    fireEvent.click(view.getByRole('button', { name: 'Gerar' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Não foi possível gerar os testes.'),
    );
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByTestId('e2e-generate-dialog')).toBeNull();
  });

  it('associates the cases saved in Test Plans, a suite or one of its plans', async () => {
    const client = generateApi(empty());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    fireEvent.click(await view.findByRole('tab', { name: 'Test Plan' }));
    const submit = () => view.getByRole('button', { name: 'Gerar' }) as HTMLButtonElement;
    // Nothing to associate until a suite or Test Plan is chosen.
    await view.findByTestId('e2e-saved-case-picker');
    expect(submit().disabled).toBe(true);
    await pickSaved(view, 'Test Plan', 'Checkout');
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() =>
      expect(client.generateE2eTests).toHaveBeenLastCalledWith('c1', {
        savedCases: { suiteId: 's1' },
      }),
    );
  });

  it('only links the saved cases to the run, without writing or running them', async () => {
    const client = {
      ...generateApi(empty()),
      linkE2eSavedCases: vi.fn().mockResolvedValue({ imported: 2, skipped: 0 }),
    };
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    // The PRD has no use for it: the button only exists for saved cases.
    expect(view.queryByRole('button', { name: 'Apenas vincular' })).toBeNull();
    fireEvent.click(await view.findByRole('tab', { name: 'Test Plan' }));
    const link = () => view.getByRole('button', { name: 'Apenas vincular' }) as HTMLButtonElement;
    await view.findByTestId('e2e-saved-case-picker');
    expect(link().disabled).toBe(true);
    await pickSaved(view, 'Test Plan', 'Checkout');
    fireEvent.click(link());
    await waitFor(() =>
      expect(client.linkE2eSavedCases).toHaveBeenCalledWith('c1', { suiteId: 's1' }),
    );
    expect(client.generateE2eTests).not.toHaveBeenCalled();
    await waitFor(() => expect(view.queryByTestId('e2e-generate-dialog')).toBeNull());
  });

  it('associates only the cases picked of a Test Plan', async () => {
    const client = generateApi(empty());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    fireEvent.click(await view.findByRole('tab', { name: 'Test Plan' }));
    await view.findByTestId('e2e-saved-case-picker');
    await pickSaved(view, 'Test Plan', 'Checkout');
    await pickSaved(view, 'Test Suite', 'Plano de pagamento');
    fireEvent.click(await view.findByLabelText(/Pagar com pix/));
    fireEvent.click(view.getByRole('button', { name: 'Gerar' }));
    await waitFor(() =>
      expect(client.generateE2eTests).toHaveBeenLastCalledWith('c1', {
        savedCases: { planId: 'p1', caseIds: ['k1'] },
      }),
    );
  });

  it('only adds cases to a run that already has tests, and only for who can write', async () => {
    const client = generateApi(run());
    const view = render(<E2eRunView {...props} apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: 'Gerar testes' }));
    // Planning again would replace the tests it has.
    expect(await view.findByRole('tab', { name: 'Test Plan' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const prdTab = view.getByRole('tab', { name: 'PRD' });
    expect((prdTab as HTMLButtonElement).disabled).toBe(true);
    expect(prdTab).toHaveAttribute(
      'title',
      'Esta execução já tem testes; planejar de novo os substituiria.',
    );
    view.unmount();

    const viewer = render(<E2eRunView {...props} isReadOnly apiClient={asClient(client)} />);
    await viewer.findByText('3 testes em storefront.example');
    expect(viewer.queryByRole('button', { name: 'Gerar testes' })).toBeNull();
    viewer.unmount();

    // Nothing can be generated while the run works.
    const busy = render(
      <E2eRunView {...props} apiClient={asClient(generateApi(run({ status: 'running' })))} />,
    );
    await busy.findByRole('status');
    expect(busy.queryByRole('button', { name: 'Gerar testes' })).toBeNull();
  });
});
