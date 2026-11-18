import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { E2eFailureReason } from '../src/features/e2e/E2eFailureReason.js';
import { failureReason, type E2eTestDetail } from '../src/features/e2e/e2e-types.js';

type Input = Pick<E2eTestDetail, 'status' | 'error' | 'analysis' | 'stepResults'>;

function input(overrides: Partial<Input> = {}): Input {
  return { status: 'failed', error: null, analysis: null, stepResults: [], ...overrides };
}

const SECTIONS = ['Objetivo', 'Executado', 'O que falhou', 'Causa provável', 'Recomendação'];
const analysisOf = (bodies: readonly string[]) =>
  SECTIONS.map((title, index) => `${title}\n${bodies[index] ?? ''}`).join('\n\n');

describe('failureReason', () => {
  it('has nothing to explain unless the run failed', () => {
    for (const status of ['passed', 'running', 'pending', 'cancelled'] as const)
      expect(failureReason(input({ status, error: 'boom' }))).toBeNull();
  });

  it('explains a run that errored', () => {
    expect(failureReason(input({ status: 'error', error: 'Error: boom' }))?.headline).toBe('boom');
  });

  it('is empty when neither the error nor the analysis says anything', () => {
    expect(failureReason(input())).toBeNull();
    expect(failureReason(input({ error: '   \n  ', analysis: 'one paragraph only' }))).toBeNull();
  });

  it('reads the failed step, the assertion and the analysis', () => {
    const reason = failureReason(
      input({
        error: 'Error: run failed',
        analysis: analysisOf(['a', 'b', 'Achou 6.\nEsperava 0.', 'Conta com permissão.', 'c']),
        stepResults: [
          {
            position: 1,
            title: 'A',
            status: 'passed',
            durationMs: 1,
            error: null,
            hasScreenshot: false,
          },
          {
            position: 2,
            title: 'B',
            status: 'failed',
            durationMs: 1,
            error: 'Error: expect(x).toBe(y)\nExpected: 0\nReceived: 6\n  at /srv/app.ts:1:1',
            hasScreenshot: false,
          },
        ],
      }),
    );
    expect(reason).toEqual({
      step: { position: 2, title: 'B' },
      summary: 'Achou 6. Esperava 0.',
      cause: 'Conta com permissão.',
      headline: 'expect(x).toBe(y)',
      expected: '0',
      received: '6',
    });
  });

  it('falls back to the run error when the failed step has none', () => {
    const reason = failureReason(
      input({
        error: 'Timeout 30000ms exceeded',
        stepResults: [
          {
            position: 1,
            title: 'A',
            status: 'failed',
            durationMs: 1,
            error: null,
            hasScreenshot: false,
          },
        ],
      }),
    );
    expect(reason).toMatchObject({
      step: { position: 1, title: 'A' },
      headline: 'Timeout 30000ms exceeded',
      expected: null,
      received: null,
    });
  });

  it('ignores an analysis that does not have the five sections and empty sections', () => {
    expect(
      failureReason(input({ error: 'boom', analysis: 'Goal: x\nWhat failed: y' }))?.summary,
    ).toBeNull();
    const empty = failureReason(input({ error: 'boom', analysis: analysisOf([]) }));
    expect(empty).toMatchObject({ summary: null, cause: null });
  });

  it('explains from the analysis alone when the runner reported no error', () => {
    const reason = failureReason(input({ analysis: analysisOf(['', '', 'Falhou aqui.']) }));
    expect(reason).toMatchObject({ summary: 'Falhou aqui.', headline: '', step: null });
  });
});

describe('E2eFailureReason', () => {
  const test = (overrides: Partial<Input>) => ({ ...input(overrides) }) as E2eTestDetail;

  it('renders only the parts the failure has', () => {
    const view = render(<E2eFailureReason test={test({ error: 'Error: boom' })} />);
    expect(view.getByText('boom')).toBeInTheDocument();
    expect(view.queryByText(/Esperado/)).toBeNull();
    expect(view.queryByText(/Recebido/)).toBeNull();
    expect(view.queryByText(/Causa provável/)).toBeNull();
    expect(view.queryByText(/^Passo/)).toBeNull();
  });

  it('renders an expected value without a received one, and the other way round', () => {
    const expectedOnly = render(<E2eFailureReason test={test({ error: 'boom\nExpected: 1' })} />);
    expect(expectedOnly.getByText('Esperado:')).toBeInTheDocument();
    expect(expectedOnly.queryByText('Recebido:')).toBeNull();
    expectedOnly.unmount();

    const receivedOnly = render(<E2eFailureReason test={test({ error: 'boom\nReceived: 2' })} />);
    expect(receivedOnly.getByText('Recebido:')).toBeInTheDocument();
    expect(receivedOnly.queryByText('Esperado:')).toBeNull();
  });

  it('renders nothing for a run that did not fail', () => {
    const view = render(<E2eFailureReason test={test({ status: 'passed', error: 'boom' })} />);
    expect(view.container.innerHTML).toBe('');
  });
});
