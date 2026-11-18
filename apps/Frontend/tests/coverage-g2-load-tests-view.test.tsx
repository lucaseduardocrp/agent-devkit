import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiCollection,
  ApiRun,
  LoadScenario,
  LoadSummary,
} from '../src/features/apitests/api-test-types.js';
import { LoadTestsView } from '../src/features/apitests/LoadTestsView.js';
import type { ApiClient } from '../src/lib/api-client.js';

const request = (id: string, name: string) => ({
  id,
  type: 'request',
  name,
  method: 'GET',
  url: '/x',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
});

const collection = (id = 'c1', name = 'Orders API') =>
  ({
    id,
    workspaceId: 'w1',
    name,
    variables: [],
    auth: { type: 'none' },
    source: { kind: 'manual' },
    updatedAt: '',
    items: [request(`${id}-login`, 'Login'), request(`${id}-list`, 'List orders')],
  }) as unknown as ApiCollection;

const summaryOf = (): LoadSummary => ({
  durationSec: 60,
  maxVus: 20,
  totalRequests: 1200,
  failedRequests: 12,
  errorRate: 0.01,
  rps: 20,
  latency: { min: 5, avg: 90, p50: 80, p90: 150, p95: 210, p99: 400, max: 900 },
  checks: { passed: 10, failed: 0 },
  statusCodes: { '200': 1188 },
  errors: {},
  thresholds: [],
  passed: true,
});

const scenario = (patch: Partial<LoadScenario> = {}): LoadScenario => ({
  id: 's1',
  name: 'Peak',
  collectionId: 'c1',
  environmentId: null,
  requests: [{ requestId: 'c1-list', weight: 3 }],
  profile: 'load',
  stages: [{ durationSec: 60, targetVus: 20 }],
  thinkTimeMs: 1000,
  thresholds: [{ metric: 'p95', operator: 'lt', value: 500 }],
  updatedAt: '',
  ...patch,
});

const runOf = (patch: Partial<ApiRun<LoadSummary>> = {}): ApiRun<LoadSummary> => ({
  id: 'run1',
  kind: 'load',
  collectionId: 'c1',
  scenarioId: 's1',
  environmentId: null,
  name: 'Peak',
  target: 'remote',
  status: 'passed',
  claimLabel: null,
  result: summaryOf(),
  error: null,
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...patch,
});

const summaries = (list: { id: string; name: string }[]) =>
  list.map((item) => ({
    ...item,
    description: '',
    source: { kind: 'manual' },
    requestCount: 2,
    updatedAt: '',
  }));

function client(overrides: Record<string, unknown> = {}) {
  return {
    listLoadScenarios: vi.fn(() => Promise.resolve([scenario()])),
    listApiCollections: vi.fn(() =>
      Promise.resolve(
        summaries([
          { id: 'c1', name: 'Orders API' },
          { id: 'c2', name: 'Billing API' },
        ]),
      ),
    ),
    listApiEnvironments: vi.fn(() => Promise.resolve([{ id: 'e1', name: 'Staging' }])),
    getApiCollection: vi.fn((id: string) => Promise.resolve(collection(id))),
    getLoadProfiles: vi.fn(() =>
      Promise.resolve([
        {
          profile: 'spike',
          stages: [{ durationSec: 5, targetVus: 50 }],
          thresholds: [{ metric: 'errorRate', operator: 'lt', value: 0.05 }],
        },
      ]),
    ),
    saveLoadScenario: vi.fn((value: Partial<LoadScenario>, _id?: string) =>
      Promise.resolve(scenario({ ...value, id: 's1' })),
    ),
    deleteLoadScenario: vi.fn(() => Promise.resolve()),
    listApiRuns: vi.fn(() => Promise.resolve([runOf()])),
    getApiRun: vi.fn(() => Promise.resolve(runOf())),
    cancelApiRun: vi.fn(() => Promise.resolve(runOf({ status: 'cancelled' }))),
    startLoadRun: vi.fn(() => Promise.resolve(runOf({ id: 'run2' }))),
    exportLoadScenarioK6: vi.fn(() => Promise.resolve({ fileName: 'peak.k6.js', body: 'x' })),
    generateApiTests: vi.fn(() => Promise.resolve({ scenario: { id: 's1' } })),
    getAllSavedTestPlans: vi.fn(() => Promise.resolve([] as { id: string; title: string }[])),
    ...overrides,
  };
}

