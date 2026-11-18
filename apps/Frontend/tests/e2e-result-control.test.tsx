import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eResultControl } from '../src/features/e2e/E2eResultControl.js';
import type { E2eTestDetail } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

function detail(overrides: Partial<E2eTestDetail> = {}): E2eTestDetail {
  return {
    id: 't1',
    creationId: 'c1',
    position: 1,
    code: 'TC001',
    title: 'Hide buttons',
    description: 'd',
    steps: [],
    priority: 'high',
    beforeRunInstructions: null,
    afterRunInstructions: null,
    scriptInstructions: null,
    status: 'failed',
    error: 'expect failed',
    analysis: null,
    verdict: null,
    durationMs: 1000,
    attempts: 1,
    hasVideo: true,
    externalCase: null,
    stepResults: [],
    createdAt: '2026-01-30T09:23:00Z',
    updatedAt: '2026-01-30T09:27:00Z',
    lastRunAt: '2026-01-30T09:27:00Z',
    scriptPath: 'tests/e2e/tc001.spec.ts',
    logs: null,
    creation: {
      id: 'c1',
      name: 'run',
      mode: 'frontend',
      baseUrl: 'http://localhost',
      path: '/',
      status: 'completed',
    },
    ...overrides,
  };
}

function setup(test: E2eTestDetail, props: { isReadOnly?: boolean; disabled?: boolean } = {}) {
  const next = detail({ status: 'passed', resultSource: 'criteria' });
  const client = {
    saveE2eSuccessCriteria: vi
      .fn()
      .mockResolvedValue({ ...test, successCriteria: 'Acesso negado' }),
    reevaluateE2eTest: vi.fn().mockResolvedValue(next),
    setE2eTestResult: vi.fn().mockResolvedValue(next),
  };
  const onChanged = vi.fn();
  const view = render(
    <E2eResultControl
      apiClient={client as unknown as ApiClient}
      test={test}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { client, onChanged, ...view };
}

describe('E2eResultControl', () => {
  it('saves the criteria the user wrote and shows that it was saved', async () => {
    const { client, onChanged, getByLabelText, getByRole, findByText } = setup(detail());
    const save = getByRole('button', { name: /Save criteria|Salvar critério/ });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(getByLabelText(/Success criteria|Critério de sucesso/), {
      target: { value: '  Acesso negado  ' },
    });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    expect(await findByText(/Criteria saved|Critério salvo/)).toBeTruthy();
    expect(client.saveE2eSuccessCriteria).toHaveBeenCalledWith('t1', 'Acesso negado');
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('re-evaluates a failed test only with saved criteria', async () => {
    const { client, onChanged, getByRole, rerender } = setup(detail({ successCriteria: null }));
    expect(getByRole('button', { name: /Re-evaluate|Reavaliar/ })).toHaveProperty('disabled', true);

    rerender(
      <E2eResultControl
        apiClient={client as unknown as ApiClient}
        test={detail({ successCriteria: 'Acesso negado' })}
        onChanged={onChanged}
      />,
    );
    const reevaluate = getByRole('button', { name: /Re-evaluate|Reavaliar/ });
    expect(reevaluate).toHaveProperty('disabled', false);
    fireEvent.click(reevaluate);
    await waitFor(() => expect(client.reevaluateE2eTest).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('leaves passing or failing by hand to each step', () => {
    const { queryByRole, queryByLabelText, rerender, client, onChanged } = setup(detail());
    expect(queryByRole('button', { name: /Mark as|Marcar como/ })).toBeNull();
    expect(queryByLabelText(/Why|Motivo/)).toBeNull();

    rerender(
      <E2eResultControl
        apiClient={client as unknown as ApiClient}
        test={detail({ status: 'passed', error: null })}
        onChanged={onChanged}
      />,
    );
    expect(queryByRole('button', { name: /Mark as|Marcar como/ })).toBeNull();
    // A pass of the run itself has nothing to re-evaluate.
    expect(queryByRole('button', { name: /Re-evaluate|Reavaliar/ })).toBeNull();
  });

  it('explains who decided the result and gives the run result back', async () => {
    const { client, getByTestId, getByRole, rerender, onChanged } = setup(
      detail({ status: 'passed', resultSource: 'criteria', successCriteria: 'x' }),
    );
    expect(getByTestId('e2e-result-source').textContent).toMatch(/success criteria|critério/i);
    fireEvent.click(getByRole('button', { name: /Use the run result|Usar o resultado/ }));
    await waitFor(() => expect(client.setE2eTestResult).toHaveBeenCalledWith('t1', 'run'));
    expect(getByRole('button', { name: /Re-evaluate|Reavaliar/ })).toBeTruthy();

    rerender(
      <E2eResultControl
        apiClient={client as unknown as ApiClient}
        test={detail({ status: 'passed', resultSource: 'manual', resultNote: 'it is fine' })}
        onChanged={onChanged}
      />,
    );
    expect(getByTestId('e2e-result-source').textContent).toMatch(/set by you|por você/);
    expect(getByTestId('e2e-result-source').textContent).toContain('it is fine');
  });

  it('shows the server error and keeps working', async () => {
    const { client, getByRole, findByRole } = setup(
      detail({ status: 'passed', resultSource: 'criteria' }),
    );
    client.setE2eTestResult.mockRejectedValueOnce(new Error('Nope'));
    fireEvent.click(getByRole('button', { name: /Use the run result|Usar o resultado/ }));
    expect((await findByRole('alert')).textContent).toBe('Nope');
    client.setE2eTestResult.mockRejectedValueOnce('boom');
    fireEvent.click(getByRole('button', { name: /Use the run result|Usar o resultado/ }));
    await waitFor(() => expect(getByRole('alert').textContent).not.toBe('Nope'));
    expect(getByRole('button', { name: /Use the run result|Usar o resultado/ })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('keeps everything locked while the test runs', () => {
    const { getByLabelText, getByRole } = setup(
      detail({ status: 'passed', resultSource: 'criteria', successCriteria: 'x' }),
      { disabled: true },
    );
    expect(getByLabelText(/Success criteria|Critério de sucesso/)).toHaveProperty('disabled', true);
    expect(getByRole('button', { name: /Use the run result|Usar o resultado/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('only shows what was decided to someone who cannot edit', () => {
    const empty = setup(detail(), { isReadOnly: true });
    expect(empty.container.innerHTML).toBe('');
    empty.unmount();

    const decided = setup(
      detail({ status: 'passed', resultSource: 'manual', successCriteria: 'Acesso negado' }),
      { isReadOnly: true },
    );
    expect(decided.getByTestId('e2e-result-source')).toBeTruthy();
    expect(decided.getByText('Acesso negado')).toBeTruthy();
    // The only control left is the one that collapses the panel.
    expect(decided.getAllByRole('button')).toHaveLength(1);
    expect(decided.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    decided.unmount();

    const onlyCriteria = setup(detail({ successCriteria: 'Acesso negado' }), { isReadOnly: true });
    expect(onlyCriteria.getByText('Acesso negado')).toBeTruthy();
    expect(onlyCriteria.queryByTestId('e2e-result-source')).toBeNull();
    onlyCriteria.unmount();

    const readOnlyBySource = setup(detail({ resultSource: 'criteria' }), { isReadOnly: true });
    expect(readOnlyBySource.getByTestId('e2e-result-source')).toBeTruthy();
    expect(readOnlyBySource.queryByText('Acesso negado')).toBeNull();
  });

  it('collapses and expands, keeping the draft criteria', () => {
    const { getByRole, getByLabelText, getByTestId } = setup(detail());
    const toggle = getByRole('button', { name: /Result|Resultado/ });
    fireEvent.change(getByLabelText(/Success criteria|Critério de sucesso/), {
      target: { value: 'Draft' },
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(getByTestId('e2e-result-control-body').hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('e2e-result-control-body').hidden).toBe(false);
    const field = getByLabelText(/Success criteria|Critério de sucesso/) as HTMLTextAreaElement;
    expect(field.value).toBe('Draft');
  });

  it('lets the criteria be written before the first run and for a test that ended in an error', () => {
    const pending = setup(detail({ status: 'pending', error: null, lastRunAt: null }));
    expect(pending.getByLabelText(/Success criteria|Critério de sucesso/)).toBeTruthy();
    expect(pending.queryByRole('button', { name: /Mark as/ })).toBeNull();
    pending.unmount();

    const errored = setup(detail({ status: 'error' }));
    expect(errored.getByLabelText(/Success criteria|Critério de sucesso/)).toBeTruthy();
    expect(errored.queryByRole('button', { name: /Mark as|Marcar como/ })).toBeNull();
  });
});
