import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationTestsSkeleton } from '../src/features/apitests/ApiTestSkeletons.js';
import {
  GenerateDialog,
  KeyValueEditor,
  VariablesEditor,
} from '../src/features/apitests/ApiTestShared.js';
import {
  newRequest,
  type ApiRequestSpec,
  type ApiRun,
  type LoadScenarioInput,
  type LoadSummary,
} from '../src/features/apitests/api-test-types.js';
import { downloadBlob } from '../src/features/apitests/api-test-ui.js';
import { AreaChart } from '../src/features/apitests/load/load-charts.js';
import { formatMetric, metricUnit } from '../src/features/apitests/load/load-model.js';
import { LoadPlanPane } from '../src/features/apitests/load/LoadPlanPane.js';
import { LoadRunDialog } from '../src/features/apitests/load/LoadRunDialog.js';
import { LoadRunsPane } from '../src/features/apitests/load/LoadRunsPane.js';
import type { ApiClient } from '../src/lib/api-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('load-model', () => {
  it('formats rates as percentages, throughput per second and latencies in ms', () => {
    expect(formatMetric('errorRate', 0.0123)).toBe('1.23 %');
    expect(formatMetric('rps', 12.34)).toBe('12.3/s');
    expect(formatMetric('p95', 210.4)).toBe('210 ms');
    expect(metricUnit('checksRate')).toBe('0–1');
    expect(metricUnit('rps')).toBe('req/s');
    expect(metricUnit('avg')).toBe('ms');
  });
});

describe('newRequest', () => {
  it('builds a GET request on the base URL that expects a 200', () => {
    const request = newRequest();
    expect(request).toMatchObject({
      type: 'request',
      name: 'New request',
      method: 'GET',
      url: '{{baseUrl}}/',
      assertions: [{ source: 'status', operator: 'eq', expected: '200' }],
    });
    expect(newRequest('Login').name).toBe('Login');
    expect(newRequest().id).not.toBe(request.id);
  });
});

describe('downloadBlob', () => {
  it('clicks a temporary link to the blob and frees it', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const blob = new Blob(['x']);
    downloadBlob(blob, 'peak.k6.js');
    expect(create).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('peak.k6.js');
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});

describe('IntegrationTestsSkeleton layout', () => {
  it('stacks the panes when the screen was left in the vertical layout', () => {
    window.localStorage.setItem('adk.integrationTests.layout', 'vertical');
    const view = render(<IntegrationTestsSkeleton />);
    const root = view.getByTestId('integration-tests-skeleton');
    expect(root.querySelector('.h-px')).not.toBeNull();
    expect(root.querySelector('.flex-col.flex-1.min-h-0, .min-h-0.flex-1.flex-col')).not.toBeNull();
  });
});

/** Moves the pointer to `clientX` over `element` (jsdom drops coordinates of pointer events). */ function hover(
  element: HTMLElement,
  clientX: number,
) {
  const event = createEvent.pointerMove(element);
  Object.defineProperty(event, 'clientX', { value: clientX });
  fireEvent(element, event);
}
describe('AreaChart', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 } as DOMRect;

  it('shows the nearest point in a tooltip while hovering and hides it on leave', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    const view = render(
      <AreaChart
        title="VUs"
        points={[
          { x: 0, y: 0 },
          { x: 50, y: 10 },
          { x: 100, y: 20 },
        ]}
        formatX={(x) => `${x}s`}
        formatY={(y) => `${y} VUs`}
        step
        data-testid="chart"
      />,
    );
    const box = view.getByRole('img', { name: 'VUs' }).parentElement!;
    hover(box, 45);
    expect(view.getByRole('tooltip').textContent).toBe('50s10 VUs');
    // Near the right edge the tooltip opens to the left.
    hover(box, 95);
    expect(view.getByRole('tooltip').textContent).toBe('100s20 VUs');
    expect(view.getByRole('tooltip').style.transform).toBe('translate(-100%, -100%)');
    fireEvent.pointerLeave(box);
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('draws nothing and ignores hovering without points', () => {
    const view = render(<AreaChart title="Empty" points={[]} formatX={String} formatY={String} />);
    const box = view.getByRole('img', { name: 'Empty' }).parentElement!;
    expect(box.querySelector('path')!.getAttribute('d')).toBe('');
    hover(box, 10);
    expect(view.queryByRole('tooltip')).toBeNull();
  });
});

