import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eExecutedSteps, E2eLinkedCase } from '../src/features/e2e/E2eTestEvidence.js';
import type { E2eTestDetail } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const externalCase = {
  provider: 'xray' as const,
  caseId: 'QA-12',
  title: 'Login com SSO',
  steps: [
    { id: '1', action: 'Abrir login', expectedResult: '  ' },
    { id: '2', action: 'Entrar', expectedResult: 'Painel aberto' },
  ],
};

const base: E2eTestDetail = {
  id: 'test-1',
  creationId: 'run-1',
  position: 1,
  code: 'TC001',
  title: 'Login',
  description: 'Validar o login',
  steps: ['Abrir login'],
  priority: 'high',
  scriptPath: 'tests/tc001.spec.ts',
  status: 'failed',
  error: null,
  analysis: null,
  verdict: null,
  durationMs: 100,
  attempts: 1,
  hasVideo: false,
  externalCase,
  stepResults: [],
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:01:00Z',
  lastRunAt: null,
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

const xrayProvider = {
  id: 'xray',
  name: 'Xray Cloud',
  configured: true,
  capabilities: { planLabel: 'Projeto Jira', caseIdLabel: 'Issue', stepEvidence: false },
};

function linkClient() {
  return {
    linkE2eTestCase: vi.fn().mockResolvedValue(base),
    getTestManagementProviders: vi.fn().mockResolvedValue([xrayProvider]),
    getTestManagementPlans: vi.fn().mockResolvedValue([{ id: 'QA', name: 'QA' }]),
    getTestManagementSuites: vi.fn(),
    getTestManagementCases: vi.fn().mockResolvedValue([externalCase]),
  };
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:step'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E2eLinkedCase', () => {
  it('shows a linked case without a link and unlinks it', async () => {
    const client = linkClient();
    const onChanged = vi.fn();
    render(
      <E2eLinkedCase
        apiClient={client as unknown as ApiClient}
        test={base}
        reporting={null}
        isReadOnly={false}
        disabled={false}
        onChanged={onChanged}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('QA-12')).toBeInTheDocument();
    expect(screen.getByText('Xray Cloud')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' }));
    await waitFor(() => expect(client.linkE2eTestCase).toHaveBeenCalledWith('test-1', null));
    expect(onChanged).toHaveBeenCalledWith(base);
  });

  it('shows why unlinking failed', async () => {
    const client = linkClient();
    client.linkE2eTestCase.mockRejectedValueOnce(new Error('Sem permissão'));
    const onChanged = vi.fn();
    render(
      <E2eLinkedCase
        apiClient={client as unknown as ApiClient}
        test={base}
        reporting={null}
        isReadOnly={false}
        disabled={false}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sem permissão');
    expect(onChanged).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Desvincular' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('links a case of a platform without suites and cancels editing', async () => {
    const client = linkClient();
    const onChanged = vi.fn();
    render(
      <E2eLinkedCase
        apiClient={client as unknown as ApiClient}
        test={{ ...base, externalCase: null }}
        reporting={{ provider: 'xray', planId: 'QA', suiteId: null, autoPublish: false }}
        isReadOnly={false}
        disabled={false}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText('Nenhum test case vinculado.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText('Nenhum test case vinculado.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    const search = await screen.findByRole('combobox', { name: 'ID do test case' });
    fireEvent.focus(search);
    fireEvent.click(await screen.findByRole('option', { name: 'QA-12 · Login com SSO' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() =>
      expect(client.linkE2eTestCase).toHaveBeenCalledWith('test-1', {
        provider: 'xray',
        caseId: 'QA-12',
        planId: 'QA',
      }),
    );
    expect(onChanged).toHaveBeenCalledWith(base);
    expect(client.getTestManagementSuites).not.toHaveBeenCalled();
  });

  it('ignores a submit without a selected case', async () => {
    const client = linkClient();
    const { container } = render(
      <E2eLinkedCase
        apiClient={client as unknown as ApiClient}
        test={{ ...base, externalCase: null }}
        reporting={null}
        isReadOnly={false}
        disabled={false}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await screen.findByLabelText('Plataforma');
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect(client.linkE2eTestCase).not.toHaveBeenCalled();
  });
});

describe('E2eExecutedSteps', () => {
  it('shows failed steps with their sanitized error and only non-blank expectations', async () => {
    const client = {
      getE2eStepScreenshot: vi.fn().mockRejectedValue(new Error('missing')),
    };
    render(
      <E2eExecutedSteps
        apiClient={client as unknown as ApiClient}
        test={{
          ...base,
          stepResults: [
            {
              position: 1,
              title: 'Abrir login',
              status: 'failed',
              durationMs: 1_000,
              error: 'Timeout\n    at /app/node_modules/playwright/index.js:1:1',
              hasScreenshot: true,
            },
            {
              position: 2,
              title: 'Entrar',
              status: 'passed',
              durationMs: 2_000,
              error: null,
              hasScreenshot: false,
            },
            {
              position: 3,
              title: 'Sair',
              status: 'passed',
              durationMs: 500,
              error: null,
              hasScreenshot: false,
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Pass' })).toHaveLength(2);
    expect(screen.getByText('Timeout').tagName).toBe('PRE');
    expect(screen.queryByText(/node_modules/)).toBeNull();
    expect(screen.getAllByText('Esperado:')).toHaveLength(1);
    expect(screen.getByText(/Painel aberto/)).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Captura indisponível' })).toBeInTheDocument();
    expect(client.getE2eStepScreenshot).toHaveBeenCalledWith('test-1', 1, expect.any(AbortSignal));
  });

  it('shows steps of a test without a linked case', () => {
    render(
      <E2eExecutedSteps
        apiClient={{} as ApiClient}
        test={{
          ...base,
          externalCase: null,
          stepResults: [
            {
              position: 1,
              title: 'Abrir login',
              status: 'passed',
              durationMs: 10,
              error: null,
              hasScreenshot: false,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('1. Abrir login')).toBeInTheDocument();
    expect(screen.queryByText('Esperado:')).toBeNull();
  });

  it('enlarges a screenshot and closes it with the button or Escape', async () => {
    const client = {
      getE2eStepScreenshot: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
    };
    render(
      <E2eExecutedSteps
        apiClient={client as unknown as ApiClient}
        test={{
          ...base,
          lastRunAt: '2026-10-07T10:01:00Z',
          stepResults: [
            {
              position: 1,
              title: 'Abrir login',
              status: 'passed',
              durationMs: 10,
              error: null,
              hasScreenshot: true,
            },
          ],
        }}
      />,
    );
    const thumbnail = await screen.findByRole('button', { name: 'Ampliar captura do passo 1' });
    fireEvent.click(thumbnail);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(thumbnail);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