const mount = (api: ReturnType<typeof client>, isReadOnly = false) =>
  render(<LoadTestsView apiClient={api as unknown as ApiClient} isReadOnly={isReadOnly} />);

function pick(testId: string, option: string) {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

async function open(api = client()) {
  const view = mount(api);
  fireEvent.click(await view.findByTestId('scenario-Peak'));
  await view.findByLabelText('List orders');
  return { view, api };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoadTestsView: loading and empty states', () => {
  it('shows why the lists could not load and dismisses the notice', async () => {
    const api = client({ listLoadScenarios: vi.fn(() => Promise.reject(new Error('API fora'))) });
    mount(api);
    expect((await screen.findByRole('alert')).textContent).toContain('API fora');
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports other rejections as text', async () => {
    mount(client({ listLoadScenarios: vi.fn(() => Promise.reject('offline')) }));
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
  });

  it('asks for a collection first when there is none', async () => {
    mount(
      client({
        listApiCollections: vi.fn(() => Promise.resolve([])),
        listLoadScenarios: vi.fn(() => Promise.resolve([])),
      }),
    );
    await screen.findByText('Nenhum cenário ainda.');
    expect(screen.getByText(/precisa de uma coleção|coleção/i)).toBeTruthy();
    expect((screen.getByTestId('new-scenario') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Gerar com IA/ })).not.toBeNull();
  });

  it('invites to create a scenario and opens the dialogs from the empty screen', async () => {
    const api = client({ listLoadScenarios: vi.fn(() => Promise.resolve([])) });
    mount(api);
    const buttons = await screen.findAllByRole('button', { name: /Novo cenário/ });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(await screen.findByTestId('name-dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByTestId('name-dialog')).toBeNull());
    const ai = screen.getAllByRole('button', { name: /Gerar com IA/ });
    fireEvent.click(ai[ai.length - 1]!);
    expect(await screen.findByTestId('generate-dialog')).toBeTruthy();
  });

  it('hides the creation buttons from members who cannot edit', async () => {
    const api = client({ listLoadScenarios: vi.fn(() => Promise.resolve([])) });
    mount(api, true);
    await screen.findByText('Nenhum cenário ainda.');
    expect(screen.queryByTestId('new-scenario')).toBeNull();
    expect(screen.queryByRole('button', { name: /Novo cenário/ })).toBeNull();
  });

  it('filters the scenarios by name', async () => {
    const api = client({
      listLoadScenarios: vi.fn(() =>
        Promise.resolve([scenario(), scenario({ id: 's2', name: 'Soak night', profile: 'soak' })]),
      ),
    });
    mount(api);
    await screen.findByTestId('scenario-Soak night');
    fireEvent.change(screen.getByLabelText('Buscar cenários'), { target: { value: ' soak ' } });
    expect(screen.queryByTestId('scenario-Peak')).toBeNull();
    expect(screen.getByTestId('scenario-Soak night')).toBeTruthy();
  });
});

describe('LoadTestsView: a scenario', () => {
  it('opens a scenario with its runs and reports when the runs cannot be read', async () => {
    const api = client({ listApiRuns: vi.fn(() => Promise.reject(new Error('sem runs'))) });
    mount(api);
    fireEvent.click(await screen.findByTestId('scenario-Peak'));
    expect((await screen.findByRole('alert')).textContent).toContain('sem runs');
  });

  it('asks before leaving unsaved changes and keeps them when the user declines', async () => {
    const api = client({
      listLoadScenarios: vi.fn(() =>
        Promise.resolve([scenario(), scenario({ id: 's2', name: 'Other' })]),
      ),
    });
    const { view } = await open(api);
    fireEvent.change(screen.getByLabelText(/Pausa entre requisições/), { target: { value: '5' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    fireEvent.click(view.getByTestId('scenario-Other'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('scenario-title').textContent).toBe('Peak');
    fireEvent.click(view.getByTestId('scenario-Other'));
    await waitFor(() => expect(view.getByTestId('scenario-title').textContent).toBe('Other'));
  });

  it('changes the collection (selecting all of its requests), the environment and the target', async () => {
    const { view, api } = await open();
    pick('scenario-collection', 'Billing API');
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledWith('c2'));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Login').checked).toBe(true),
    );
    expect(screen.getByLabelText<HTMLInputElement>('List orders').checked).toBe(true);
    // Choosing the same collection again does nothing.
    pick('scenario-collection', 'Billing API');
    expect(api.getApiCollection).toHaveBeenCalledTimes(2);
    pick('scenario-environment', 'Staging');
    pick('scenario-environment', 'Sem ambiente');
    pick('run-target', 'Meu computador (devkit runner)');
    expect(view.getByText(/Ctrl \+ S/)).toBeTruthy();
    expect(view.getByTestId('load-tests-view').querySelector('.ti-device-laptop')).not.toBeNull();
  });

  it('keeps the requests when the collection answers after the user moved on', async () => {
    let answer!: (value: ApiCollection) => void;
    const api = client();
    const first = api.getApiCollection;
    api.getApiCollection = vi
      .fn()
      .mockImplementationOnce((id: string) => first(id))
      .mockImplementationOnce(
        () =>
          new Promise<ApiCollection>((done) => {
            answer = done;
          }),
      )
      .mockImplementation((id: string) => first(id));
    await open(api);
    pick('scenario-collection', 'Billing API');
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledTimes(2));
    pick('scenario-collection', 'Orders API');
    // The loaded collection is still Orders, so nothing is fetched again until Billing arrives.
    await act(async () => {
      answer(collection('c2'));
    });
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledTimes(3));
    await screen.findByLabelText('Login');
    // The answer was for another collection: no request is selected on its behalf.
    expect(screen.getByLabelText<HTMLInputElement>('Login').checked).toBe(false);
  });

  it('reports a collection that cannot be read', async () => {
    const api = client({ getApiCollection: vi.fn(() => Promise.reject(new Error('sem coleção'))) });
    mount(api);
    fireEvent.click(await screen.findByTestId('scenario-Peak'));
    expect((await screen.findByRole('alert')).textContent).toContain('sem coleção');
  });

  it('applies presets, custom plans and reports presets that fail', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getByTestId('profile-spike'));
    await waitFor(() => expect(view.getByTestId('plan-summary').textContent).toContain('50'));
    expect(api.getLoadProfiles).toHaveBeenCalledWith(20, 300);
    // A type the server does not know keeps the stages.
    fireEvent.click(view.getByTestId('profile-soak'));
    await waitFor(() => expect(api.getLoadProfiles).toHaveBeenCalledTimes(2));
    expect(view.getByTestId('profile-soak').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(view.getByTestId('profile-custom'));
    expect(api.getLoadProfiles).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('profile-custom').getAttribute('aria-checked')).toBe('true');
    api.getLoadProfiles.mockRejectedValueOnce(new Error('sem perfis'));
    fireEvent.click(view.getByTestId('profile-stress'));
    expect((await view.findByRole('alert')).textContent).toContain('sem perfis');
  });

  it('edits the preset used by the profiles', async () => {
    const { view, api } = await open();
    fireEvent.change(view.getByLabelText('VUs no pico'), { target: { value: '7' } });
    fireEvent.click(view.getByTestId('profile-spike'));
    await waitFor(() => expect(api.getLoadProfiles).toHaveBeenCalledWith(7, 300));
  });
});