describe('LoadRunDialog', () => {
  it('names the local runner as the target', () => {
    const view = render(
      <LoadRunDialog
        open
        scenario={{
          name: 'Peak',
          collectionId: 'c1',
          environmentId: null,
          requests: [],
          profile: 'load',
          stages: [{ durationSec: 30, targetVus: 4 }],
          thinkTimeMs: 0,
          thresholds: [],
        }}
        target="local"
        starting={false}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(view.getByText('Meu computador (devkit runner)')).toBeInTheDocument();
  });
});

const request = (id: string, name: string): ApiRequestSpec => ({
  ...newRequest(name),
  id,
});

const draft: LoadScenarioInput = {
  name: 'Peak',
  collectionId: 'c1',
  environmentId: null,
  requests: [
    { requestId: 'a', weight: 3 },
    { requestId: 'b', weight: 1 },
  ],
  profile: 'load',
  stages: [
    { durationSec: 30, targetVus: 10 },
    { durationSec: 60, targetVus: 20 },
  ],
  thinkTimeMs: 1000,
  thresholds: [{ metric: 'p95', operator: 'lt', value: 500 }],
};

function renderPlan(overrides: Partial<React.ComponentProps<typeof LoadPlanPane>> = {}) {
  const onChange = vi.fn();
  const onPreset = vi.fn();
  const onApplyProfile = vi.fn();
  const view = render(
    <LoadPlanPane
      draft={draft}
      requests={[
        { request: request('a', 'Login'), path: [] },
        { request: request('b', 'List'), path: ['Orders'] },
        { request: request('c', 'Delete'), path: [] },
      ]}
      preset={{ vus: 20, durationSec: 300 }}
      readOnly={false}
      onChange={onChange}
      onPreset={onPreset}
      onApplyProfile={onApplyProfile}
      {...overrides}
    />,
  );
  return { view, onChange, onPreset, onApplyProfile };
}

describe('LoadPlanPane', () => {
  it('edits the preset, stages and think time; editing stages makes the test custom', () => {
    const { view, onChange, onPreset, onApplyProfile } = renderPlan();
    fireEvent.change(view.getByLabelText('VUs no pico'), { target: { value: '50' } });
    expect(onPreset).toHaveBeenLastCalledWith({ vus: 50, durationSec: 300 });
    fireEvent.change(view.getAllByLabelText('Duração (s)')[0]!, { target: { value: '600' } });
    expect(onPreset).toHaveBeenLastCalledWith({ vus: 20, durationSec: 600 });
    fireEvent.click(view.getByText('Aplicar aos estágios'));
    expect(onApplyProfile).toHaveBeenCalledWith('load');

    fireEvent.change(view.getByLabelText('Estágio 2 · Duração (s)'), { target: { value: '90' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: 'custom',
        stages: [
          { durationSec: 30, targetVus: 10 },
          { durationSec: 90, targetVus: 20 },
        ],
      }),
    );
    fireEvent.change(view.getByLabelText('Estágio 1 · VUs alvo'), { target: { value: '15' } });
    expect(onChange.mock.lastCall![0].stages[0]).toEqual({ durationSec: 30, targetVus: 15 });

    const stageRow = view.getByLabelText('Estágio 1 · VUs alvo').parentElement!;
    fireEvent.click(within(stageRow).getByRole('button', { name: 'Remover' }));
    expect(onChange.mock.lastCall![0]).toMatchObject({
      profile: 'custom',
      stages: [{ durationSec: 60, targetVus: 20 }],
    });
    fireEvent.click(view.getByText('Adicionar estágio'));
    expect(onChange.mock.lastCall![0].stages.at(-1)).toEqual({ durationSec: 60, targetVus: 20 });

    fireEvent.change(view.getByLabelText(/Pausa entre requisições/), {
      target: { value: '250' },
    });
    expect(onChange.mock.lastCall![0].thinkTimeMs).toBe(250);
  });

  it('adds a stage of 10 VUs when no stage has load yet', () => {
    const { view, onChange } = renderPlan({
      draft: { ...draft, stages: [{ durationSec: 10, targetVus: 0 }] },
    });
    // A single stage cannot be removed.
    expect(view.queryByRole('button', { name: 'Remover', hidden: false })).not.toBeNull();
    fireEvent.click(view.getByText('Adicionar estágio'));
    expect(onChange.mock.lastCall![0].stages[1]).toEqual({ durationSec: 60, targetVus: 10 });
  });

  it('picks requests, weighs them and shows their share of the traffic', () => {
    const { view, onChange } = renderPlan();
    expect(view.getByText('Orders / List')).toBeInTheDocument();
    expect(view.getByText('75%')).toBeInTheDocument();
    expect(view.getByText('25%')).toBeInTheDocument();
    fireEvent.change(view.getByLabelText('peso · List'), { target: { value: '5' } });
    expect(onChange.mock.lastCall![0].requests).toEqual([
      { requestId: 'a', weight: 3 },
      { requestId: 'b', weight: 5 },
    ]);
    fireEvent.click(view.getByLabelText('Delete'));
    expect(onChange.mock.lastCall![0].requests).toContainEqual({ requestId: 'c', weight: 1 });
    fireEvent.click(view.getByLabelText('Login'));
    expect(onChange.mock.lastCall![0].requests).toEqual([{ requestId: 'b', weight: 1 }]);
  });

  it('shows a 0% share when every weight is zero', () => {
    const { view } = renderPlan({
      draft: { ...draft, requests: [{ requestId: 'a', weight: 0 }] },
    });
    expect(view.getByText('0%')).toBeInTheDocument();
  });

  it('edits, adds and removes pass/fail criteria', () => {
    const { view, onChange } = renderPlan();
    fireEvent.click(view.getByRole('combobox', { name: 'Métrica' }));
    fireEvent.click(view.getByRole('option', { name: 'Taxa de erros' }));
    expect(onChange.mock.lastCall![0].thresholds[0]).toMatchObject({ metric: 'errorRate' });
    fireEvent.click(view.getByRole('combobox', { name: 'Operador' }));
    fireEvent.click(view.getByRole('option', { name: '≥' }));
    expect(onChange.mock.lastCall![0].thresholds[0]).toMatchObject({ operator: 'gte' });
    fireEvent.change(view.getByLabelText('Valor'), { target: { value: '300' } });
    expect(onChange.mock.lastCall![0].thresholds[0]).toMatchObject({ value: 300 });
    fireEvent.click(view.getByLabelText('Parar ao falhar'));
    expect(onChange.mock.lastCall![0].thresholds[0]).toMatchObject({ abortOnFail: true });
    const row = view.getByLabelText('Valor').parentElement!;
    fireEvent.click(within(row).getByRole('button', { name: 'Remover' }));
    expect(onChange.mock.lastCall![0].thresholds).toEqual([]);
    fireEvent.click(view.getByText('Adicionar threshold'));
    expect(onChange.mock.lastCall![0].thresholds).toEqual([
      { metric: 'p95', operator: 'lt', value: 500 },
      { metric: 'p95', operator: 'lt', value: 500 },
    ]);
  });

  it('changes only the criterion being edited', () => {
    const { view, onChange } = renderPlan({
      draft: {
        ...draft,
        thresholds: [
          { metric: 'p95', operator: 'lt', value: 500 },
          { metric: 'errorRate', operator: 'lt', value: 0.01 },
        ],
      },
    });
    fireEvent.change(view.getAllByLabelText('Valor')[1]!, { target: { value: '0.05' } });
    expect(onChange.mock.lastCall![0].thresholds).toEqual([
      { metric: 'p95', operator: 'lt', value: 500 },
      { metric: 'errorRate', operator: 'lt', value: 0.05 },
    ]);
  });

  it('is read-only for viewers and says when the collection has no requests', () => {
    const { view } = renderPlan({ readOnly: true, requests: [] });
    expect(view.getByText('A coleção não tem requisições.')).toBeInTheDocument();
    expect(view.queryByText('Adicionar estágio')).toBeNull();
    expect(view.queryByText('Adicionar threshold')).toBeNull();
    expect(view.queryByText('Aplicar aos estágios')).toBeNull();
    expect(view.queryByRole('button', { name: 'Remover' })).toBeNull();
  });
});

const summary: LoadSummary = {
  durationSec: 60,
  maxVus: 20,
  totalRequests: 100,
  failedRequests: 0,
  errorRate: 0,
  rps: 2,
  latency: { min: 1, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5, max: 6 },
  checks: { passed: 1, failed: 0 },
  statusCodes: { '200': 100 },
  errors: {},
  thresholds: [{ metric: 'errorRate', operator: 'gte', value: 0.5, actual: 0, passed: false }],
  passed: false,
  abortedBy: 'errorRate',
  timeline: [{ t: 1, vus: 1, requests: 1, errors: 0, avg: 1, p50: 1, p95: 1, p99: 1 }],
};

const baseRun: ApiRun<LoadSummary> = {
  id: 'r1',
  kind: 'load',
  collectionId: 'c1',
  scenarioId: 's1',
  environmentId: null,
  name: 'Peak',
  target: 'local',
  status: 'queued',
  claimLabel: null,
  error: 'Runner offline',
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: null,
};

describe('LoadRunsPane', () => {
  it('says when the scenario has no runs yet', () => {
    const view = render(
      <LoadRunsPane runs={[]} run={null} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(view.getByText('Nenhuma execução ainda.')).toBeInTheDocument();
  });

  it('lists the runs and asks to pick one', () => {
    const onSelect = vi.fn();
    const view = render(
      <LoadRunsPane runs={[baseRun]} run={null} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    expect(view.getByText('Selecione uma execução.')).toBeInTheDocument();
    fireEvent.click(view.getByText('Na fila'));
    expect(onSelect).toHaveBeenCalledWith('r1');
  });

  it('shows a queued local run waiting for the runner, with its error, and cancels it', () => {
    const onCancel = vi.fn();
    const view = render(
      <LoadRunsPane runs={[baseRun]} run={baseRun} onSelect={vi.fn()} onCancel={onCancel} />,
    );
    const detail = view.getByTestId('load-run-detail');
    expect(within(detail).getByRole('alert').textContent).toBe('Runner offline');
    expect(within(detail).getByText('Aguardando métricas…')).toBeInTheDocument();
    expect(within(detail).getByText('Meu computador (devkit runner)')).toBeInTheDocument();
    fireEvent.click(within(detail).getByText('Cancelar execução'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows an aborted run with failed thresholds and too few ticks to chart', () => {
    const run = { ...baseRun, status: 'failed', error: null, result: summary } as const;
    const view = render(
      <LoadRunsPane runs={[run]} run={run} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const detail = view.getByTestId('load-run-detail');
    expect(
      within(detail).getByText('Interrompido: threshold de errorRate falhou'),
    ).toBeInTheDocument();
    expect(within(detail).getByText('Aguardando métricas…')).toBeInTheDocument();
    expect(within(detail).getByText('Taxa de erros ≥ 50.00 %')).toBeInTheDocument();
    expect(detail.querySelector('.ti-circle-x')).not.toBeNull();
    expect(within(detail).queryByText('Cancelar execução')).toBeNull();
    expect(within(detail).queryByText('Por requisição')).toBeNull();
    expect(within(detail).queryByText('Erros')).toBeNull();
  });

  it('leaves out the timeline and thresholds a summary does not have', () => {
    const run = {
      ...baseRun,
      status: 'passed',
      target: 'remote',
      error: null,
      result: { ...summary, timeline: undefined, thresholds: [], abortedBy: undefined },
    } as unknown as ApiRun<LoadSummary>;
    const view = render(
      <LoadRunsPane runs={[run]} run={run} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const detail = view.getByTestId('load-run-detail');
    expect(within(detail).queryByText('Aguardando métricas…')).toBeNull();
    expect(within(detail).queryByRole('list', { name: 'Thresholds' })).toBeNull();
    expect(within(detail).getByText('Workers do ADK')).toBeInTheDocument();
  });
});

describe('KeyValueEditor', () => {
  it('edits, switches off, removes and adds rows', () => {
    const onChange = vi.fn();
    const view = render(
      <KeyValueEditor rows={[{ key: 'Accept', value: 'json' }]} onChange={onChange} />,
    );
    fireEvent.click(view.getByLabelText('Ativo'));
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'Accept', value: 'json', enabled: false }]);
    fireEvent.change(view.getByLabelText('Chave'), { target: { value: 'X-Id' } });
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'X-Id', value: 'json' }]);
    fireEvent.change(view.getByLabelText('Accept'), { target: { value: 'xml' } });
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'Accept', value: 'xml' }]);
    fireEvent.click(view.getByRole('button', { name: 'Remover' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(view.getByText('Adicionar'));
    expect(onChange).toHaveBeenLastCalledWith([
      { key: 'Accept', value: 'json' },
      { key: '', value: '' },
    ]);
  });

  it('turns a disabled row back on', () => {
    const onChange = vi.fn();
    const view = render(
      <KeyValueEditor rows={[{ key: '', value: 'b', enabled: false }]} onChange={onChange} />,
    );
    fireEvent.click(view.getByLabelText('Ativo'));
    expect(onChange).toHaveBeenLastCalledWith([{ key: '', value: 'b', enabled: undefined }]);
    // Without a key, the value is named by the default placeholder.
    expect(view.getByLabelText('Valor')).toBeInTheDocument();
  });
});

describe('editors with several rows', () => {
  it('labels rows without a key by their placeholder and changes only the edited row', () => {
    const onChange = vi.fn();
    const view = render(
      <KeyValueEditor
        rows={[
          { key: 'id', value: '1' },
          { key: '', value: '' },
        ]}
        keyPlaceholder="Nome"
        valuePlaceholder="Conteúdo"
        onChange={onChange}
      />,
    );
    fireEvent.change(view.getByLabelText('Conteúdo'), { target: { value: 'x' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { key: 'id', value: '1' },
      { key: '', value: 'x' },
    ]);

    const variables = vi.fn();
    render(
      <VariablesEditor
        variables={[
          { key: 'host', value: 'a' },
          { key: '', value: '' },
        ]}
        onChange={variables}
      />,
    );
    const empty = screen.getByLabelText<HTMLInputElement>('Valor');
    expect(empty.type).toBe('text');
    expect(empty.placeholder).toBe('Valor');
    fireEvent.change(empty, { target: { value: 'b' } });
    expect(variables).toHaveBeenLastCalledWith([
      { key: 'host', value: 'a' },
      { key: '', value: 'b' },
    ]);
  });
});

describe('VariablesEditor', () => {
  it('edits keys, values and the secret switch, removes and adds variables', () => {
    const onChange = vi.fn();
    const view = render(
      <VariablesEditor
        variables={[{ key: 'token', value: '', secret: true, hasValue: true }]}
        onChange={onChange}
      />,
    );
    const value = screen.getByLabelText<HTMLInputElement>('token');
    expect(value.type).toBe('password');
    expect(value.placeholder).toBe('•••••• (salvo)');
    fireEvent.change(view.getByLabelText('Chave'), { target: { value: 'jwt' } });
    expect(onChange.mock.lastCall![0][0]).toMatchObject({ key: 'jwt' });
    fireEvent.change(value, { target: { value: 's3cr3t' } });
    expect(onChange.mock.lastCall![0][0]).toMatchObject({ value: 's3cr3t' });
    fireEvent.click(view.getByLabelText('Secreto'));
    expect(onChange.mock.lastCall![0][0]).toMatchObject({ secret: false });
    fireEvent.click(view.getByRole('button', { name: 'Remover' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(view.getByText('Adicionar variável'));
    expect(onChange.mock.lastCall![0]).toHaveLength(2);
  });
});

function generateClient() {
  return {
    getAllSavedTestPlans: vi.fn(() => Promise.resolve([{ id: 'p1', title: 'Checkout plan' }])),
    getTestSuites: vi.fn(() => Promise.resolve([{ id: 't1', name: 'Smoke suite' }])),
    getKnowledgeDocuments: vi.fn(() => Promise.resolve([{ pageId: 'k1', title: 'Orders doc' }])),
    getSpecifications: vi.fn(() => Promise.resolve([{ id: 'sp1', title: 'Orders spec' }])),
    getPbiItems: vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([{ id: 'b1', title: 'Checkout PBI' }]),
    generateApiTests: vi.fn(() => Promise.resolve({ collection: { id: 'c9' } })),
  };
}

describe('GenerateDialog', () => {
  it('lists each kind of source, filters, picks and generates a collection', async () => {
    const api = generateClient();
    const onGenerated = vi.fn();
    const view = render(
      <GenerateDialog
        open
        kind="integration"
        apiClient={api as unknown as ApiClient}
        onClose={vi.fn()}
        onGenerated={onGenerated}
      />,
    );
    expect(view.getByText('Gerar testes de integração')).toBeInTheDocument();
    const plan = await view.findByLabelText('Checkout plan');
    fireEvent.click(plan);
    expect(view.getByText('Planos de teste: Checkout plan')).toBeInTheDocument();
    // Picking again drops it.
    fireEvent.click(plan);
    expect(view.queryByText('Planos de teste: Checkout plan')).toBeNull();
    fireEvent.click(plan);

    fireEvent.click(view.getByRole('button', { name: 'Suítes' }));
    expect(await view.findByLabelText('Smoke suite')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Brain' }));
    expect(await view.findByLabelText('Orders doc')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Specs' }));
    fireEvent.click(await view.findByLabelText('Orders spec'));
    fireEvent.change(view.getByPlaceholderText('Buscar…'), { target: { value: 'zzz' } });
    expect(view.getByText('Nada para escolher aqui.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'PBIs' }));
    await waitFor(() => expect(api.getPbiItems).toHaveBeenCalled());
    expect(view.getByText('Nada para escolher aqui.')).toBeInTheDocument();
    // A list that fails to load is shown empty; the next try lists it.
    fireEvent.change(view.getByPlaceholderText('Buscar…'), { target: { value: '' } });
    fireEvent.click(view.getByRole('button', { name: 'Specs' }));
    fireEvent.click(view.getByRole('button', { name: 'PBIs' }));
    expect(await view.findByLabelText('Checkout PBI')).toBeInTheDocument();

    const textarea = document.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '  only happy paths  ' } });
    fireEvent.change(view.getByPlaceholderText('URL base do sistema testado (opcional)'), {
      target: { value: ' https://api.test ' },
    });
    fireEvent.click(view.getByTestId('generate-submit'));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith({ collectionId: 'c9' }));
    expect(api.generateApiTests).toHaveBeenCalledWith('integration', {
      sources: [
        { type: 'testPlan', id: 'p1' },
        { type: 'spec', id: 'sp1' },
      ],
      instructions: 'only happy paths',
      baseUrl: 'https://api.test',
    });
  });

  it('plans a load scenario for the collection and shows a failure', async () => {
    const api = {
      ...generateClient(),
      generateApiTests: vi
        .fn()
        .mockRejectedValueOnce(new Error('Sem provedor de IA'))
        .mockRejectedValueOnce('boom')
        .mockResolvedValueOnce({ scenario: { id: 's9' } }),
    };
    const onGenerated = vi.fn();
    const view = render(
      <GenerateDialog
        open
        kind="load"
        collectionId="c1"
        apiClient={api as unknown as ApiClient}
        onClose={vi.fn()}
        onGenerated={onGenerated}
      />,
    );
    expect(view.getByText('Planejar um teste de carga')).toBeInTheDocument();
    expect(view.queryByPlaceholderText('URL base do sistema testado (opcional)')).toBeNull();
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'ramp' } });
    fireEvent.click(view.getByTestId('generate-submit'));
    expect((await view.findByRole('alert')).textContent).toBe('Sem provedor de IA');
    fireEvent.click(view.getByTestId('generate-submit'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('boom'));
    fireEvent.click(view.getByTestId('generate-submit'));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith({ scenarioId: 's9' }));
    expect(api.generateApiTests).toHaveBeenLastCalledWith('load', {
      sources: [],
      instructions: 'ramp',
      collectionId: 'c1',
    });
  });

  it('ignores a source list that arrives after the dialog closed', async () => {
    const pending: {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }[] = [];
    const api = {
      ...generateClient(),
      getAllSavedTestPlans: vi.fn(
        () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      ),
    };
    const props = {
      kind: 'load' as const,
      apiClient: api as unknown as ApiClient,
      onClose: vi.fn(),
      onGenerated: vi.fn(),
    };
    const view = render(<GenerateDialog open {...props} />);
    view.rerender(<GenerateDialog open={false} {...props} />);
    view.rerender(<GenerateDialog open {...props} />);
    view.rerender(<GenerateDialog open={false} {...props} />);
    expect(pending).toHaveLength(2);
    pending[0]!.resolve([{ id: 'p1', title: 'Late plan' }]);
    pending[1]!.reject(new Error('late'));
    view.rerender(<GenerateDialog open {...props} />);
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(view.queryByLabelText('Late plan')).toBeNull();
  });
});
