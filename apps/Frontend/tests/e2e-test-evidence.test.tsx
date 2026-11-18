import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2eExecutedSteps, E2eLinkedCase } from '../src/features/e2e/E2eTestEvidence.js';
import type { E2eTestDetail } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const test: E2eTestDetail = {
  id: 'test-1',
  creationId: 'run-1',
  position: 1,
  code: 'TC001',
  title: 'Permissões',
  description: 'Validar a tela',
  steps: ['Abrir grupos'],
  priority: 'high',
  beforeRunInstructions: null,
  afterRunInstructions: null,
  scriptInstructions: null,
  scriptPath: 'tests/tc001.spec.ts',
  status: 'passed',
  error: null,
  analysis: null,
  verdict: null,
  durationMs: 100,
  attempts: 1,
  hasVideo: false,
  externalCase: {
    provider: 'azure_devops',
    caseId: '50605',
    title: 'Permissões de Empresas',
    steps: [{ id: '2', action: 'Abrir grupos', expectedResult: 'Grupos visíveis' }],
    url: 'https://dev.azure.com/example/_workitems/edit/50605',
  },
  stepResults: [
    {
      position: 1,
      title: 'Abrir grupos',
      status: 'passed',
      durationMs: 100,
      error: null,
      hasScreenshot: true,
    },
  ],
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:01:00Z',
  lastRunAt: '2026-10-07T10:01:00Z',
  logs: null,
  creation: {
    id: 'run-1',
    name: 'Empresas',
    mode: 'frontend',
    baseUrl: 'https://example.test',
    path: '/',
    status: 'completed',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E2E test case evidence', () => {
  it('shows the linked case, step result, expected result and screenshot', async () => {
    const createObjectURL = vi.fn(() => 'blob:step-one');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const client = {
      getE2eStepScreenshot: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
    } as unknown as ApiClient;
    const view = render(
      <>
        <E2eLinkedCase
          apiClient={client}
          test={test}
          reporting={null}
          isReadOnly
          disabled={false}
          onChanged={vi.fn()}
        />
        <E2eExecutedSteps apiClient={client} test={test} />
      </>,
    );
    expect(screen.getByRole('link', { name: /50605/ }).getAttribute('href')).toContain('50605');
    expect(screen.getByText('Grupos visíveis')).toBeTruthy();
    const screenshot = await screen.findByRole('button', { name: /ampliar|enlarge/i });
    fireEvent.click(screenshot);
    expect(
      screen.getAllByRole('img').some((image) => image.getAttribute('src') === 'blob:step-one'),
    ).toBe(true);
    view.unmount();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:step-one'));
  });

  it('links only a case selected from the configured plan and suite', async () => {
    const linked = { ...test, externalCase: null };
    const client = {
      linkE2eTestCase: vi.fn().mockResolvedValue(test),
      getTestManagementProviders: vi.fn().mockResolvedValue([
        {
          id: 'azure_devops',
          name: 'Azure DevOps Test Plan',
          configured: true,
          capabilities: {
            planLabel: 'Test Plan',
            suiteLabel: 'Suite',
            suiteRequired: true,
            caseIdLabel: 'Test Case ID',
            stepEvidence: true,
          },
        },
      ]),
      getTestManagementPlans: vi.fn().mockResolvedValue([{ id: '7', name: 'Plano' }]),
      getTestManagementSuites: vi.fn().mockResolvedValue([{ id: '8', name: 'Suite' }]),
      getTestManagementCases: vi.fn().mockResolvedValue([test.externalCase]),
    } as unknown as ApiClient;
    const onChanged = vi.fn();
    render(
      <E2eLinkedCase
        apiClient={client}
        test={linked}
        reporting={{ provider: 'azure_devops', planId: '7', suiteId: '8', autoPublish: true }}
        isReadOnly={false}
        disabled={false}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    const search = await screen.findByRole('combobox', { name: 'ID do test case' });
    await waitFor(() =>
      expect(client.getTestManagementCases).toHaveBeenCalledWith('azure_devops', {
        planId: '7',
        suiteId: '8',
      }),
    );
    fireEvent.focus(search);
    await screen.findByRole('option', { name: /50605/ });
    fireEvent.change(search, { target: { value: '99999' } });
    expect(screen.getByText('Nenhum test case encontrado.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vincular' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(search, { target: { value: 'Empresas' } });
    fireEvent.click(screen.getByRole('option', { name: /50605/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() =>
      expect(client.linkE2eTestCase).toHaveBeenCalledWith('test-1', {
        provider: 'azure_devops',
        caseId: '50605',
        planId: '7',
        suiteId: '8',
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(test));
  });
});

describe('E2E step decisions', () => {
  const failedStep = {
    position: 1,
    title: 'Abrir grupos',
    status: 'failed' as const,
    durationMs: 100,
    error: 'expect(locator).toHaveCount(expected) failed',
    hasScreenshot: false,
  };
  const failedTest: E2eTestDetail = { ...test, status: 'failed', stepResults: [failedStep] };

  function setup(overrides: Partial<E2eTestDetail> = {}) {
    const client = {
      setE2eStepResult: vi.fn().mockResolvedValue(test),
    };
    const onChanged = vi.fn();
    const view = render(
      <E2eExecutedSteps
        apiClient={client as unknown as ApiClient}
        test={{ ...failedTest, ...overrides }}
        isReadOnly={false}
        onChanged={onChanged}
      />,
    );
    return { client, onChanged, ...view };
  }

  it('passes a failed step with a note, and clears the note afterwards', async () => {
    const { client, onChanged } = setup();
    expect(screen.getByText(/toHaveCount/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Why|Motivo/), {
      target: { value: ' screen is right ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Mark as passed|Marcar como sucesso/ }));
    await waitFor(() =>
      expect(client.setE2eStepResult).toHaveBeenCalledWith(
        'test-1',
        1,
        'passed',
        'screen is right',
      ),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(test));
    await waitFor(() => expect(screen.getByLabelText(/Why|Motivo/)).toHaveProperty('value', ''));
    expect(screen.queryByRole('button', { name: /Mark as failed|Marcar como falha/ })).toBeNull();
  });

  it('fails a passed step', async () => {
    const { client } = setup({ stepResults: [{ ...failedStep, status: 'passed', error: null }] });
    fireEvent.click(screen.getByRole('button', { name: /Mark as failed|Marcar como falha/ }));
    await waitFor(() =>
      expect(client.setE2eStepResult).toHaveBeenCalledWith('test-1', 1, 'failed', ''),
    );
  });

  it('hides the error of a step the user passed, and gives the run result back', async () => {
    const { client } = setup({
      stepResults: [{ ...failedStep, manualStatus: 'passed', manualNote: 'it is fine' }],
    });
    expect(screen.queryByText(/toHaveCount/)).toBeNull();
    expect(screen.getByText(/Set by you|Definido por você/).textContent).toContain('it is fine');
    expect(screen.getByRole('img', { name: /Pass/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Use the run result|Usar o resultado/ }));
    await waitFor(() =>
      expect(client.setE2eStepResult).toHaveBeenCalledWith('test-1', 1, 'run', undefined),
    );
  });

  it('shows a step the user failed without a note', () => {
    setup({
      stepResults: [{ ...failedStep, status: 'passed', error: null, manualStatus: 'failed' }],
    });
    expect(screen.getByText(/Set by you|Definido por você/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Failed/ })).toBeTruthy();
  });

  it('shows the server error and keeps working', async () => {
    const { client } = setup();
    client.setE2eStepResult.mockRejectedValueOnce(new Error('Nope'));
    fireEvent.click(screen.getByRole('button', { name: /Mark as passed|Marcar como sucesso/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Nope');
    client.setE2eStepResult.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByRole('button', { name: /Mark as passed|Marcar como sucesso/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toBe('Nope'));
    expect(screen.getByLabelText(/Why|Motivo/)).toHaveProperty('disabled', false);
  });

  it('only shows the steps to someone who cannot edit', () => {
    render(
      <E2eExecutedSteps
        apiClient={{} as unknown as ApiClient}
        test={failedTest}
        isReadOnly
        onChanged={vi.fn()}
      />,
    );
    // The only control left is the one that collapses the panel.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText(/toHaveCount/)).toBeTruthy();
  });

  it('collapses and expands the executed steps', () => {
    render(
      <E2eExecutedSteps
        apiClient={{} as unknown as ApiClient}
        test={failedTest}
        isReadOnly
        onChanged={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('button', { name: /Executed steps|Passos executados/ });
    const body = screen.getByTestId('e2e-executed-steps-body');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(body.hidden).toBe(false);
  });
});
