import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadTestsView } from '../src/features/apitests/LoadTestsView.js';
import type {
  ApiCollection,
  ApiRun,
  LoadScenario,
  LoadSummary,
} from '../src/features/apitests/api-test-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const requestSpec = (id: string, name: string) => ({
  id,
  type: 'request' as const,
  name,
  method: 'GET' as const,
  url: `{{baseUrl}}/${id}`,
  headers: [],
  query: [],
  body: { mode: 'none' as const },
  auth: { type: 'inherit' as const },
  assertions: [],
  captures: [],
});

const collectionOf = (id: string, requests: [string, string][]): ApiCollection => ({
  id,
  workspaceId: 'w1',
  name: id,
  variables: [],
  auth: { type: 'none' },
  source: { kind: 'manual' },
  updatedAt: '',
  items: requests.map(([requestId, name]) => requestSpec(requestId, name)),
});

const collections: Record<string, ApiCollection> = {
  c1: collectionOf('c1', [['list', 'List orders']]),
  c2: collectionOf('c2', [
    ['pay', 'Pay'],
    ['refund', 'Refund'],
  ]),
};

const peak: LoadScenario = {
  id: 's1',
  name: 'Peak',
  collectionId: 'c1',
  environmentId: null,
  requests: [{ requestId: 'list', weight: 1 }],
  profile: 'load',
  stages: [{ durationSec: 60, targetVus: 20 }],
  thinkTimeMs: 1000,
  thresholds: [],
  updatedAt: '',
};
const soak: LoadScenario = { ...peak, id: 's2', name: 'Soak', profile: 'soak' };

const summary: LoadSummary = {
  durationSec: 60,
  maxVus: 20,
  totalRequests: 1200,
  failedRequests: 0,
  errorRate: 0,
  rps: 20,
  latency: { min: 5, avg: 90, p50: 80, p90: 150, p95: 210, p99: 400, max: 900 },
  checks: { passed: 10, failed: 0 },
  statusCodes: { '200': 1200 },
  errors: {},
  thresholds: [],
  passed: true,
};

const loadRun = (overrides: Partial<ApiRun<LoadSummary>> = {}): ApiRun<LoadSummary> => ({
  id: 'r1',
  kind: 'load',
  collectionId: 'c1',
  scenarioId: 's1',
  environmentId: null,
  name: 'Peak',
  target: 'remote',
  status: 'passed',
  claimLabel: null,
  error: null,
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: summary,
  ...overrides,
});

function client() {
  return {
    listLoadScenarios: vi.fn(() => Promise.resolve([peak, soak])),
    listApiCollections: vi.fn(() =>
      Promise.resolve([
        {
          id: 'c1',
          name: 'Orders API',
          description: '',
          source: { kind: 'manual' },
          requestCount: 1,
          updatedAt: '',
        },
        {
          id: 'c2',
          name: 'Payments API',
          description: '',
          source: { kind: 'manual' },
          requestCount: 2,
          updatedAt: '',
        },
      ]),
    ),
    listApiEnvironments: vi.fn(() =>
      Promise.resolve([{ id: 'e1', name: 'Staging', variables: [] }]),
    ),
    getApiCollection: vi.fn((id: string) => Promise.resolve(collections[id]!)),
    getLoadProfiles: vi.fn(() => Promise.resolve([])),
    saveLoadScenario: vi.fn((value: Omit<LoadScenario, 'id' | 'updatedAt'>, id?: string) =>
      Promise.resolve({ ...value, id: id ?? 's9', updatedAt: '' }),
    ),
    deleteLoadScenario: vi.fn(() => Promise.resolve()),
    listApiRuns: vi.fn(() => Promise.resolve([] as ApiRun[])),
    getApiRun: vi.fn(() => Promise.resolve(loadRun())),
    cancelApiRun: vi.fn(() => Promise.resolve(loadRun({ status: 'cancelled' }))),
    startLoadRun: vi.fn(() => Promise.resolve(loadRun())),
    exportLoadScenarioK6: vi.fn(() => Promise.resolve({ fileName: 'peak.k6.js', body: 'x' })),
    generateApiTests: vi.fn(() => Promise.resolve({ scenario: { id: 's2' } })),
    getAllSavedTestPlans: vi.fn(() => Promise.resolve([])),
  };
}

type Client = ReturnType<typeof client>;

async function open(api: Client, name = 'Peak', props: { isReadOnly?: boolean } = {}) {
  const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} {...props} />);
  fireEvent.click(await view.findByTestId(`scenario-${name}`));
  await view.findByLabelText('List orders');
  return view;
}

