import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eTestDetail } from '../src/features/e2e/E2eTestDetail.js';
import type { E2eStepResult, E2eTestDetail as Dto } from '../src/features/e2e/e2e-types.js';
import { ActivityCenter, ActivityProvider } from '../src/features/activities/ActivityCenter.js';
import { MediaProvider } from '../src/features/shared/media.js';
import type { ApiClient } from '../src/lib/api-client.js';

const steps: readonly E2eStepResult[] = [
  {
    position: 1,
    title: 'Abrir',
    status: 'passed',
    durationMs: 10,
    error: null,
    hasScreenshot: false,
  },
  {
    position: 2,
    title: 'Conferir os cabeçalhos',
    status: 'failed',
    durationMs: 20,
    error: 'Expected: 4 Received: 5',
    hasScreenshot: false,
  },
  {
    position: 3,
    title: 'Exportar',
    status: 'failed',
    durationMs: 30,
    error: 'Timeout',
    hasScreenshot: false,
  },
];

function detail(overrides: Partial<Dto> = {}): Dto {
  return {
    id: 't1',
    creationId: 'c1',
    position: 7,
    code: 'TC007',
    title: 'Ensure real-time ordering',
    description: 'Validate that the list reorders in real time.',
    steps: ['Open the event', 'Vote'],
    priority: 'high',
    beforeRunInstructions: null,
    afterRunInstructions: null,
    scriptInstructions: null,
    status: 'failed',
    error: 'expect(locator).toHaveCount(expected) failed',
    analysis: null,
    verdict: null,
    durationMs: 65_000,
    attempts: 2,
    hasVideo: false,
    externalCase: null,
    stepResults: steps,
    createdAt: '2026-01-30T09:23:00Z',
    updatedAt: '2026-01-30T09:27:00Z',
    lastRunAt: '2026-01-30T09:27:00Z',
    scriptPath: 'tests/e2e/tc007-ordering.spec.ts',
    logs: '',
    creation: {
      id: 'c1',
      name: 'ama',
      mode: 'frontend',
      baseUrl: 'http://localhost:3000',
      path: '/e/123',
      status: 'completed',
    },
    ...overrides,
  };
}

