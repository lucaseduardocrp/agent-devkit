import type { LoadProfileType, LoadStage } from './types.js';

export interface ProfileInput {
  /** Peak virtual users of the profile. */
  readonly vus: number;
  /** Total length in seconds. */
  readonly durationSec: number;
}

const stage = (durationSec: number, targetVus: number): LoadStage => ({
  durationSec: Math.max(1, Math.round(durationSec)),
  targetVus: Math.max(0, Math.round(targetVus)),
});

/**
 * Default stages of each test type, from the peak VUs and the total duration:
 *
 * - smoke: a couple of users for a short time, to check the scenario works at all.
 * - load: ramp to the expected traffic, hold it, ramp down.
 * - stress: steps beyond the expected traffic (up to 150 %) to see how it degrades.
 * - spike: quiet traffic, a sudden burst to the peak, back to quiet, to check recovery.
 * - soak: the expected traffic for a long time, to find leaks and slow degradation.
 * - breakpoint: a steady ramp to the peak, to find where it breaks (pair it with an
 *   `abortOnFail` threshold).
 * - custom: the stages are edited by hand; this returns a load-like starting point.
 */
export function profileStages(type: LoadProfileType, input: ProfileInput): LoadStage[] {
  const vus = Math.max(1, Math.round(input.vus));
  const total = Math.max(10, Math.round(input.durationSec));
  switch (type) {
    case 'smoke':
      return [stage(Math.min(total, 60), Math.min(vus, 2))];
    case 'stress': {
      const step = total / 7;
      return [
        stage(step, vus * 0.5),
        stage(step, vus * 0.75),
        stage(step, vus),
        stage(step, vus * 1.25),
        stage(step, vus * 1.5),
        stage(step, vus * 1.5),
        stage(step, 0),
      ];
    }
    case 'spike': {
      const base = Math.max(1, vus * 0.1);
      return [
        stage(total * 0.2, base),
        stage(total * 0.05, vus),
        stage(total * 0.15, vus),
        stage(total * 0.05, base),
        stage(total * 0.45, base),
        stage(total * 0.1, 0),
      ];
    }
    case 'soak':
      return [stage(total * 0.05, vus), stage(total * 0.9, vus), stage(total * 0.05, 0)];
    case 'breakpoint':
      return [stage(total, vus)];
    case 'load':
    case 'custom':
      return [stage(total * 0.1, vus), stage(total * 0.8, vus), stage(total * 0.1, 0)];
  }
}

export const totalDuration = (stages: readonly LoadStage[]) =>
  stages.reduce((sum, item) => sum + item.durationSec, 0);

export const peakVus = (stages: readonly LoadStage[]) =>
  stages.reduce((max, item) => Math.max(max, item.targetVus), 0);

/** VUs that should be running `elapsedSec` after the start: linear inside each stage. */
export function vusAt(stages: readonly LoadStage[], elapsedSec: number): number {
  let from = 0;
  let start = 0;
  for (const item of stages) {
    const end = start + item.durationSec;
    if (elapsedSec < end) {
      const progress = (elapsedSec - start) / item.durationSec;
      return Math.round(from + (item.targetVus - from) * progress);
    }
    from = item.targetVus;
    start = end;
  }
  return 0;
}