describe('LoadTestsView: saving, renaming and duplicating', () => {
  it('saves with the button and with Ctrl+S, and reports a failure', async () => {
    const { view, api } = await open();
    const save = view.getByTestId('save-scenario') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Nothing to save yet.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveLoadScenario).not.toHaveBeenCalled();
    fireEvent.change(view.getByLabelText(/Pausa entre requisições/), { target: { value: '7' } });
    expect(view.getByLabelText('Alterações não salvas')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    expect(api.saveLoadScenario).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'S', metaKey: true });
    await waitFor(() => expect(api.saveLoadScenario).toHaveBeenCalledTimes(1));
    expect(api.saveLoadScenario.mock.calls[0]![1]).toBe('s1');
    await waitFor(() => expect(save.disabled).toBe(true));
    api.saveLoadScenario.mockRejectedValueOnce(new Error('não salvou'));
    fireEvent.change(view.getByLabelText(/Pausa entre requisições/), { target: { value: '9' } });
    fireEvent.click(save);
    expect((await view.findByRole('alert')).textContent).toContain('não salvou');
  });

  it('does not save from the keyboard when read only', async () => {
    const api = client();
    const view = mount(api, true);
    fireEvent.click(await view.findByTestId('scenario-Peak'));
    await view.findByLabelText('List orders');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveLoadScenario).not.toHaveBeenCalled();
    expect(view.queryByTestId('save-scenario')).toBeNull();
    expect(view.queryByTestId('rename-scenario')).toBeNull();
    expect(view.queryByTestId('open-run')).toBeNull();
    // Read only members can still export it.
    expect(view.getByTestId('export-k6')).toBeTruthy();
  });

  it('renames the scenario', async () => {
    const { view } = await open();
    fireEvent.click(view.getByTestId('rename-scenario'));
    const input = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
    expect(input.value).toBe('Peak');
    fireEvent.change(input, { target: { value: 'Peak 2' } });
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    expect(view.getByTestId('scenario-title').textContent).toBe('Peak 2');
    expect(view.getByLabelText('Alterações não salvas')).toBeTruthy();
  });

  it('duplicates a scenario from its menu as an unsaved copy', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getByRole('button', { name: 'Ações de Peak' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicar/ }));
    const input = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
    await waitFor(() => expect(input.value).toBe('Peak cópia'));
    fireEvent.change(input, { target: { value: 'Peak copy' } });
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    expect(view.getByTestId('scenario-title').textContent).toBe('Peak copy');
    expect(view.getByText('Alterações não salvas', { selector: 'span' })).toBeTruthy();
    expect(view.queryByTestId('export-k6')).toBeNull();
    fireEvent.click(view.getByTestId('save-scenario'));
    await waitFor(() => expect(api.saveLoadScenario).toHaveBeenCalled());
    expect(api.saveLoadScenario.mock.calls[0]![1]).toBeUndefined();
  });

  it('does not rename or duplicate without a scenario open', async () => {
    const api = client({ listLoadScenarios: vi.fn(() => Promise.resolve([])) });
    mount(api);
    const buttons = await screen.findAllByRole('button', { name: /Novo cenário/ });
    fireEvent.click(buttons[buttons.length - 1]!);
    fireEvent.change(await screen.findByTestId('name-dialog-input'), {
      target: { value: 'Fresh' },
    });
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    expect(screen.getByTestId('scenario-title').textContent).toBe('Fresh');
    expect(screen.getByText('Alterações não salvas', { selector: 'span' })).toBeTruthy();
  });
});