/** Chooses an option of the app's SearchableSelect. */
function pick(testId: string, option: string) {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

const unsavedDot = () => screen.queryByLabelText('Alterações não salvas');

describe('LoadTestsView scenario editing', () => {
  it('saves with Ctrl+S or Cmd+S only when there are valid changes', async () => {
    const api = client();
    const view = await open(api);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveLoadScenario).not.toHaveBeenCalled();

    pick('scenario-environment', 'Staging');
    expect(unsavedDot()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'S' });
    expect(api.saveLoadScenario).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'S', metaKey: true });
    await waitFor(() =>
      expect(api.saveLoadScenario).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: 'e1' }),
        's1',
      ),
    );
    await waitFor(() => expect(unsavedDot()).toBeNull());

    // Back to no environment; then an empty scenario cannot be saved.
    pick('scenario-environment', 'Sem ambiente');
    fireEvent.click(view.getByLabelText('List orders'));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveLoadScenario).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId<HTMLButtonElement>('open-run').disabled).toBe(true);
  });

  it('shows why a save failed, and closes the message', async () => {
    const api = client();
    api.saveLoadScenario.mockRejectedValueOnce('quota exceeded');
    const view = await open(api);
    pick('scenario-environment', 'Staging');
    fireEvent.click(view.getByTestId('save-scenario'));
    expect((await view.findByRole('alert')).textContent).toContain('quota exceeded');
    fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: 'Fechar' }));
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('does not let read-only members save with the shortcut', async () => {
    const api = client();
    const view = await open(api, 'Peak', { isReadOnly: true });
    expect(view.queryByTestId('save-scenario')).toBeNull();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveLoadScenario).not.toHaveBeenCalled();
  });

  it('switches collection, selecting all of its requests, and keeps the same one as is', async () => {
    const api = client();
    await open(api);
    pick('scenario-collection', 'Orders API');
    expect(unsavedDot()).toBeNull();
    pick('scenario-collection', 'Payments API');
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Pay').checked).toBe(true));
    expect(screen.getByLabelText<HTMLInputElement>('Refund').checked).toBe(true);
  });

  it('keeps the requests chosen for the newest collection when an older one loads late', async () => {
    const api = client();
    let release!: () => void;
    api.getApiCollection.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          if (id === 'c2') release = () => resolve(collections.c2!);
          else resolve(collections[id]!);
        }),
    );
    await open(api);
    pick('scenario-collection', 'Payments API');
    pick('scenario-collection', 'Orders API');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('List orders').checked).toBe(true),
    );
    release();
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText<HTMLInputElement>('List orders').checked).toBe(true);
  });

  it('makes the scenario custom, keeps stages when a profile is unknown and reports failures', async () => {
    const api = client();
    const view = await open(api);
    fireEvent.click(view.getByTestId('profile-custom'));
    expect(view.getByTestId('profile-custom')).toHaveAttribute('aria-checked', 'true');
    expect(api.getLoadProfiles).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId('profile-smoke'));
    await waitFor(() =>
      expect(view.getByTestId('profile-smoke')).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Estágio 1 · VUs alvo').value).toBe('20');

    api.getLoadProfiles.mockRejectedValueOnce(new Error('profiles offline'));
    fireEvent.click(view.getByTestId('profile-stress'));
    expect((await view.findByRole('alert')).textContent).toContain('profiles offline');
  });

  it('renames the scenario and cancels the rename dialog', async () => {
    const api = client();
    const view = await open(api);
    fireEvent.click(view.getByTestId('rename-scenario'));
    expect(screen.getByText('Renomear cenário', { selector: 'h2' })).toBeInTheDocument();
    const input = screen.getByTestId<HTMLInputElement>('name-dialog-input');
    expect(input.value).toBe('Peak');
    fireEvent.change(input, { target: { value: 'Peak v2' } });
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    expect(view.getByTestId('scenario-title').textContent).toBe('Peak v2');

    fireEvent.click(view.getByTestId('rename-scenario'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByTestId('name-dialog')).toBeNull());
  });

  it('exports the k6 script and reports an export failure', async () => {
    const api = client();
    const create = vi.fn(() => 'blob:k6');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const view = await open(api);
    fireEvent.click(view.getByTestId('export-k6'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(api.exportLoadScenarioK6).toHaveBeenCalledWith('s1');
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('peak.k6.js');

    api.exportLoadScenarioK6.mockRejectedValueOnce(new Error('no script'));
    fireEvent.click(view.getByTestId('export-k6'));
    expect((await view.findByRole('alert')).textContent).toContain('no script');
  });

  it('opens a scenario even when its runs cannot be listed', async () => {
    const api = client();
    api.listApiRuns.mockRejectedValueOnce(new Error('runs offline'));
    const view = await open(api);
    expect((await view.findByRole('alert')).textContent).toContain('runs offline');
    expect(view.getByTestId('scenario-title').textContent).toBe('Peak');
  });
});

