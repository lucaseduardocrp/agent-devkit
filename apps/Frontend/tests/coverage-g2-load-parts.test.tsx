import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ApiRun,
  LoadScenarioInput,
  LoadSummary,
} from '../src/features/apitests/api-test-types.js';
import { AreaChart } from '../src/features/apitests/load/load-charts.js';
import {
  emptyScenario,
  formatMetric,
  metricUnit,
  peakVus,
  stagePoints,
  totalSeconds,
} from '../src/features/apitests/load/load-model.js';
import { LoadRunDialog } from '../src/features/apitests/load/LoadRunDialog.js';
import { LoadRunDetail, LoadRunsPane } from '../src/features/apitests/load/LoadRunsPane.js';

beforeAll(() => {
  // jsdom has no PointerEvent: the chart reads clientX from the pointer events.
  class TestPointerEvent extends MouseEvent {}
  (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
});

const scenario = (patch: Partial<LoadScenarioInput> = {}): LoadScenarioInput => ({
  ...emptyScenario('Checkout', 'c1'),
  requests: [{ requestId: 'r1', weight: 1 }],
  ...patch,
});

describe('load-model', () => {
  it('formats each kind of metric with its unit', () => {
    expect(formatMetric('errorRate', 0.0123)).toBe('1.23 %');
    expect(formatMetric('checksRate', 1)).toBe('100.00 %');
    expect(formatMetric('rps', 12.34)).toBe('12.3/s');
    expect(formatMetric('p95', 499.6)).toBe('500 ms');
    expect(metricUnit('errorRate')).toBe('0–1');
    expect(metricUnit('rps')).toBe('req/s');
    expect(metricUnit('p99')).toBe('ms');
  });

  it('builds an empty scenario and measures its plan', () => {
    const plan = emptyScenario('Smoke');
    expect(plan.collectionId).toBe('');
    expect(emptyScenario('Smoke', 'c9').collectionId).toBe('c9');
    expect(totalSeconds(plan)).toBe(300);
    expect(peakVus(plan)).toBe(10);
    expect(peakVus({ stages: [] })).toBe(0);
    expect(stagePoints(plan)).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 10 },
      { x: 270, y: 10 },
      { x: 300, y: 0 },
    ]);
  });
});

