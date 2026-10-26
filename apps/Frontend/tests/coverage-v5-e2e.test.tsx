import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2eConfigForm } from '../src/features/e2e/E2eConfigForm.js';
import { E2eLocalRunnerPanel } from '../src/features/e2e/E2eLocalRunnerPanel.js';
import { E2eTestDetail } from '../src/features/e2e/E2eTestDetail.js';
import { E2eExecutedSteps } from '../src/features/e2e/E2eTestEvidence.js';
import { E2eCasePicker, EMPTY_SELECTION } from '../src/features/e2e/E2eTestManagement.js';
import type { E2eTestDetail as Dto } from '../src/features/e2e/e2e-types.js';
import { localTunnelBridge } from '../src/features/e2e/local-tunnel-bridge.js';
import type * as TunnelBridge from '../src/features/e2e/local-tunnel-bridge.js';
import type { ApiClient } from '../src/lib/api-client.js';

vi.mock('../src/features/e2e/local-tunnel-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TunnelBridge>()),
  localTunnelBridge: { start: vi.fn(), status: vi.fn(), stop: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const test: Dto = {
  id: 't1',
  creationId: 'c1',
  position: 1,
  code: 'TC001',
  title: 'Login',
  description: 'Validar o login.',
  steps: ['Abrir login'],
  priority: 'medium',
  status: 'failed',
  error: null,
  analysis: null,
  verdict: null,
  durationMs: 1_000,
  attempts: 1,
  hasVideo: true,
  externalCase: null,
  stepResults: [
    {
      position: 1,
      title: 'Abrir login',
      status: 'failed',
      durationMs: 1_000,
      error: null,
      hasScreenshot: true,
    },
  ],
  createdAt: '2026-01-30T09:23:00Z',
  updatedAt: '2026-01-30T09:27:00Z',
  lastRunAt: '2026-01-30T09:27:00Z',
  scriptPath: 'tests/e2e/tc001.spec.ts',
  logs: null,
  creation: {
    id: 'c1',
    name: 'ama',
    mode: 'frontend',
    baseUrl: 'https://app.example.test',
    path: '/',
    status: 'completed',
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('E2E loaders that finish after the view is gone', () => {
  it('does not flag a video failure caused by leaving the test', async () => {
    const video = deferred<null>();
    const client = {
      getE2eTest: vi.fn().mockResolvedValue({ ...test, stepResults: [] }),
      getE2eTestVideoUrl: vi.fn().mockReturnValue(video.promise),
      getE2eTestVideo: vi.fn(),
    };
    const view = render(
      <E2eTestDetail apiClient={client as unknown as ApiClient} testId="t1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(client.getE2eTestVideoUrl).toHaveBeenCalled());
    const signal = client.getE2eTestVideoUrl.mock.calls[0]![1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => video.reject(new DOMException('aborted', 'AbortError')));
    expect(client.getE2eTestVideo).not.toHaveBeenCalled();
  });

  it('does not flag a screenshot failure caused by leaving the step', async () => {
    const shot = deferred<Blob>();
    const client = { getE2eStepScreenshot: vi.fn().mockReturnValue(shot.promise) };
    const view = render(
      <E2eExecutedSteps apiClient={client as unknown as ApiClient} test={test} />,
    );
    await waitFor(() => expect(client.getE2eStepScreenshot).toHaveBeenCalled());
    const signal = client.getE2eStepScreenshot.mock.calls[0]![2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => shot.reject(new DOMException('aborted', 'AbortError')));
  });

  it('ignores a provider failure that arrives after the picker closed', async () => {
    const providers = deferred<never>();
    const client = { getTestManagementProviders: vi.fn().mockReturnValue(providers.promise) };
    const view = render(
      <E2eCasePicker
        apiClient={client as unknown as ApiClient}
        value={EMPTY_SELECTION}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(client.getTestManagementProviders).toHaveBeenCalled());
    view.unmount();
    await act(async () => providers.reject(new Error('late')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('E2eLocalRunnerPanel polling', () => {
  it('polls the runners and ignores answers that arrive after unmount', async () => {
    vi.useFakeTimers();
    const first = deferred<never>();
    const second = deferred<never>();
    const client = {
      apiUrl: '/api',
      getE2eRunners: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    };
    const view = render(<E2eLocalRunnerPanel apiClient={client as unknown as ApiClient} />);
    expect(client.getE2eRunners).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(client.getE2eRunners).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      first.resolve([] as never);
      second.reject(new Error('offline'));
    });
    expect(client.getE2eRunners).toHaveBeenCalledTimes(2);
  });
});

describe('E2eConfigForm backend local tunnel', () => {
  it('starts a tunnel for a local backend without storing a browser origin', async () => {
    vi.mocked(localTunnelBridge.start).mockResolvedValueOnce({
      tunnel: {
        localUrl: 'http://localhost:3000',
        publicUrl: 'https://api.trycloudflare.com',
        accessClientId: 'id',
        accessClientSecret: 'secret',
      },
    });
    const client = {
      apiUrl: 'https://api.adk.example.com',
      getE2eRunners: vi.fn().mockResolvedValue([]),
      getAgents: vi.fn().mockResolvedValue([{ id: 'qa', name: 'QA Engineer', role: 'QA' }]),
      getE2eRepositories: vi.fn().mockResolvedValue({ repositories: [], warnings: [] }),
      getE2eBranches: vi.fn().mockResolvedValue([]),
      checkE2eTunnel: vi.fn().mockResolvedValue({ reachable: true, reason: 'ok', status: 200 }),
      getTestManagementProviders: vi.fn().mockResolvedValue([]),
    };
    render(
      <E2eConfigForm
        apiClient={client as unknown as ApiClient}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'Backend' }));
    fireEvent.change(screen.getByLabelText('URL base'), {
      target: { value: 'http://localhost:3000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Iniciar t.nel no meu computador/ }));
    await waitFor(() =>
      expect(client.checkE2eTunnel).toHaveBeenCalledWith('https://api.trycloudflare.com', {
        accessClientId: 'id',
        accessClientSecret: 'secret',
      }),
    );
    expect(localTunnelBridge.start).toHaveBeenCalledWith('http://localhost:3000');
    expect(screen.getByLabelText<HTMLInputElement>('URL base').value).toBe(
      'https://api.trycloudflare.com',
    );
  });
});
