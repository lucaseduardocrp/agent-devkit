import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eExploration } from '../src/features/e2e/E2eExploration.js';
import { E2eSources } from '../src/features/e2e/E2eSources.js';
import { E2eSourcesPage } from '../src/features/e2e/E2eSourcesPage.js';
import type { ApiClient } from '../src/lib/api-client.js';
import {
  e2eImagePath,
  type E2eCreationDetail,
  type E2eEnvironment,
  type E2eSourceState,
  type E2eExploration as Exploration,
  type E2eMapPage,
  type E2eSource,
  type E2eSourceDocumentation,
} from '../src/features/e2e/e2e-types.js';

const asClient = (client: object) => client as unknown as ApiClient;

function environment(id: string): E2eEnvironment {
  return {
    id,
    name: `Ambiente ${id}`,
    baseUrl: `https://${id}.example`,
    username: 'qa@example.com',
    hasPassword: true,
    isDefault: id === 'env1',
    variableNames: [],
  };
}

const agent = (id: string) => ({ id, name: `Agente ${id}` });

function mapPage(id: string, overrides: Partial<E2eMapPage> = {}): E2eMapPage {
  return {
    id,
    path: `/page-${id}`,
    title: `Title ${id}`,
    image: null,
    testIds: ['flow-2', 'flow-3'],
    touches: 0,
    failedTestIds: [],
    elements: [],
    ...overrides,
  };
}

function source(overrides: Partial<E2eSource> = {}): E2eSource {
  return {
    workspaceId: 'ws',
    creationId: 'anchor',
    environmentId: 'env2',
    startUrl: 'https://app.example/',
    signedInMs: null,
    script: [
      { atMs: 100, action: 'navigate', target: 'https://app.example/login', result: 'Sign in' },
      { atMs: 2_000, action: 'click', target: 'Issues', result: 'Issues' },
      { atMs: 3_000, action: 'click', target: 'Broken', result: null },
    ],
    pages: [
      {
        index: 1,
        url: 'https://app.example/login',
        title: 'Sign in',
        summary: 'App · Sign in',
        elements: ['Enter'],
        hasScreenshot: true,
      },
      {
        index: 2,
        url: 'https://app.example/issues',
        title: 'Issues',
        summary: 'App · Issues',
        elements: [],
        hasScreenshot: false,
      },
    ],
    documentation: null,
    documentationError: null,
    startedAt: '2026-11-11T10:00:00Z',
    finishedAt: '2026-11-11T10:01:00Z',
    updatedAt: '2026-11-11T10:01:00Z',
    map: {
      pages: [
        mapPage('1', {
          path: '/login',
          title: 'Sign in',
          image: { testId: 'source', index: 1 },
          testIds: ['flow-1', 'flow-2', 'flow-3'],
          touches: 3,
        }),
        mapPage('2', { path: '/issues', title: 'Issues' }),
      ],
      edges: [
        { from: null, to: '1', testIds: ['flow-1', 'flow-2', 'flow-3'] },
        { from: '1', to: '2', testIds: ['flow-2', 'flow-3'] },
      ],
      tests: [
        { id: 'flow-1', status: 'passed', path: ['1'], live: null },
        { id: 'flow-2', status: 'passed', path: ['1', '2'], live: null },
        { id: 'flow-3', status: 'passed', path: ['1', '2'], live: null },
      ],
    },
    flows: [
      {
        id: 'flow-1',
        step: 1,
        action: 'navigate',
        target: 'https://app.example/login',
        group: 'Sign in',
      },
      { id: 'flow-2', step: 2, action: 'click', target: 'Issues', group: 'Issues' },
      { id: 'flow-3', step: 3, action: 'click', target: 'Filter', group: 'Issues' },
      // Not in the map: a flow whose path was lost has no page to open.
      { id: 'flow-9', step: 9, action: 'sign_in', target: 'qa@example.com', group: 'Lost' },
    ],
    ...overrides,
  };
}

