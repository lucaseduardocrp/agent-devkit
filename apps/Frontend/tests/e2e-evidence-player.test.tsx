import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eEvidencePlayer } from '../src/features/e2e/E2eEvidencePlayer.js';
import type { E2eTestDetail } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const steps = [1, 2, 3].map((position) => ({
  position,
  title: `Step ${position}`,
  status: 'passed' as const,
  durationMs: 1000,
  error: null,
  hasScreenshot: true,
}));

function detail(overrides: Partial<E2eTestDetail> = {}): E2eTestDetail {
  return {
    id: 't1',
    hasVideo: true,
    stepResults: steps,
    creation: {
      id: 'c1',
      name: 'adk',
      mode: 'frontend',
      baseUrl: 'https://agent-devkit.vercel.app/login',
      path: '/e/1',
      status: 'completed',
    },
    ...overrides,
  } as E2eTestDetail;
}

function setup(test: E2eTestDetail = detail(), screenshot?: () => Promise<Blob>) {
  const client = {
    getE2eTestVideo: vi.fn().mockResolvedValue(new Blob(['video'])),
    getE2eTestVideoUrl: vi.fn().mockResolvedValue(null),
    getE2eStepScreenshot: vi.fn(
      screenshot ??
        ((_id: string, position: number) => Promise.resolve(new Blob([`s${position}`]))),
    ),
  };
  const view = render(
    <E2eEvidencePlayer apiClient={client as unknown as ApiClient} test={test} version="v1" />,
  );
  return { client, view };
}

let created = 0;
beforeEach(() => {
  created = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++created}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.useRealTimers());

const counter = (view: ReturnType<typeof setup>['view']) =>
  view.getByTestId('e2e-player-counter').textContent;