describe('LoadTestsView: races between dialogs and the open scenario', () => {
  it('names a new scenario without collection when the list emptied meanwhile', async () => {
    const api = client();
    const { view } = await open(api);
    fireEvent.click(view.getByTestId('new-scenario'));
    const input = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
    // Saving elsewhere refreshes the lists, now without collections.
    api.listApiCollections.mockResolvedValue([]);
    fireEvent.change(view.getByLabelText(/Pausa entre requisições/), { target: { value: '4' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(api.saveLoadScenario).toHaveBeenCalled());
    await waitFor(() => expect(api.listApiCollections).toHaveBeenCalledTimes(2));
    fireEvent.change(input, { target: { value: 'Orphan' } });
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    // Without collections the main area asks for one, but the new scenario is listed.
    await waitFor(() => expect(view.getByText('Orphan')).toBeTruthy());
  });

  it('does not save a scenario that is not valid yet', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getByLabelText('List orders'));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await Promise.resolve();
    expect(api.saveLoadScenario).not.toHaveBeenCalled();
    expect((view.getByTestId('open-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('forgets a pending deletion once another scenario replaced the open one', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getByRole('button', { name: 'Ações de Peak' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Excluir/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(view.getByTestId('new-scenario'));
    const input = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
    fireEvent.change(input, { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(api.deleteLoadScenario).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(view.getByTestId('scenario-title').textContent).toBe('Fresh');
  });

  it('does not start a run once the open scenario was replaced by an unsaved one', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getByTestId('open-run'));
    await view.findByTestId('load-run-dialog');
    fireEvent.click(screen.getByTestId('authorized'));
    fireEvent.click(view.getByTestId('new-scenario'));
    fireEvent.change(await screen.findByTestId('name-dialog-input'), {
      target: { value: 'Fresh' },
    });
    fireEvent.click(screen.getByTestId('name-dialog-submit'));
    fireEvent.click(screen.getByTestId('run-load'));
    await Promise.resolve();
    expect(api.startLoadRun).not.toHaveBeenCalled();
  });

  it('closes the generation dialog without generating', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getAllByRole('button', { name: 'Gerar com IA' })[0]!);
    const dialog = await view.findByTestId('generate-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
    expect(api.generateApiTests).not.toHaveBeenCalled();
  });
});

describe('LoadTestsView: deleting and exporting', () => {
  it('deletes a scenario after confirming', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getByRole('button', { name: 'Ações de Peak' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Excluir/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Excluir o cenário "Peak"?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(api.deleteLoadScenario).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Ações de Peak' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Excluir/ }));
    const again = await screen.findByRole('alertdialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(api.deleteLoadScenario).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(view.queryByTestId('scenario-title')).toBeNull());
  });

  it('reports a scenario that could not be deleted', async () => {
    const api = client({ deleteLoadScenario: vi.fn(() => Promise.reject(new Error('em uso'))) });
    const { view } = await open(api);
    fireEvent.click(view.getByRole('button', { name: 'Ações de Peak' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Excluir/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect((await view.findByRole('alert')).textContent).toContain('em uso');
  });

  it('exports the scenario for k6 and reports a failed export', async () => {
    const { view, api } = await open();
    fireEvent.click(view.getByTestId('export-k6'));
    await waitFor(() => expect(api.exportLoadScenarioK6).toHaveBeenCalledWith('s1'));
    api.exportLoadScenarioK6.mockRejectedValueOnce(new Error('sem k6'));
    fireEvent.click(view.getByTestId('export-k6'));
    expect((await view.findByRole('alert')).textContent).toContain('sem k6');
  });
});

describe('LoadTestsView: running', () => {
  it('saves pending edits before the run and gives up when saving fails', async () => {
    const { view, api } = await open();
    fireEvent.change(view.getByLabelText(/Pausa entre requisições/), { target: { value: '3' } });
    api.saveLoadScenario.mockRejectedValueOnce(new Error('sem salvar'));
    fireEvent.click(view.getByTestId('open-run'));
    expect((await view.findByRole('alert')).textContent).toContain('sem salvar');
    expect(view.queryByTestId('load-run-dialog')).toBeNull();
    fireEvent.click(view.getByTestId('open-run'));
    await view.findByTestId('load-run-dialog');
    expect(api.saveLoadScenario).toHaveBeenCalledTimes(2);
  });

  it('starts the run on the chosen target and reports a failed start', async () => {
    const { view, api } = await open();
    pick('run-target', 'Meu computador (devkit runner)');
    fireEvent.click(view.getByTestId('open-run'));
    await view.findByTestId('load-run-dialog');
    fireEvent.click(screen.getByTestId('authorized'));
    api.startLoadRun.mockRejectedValueOnce(new Error('sem runner'));
    fireEvent.click(screen.getByTestId('run-load'));
    expect((await view.findByRole('alert')).textContent).toContain('sem runner');
    fireEvent.click(screen.getByTestId('run-load'));
    await waitFor(() =>
      expect(api.startLoadRun).toHaveBeenLastCalledWith({
        scenarioId: 's1',
        target: 'local',
        authorized: true,
      }),
    );
    await view.findByTestId('load-run-detail');
    // Closing the dialog also works.
    fireEvent.click(view.getByTestId('open-run'));
    await view.findByTestId('load-run-dialog');
    fireEvent.click(
      within(screen.getByTestId('load-run-dialog')).getByRole('button', { name: 'Cancelar' }),
    );
    await waitFor(() => expect(screen.queryByTestId('load-run-dialog')).toBeNull());
  });

  it('opens a past run, cancels an active one and reports failures', async () => {
    const api = client({
      listApiRuns: vi.fn(() =>
        Promise.resolve([
          runOf({ id: 'r-done' }),
          runOf({ id: 'r-live', status: 'running', result: null }),
        ]),
      ),
    });
    const { view } = await open(api);
    fireEvent.click(view.getByRole('tab', { name: /Execuções/ }));
    const list = view.getByRole('list', { name: 'Execuções' });
    api.getApiRun.mockRejectedValueOnce(new Error('sem run'));
    fireEvent.click(within(list).getAllByRole('button')[0]!);
    expect((await view.findByRole('alert')).textContent).toContain('sem run');
    api.getApiRun.mockResolvedValueOnce(runOf({ id: 'r-live', status: 'running', result: null }));
    fireEvent.click(within(list).getAllByRole('button')[1]!);
    const cancel = await view.findByRole('button', { name: /Cancelar execução/ });
    api.cancelApiRun.mockRejectedValueOnce(new Error('não cancelou'));
    fireEvent.click(cancel);
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('não cancelou'));
    fireEvent.click(await view.findByRole('button', { name: /Cancelar execução/ }));
    await waitFor(() => expect(api.cancelApiRun).toHaveBeenCalledWith('load', 'r-live'));
    await waitFor(() =>
      expect(view.queryByRole('button', { name: /Cancelar execução/ })).toBeNull(),
    );
  });

  it('follows an active run until it ends and ignores polls that fail', async () => {
    let tick: (() => void) | undefined;
    const spy = vi.spyOn(window, 'setInterval').mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      if (delay === 2000) tick = handler;
      return 1;
    }) as unknown as typeof window.setInterval);
    const clear = vi.spyOn(window, 'clearInterval');
    const live = runOf({ id: 'r-live', status: 'running', result: null });
    const api = client({
      listApiRuns: vi.fn(() => Promise.resolve([runOf({ id: 'older' }), live])),
    });
    const { view } = await open(api);
    fireEvent.click(view.getByRole('tab', { name: /Execuções/ }));
    api.getApiRun.mockResolvedValueOnce(live);
    fireEvent.click(
      within(view.getByRole('list', { name: 'Execuções' })).getAllByRole('button')[1]!,
    );
    await view.findByTestId('load-run-detail');
    await waitFor(() => expect(tick).toBeTypeOf('function'));
    api.getApiRun.mockRejectedValueOnce(new Error('blip'));
    await act(async () => {
      tick!();
    });
    expect(view.queryByRole('alert')).toBeNull();
    api.getApiRun.mockResolvedValueOnce(runOf({ id: 'r-live', status: 'passed' }));
    await act(async () => {
      tick!();
    });
    await waitFor(() =>
      expect(view.queryByRole('button', { name: /Cancelar execução/ })).toBeNull(),
    );
    expect(clear).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('LoadTestsView: generating', () => {
  it('opens the generated scenario, or just refreshes the list when it is not there', async () => {
    const api = client({
      generateApiTests: vi
        .fn()
        .mockResolvedValueOnce({ scenario: { id: 's1' } })
        .mockResolvedValueOnce({ scenario: { id: 'gone' } }),
    });
    api.getAllSavedTestPlans.mockResolvedValue([{ id: 'tp1', title: 'Plan one' }]);
    const view = mount(api);
    await view.findByTestId('scenario-Peak');
    for (const expected of ['s1', 'gone']) {
      fireEvent.click(view.getAllByRole('button', { name: 'Gerar com IA' })[0]!);
      const dialog = await view.findByTestId('generate-dialog');
      const source = await within(dialog).findByLabelText<HTMLInputElement>('Plan one');
      // The dialog remembers what was chosen the last time.
      if (!source.checked) fireEvent.click(source);
      fireEvent.click(within(dialog).getByTestId('generate-submit'));
      await waitFor(() =>
        expect(api.generateApiTests).toHaveBeenCalledTimes(expected === 's1' ? 1 : 2),
      );
      await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
      if (expected === 's1')
        await waitFor(() => expect(view.getByTestId('scenario-title').textContent).toBe('Peak'));
    }
    expect(api.listLoadScenarios).toHaveBeenCalledTimes(3);
    expect(api.generateApiTests).toHaveBeenLastCalledWith(
      'load',
      expect.objectContaining({ collectionId: 'c1' }),
    );
  });
});
