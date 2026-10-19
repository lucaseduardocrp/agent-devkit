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