function setup(response: Dto = detail(), isReadOnly = false) {
  const client = {
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn().mockResolvedValue(undefined),
    getE2eTest: vi.fn().mockResolvedValue(response),
    getE2eEnvironments: vi.fn().mockResolvedValue([]),
    fixE2eTestStep: vi.fn().mockResolvedValue(undefined),
    rerunE2eTest: vi.fn().mockResolvedValue(undefined),
    getE2eStepScreenshot: vi.fn(),
  };
  const view = render(
    <MediaProvider apiClient={client as unknown as ApiClient}>
      <E2eTestDetail
        apiClient={client as unknown as ApiClient}
        testId="t1"
        isReadOnly={isReadOnly}
        onBack={vi.fn()}
      />
    </MediaProvider>,
  );
  return { client, view };
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('fixing one failed step with the AI', () => {
  it('offers the fix on every failed step, and only there', async () => {
    const { view } = setup();
    await view.findByText('TC007-Ensure real-time ordering');
    expect(view.queryByRole('button', { name: 'Corrigir step com IA (1)' })).toBeNull();
    expect(view.getByRole('button', { name: 'Corrigir step com IA (2)' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Corrigir step com IA (3)' })).toBeInTheDocument();
  });

  it('is not offered to who cannot edit, nor without a script', async () => {
    const readOnly = setup(detail(), true);
    await readOnly.view.findByText('TC007-Ensure real-time ordering');
    expect(readOnly.view.queryByRole('button', { name: /Corrigir step com IA/ })).toBeNull();
    readOnly.view.unmount();

    const noScript = setup(detail({ scriptPath: null }));
    await noScript.view.findByText('TC007-Ensure real-time ordering');
    expect(noScript.view.queryByRole('button', { name: /Corrigir step com IA/ })).toBeNull();
  });

  it('sends the instructions of the step and nothing else is rewritten', async () => {
    const { view, client } = setup();
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
    expect(await view.findByRole('heading', { name: 'Corrigir o step 2' })).toBeInTheDocument();
    expect(view.getByText('Conferir os cabeçalhos', { selector: 'p' })).toBeInTheDocument();
    fireEvent.click(await view.findByTestId('editor-mode-code'));
    fireEvent.change(view.getByTestId('e2e-step-fix-instructions-code'), {
      target: { value: '  Preencha só o filtro de documentos  ' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Corrigir step' }));
    await waitFor(() =>
      expect(client.fixE2eTestStep).toHaveBeenCalledWith(
        't1',
        2,
        'Preencha só o filtro de documentos',
      ),
    );
    expect(client.rerunE2eTest).not.toHaveBeenCalled();
    await waitFor(() => expect(view.queryByTestId('e2e-step-fix-dialog')).not.toBeInTheDocument());
  });

  it('starts empty for every step', async () => {
    const { view } = setup();
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
    fireEvent.click(await view.findByTestId('editor-mode-code'));
    fireEvent.change(view.getByTestId('e2e-step-fix-instructions-code'), {
      target: { value: 'sobre o step 2' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(view.queryByTestId('e2e-step-fix-dialog')).not.toBeInTheDocument());
    fireEvent.click(view.getByRole('button', { name: 'Corrigir step com IA (3)' }));
    fireEvent.click(await view.findByTestId('editor-mode-code'));
    expect((view.getByTestId('e2e-step-fix-instructions-code') as HTMLTextAreaElement).value).toBe(
      '',
    );
  });

  it('closes with the X without fixing anything', async () => {
    const { view, client } = setup();
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
    fireEvent.click(await view.findByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(view.queryByTestId('e2e-step-fix-dialog')).not.toBeInTheDocument());
    expect(client.fixE2eTestStep).not.toHaveBeenCalled();
  });

  it('does not let instructions the API would refuse be sent', async () => {
    const { view, client } = setup();
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
    fireEvent.click(await view.findByTestId('editor-mode-code'));
    const field = view.getByTestId('e2e-step-fix-instructions-code');
    fireEvent.change(field, { target: { value: 'x'.repeat(20_001) } });
    expect(view.getByRole('alert')).toHaveTextContent('até 20000 caracteres');
    const confirm = view.getByRole('button', { name: 'Corrigir step' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(client.fixE2eTestStep).not.toHaveBeenCalled();
  });

  it('shows why the fix could not start', async () => {
    const { view, client } = setup();
    client.fixE2eTestStep.mockRejectedValue(new Error('Test is running'));
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
    expect(await view.findByText('Test is running')).toBeInTheDocument();
  });

  it('falls back to a generic message when the failure has no text', async () => {
    const { view, client } = setup();
    client.fixE2eTestStep.mockRejectedValue('boom');
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
    expect(await view.findByRole('alert')).toBeInTheDocument();
  });

  it('keeps the other fixes from starting while one is on its way', async () => {
    const { view, client } = setup();
    let finish: () => void = () => undefined;
    client.fixE2eTestStep.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
    fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
    await waitFor(() => expect(client.fixE2eTestStep).toHaveBeenCalled());
    expect(view.queryByRole('button', { name: /Corrigir step com IA/ })).toBeNull();
    await act(async () => finish());
    expect(
      await view.findByRole('button', { name: 'Corrigir step com IA (3)' }),
    ).toBeInTheDocument();
  });

  describe('feedback and activities', () => {
    function setupWithActivities(response: Dto = detail()) {
      const client = {
        uploadAttachment: vi.fn(),
        deleteAttachment: vi.fn().mockResolvedValue(undefined),
        getE2eTest: vi.fn().mockResolvedValue(response),
        getE2eEnvironments: vi.fn().mockResolvedValue([]),
        fixE2eTestStep: vi.fn().mockResolvedValue(undefined),
        rerunE2eTest: vi.fn().mockResolvedValue(undefined),
        getE2eStepScreenshot: vi.fn(),
      };
      const view = render(
        <ActivityProvider>
          <ActivityCenter />
          <MediaProvider apiClient={client as unknown as ApiClient}>
            <E2eTestDetail
              apiClient={client as unknown as ApiClient}
              testId="t1"
              onBack={vi.fn()}
            />
          </MediaProvider>
        </ActivityProvider>,
      );
      return { client, view };
    }

    const openActivities = (view: ReturnType<typeof setup>['view']) =>
      fireEvent.click(view.getByRole('button', { name: /Abrir atividades|Atividades/i }));

    it('says right away that the fix is on its way, and shows it in the activities', async () => {
      const { view, client } = setupWithActivities();
      let accept: () => void = () => undefined;
      client.fixE2eTestStep.mockReturnValue(new Promise<void>((resolve) => (accept = resolve)));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
      expect(await view.findByTestId('e2e-ai-starting')).toHaveTextContent(
        'Enviando a correção do step 2 para a IA',
      );
      expect(view.queryByTestId('e2e-step-fix-dialog')).not.toBeInTheDocument();
      expect(view.getByText('A IA está trabalhando neste teste…')).toBeInTheDocument();
      openActivities(view);
      const item = await view.findByText('Corrigindo o step 2 de TC007');
      expect(item.closest('li')).toHaveAttribute('data-status', 'running');
      await act(async () => accept());
      await waitFor(() => expect(view.queryByTestId('e2e-ai-starting')).not.toBeInTheDocument());
      await waitFor(() => expect(item.closest('li')).toHaveAttribute('data-status', 'success'));
    });

    it('keeps the activity running until the test stops, then completes it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { view, client } = setupWithActivities();
        client.getE2eTest.mockResolvedValue(detail({ status: 'running' }));
        fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
        client.getE2eTest.mockResolvedValue(detail({ status: 'running' }));
        fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
        await waitFor(() => expect(client.fixE2eTestStep).toHaveBeenCalled());
        openActivities(view);
        const item = await view.findByText('Corrigindo o step 2 de TC007');
        expect(item.closest('li')).toHaveAttribute('data-status', 'running');
        client.getE2eTest.mockResolvedValue(detail({ status: 'failed' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3100);
        });
        await waitFor(() => expect(item.closest('li')).toHaveAttribute('data-status', 'success'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('registers a fix whose run ended in error as failed', async () => {
      const { view, client } = setupWithActivities();
      client.getE2eTest
        .mockResolvedValueOnce(detail())
        .mockResolvedValue(detail({ status: 'error', error: 'The AI could not rewrite it' }));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
      openActivities(view);
      const item = await view.findByText('Corrigindo o step 2 de TC007');
      await waitFor(() => expect(item.closest('li')).toHaveAttribute('data-status', 'error'));
      expect(item.closest('li')).toHaveTextContent('The AI could not rewrite it');
    });

    it('falls back to a generic reason when the run ended without one', async () => {
      const { view, client } = setupWithActivities();
      client.getE2eTest
        .mockResolvedValueOnce(detail())
        .mockResolvedValue(detail({ status: 'cancelled', error: null }));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
      openActivities(view);
      const item = await view.findByText('Corrigindo o step 2 de TC007');
      await waitFor(() => expect(item.closest('li')).toHaveAttribute('data-status', 'error'));
      expect(item.closest('li')).toHaveTextContent('Não foi possível concluir a ação.');
    });

    it('registers a fix that could not start as failed too', async () => {
      const { view, client } = setupWithActivities();
      client.fixE2eTestStep.mockRejectedValue(new Error('Test is running'));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step' }));
      expect(
        await view.findByText('Test is running', { selector: 'p.text-red-400' }),
      ).toBeInTheDocument();
      openActivities(view);
      const item = await view.findByText('Corrigindo o step 2 de TC007');
      await waitFor(() => expect(item.closest('li')).toHaveAttribute('data-status', 'error'));
      expect(view.queryByTestId('e2e-ai-starting')).not.toBeInTheDocument();
    });

    it('registers the rewrite of the whole script as an activity as well', async () => {
      const { view, client } = setupWithActivities();
      fireEvent.click(await view.findByRole('button', { name: 'Regenerar script' }));
      fireEvent.click(await view.findByRole('button', { name: 'Regenerar' }));
      await waitFor(() => expect(client.rerunE2eTest).toHaveBeenCalled());
      openActivities(view);
      const item = await view.findByText('Regenerando o script de TC007');
      await waitFor(() => expect(item.closest('li')).toHaveAttribute('data-status', 'success'));
    });

    it('does not make a plain rerun an AI activity', async () => {
      const { view, client } = setupWithActivities();
      fireEvent.click(await view.findByRole('button', { name: 'Executar novamente' }));
      await waitFor(() => expect(client.rerunE2eTest).toHaveBeenCalled());
      openActivities(view);
      expect(await view.findByText(/Nenhuma atividade/i)).toBeInTheDocument();
    });
  });

  describe('images in the instructions of the step', () => {
    const STORED = '6f1c2a90-1f0e-4a3b-8f4e-5a2c9d7e1b11';
    const stored = {
      id: STORED,
      name: 'tela.png',
      kind: 'image',
      scope: 'e2e',
      source: 'adk',
      url: `/attachments/files/${STORED}`,
    };

    async function attach(view: ReturnType<typeof setup>['view']) {
      fireEvent.click(await view.findByRole('button', { name: 'Corrigir step com IA (2)' }));
      fireEvent.change(await view.findByTestId('input-document-image'), {
        target: { files: [new File(['x'], 'tela.png', { type: 'image/png' })] },
      });
    }

    it('uploads them when the fix is confirmed', async () => {
      const { view, client } = setup();
      client.uploadAttachment.mockResolvedValue(stored);
      await attach(view);
      fireEvent.click(view.getByRole('button', { name: 'Corrigir step' }));
      await waitFor(() => expect(client.fixE2eTestStep).toHaveBeenCalled());
      const sent = client.fixE2eTestStep.mock.calls[0]![2] as string;
      expect(sent).toContain(`(/attachments/files/${STORED})`);
      expect(sent).not.toContain('/attachments/drafts/');
    });

    it('removes them again when the fix cannot start', async () => {
      const { view, client } = setup();
      client.uploadAttachment.mockResolvedValue(stored);
      client.fixE2eTestStep.mockRejectedValue(new Error('Test is running'));
      await attach(view);
      fireEvent.click(view.getByRole('button', { name: 'Corrigir step' }));
      expect(await view.findByText('Test is running')).toBeInTheDocument();
      expect(client.deleteAttachment).toHaveBeenCalledWith(STORED);
    });

    it('forgets the ones never sent when the dialog is cancelled', async () => {
      const { view, client } = setup();
      await attach(view);
      fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
      await waitFor(() =>
        expect(view.queryByTestId('e2e-step-fix-dialog')).not.toBeInTheDocument(),
      );
      expect(URL.revokeObjectURL).toHaveBeenCalled();
      expect(client.uploadAttachment).not.toHaveBeenCalled();
      expect(client.fixE2eTestStep).not.toHaveBeenCalled();
    });
  });
});

describe('steps a failed run never got to', () => {
  const planned = ['Abrir a tela => A tela abre', 'Votar'];

  it('lists every planned step as not executed, and says the run failed before the first one', async () => {
    const { view, client } = setup(
      detail({ stepResults: [], steps: planned, error: 'Test timeout of 90000ms exceeded.' }),
    );
    expect(await view.findByTestId('e2e-executed-steps')).toBeInTheDocument();
    expect(view.getByTestId('e2e-step-not-run-1')).toHaveTextContent('1. Abrir a tela');
    expect(view.getByTestId('e2e-step-not-run-1')).toHaveTextContent('Resultado esperado');
    expect(view.getByTestId('e2e-step-not-run-1')).toHaveTextContent('A tela abre');
    expect(view.getByTestId('e2e-step-not-run-2')).toHaveTextContent('2. Votar');
    expect(view.getByTestId('e2e-step-not-run-2')).not.toHaveTextContent('Resultado esperado');
    expect(view.getAllByText('Não executado')).toHaveLength(2);
    expect(view.getByText(/falhou antes do primeiro step/)).toBeInTheDocument();
    // Nothing ran, so there is no step to fix or to decide about.
    expect(view.queryByRole('button', { name: /Corrigir step com IA/ })).toBeNull();
    expect(client.fixE2eTestStep).not.toHaveBeenCalled();
  });

  it('lists the steps after the one that failed, without the notice of a run that never started', async () => {
    const { view } = setup(detail({ stepResults: [steps[1]!], steps: planned, status: 'error' }));
    expect(await view.findByTestId('e2e-step-not-run-2')).toHaveTextContent('2. Votar');
    expect(view.queryByTestId('e2e-step-not-run-1')).toBeNull();
    expect(view.queryByText(/falhou antes do primeiro step/)).toBeNull();
  });

  it('shows nothing of the kind for a run that passed or has all its steps', async () => {
    const passedRun = setup(detail({ status: 'passed', stepResults: [], steps: planned }));
    await passedRun.view.findByText('TC007-Ensure real-time ordering');
    expect(passedRun.view.queryByTestId('e2e-executed-steps')).toBeNull();
    passedRun.view.unmount();

    const complete = setup(detail({ stepResults: [steps[0]!, steps[1]!], steps: planned }));
    expect(await complete.view.findByTestId('e2e-executed-steps')).toBeInTheDocument();
    expect(complete.view.queryByTestId('e2e-step-not-run-1')).toBeNull();
    expect(complete.view.queryByTestId('e2e-step-not-run-2')).toBeNull();
  });
});