function api(
  current: E2eSource | null = source(),
  state: Partial<E2eSourceState> = {},
  environments = [environment('env1'), environment('env2')],
  agents = [agent('a1'), agent('a2')],
) {
  return {
    getE2eSource: vi.fn().mockResolvedValue({
      source: current,
      anchorId: 'anchor',
      agentId: 'a2',
      busy: false,
      ...state,
    }),
    getE2eEnvironments: vi.fn().mockResolvedValue(environments),
    getAgents: vi.fn().mockResolvedValue(agents),
    exploreE2eSource: vi.fn().mockResolvedValue({}),
    documentE2eSource: vi.fn().mockResolvedValue(undefined),
    getE2eImage: vi.fn().mockResolvedValue(new Blob(['img'])),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:image', revokeObjectURL: () => undefined }),
  );
});
afterEach(() => vi.restoreAllMocks());

describe('E2eSources', () => {
  const props = { onExplore: vi.fn() };

  it('shows a skeleton with the layout of the page while it loads', async () => {
    const client = api();
    let release!: () => void;
    client.getE2eSource.mockReturnValue(
      new Promise(
        (resolve) =>
          (release = () =>
            resolve({ source: source(), anchorId: null, agentId: null, busy: false })),
      ),
    );
    const view = render(<E2eSources {...props} apiClient={asClient(client)} />);
    const skeleton = view.getByTestId('e2e-sources-skeleton');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    // The page has no title of its own: the top bar already names it.
    expect(view.queryByTestId('e2e-sources-controls')).toBeNull();
    release();
    expect(await view.findByTestId('e2e-sources-controls')).toBeInTheDocument();
    expect(view.queryByTestId('e2e-sources-skeleton')).toBeNull();
  });

  it('draws the map of the source with its flows grouped by the page they end on', async () => {
    const client = api();
    const view = render(<E2eSources {...props} apiClient={asClient(client)} />);
    expect(await view.findByText(/app\.example\/ · 2 páginas · 4 fluxos/)).toBeInTheDocument();
    expect(view.queryByRole('heading', { level: 1 })).toBeNull();
    expect(view.queryByText(/Há um único Source/)).toBeNull();
    // What the last update used is the one offered to update it.
    const environmentSelect = view.getByLabelText('Ambiente') as HTMLSelectElement;
    expect(environmentSelect.value).toBe('env2');
    expect(within(environmentSelect).getAllByRole('option')).toHaveLength(2);
    expect((view.getByLabelText('Agente que documenta') as HTMLSelectElement).value).toBe('a2');
    expect(view.getByRole('button', { name: /Atualizar Source/ })).toBeInTheDocument();

    expect(view.getByTestId('e2e-run-map')).toBeInTheDocument();
    expect(view.getByText('início · 4')).toBeInTheDocument();
    expect(view.getByText('3 fluxos · 3 ações')).toBeInTheDocument();
    await waitFor(() =>
      expect(client.getE2eImage).toHaveBeenCalledWith(
        e2eImagePath.sourcePage(1),
        expect.any(AbortSignal),
      ),
    );

    const groups = view.getAllByRole('button', { expanded: true });
    expect(groups.map((group) => group.textContent)).toEqual(['Sign in1', 'Issues2', 'Lost1']);
    const flow = view.getByRole('button', { name: 'Abrir o fluxo clicar Issues' });
    expect(flow).toHaveTextContent('2 páginas');
    expect(
      view.getByRole('button', { name: 'Abrir o fluxo login qa@example.com' }),
    ).toHaveTextContent('0 páginas');

    // Hovering (or focusing) a flow traces its way on the map.
    const traced = () =>
      Array.from(view.container.querySelectorAll('path')).map((edge) =>
        edge.getAttribute('data-traced'),
      );
    expect(traced()).toEqual(['false', 'false']);
    fireEvent.mouseEnter(flow);
    expect(traced()).toEqual(['true', 'true']);
    fireEvent.mouseLeave(flow);
    fireEvent.focus(view.getByRole('button', { name: /Abrir o fluxo navegar/ }));
    expect(traced()).toEqual(['true', 'false']);
    fireEvent.blur(view.getByRole('button', { name: /Abrir o fluxo navegar/ }));
    expect(traced()).toEqual(['false', 'false']);

    // A group folds and opens again.
    fireEvent.click(groups[1]!);
    expect(view.queryByRole('button', { name: 'Abrir o fluxo clicar Issues' })).toBeNull();
    fireEvent.click(view.getByRole('button', { expanded: false }));
    expect(view.getByRole('button', { name: 'Abrir o fluxo clicar Issues' })).toBeInTheDocument();
    // A page of the sidebar: there is nowhere to go back to.
    expect(view.queryByRole('button', { name: /Voltar/ })).toBeNull();
  });

  it('opens the page a flow ends on, or a page picked on the map', async () => {
    const view = render(<E2eSources {...props} apiClient={asClient(api())} />);
    fireEvent.click(await view.findByRole('button', { name: 'Abrir o fluxo clicar Issues' }));
    let panel = view.getByTestId('e2e-source-page-panel');
    expect(within(panel).getByRole('heading', { name: 'Issues' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('https://app.example/issues');
    expect(panel).toHaveTextContent('App · Issues');
    // No picture and no controls were captured for this page.
    expect(within(panel).queryByRole('img')).toBeNull();
    expect(within(panel).queryByText('Controles da página')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Abrir página /login' }));
    panel = view.getByTestId('e2e-source-page-panel');
    expect(await within(panel).findByAltText('Página Sign in')).toBeInTheDocument();
    expect(within(panel).getByText('Controles da página')).toBeInTheDocument();
    expect(within(panel).getByText('Enter')).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /Fluxos/ }));
    expect(view.queryByTestId('e2e-source-page-panel')).toBeNull();
    // A flow that is not on the map has no page to open.
    fireEvent.click(view.getByRole('button', { name: 'Abrir o fluxo login qa@example.com' }));
    expect(view.queryByTestId('e2e-source-page-panel')).toBeNull();
  });

  it('shows the script kept in the database', async () => {
    const view = render(<E2eSources {...props} apiClient={asClient(api())} />);
    fireEvent.click(await view.findByRole('tab', { name: 'Roteiro' }));
    expect(view.queryByTestId('e2e-run-map')).toBeNull();
    expect(view.getByText(/Fica salvo no banco de dados/)).toBeInTheDocument();
    const entries = view.getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(entries[1]).toHaveTextContent('+2sclicar Issues→ Issues');
    expect(entries[2]).not.toHaveTextContent('→');
    fireEvent.click(view.getByRole('tab', { name: 'Ações do agente' }));
    expect(view.getByTestId('e2e-run-map')).toBeInTheDocument();
    view.unmount();

    const empty = source({
      script: [],
      pages: [],
      flows: [],
      map: { pages: [], edges: [], tests: [] },
    });
    const bare = render(<E2eSources {...props} apiClient={asClient(api(empty))} />);
    expect(
      await bare.findByText('O roteiro deste Source não levou a nenhuma página.'),
    ).toBeInTheDocument();
    fireEvent.click(bare.getByRole('tab', { name: 'Roteiro' }));
    expect(bare.getByText('Nada feito ainda.')).toBeInTheDocument();
  });

  it('explores the application of the chosen environment and reports when it cannot start', async () => {
    // The environment of the last update is gone: the first one is offered.
    const client = api(source({ environmentId: 'deleted' }), { agentId: 'deleted' });
    const onExplore = vi.fn();
    const view = render(
      <E2eSources {...props} apiClient={asClient(client)} onExplore={onExplore} />,
    );
    const environmentSelect = await view.findByLabelText('Ambiente');
    expect((environmentSelect as HTMLSelectElement).value).toBe('env1');
    expect((view.getByLabelText('Agente que documenta') as HTMLSelectElement).value).toBe('a1');
    expect(within(view.getByLabelText('Onde executar')).getAllByRole('option')).toHaveLength(3);
    fireEvent.change(environmentSelect, { target: { value: 'env2' } });
    fireEvent.change(view.getByLabelText('Agente que documenta'), { target: { value: 'a2' } });

    client.exploreE2eSource.mockRejectedValueOnce(new Error('Run already in progress.'));
    fireEvent.click(view.getByRole('button', { name: /Atualizar Source/ }));
    expect(await view.findByRole('alert')).toHaveTextContent('Run already in progress.');
    client.exploreE2eSource.mockRejectedValueOnce('nope');
    fireEvent.click(view.getByRole('button', { name: /Atualizar Source/ }));
    expect(await view.findByText('Não foi possível concluir a ação.')).toBeInTheDocument();
    expect(onExplore).not.toHaveBeenCalled();

    // Where to run is only sent when chosen.
    fireEvent.click(view.getByRole('button', { name: /Atualizar Source/ }));
    await waitFor(() => expect(onExplore).toHaveBeenCalledWith('anchor'));
    expect(client.exploreE2eSource).toHaveBeenLastCalledWith({
      environmentId: 'env2',
      agentId: 'a2',
    });
    fireEvent.change(view.getByLabelText('Onde executar'), { target: { value: 'local' } });
    fireEvent.click(view.getByRole('button', { name: /Atualizar Source/ }));
    await waitFor(() => expect(onExplore).toHaveBeenCalledTimes(2));
    expect(client.exploreE2eSource).toHaveBeenLastCalledWith({
      environmentId: 'env2',
      agentId: 'a2',
      executionTarget: 'local',
    });

    // Without a hidden run to follow the page just reloads.
    client.getE2eSource.mockResolvedValue({
      source: source(),
      anchorId: null,
      agentId: null,
      busy: false,
    });
    fireEvent.click(view.getByRole('button', { name: /Atualizar Source/ }));
    await waitFor(() => expect(client.exploreE2eSource).toHaveBeenCalledTimes(5));
    expect(onExplore).toHaveBeenCalledTimes(2);
  });

  it('writes the documentation again without exploring', async () => {
    const client = api();
    const view = render(<E2eSources {...props} apiClient={asClient(client)} />);
    client.documentE2eSource.mockRejectedValueOnce(new Error('No model.'));
    fireEvent.click(await view.findByRole('button', { name: 'Atualizar documentação' }));
    expect(await view.findByRole('alert')).toHaveTextContent('No model.');
    client.documentE2eSource.mockRejectedValueOnce('nope');
    fireEvent.click(view.getByRole('button', { name: 'Atualizar documentação' }));
    expect(await view.findByText('Não foi possível concluir a ação.')).toBeInTheDocument();

    const loads = client.getE2eSource.mock.calls.length;
    fireEvent.click(view.getByRole('button', { name: 'Atualizar documentação' }));
    await waitFor(() => expect(client.getE2eSource.mock.calls.length).toBeGreaterThan(loads));
    expect(client.documentE2eSource).toHaveBeenCalledTimes(3);
    expect(client.exploreE2eSource).not.toHaveBeenCalled();
  });

  it('follows an update that is running until it ends', async () => {
    const client = api(source(), { busy: true });
    const onExplore = vi.fn();
    const view = render(
      <E2eSources {...props} apiClient={asClient(client)} onExplore={onExplore} />,
    );
    const status = await view.findByRole('status');
    expect(status).toHaveTextContent('O Source está sendo atualizado');
    // Nothing can start meanwhile, but the exploration can be followed.
    expect(view.getByRole('button', { name: /Atualizar Source/ })).toHaveProperty('disabled', true);
    expect(view.getByRole('button', { name: 'Atualizar documentação' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(status).getByRole('button', { name: 'Acompanhar' }));
    expect(onExplore).toHaveBeenCalledWith('anchor');

    // It is reloaded while it runs and the page frees itself when it is done.
    const timers = vi.spyOn(window, 'setInterval');
    view.unmount();
    const again = render(<E2eSources {...props} apiClient={asClient(client)} />);
    await again.findByRole('status');
    const tick = timers.mock.calls.filter((call) => call[1] === 3000).at(-1)![0] as () => void;
    client.getE2eSource.mockResolvedValue({
      source: source(),
      anchorId: 'anchor',
      agentId: 'a2',
      busy: false,
    });
    await act(async () => tick());
    await waitFor(() => expect(again.queryByRole('status')).toBeNull());
    expect(again.getByRole('button', { name: /Atualizar Source/ })).toHaveProperty(
      'disabled',
      false,
    );
    again.unmount();

    // Without a hidden run to follow there is nothing to open.
    const lone = render(
      <E2eSources {...props} apiClient={asClient(api(null, { busy: true, anchorId: null }))} />,
    );
    await lone.findByRole('status');
    expect(lone.queryByRole('button', { name: 'Acompanhar' })).toBeNull();
    lone.unmount();
  });

  it('offers where to run the exploration only outside the desktop app', async () => {
    const browser = render(<E2eSources {...props} apiClient={asClient(api())} />);
    expect(await browser.findByLabelText('Onde executar')).toBeInTheDocument();
    browser.unmount();

    // The desktop app always runs on this computer: nothing to choose, nothing is sent.
    Object.defineProperty(window, 'adkDesktop', {
      value: { apiUrl: 'http://127.0.0.1:60675' },
      configurable: true,
    });
    try {
      const client = api();
      const desktop = render(<E2eSources {...props} apiClient={asClient(client)} />);
      await desktop.findByLabelText('Ambiente');
      expect(desktop.queryByLabelText('Onde executar')).toBeNull();
      fireEvent.click(desktop.getByRole('button', { name: /Atualizar Source/ }));
      await waitFor(() => expect(client.exploreE2eSource).toHaveBeenCalled());
      expect(client.exploreE2eSource).toHaveBeenCalledWith({
        environmentId: 'env2',
        agentId: 'a2',
      });
    } finally {
      Reflect.deleteProperty(window, 'adkDesktop');
    }
  });

  it('explains a workspace without source, environments or agents', async () => {
    const view = render(<E2eSources {...props} apiClient={asClient(api(null))} />);
    // One quiet line, as the other lists of the app: no card, no illustration.
    expect(await view.findByText(/Nenhum Source ainda. Explore a aplicação/)).toBeInTheDocument();
    expect(view.getByRole('button', { name: /Explorar aplicação/ })).toHaveProperty(
      'disabled',
      false,
    );
    expect(view.queryByRole('button', { name: 'Atualizar documentação' })).toBeNull();
    expect(view.queryByRole('tablist')).toBeNull();
    view.unmount();

    const bare = render(<E2eSources {...props} apiClient={asClient(api(null, {}, [], []))} />);
    expect(await bare.findByText(/Crie um agente/)).toBeInTheDocument();
    expect(bare.queryByText(/Cadastre o ambiente da aplicação/)).toBeNull();
    expect((bare.getByLabelText('Ambiente') as HTMLSelectElement).value).toBe('');
    expect(bare.getByRole('button', { name: /Explorar aplicação/ })).toHaveProperty(
      'disabled',
      true,
    );
    bare.unmount();

    // Viewers see the source but cannot replace it.
    const viewer = render(<E2eSources {...props} isReadOnly apiClient={asClient(api())} />);
    expect(await viewer.findByTestId('e2e-run-map')).toBeInTheDocument();
    expect(viewer.queryByTestId('e2e-sources-controls')).toBeNull();
    expect(viewer.queryByRole('button', { name: /Atualizar Source/ })).toBeNull();
  });

  it('adds an environment without leaving the page', async () => {
    const client = {
      ...api(null, {}, []),
      saveE2eEnvironment: vi.fn().mockResolvedValue(environment('env1')),
    };
    const view = render(<E2eSources {...props} apiClient={asClient(client)} />);
    await view.findByTestId('e2e-sources-controls');
    // The same dialog as in E2E Automation, with its custom variables and without a hint about them.
    fireEvent.click(view.getByRole('button', { name: /Adicionar ambiente/ }));
    const dialog = await view.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Adicionar variável/ })).toBeInTheDocument();
    expect(within(dialog).queryByText(/process.env.E2E_VAR_/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByRole('dialog')).toBeNull();

    // A saved environment is offered right away.
    fireEvent.click(view.getByRole('button', { name: /Adicionar ambiente/ }));
    fireEvent.change(view.getByLabelText('Nome'), { target: { value: 'Ambiente env1' } });
    fireEvent.change(view.getByLabelText('URL do site'), {
      target: { value: 'https://env1.example' },
    });
    client.getE2eEnvironments.mockResolvedValue([environment('env1')]);
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(client.saveE2eEnvironment).toHaveBeenCalled());
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect((view.getByLabelText('Ambiente') as HTMLSelectElement).value).toBe('env1'),
    );
    // Viewers cannot add environments.
    view.unmount();
    const viewer = render(<E2eSources {...props} isReadOnly apiClient={asClient(api())} />);
    await viewer.findByTestId('e2e-run-map');
    expect(viewer.queryByRole('button', { name: /Adicionar ambiente/ })).toBeNull();
  });

  it('reports a source that cannot be loaded and tries again', async () => {
    const client = api();
    client.getE2eSource.mockRejectedValueOnce(new Error('offline'));
    const view = render(<E2eSources {...props} apiClient={asClient(client)} />);
    expect(await view.findByRole('alert')).toHaveTextContent('offline');
    client.getE2eSource.mockRejectedValueOnce('nope');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await view.findByText('Não foi possível carregar as execuções E2E.'),
    ).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByTestId('e2e-run-map')).toBeInTheDocument();
  });
});

