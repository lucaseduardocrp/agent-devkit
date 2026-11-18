import { describe, expect, it } from 'vitest';
import {
  buildRegenerationFeedback,
  parseRegenerationFeedback,
} from '../src/modules/e2e/domain/e2e.js';
import type { E2eStepResult } from '../src/modules/e2e/domain/e2e.js';

const step = (over: Partial<E2eStepResult>): E2eStepResult => ({
  position: 1,
  title: 'Passo 1',
  status: 'passed',
  durationMs: 1,
  error: null,
  screenshotKey: null,
  ...over,
});
const base = { status: 'failed', error: null, analysis: null, logs: null } as const;

describe('feedback for rewriting a spec', () => {
  it('puts what the user decided about the steps before what the run reported', () => {
    const { problem } = buildRegenerationFeedback(
      {
        ...base,
        resultSource: 'manual',
        stepResults: [
          step({ position: 1, manualStatus: 'failed', manualNote: ' still shows it ' }),
          step({ position: 2, status: 'failed', error: 'Expected: 0', manualStatus: 'passed' }),
          step({ position: 3 }),
        ],
      },
      'script',
    );
    expect(problem).toContain('Decisions of the user (they overrule the run');
    expect(problem).toContain(
      '1. Passo 1: the user decided "failed" (the run reported "passed") - ',
    );
    expect(problem).toContain('still shows it');
    expect(problem).toContain('2. Passo 1: the user decided "passed" (the run reported "failed")');
    expect(problem).not.toContain('3. Passo 1: the user decided');
    expect(problem.indexOf('Decisions of the user')).toBeLessThan(
      problem.indexOf('Steps of the last run'),
    );
  });

  it('says what the user decided about the whole test, when no step was decided', () => {
    const withNote = buildRegenerationFeedback(
      {
        ...base,
        status: 'passed',
        resultSource: 'manual',
        resultNote: 'it is fine',
        stepResults: [step({})],
      },
      's',
    ).problem;
    expect(withNote).toContain('The whole test: the user decided "passed" - it is fine');

    const withoutNote = buildRegenerationFeedback(
      { ...base, resultSource: 'manual', resultNote: null, stepResults: [] },
      's',
    ).problem;
    expect(withoutNote).toContain('The whole test: the user decided "failed"');
    expect(withoutNote).not.toContain('"failed" -');
  });

  it('has no decisions to report when the result is the run’s own', () => {
    const { problem } = buildRegenerationFeedback(
      { ...base, resultSource: 'run', stepResults: [step({ status: 'failed' })] },
      's',
    );
    expect(problem).not.toContain('Decisions of the user');
    expect(buildRegenerationFeedback({ ...base, stepResults: [] }, 's').problem).toContain(
      'no output of a previous run',
    );
  });
});

describe('stored feedback for rewriting a spec', () => {
  const stored = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ script: 's', problem: 'p', ...extra });

  it('reads the script and the problem, and the step to fix when there is one', () => {
    expect(parseRegenerationFeedback(stored())).toEqual({ script: 's', problem: 'p' });
    expect(
      parseRegenerationFeedback(
        stored({ step: { position: 2, title: 'Passo 2', instructions: 'use CPF', extra: 1 } }),
      ),
    ).toEqual({
      script: 's',
      problem: 'p',
      step: { position: 2, title: 'Passo 2', instructions: 'use CPF' },
    });
  });

  it('ignores a step that is not well formed instead of fixing the wrong one', () => {
    for (const step of [
      null,
      'two',
      { position: 1.5, title: 't', instructions: '' },
      { position: 2, title: 3, instructions: '' },
      { position: 2, title: 't' },
    ])
      expect(parseRegenerationFeedback(stored({ step }))).toEqual({ script: 's', problem: 'p' });
  });

  it('reads nothing from what is missing or broken', () => {
    expect(parseRegenerationFeedback(null)).toBeNull();
    expect(parseRegenerationFeedback('{not json')).toBeNull();
    expect(parseRegenerationFeedback(JSON.stringify({ script: 's' }))).toBeNull();
  });
});
