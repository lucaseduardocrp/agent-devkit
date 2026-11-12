import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eExploration } from '../src/features/e2e/E2eExploration.js';
import { E2eRunView } from '../src/features/e2e/E2eRunView.js';
import { E2eView } from '../src/features/e2e/E2eView.js';
import { MAP_CARD, layoutActionMap } from '../src/features/e2e/e2e-run-layout.js';
import type { ApiClient } from '../src/lib/api-client.js';
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
    getE2eImage: vi.fn().mockResolvedValue(new Blob(['img'])),
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
    fireEvent.click(view.getByRole('button', { expanded: false }));
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
    getE2eImage: vi.fn().mockResolvedValue(new Blob(['img'])),
  };
}

describe('E2eExploration', () => {
  const props = { creationId: 'c1', onBack: vi.fn(), onOpenRun: vi.fn() };

  it('tells whether an exploration is in progress', () => {
    expect(isExplorationActive(null)).toBe(false);
    expect(isExplorationActive(exploration())).toBe(false);
    expect(isExplorationActive(exploration({ status: 'signing_in' }))).toBe(true);
    expect(isExplorationActive(exploration({ status: 'exploring' }))).toBe(true);
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

    fireEvent.click(view.getByRole('button', { name: /Ver execução/ }));
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
    expect(view.queryByRole('button', { name: /Ver execução/ })).toBeNull();

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
    // The field only exists inside the modal.
    expect(view.queryByLabelText('O que explorar (opcional)')).toBeNull();
    const open = await view.findByRole('button', { name: /Instruções da exploração/ });
    expect(view.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();

    fireEvent.click(open);
    expect(view.getByRole('dialog')).toBeInTheDocument();
    fireEvent.change(view.getByLabelText('O que explorar (opcional)'), {
      target: { value: 'descartado' },
    });
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.queryByRole('img', { name: 'Instruções definidas' })).toBeNull();

    fireEvent.click(open);
    expect((view.getByLabelText('O que explorar (opcional)') as HTMLTextAreaElement).value).toBe(
      '',
    );
    fireEvent.change(view.getByLabelText('O que explorar (opcional)'), {
      target: { value: '  Só as telas de cobrança  ' },
    });
    fireEvent.click(view.getByRole('button', { name: /Salvar/ }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('img', { name: 'Instruções definidas' })).toBeInTheDocument();
    // Reopening starts from what was saved.
    fireEvent.click(open);
    expect((view.getByLabelText('O que explorar (opcional)') as HTMLTextAreaElement).value).toBe(
      '  Só as telas de cobrança  ',
    );
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

    // Where the finished script went, or why it did not.
    const kept = [
      [{ savedTo: 'database' }, 'Roteiro salvo no banco de dados.'],
      [
        { savedTo: null, saveError: 'branch is protected' },
        'Não foi possível salvar o roteiro: branch is protected',
      ],
    ] as const;
    for (const [state, message] of kept) {
      const shown = render(
        <E2eExploration
          {...props}
          apiClient={asClient(exploreApi(exploration({ status: 'ready', ...state })))}
        />,
      );
      expect(await shown.findByText(message)).toBeInTheDocument();
      shown.unmount();
    }
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
    fireEvent.click(await view.findByRole('button', { name: /Ver execução/ }));
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

  it('shows the agent exploring right after a new UI run is created', async () => {
    const client = viewApi();
    const { tests: _tests, prd: _prd, diff: _diff, instructions: _i, ...summary } = run();
    client.createE2eCreation.mockResolvedValue({
      ...summary,
      id: 'c9',
      status: 'queued',
      tests: [],
    });
    const view = render(<E2eView apiClient={asClient(client)} />);
    fireEvent.click(await view.findByRole('button', { name: /Nova execução/ }));
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('a1'),
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'new run' } });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'PRD' } });
    await waitFor(() =>
      expect(view.getByLabelText('Repositório').querySelectorAll('option').length).toBe(2),
    );
    fireEvent.change(view.getByLabelText('Repositório'), { target: { value: 'github:42' } });
    await waitFor(() =>
      expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.change(view.getByLabelText('URL base'), { target: { value: 'https://example.com' } });
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(await view.findByTestId('e2e-exploration')).toBeInTheDocument();
    expect(await view.findByText('Visão geral de storefront.example')).toBeInTheDocument();
    expect(client.getE2eExploration).toHaveBeenCalledWith('c9');
  });
});