describe('the documentation of the system', () => {
  const documentation: E2eSourceDocumentation = {
    overview: '# Agent DevKit\n\nPlataforma de QA.',
    areas: [
      {
        name: 'Issues',
        description: 'Acompanhamento de problemas.',
        flows: [
          {
            title: 'Criar issue',
            description: 'O usuário registra um problema.',
            steps: ['Abrir Issues', 'Clicar em Nova issue'],
            pages: ['Issues', 'Nova issue'],
            origin: 'both',
          },
          { title: 'Filtrar issues', description: '', steps: [], pages: [], origin: 'documented' },
        ],
      },
      {
        name: 'Ajustes',
        description: '',
        flows: [
          { title: 'Trocar tema', description: '', steps: [], pages: [], origin: 'discovered' },
        ],
      },
    ],
    brainDocuments: [{ title: 'Especificação', source: 'wiki://spec' }],
    generatedAt: '2026-11-11T10:02:00Z',
  };
  const props = { onExplore: vi.fn() };

  it('opens on the overview with every flow by area and where each one comes from', async () => {
    const view = render(
      <E2eSources {...props} apiClient={asClient(api(source({ documentation })))} />,
    );
    const overview = await view.findByTestId('e2e-source-overview');
    expect(view.getByRole('tab', { name: 'Visão geral' })).toHaveAttribute('aria-selected', 'true');
    expect(within(overview).getByText('Plataforma de QA.')).toBeInTheDocument();
    expect(within(overview).getByText('2 áreas · 3 fluxos')).toBeInTheDocument();

    const flow = within(overview).getByRole('article', { name: 'Criar issue' });
    expect(flow).toHaveTextContent('Brain + descoberto');
    expect(flow).toHaveTextContent('O usuário registra um problema.');
    expect(
      within(flow)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Abrir Issues', 'Clicar em Nova issue']);
    expect(within(flow).getByText('Nova issue')).toBeInTheDocument();
    const bare = within(overview).getByRole('article', { name: 'Filtrar issues' });
    expect(bare).toHaveTextContent('Brain');
    expect(within(bare).queryByRole('list')).toBeNull();
    expect(within(overview).getByRole('article', { name: 'Trocar tema' })).toHaveTextContent(
      'Descoberto',
    );
    expect(within(overview).getByText('Acompanhamento de problemas.')).toBeInTheDocument();
    expect(within(overview).getByText('Especificação')).toBeInTheDocument();
    expect(within(overview).getByText(/Documentação gerada em/)).toBeInTheDocument();

    // An area folds and opens again.
    fireEvent.click(within(overview).getByRole('button', { name: /Issues/ }));
    expect(within(overview).queryByRole('article', { name: 'Criar issue' })).toBeNull();
    fireEvent.click(within(overview).getByRole('button', { name: /Issues/ }));
    expect(within(overview).getByRole('article', { name: 'Criar issue' })).toBeInTheDocument();

    // The map and the script are still one tab away.
    fireEvent.click(view.getByRole('tab', { name: 'Ações do agente' }));
    expect(view.getByTestId('e2e-run-map')).toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: 'Visão geral' }));
    expect(view.getByTestId('e2e-source-overview')).toBeInTheDocument();
  });

  it('keeps the documentation in use and shows why the last update failed', async () => {
    const view = render(
      <E2eSources
        {...props}
        apiClient={asClient(
          api(source({ documentation, documentationError: 'Modelo sobrecarregado.' })),
        )}
      />,
    );
    const overview = await view.findByTestId('e2e-source-overview');
    expect(within(overview).getByRole('alert')).toHaveTextContent(
      'Não foi possível atualizar a documentação: Modelo sobrecarregado.',
    );
    expect(within(overview).getByText('Plataforma de QA.')).toBeInTheDocument();
  });

  it('says when nothing was documented, from the Brain or at all', async () => {
    const empty = { ...documentation, areas: [], brainDocuments: [] };
    const view = render(
      <E2eSources {...props} apiClient={asClient(api(source({ documentation: empty })))} />,
    );
    expect(await view.findByText('Nenhuma área foi documentada.')).toBeInTheDocument();
    expect(view.getByText(/O Brain não trouxe documentos/)).toBeInTheDocument();
    view.unmount();

    // Without documentation the page opens on the map; the overview tab explains why.
    const failed = render(
      <E2eSources
        {...props}
        apiClient={asClient(api(source({ documentationError: 'Nenhum modelo configurado.' })))}
      />,
    );
    expect(await failed.findByTestId('e2e-run-map')).toBeInTheDocument();
    fireEvent.click(failed.getByRole('tab', { name: 'Visão geral' }));
    expect(failed.getByRole('alert')).toHaveTextContent('Nenhum modelo configurado.');
    expect(failed.getByText('O sistema ainda não foi documentado')).toBeInTheDocument();
    failed.unmount();

    const never = render(<E2eSources {...props} apiClient={asClient(api())} />);
    fireEvent.click(await never.findByRole('tab', { name: 'Visão geral' }));
    expect(never.getByTestId('e2e-source-overview-empty')).toBeInTheDocument();
    expect(never.queryByRole('alert')).toBeNull();
  });
});