describe('E2eEvidencePlayer', () => {
  it('shows the run like a browser session, with the video first when there is one', async () => {
    const { view } = setup();
    expect(view.getByText('adk')).toBeInTheDocument();
    expect(view.getByText('agent-devkit.vercel.app')).toBeInTheDocument();
    expect(view.getByText('Carregando vídeo…')).toBeInTheDocument();
    expect(await view.findByTestId('e2e-video')).toBeInTheDocument();
    expect(counter(view)).toBe('1 / 3');
    expect(view.getByRole('button', { name: 'Vídeo da execução' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The steps are driven in the step view; the video has its own controls.
    expect(view.getByRole('button', { name: 'Reproduzir' })).toHaveProperty('disabled', true);
    expect(view.getByRole('button', { name: 'Próximo passo' })).toHaveProperty('disabled', true);
  });

  it('flips through the screenshots of the steps', async () => {
    const { view, client } = setup();
    fireEvent.click(view.getByRole('button', { name: 'Passos (capturas de tela)' }));
    const image = await view.findByTestId('e2e-player-image');
    expect(image).toHaveAttribute('alt', 'Captura do passo 1');
    expect(client.getE2eStepScreenshot).toHaveBeenCalledTimes(3);
    expect(view.getByRole('button', { name: 'Passo anterior' })).toHaveProperty('disabled', true);
    fireEvent.click(view.getByRole('button', { name: 'Próximo passo' }));
    expect(counter(view)).toBe('2 / 3');
    expect(view.getByTestId('e2e-player-image')).toHaveAttribute('alt', 'Captura do passo 2');
    fireEvent.click(view.getByRole('button', { name: 'Próximo passo' }));
    expect(view.getByRole('button', { name: 'Próximo passo' })).toHaveProperty('disabled', true);
    fireEvent.click(view.getByRole('button', { name: 'Passo anterior' }));
    expect(counter(view)).toBe('2 / 3');
  });

  it('plays the steps by itself, stops on the last one and plays again from the start', async () => {
    vi.useFakeTimers();
    const { view } = setup(detail({ hasVideo: false }));
    await act(() => vi.advanceTimersByTimeAsync(10));
    fireEvent.click(view.getByRole('button', { name: 'Reproduzir' }));
    expect(view.getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(counter(view)).toBe('2 / 3');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(counter(view)).toBe('3 / 3');
    expect(view.getByRole('button', { name: 'Reproduzir' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Reproduzir' }));
    expect(counter(view)).toBe('1 / 3');
    fireEvent.click(view.getByRole('button', { name: 'Pausar' }));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(counter(view)).toBe('1 / 3');
  });

  it('releases a video that arrives after the player is gone', async () => {
    let arrive!: (blob: Blob) => void;
    const late = new Promise<Blob>((resolve) => (arrive = resolve));
    const client = {
      getE2eTestVideo: vi.fn().mockReturnValue(late),
      getE2eTestVideoUrl: vi.fn().mockResolvedValue(null),
      getE2eStepScreenshot: vi.fn().mockResolvedValue(new Blob(['s'])),
    };
    const view = render(
      <E2eEvidencePlayer apiClient={client as unknown as ApiClient} test={detail()} version="v1" />,
    );
    // The recording is being downloaded when the player goes away.
    await act(async () => undefined);
    view.unmount();
    await act(async () => arrive(new Blob(['late'], { type: 'video/mp4' })));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });

  it('cycles the speed, faster playback and the speed of the video', async () => {
    vi.useFakeTimers();
    const { view } = setup();
    await act(() => vi.advanceTimersByTimeAsync(10));
    const video = view.getByTestId('e2e-video') as HTMLVideoElement;
    const speed = (value: string) => view.getByRole('button', { name: `Velocidade: ${value}×` });
    fireEvent.click(speed('1'));
    expect(video.playbackRate).toBe(1.5);
    fireEvent.click(speed('1.5'));
    expect(video.playbackRate).toBe(2);
    fireEvent.click(speed('2'));
    expect(video.playbackRate).toBe(0.5);
    fireEvent.click(speed('0.5'));
    expect(video.playbackRate).toBe(1);

    fireEvent.click(view.getByRole('button', { name: 'Passos (capturas de tela)' }));
    fireEvent.click(speed('1'));
    fireEvent.click(speed('1.5'));
    fireEvent.click(view.getByRole('button', { name: 'Reproduzir' }));
    // At 2×, a step takes one second.
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(counter(view)).toBe('2 / 3');
    // Going back to the video stops the steps.
    fireEvent.click(view.getByRole('button', { name: 'Vídeo da execução' }));
    expect(view.getByRole('button', { name: 'Reproduzir' })).toHaveProperty('disabled', true);
  });

  it('opens on the steps when the run has no video, and says when a screenshot is missing', async () => {
    const { view } = setup(
      detail({ hasVideo: false }),
      (() => {
        let calls = 0;
        return () =>
          ++calls === 1 ? Promise.reject(new Error('gone')) : Promise.resolve(new Blob());
      })(),
    );
    expect(view.getByText('Carregando captura…')).toBeInTheDocument();
    expect(await view.findByText('Captura indisponível')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Vídeo da execução' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(view.getByRole('button', { name: 'Próximo passo' }));
    expect(await view.findByTestId('e2e-player-image')).toBeInTheDocument();
  });

  it('plays only the video when no step has a screenshot', async () => {
    const { view } = setup(detail({ stepResults: [] }));
    expect(counter(view)).toBe('–');
    expect(view.getByRole('button', { name: 'Passos (capturas de tela)' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(await view.findByTestId('e2e-video')).toBeInTheDocument();
  });

  it('keeps an address it cannot parse as it is and frees the screenshots on unmount', async () => {
    const test = detail();
    const { view, client } = setup({
      ...test,
      creation: { ...test.creation, baseUrl: 'not a url' },
      hasVideo: false,
    });
    expect(view.getByText('not a url')).toBeInTheDocument();
    await view.findByTestId('e2e-player-image');
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(client.getE2eStepScreenshot).toHaveBeenCalledTimes(3);
  });

  it('ignores screenshots that fail after the player is gone', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const { view } = setup(
      detail({ hasVideo: false, stepResults: steps.slice(0, 1) }),
      () => new Promise<Blob>((_resolve, reject) => (fail = reject)),
    );
    view.unmount();
    await act(async () => fail(new Error('aborted')));
    expect(created).toBe(0);
  });
});