describe('LoadTestsView scenario list', () => {
  it('asks before dropping unsaved changes and stays when declined', async () => {
    const api = client();
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const view = await open(api);
    pick('scenario-environment', 'Staging');
    fireEvent.click(view.getByTestId('scenario-Soak'));
    expect(confirm).toHaveBeenCalledWith('Descartar as alterações não salvas?');
    expect(view.getByTestId('scenario-title').textContent).toBe('Peak');
    fireEvent.click(view.getByTestId('scenario-Soak'));
    await waitFor(() => expect(view.getByTestId('scenario-title').textContent).toBe('Soak'));
  });

  it('filters scenarios by name', async () => {
    const view = render(<LoadTestsView apiClient={client() as unknown as ApiClient} />);
    fireEvent.change(await view.findByLabelText('Buscar cenários'), { target: { value: ' SOA ' } });
    expect(view.queryByTestId('scenario-Peak')).toBeNull();
    expect(view.getByTestId('scenario-Soak')).toBeInTheDocument();
  });

  it('duplicates a scenario as a new unsaved one', async () => {
    const api = client();
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('scenario-Soak');
    fireEvent.click(view.getByRole('button', { name: 'Ações de Soak' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicar' }));
    const input = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
    await waitFor(() => expect(input.value).toBe('Soak cópia'));
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    expect(view.getByTestId('scenario-title').textContent).toBe('Soak cópia');
    expect(view.queryByTestId('export-k6')).toBeNull();
    expect(view.getByText('Alterações não salvas', { selector: 'span' })).toBeInTheDocument();
    fireEvent.click(view.getByTestId('save-scenario'));
    await waitFor(() =>
      expect(api.saveLoadScenario).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Soak cópia', profile: 'soak' }),
        undefined,
      ),
    );
  });

  it('does not duplicate or delete another scenario when unsaved changes are kept', async () => {
    const api = client();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = await open(api);
    pick('scenario-environment', 'Staging');
    fireEvent.click(view.getByRole('button', { name: 'Ações de Soak' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicar' }));
    fireEvent.click(view.getByRole('button', { name: 'Ações de Soak' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('name-dialog')).toBeNull();
    expect(screen.queryByText('Excluir o cenário "Peak"?')).toBeNull();
    expect(view.getByTestId('scenario-title').textContent).toBe('Peak');
  });

  it('deletes a scenario after confirmation, and keeps it when the API fails or on cancel', async () => {
    const api = client();
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('scenario-Soak');
    const askDelete = async () => {
      fireEvent.click(view.getByRole('button', { name: 'Ações de Soak' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
      return screen.findByText('Excluir o cenário "Soak"?');
    };

    await askDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Excluir o cenário "Soak"?')).toBeNull());

    api.deleteLoadScenario.mockRejectedValueOnce(new Error('in use'));
    await askDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect((await view.findByRole('alert')).textContent).toContain('in use');

    api.listLoadScenarios.mockResolvedValue([peak]);
    await askDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(view.queryByTestId('scenario-Soak')).toBeNull());
    expect(api.deleteLoadScenario).toHaveBeenLastCalledWith('s2');
    expect(view.queryByTestId('scenario-title')).toBeNull();
  });

  it('opens a scenario generated with AI and ignores one it cannot find', async () => {
    const api = client();
    api.getAllSavedTestPlans.mockResolvedValue([{ id: 'p1', title: 'Checkout plan' }] as never);
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('scenario-Soak');
    const generate = async () => {
      fireEvent.click(view.getAllByRole('button', { name: 'Gerar com IA' })[0]!);
      const source = await screen.findByLabelText<HTMLInputElement>('Checkout plan');
      // The dialog keeps the sources picked last time.
      if (!source.checked) fireEvent.click(source);
      fireEvent.click(screen.getByTestId('generate-submit'));
    };
    await generate();
    await waitFor(() => expect(view.getByTestId('scenario-title').textContent).toBe('Soak'));
    expect(api.generateApiTests).toHaveBeenCalledWith(
      'load',
      expect.objectContaining({ collectionId: 'c1' }),
    );

    api.generateApiTests.mockResolvedValueOnce({ scenario: { id: 'missing' } });
    await generate();
    await waitFor(() => expect(api.listLoadScenarios).toHaveBeenCalledTimes(3));
    expect(view.getByTestId('scenario-title').textContent).toBe('Soak');

    fireEvent.click(view.getAllByRole('button', { name: 'Gerar com IA' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByTestId('generate-dialog')).toBeNull());
  });

  it('offers creating or generating when no scenario is open', async () => {
    const api = client();
    api.listLoadScenarios.mockResolvedValue([]);
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    expect(await view.findByText('Nenhum cenário ainda.')).toBeInTheDocument();
    fireEvent.click(view.getAllByRole('button', { name: 'Novo cenário' })[1]!);
    expect(screen.getByTestId<HTMLInputElement>('name-dialog-input').value).toBe(
      'Novo cenário de carga',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(view.getAllByRole('button', { name: 'Gerar com IA' })[1]!);
    expect(await screen.findByTestId('generate-dialog')).toBeInTheDocument();
  });
});

describe('LoadTestsView runs', () => {
  it('saves a new scenario before running it and stops when saving fails', async () => {
    const api = client();
    api.saveLoadScenario.mockRejectedValueOnce(new Error('invalid stages'));
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('scenario-Peak');
    fireEvent.click(view.getByTestId('new-scenario'));
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('List orders').checked).toBe(true),
    );
    fireEvent.click(view.getByTestId('open-run'));
    expect((await view.findByRole('alert')).textContent).toContain('invalid stages');
    expect(screen.queryByTestId('load-run-dialog')).toBeNull();

    fireEvent.click(view.getByTestId('open-run'));
    const dialog = await screen.findByTestId('load-run-dialog');
    expect(api.saveLoadScenario).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByTestId('load-run-dialog')).toBeNull());
  });

  it('runs on the local runner, follows the run until it ends and reports start failures', async () => {
    const api = client();
    api.startLoadRun
      .mockRejectedValueOnce(new Error('no runner'))
      .mockResolvedValueOnce(
        loadRun({ id: 'r2', status: 'queued', target: 'local', result: null }),
      );
    api.getApiRun
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(loadRun({ id: 'r2', target: 'local' }));
    // An older run stays in the list, untouched by the polling.
    api.listApiRuns.mockResolvedValue([loadRun({ id: 'r0', status: 'failed' })]);
    const view = await open(api);
    pick('run-target', 'Meu computador (devkit runner)');
    expect(view.getByText('Rode "devkit runner" em um terminal.')).toBeInTheDocument();

    fireEvent.click(view.getByTestId('open-run'));
    fireEvent.click(await screen.findByTestId('authorized'));
    fireEvent.click(screen.getByTestId('run-load'));
    expect((await view.findByRole('alert')).textContent).toContain('no runner');

    fireEvent.click(screen.getByTestId('run-load'));
    await waitFor(() =>
      expect(api.startLoadRun).toHaveBeenLastCalledWith({
        scenarioId: 's1',
        target: 'local',
        authorized: true,
      }),
    );
    const detail = await view.findByTestId('load-run-detail');
    expect(within(detail).getByText('Na fila')).toBeInTheDocument();
    // Polled every 2 s: the first poll fails silently, the next one brings the result.
    await waitFor(
      () =>
        expect(
          within(view.getByTestId('load-run-detail')).getByText('1200', { selector: 'dd' }),
        ).toBeInTheDocument(),
      { timeout: 6_000 },
    );
    expect(api.getApiRun).toHaveBeenCalledWith('load', 'r2');
    expect(view.getByText('Falhou')).toBeInTheDocument();
  }, 10_000);

  it('opens a past run, cancels an active one and reports failures', async () => {
    const api = client();
    api.listApiRuns.mockResolvedValue([
      loadRun({ id: 'r1', status: 'running', result: null }),
      loadRun({ id: 'r0' }),
    ]);
    api.getApiRun
      .mockResolvedValueOnce(loadRun({ id: 'r1', status: 'running', result: null }))
      .mockRejectedValueOnce(new Error('run gone'));
    api.cancelApiRun
      .mockRejectedValueOnce(new Error('too late'))
      .mockResolvedValueOnce(loadRun({ id: 'r1', status: 'cancelled', result: null }));
    const view = await open(api);
    fireEvent.click(view.getByRole('tab', { name: /Execuções/ }));
    fireEvent.click(view.getByText('Executando'));
    const detail = await view.findByTestId('load-run-detail');
    fireEvent.click(within(detail).getByText('Cancelar execução'));
    expect((await view.findByRole('alert')).textContent).toContain('too late');
    fireEvent.click(within(detail).getByText('Cancelar execução'));
    await waitFor(() =>
      expect(
        within(view.getByTestId('load-run-detail')).getByText('Cancelado'),
      ).toBeInTheDocument(),
    );
    expect(api.cancelApiRun).toHaveBeenCalledWith('load', 'r1');

    fireEvent.click(view.getAllByText('Passou')[0]!);
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('run gone'));
  });
});