describe('the Sources page of the Test module', () => {
  const exploration = (overrides: Partial<Exploration> = {}): Exploration => ({
    status: 'ready',
    source: true,
    savedTo: 'source',
    startedAt: '2026-11-11T10:00:00Z',
    updatedAt: '2026-11-11T10:01:00Z',
    signedInMs: null,
    finishedAt: '2026-11-11T10:01:00Z',
    error: null,
    pages: [],
    log: [],
    hasLiveFrame: false,
    ...overrides,
  });
  const detail = {
    id: 'anchor',
    name: 'Source',
    mode: 'frontend',
    baseUrl: 'https://env2.example',
    path: '/',
    status: 'draft',
    tests: [],
  } as unknown as E2eCreationDetail;

  it('shows the sources and follows the exploration that updates them', async () => {
    const client = {
      ...api(),
      getE2eCreation: vi.fn().mockResolvedValue(detail),
      getE2eExploration: vi.fn().mockResolvedValue(exploration()),
    };
    const view = render(<E2eSourcesPage apiClient={asClient(client)} />);
    expect(await view.findByTestId('e2e-sources')).toBeInTheDocument();

    fireEvent.click(await view.findByRole('button', { name: /Atualizar Source/ }));
    expect(await view.findByTestId('e2e-exploration')).toBeInTheDocument();
    expect(client.getE2eExploration).toHaveBeenCalledWith('anchor');
    expect(
      await view.findByText('Roteiro salvo no banco de dados como o Source do workspace.'),
    ).toBeInTheDocument();
    // Only followed: no instructions, no new exploration and no step for planning tests.
    expect(view.queryByRole('button', { name: /Instruções/ })).toBeNull();
    expect(view.queryByRole('button', { name: /Explorar novamente|Re-explorar/ })).toBeNull();
    expect(view.queryByRole('button', { name: /Ver execução/ })).toBeNull();
    expect(view.getByLabelText('Etapas da exploração').children).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    expect(await view.findByTestId('e2e-sources')).toBeInTheDocument();

    // A run that is being followed can also be left through its own link.
    fireEvent.click(view.getByRole('button', { name: /Atualizar Source/ }));
    await view.findByTestId('e2e-exploration');
    view.unmount();

    // Viewers see the page but cannot replace the source.
    const viewer = render(<E2eSourcesPage isReadOnly apiClient={asClient(client)} />);
    expect(await viewer.findByTestId('e2e-run-map')).toBeInTheDocument();
    expect(viewer.queryByRole('button', { name: /Atualizar Source/ })).toBeNull();
  });

  it('offers no run to open when none is given, even with tests planned', async () => {
    const planned = { ...detail, tests: [{ id: 't1' }] } as unknown as E2eCreationDetail;
    const view = render(
      <E2eExploration
        creationId="c1"
        onBack={vi.fn()}
        apiClient={asClient({
          getE2eCreation: vi.fn().mockResolvedValue(planned),
          getE2eExploration: vi.fn().mockResolvedValue(exploration()),
        })}
      />,
    );
    await view.findByTestId('e2e-exploration');
    expect(view.queryByRole('button', { name: /Ver execução/ })).toBeNull();
  });

  it('says where the script of a source exploration was kept', async () => {
    const view = render(
      <E2eExploration
        creationId="anchor"
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        apiClient={asClient({
          getE2eCreation: vi.fn().mockResolvedValue(detail),
          getE2eExploration: vi.fn().mockResolvedValue(exploration()),
        })}
      />,
    );
    expect(
      await view.findByText('Roteiro salvo no banco de dados como o Source do workspace.'),
    ).toBeInTheDocument();
  });
});
