import type { LoadMetric, LoadProfileType, LoadScenarioInput } from '../api-test-types.js';

export const RATE_METRICS = new Set<LoadMetric>(['errorRate', 'checksRate']);

export const formatMetric = (metric: LoadMetric, value: number) =>
  RATE_METRICS.has(metric)
    ? `${(value * 100).toFixed(2)} %`
    : metric === 'rps'
      ? `${value.toFixed(1)}/s`
      : `${Math.round(value)} ms`;

export const metricUnit = (metric: LoadMetric) =>
  RATE_METRICS.has(metric) ? '0–1' : metric === 'rps' ? 'req/s' : 'ms';

export const PROFILE_ICON: Record<LoadProfileType, string> = {
  smoke: 'ti-flask',
  load: 'ti-chart-line',
  stress: 'ti-trending-up',
  spike: 'ti-bolt',
  soak: 'ti-hourglass',
  breakpoint: 'ti-chart-arrows-vertical',
  custom: 'ti-adjustments',
};

export function emptyScenario(name: string, collectionId = ''): LoadScenarioInput {
  return {
    name,
    collectionId,
    environmentId: null,
    requests: [],
    profile: 'load',
    stages: [
      { durationSec: 30, targetVus: 10 },
      { durationSec: 240, targetVus: 10 },
      { durationSec: 30, targetVus: 0 },
    ],
    thinkTimeMs: 1000,
    thresholds: [
      { metric: 'errorRate', operator: 'lt', value: 0.01 },
      { metric: 'p95', operator: 'lt', value: 500 },
    ],
  };
}

export const totalSeconds = (scenario: Pick<LoadScenarioInput, 'stages'>) =>
  scenario.stages.reduce((sum, stage) => sum + stage.durationSec, 0);

export const peakVus = (scenario: Pick<LoadScenarioInput, 'stages'>) =>
  Math.max(0, ...scenario.stages.map((stage) => stage.targetVus));

/** The planned VUs as chart points: each stage ramps linearly to its target. */
export function stagePoints(scenario: Pick<LoadScenarioInput, 'stages'>) {
  let t = 0;
  return [
    { x: 0, y: 0 },
    ...scenario.stages.map((stage) => {
      t += stage.durationSec;
      return { x: t, y: stage.targetVus };
    }),
  ];
}