describe('LoadRunDialog', () => {
  const renderDialog = (
    props: Partial<React.ComponentProps<typeof LoadRunDialog>> = {},
  ): { onStart: () => void; onClose: () => void } => {
    const onStart = vi.fn();
    const onClose = vi.fn();
    render(
      <LoadRunDialog
        open
        scenario={scenario()}
        target="remote"
        starting={false}
        onStart={onStart}
        onClose={onClose}
        {...props}
      />,
    );
    return { onStart, onClose };
  };

  it('only starts after the authorization is checked', () => {
    const { onStart, onClose } = renderDialog();
    const start = screen.getByTestId('run-load');
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('authorized'));
    expect((start as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('names a local target and keeps the button locked while starting', () => {
    renderDialog({ target: 'local', starting: true });
    const dialog = screen.getByTestId('load-run-dialog');
    expect(dialog.querySelector('.ti-device-laptop')).not.toBeNull();
    expect(dialog.querySelector('.ti-cloud')).toBeNull();
    fireEvent.click(screen.getByTestId('authorized'));
    expect((screen.getByTestId('run-load') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a remote target and forgets the authorization when reopened', () => {
    const props = {
      scenario: scenario(),
      target: 'remote' as const,
      starting: false,
      onStart: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<LoadRunDialog open {...props} />);
    expect(screen.getByTestId('load-run-dialog').querySelector('.ti-cloud')).not.toBeNull();
    fireEvent.click(screen.getByTestId('authorized'));
    expect((screen.getByTestId('authorized') as HTMLInputElement).checked).toBe(true);
    view.rerender(<LoadRunDialog open={false} {...props} />);
    view.rerender(<LoadRunDialog open {...props} />);
    expect((screen.getByTestId('authorized') as HTMLInputElement).checked).toBe(false);
  });
});

describe('AreaChart', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 5 },
    { x: 20, y: 10 },
  ];
  const chart = (
    props: Partial<React.ComponentProps<typeof AreaChart>> = {},
    data: readonly { x: number; y: number }[] = points,
  ) =>
    render(
      <AreaChart
        title="Throughput"
        points={data}
        formatX={(x) => `${x}s`}
        formatY={(y) => `${y}/s`}
        data-testid="chart"
        {...props}
      />,
    );

  it('shows a tooltip for the point nearest to the pointer and hides it on leave', () => {
    const { container } = chart();
    const box = container.querySelector('div.relative') as HTMLDivElement;
    box.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 120, right: 200, bottom: 120 }) as DOMRect;
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerMove(box, { clientX: 100 });
    expect(within(screen.getByRole('tooltip')).getByText('10s')).toBeTruthy();
    expect(screen.getByRole('tooltip').textContent).toContain('5/s');
    // Moving towards a closer point keeps the nearest one; the far right flips the tooltip.
    fireEvent.pointerMove(box, { clientX: 190 });
    expect(screen.getByRole('tooltip').textContent).toContain('10/s');
    expect(screen.getByRole('tooltip').style.transform).toContain('-100%');
    fireEvent.pointerMove(box, { clientX: 100 });
    fireEvent.pointerMove(box, { clientX: 2 });
    expect(screen.getByRole('tooltip').textContent).toContain('0/s');
    fireEvent.pointerLeave(box);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ignores the pointer when the chart has no measure', () => {
    const { container } = chart({}, []);
    const box = container.querySelector('div.relative') as HTMLDivElement;
    box.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    fireEvent.pointerMove(box, { clientX: 10 });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(container.querySelector('path')?.getAttribute('d')).toBe('');
  });

  it('ignores the pointer when the box cannot be measured', () => {
    const { container } = chart();
    const box = container.querySelector('div.relative') as HTMLDivElement;
    box.getBoundingClientRect = (() => undefined) as unknown as () => DOMRect;
    fireEvent.pointerMove(box, { clientX: 10 });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('draws the plan as steps with a custom height', () => {
    const { container } = chart({ step: true, height: 80, className: 'extra' });
    expect(container.querySelectorAll('line[stroke-dasharray]').length).toBe(3);
    expect(screen.getByTestId('chart').className).toContain('extra');
    const plain = chart();
    expect(plain.container.querySelectorAll('line[stroke-dasharray]').length).toBe(0);
  });
});

const summary = (patch: Partial<LoadSummary> = {}): LoadSummary => ({
  durationSec: 30,
  maxVus: 5,
  totalRequests: 100,
  failedRequests: 10,
  errorRate: 0.1,
  rps: 3,
  latency: { min: 1, avg: 20, p50: 18, p90: 30, p95: 40, p99: 60, max: 90 },
  checks: { passed: 9, failed: 1 },
  statusCodes: { '200': 90, '500': 10 },
  errors: {},
  thresholds: [],
  passed: false,
  ...patch,
});

const run = (patch: Partial<ApiRun<LoadSummary>> = {}): ApiRun<LoadSummary> => ({
  id: 'run1',
  kind: 'load',
  collectionId: 'c1',
  scenarioId: 's1',
  environmentId: null,
  name: 'Checkout',
  target: 'remote',
  status: 'passed',
  claimLabel: null,
  result: summary(),
  error: null,
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...patch,
});

describe('LoadRunDetail', () => {
  it('shows the full detail of a finished run', () => {
    const tick = (t: number) => ({
      t,
      vus: t,
      requests: t * 2,
      errors: 0,
      avg: 10,
      p50: 10,
      p95: 20,
      p99: 30,
    });
    render(
      <LoadRunDetail
        run={run({
          target: 'local',
          claimLabel: 'Runner Local',
          error: 'boom',
          result: summary({
            abortedBy: 'p95',
            errors: { ECONNRESET: 4 },
            timeline: [tick(0), tick(5)],
            thresholds: [
              { metric: 'p95', operator: 'lt', value: 500, actual: 40, passed: true },
              { metric: 'errorRate', operator: 'gte', value: 0.01, actual: 0.1, passed: false },
            ],
            perRequest: [
              { requestId: 'r1', name: 'Login', count: 50, failed: 0, avg: 10, p95: 20 },
              { requestId: 'r2', name: 'Pay', count: 50, failed: 3, avg: 12, p95: 25 },
            ],
          }),
        })}
      />,
    );
    const detail = screen.getByTestId('load-run-detail');
    expect(detail.querySelector('.ti-device-laptop')).not.toBeNull();
    expect(within(detail).getByText('Runner Local')).toBeTruthy();
    expect(within(detail).getByRole('alert').textContent).toBe('boom');
    expect(within(detail).getByText('ECONNRESET')).toBeTruthy();
    expect(screen.getByTestId('timeline-chart')).toBeTruthy();
    expect(within(detail).getAllByRole('listitem').length).toBe(5);
    expect(within(detail).getByText('Pay')).toBeTruthy();
    expect(within(detail).getByText('3', { selector: 'td' }).className).toContain('danger');
    expect(within(detail).getByText('0', { selector: 'td' }).className).not.toContain('danger');
    expect(detail.querySelector('.ti-circle-x')).not.toBeNull();
    expect(detail.querySelector('.ti-circle-check')).not.toBeNull();
    expect(within(detail).getByText('200').className).toContain('success');
    expect(within(detail).getByText('500').className).toContain('danger');
  });

  it('waits for metrics when the timeline is too short', () => {
    render(
      <LoadRunDetail
        run={run({
          result: summary({
            timeline: [{ t: 0, vus: 1, requests: 1, errors: 0, avg: 1, p50: 1, p95: 1, p99: 1 }],
          }),
        })}
      />,
    );
    expect(screen.queryByTestId('timeline-chart')).toBeNull();
  });

  it('offers to cancel an active run and hints about a queued local run', () => {
    const onCancel = vi.fn();
    render(
      <LoadRunDetail
        run={run({ status: 'queued', target: 'local', result: null })}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancelar/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('load-run-detail').querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows no cancel button when nobody listens or the run is over', () => {
    const { unmount } = render(<LoadRunDetail run={run({ status: 'running', result: null })} />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    render(<LoadRunDetail run={run({ status: 'failed' })} onCancel={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('load-run-detail').querySelector('.animate-spin')).toBeNull();
  });
});

describe('LoadRunsPane', () => {
  it('shows an empty pane without runs', () => {
    render(<LoadRunsPane runs={[]} run={null} onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists the runs, selects one and invites to pick when none is open', () => {
    const onSelect = vi.fn();
    const runs = [run({ id: 'a' }), run({ id: 'b', target: 'local', status: 'failed' })];
    const view = render(
      <LoadRunsPane runs={runs} run={null} onSelect={onSelect} onCancel={() => {}} />,
    );
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('button');
    fireEvent.click(items[1]!);
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.queryByTestId('load-run-detail')).toBeNull();
    view.rerender(
      <LoadRunsPane runs={runs} run={runs[0]!} onSelect={onSelect} onCancel={() => {}} />,
    );
    expect(screen.getByTestId('load-run-detail')).toBeTruthy();
    expect(within(list).getAllByRole('button')[0]!.className).toContain('selected');
  });

  it('shows the open run even when the list is empty', () => {
    render(<LoadRunsPane runs={[]} run={run()} onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId('load-run-detail')).toBeTruthy();
  });
});
