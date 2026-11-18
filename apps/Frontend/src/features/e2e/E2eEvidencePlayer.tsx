import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import type { E2eTestDetail } from './e2e-types.js';

/** Playback speeds the player cycles through. */
const PLAYER_SPEEDS = [1, 1.5, 2, 0.5] as const;
/** How long a step stays on screen at 1×. */
const STEP_MS = 2000;

type Mode = 'steps' | 'video';

export function Placeholder({
  icon,
  text,
  bare = false,
}: {
  readonly icon: string;
  readonly text: string;
  /** Fills its parent instead of sizing itself (inside the player). */
  readonly bare?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-sm text-[var(--text-muted)]',
        bare
          ? 'h-full w-full'
          : 'mx-auto aspect-video w-full max-w-2xl rounded-md bg-[var(--surface-0)]',
      )}
    >
      <i className={cn('ti text-3xl', icon)} aria-hidden="true" />
      {text}
    </div>
  );
}

/** Where a recording is: `temporary` is an object URL that is released when the video goes. */
export interface VideoSource {
  readonly url: string;
  readonly type: string;
  readonly temporary?: boolean;
}

/** The recording of the test; fills the player's screen. */
function TestVideo({
  apiClient,
  testId,
  version,
  rate,
}: {
  readonly apiClient: ApiClient;
  readonly testId: string;
  readonly version: string;
  readonly rate: number;
}) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<VideoSource> => {
      // Object storage: the player streams straight from a signed URL (no API download).
      const signed = await apiClient.getE2eTestVideoUrl(testId, signal);
      if (signed) return { url: signed.url, type: signed.mimeType };
      const blob = await apiClient.getE2eTestVideo(testId, signal);
      return { url: URL.createObjectURL(blob), type: blob.type, temporary: true };
    },
    [apiClient, testId],
  );
  return <RecordedVideo load={load} name={testId} version={version} rate={rate} />;
}

/** A recording that fills the player's screen, at the speed asked for. */
export function RecordedVideo({
  load,
  name,
  version,
  rate,
}: {
  /** Finds the recording; it must keep its identity while the same video is shown. */
  readonly load: (signal: AbortSignal) => Promise<VideoSource>;
  /** Names the file when the browser cannot play the video and offers it for download. */
  readonly name: string;
  readonly version: string;
  readonly rate: number;
}) {
  const { t } = useI18n();
  const [video, setVideo] = useState<VideoSource | null>(null);
  const [failed, setFailed] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const element = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let temporary: string | null = null;
    setVideo(null);
    setFailed(false);
    setUnplayable(false);
    load(controller.signal)
      .then((source) => {
        if (source.temporary) temporary = source.url;
        // A video that arrives after the player moved on is released at once.
        if (controller.signal.aborted) {
          if (temporary) URL.revokeObjectURL(temporary);
          return;
        }
        setVideo(source);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (temporary) URL.revokeObjectURL(temporary);
    };
  }, [load, version]);

  useEffect(() => {
    if (element.current) element.current.playbackRate = rate;
  }, [rate, video]);

  if (failed) return <Placeholder bare icon="ti-video-off" text={t('e2e.videoFailed')} />;
  if (!video)
    return <Placeholder bare icon="ti-loader-2 animate-spin" text={t('e2e.videoLoading')} />;
  // Without this, a browser that cannot decode the file shows a silent grey player.
  if (unplayable)
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-[var(--text-muted)]">
        <i className="ti ti-video-off text-3xl" aria-hidden="true" />
        {t('e2e.videoUnplayable')}
        <a
          href={video.url}
          download={`${name}.${video.type.includes('mp4') ? 'mp4' : 'webm'}`}
          className="text-[var(--text-accent)] underline-offset-4 hover:underline"
        >
          {t('e2e.downloadVideo')}
        </a>
      </div>
    );
  return (
    <video
      ref={element}
      src={video.url}
      controls
      playsInline
      onError={() => setUnplayable(true)}
      className="block h-full w-full bg-black object-contain"
      data-testid="e2e-video"
    />
  );
}

/** Loads the picture of every step once, keeping them for the player to flip through. */
function useStepImages(
  load: (index: number, signal: AbortSignal) => Promise<Blob>,
  keys: readonly string[],
  version: string,
) {
  const [images, setImages] = useState<Record<number, string | null>>({});
  const loader = useRef(load);
  loader.current = load;
  const key = keys.join(',');

  useEffect(() => {
    const controller = new AbortController();
    const created: string[] = [];
    setImages({});
    keys.forEach((_, index) => {
      loader
        .current(index, controller.signal)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          created.push(url);
          setImages((current) => ({ ...current, [index]: url }));
        })
        .catch(() => {
          if (!controller.signal.aborted) setImages((current) => ({ ...current, [index]: null }));
        });
    });
    return () => {
      controller.abort();
      created.forEach((url) => URL.revokeObjectURL(url));
    };
    // The key stands for the steps: a new array with the same steps must not reload them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  return images;
}

/** One screen of the player: what the picture shows and what was done to get there. */
export interface PlayerStep {
  /** Tells the step apart; the pictures are loaded again when the keys change. */
  readonly key: string;
  readonly alt: string;
  /** The address the browser was on; the player's own address when absent. */
  readonly address?: string;
  /** What was done and why, shown under the screen. */
  readonly note?: string;
  /** Which browser did it, when several worked at once. */
  readonly badge?: string;
}

export interface E2eStepPlayerProps {
  /** Name shown first in the address bar. */
  readonly name: string;
  /** What the address bar shows when a step has no address of its own. */
  readonly address: string;
  readonly steps: readonly PlayerStep[];
  /** The picture of a step, by its position among the steps (0-based). */
  readonly loadImage: (index: number, signal: AbortSignal) => Promise<Blob>;
  readonly version: string;
  /** The recording, at the speed asked for; without it there is no switch to a video. */
  readonly renderVideo?: (rate: number) => ReactNode;
}

/**
 * The work of a browser like a session you can watch: an address bar, the screen (the recording or
 * the picture of each step, with the cursor and the caption of what was done) and a player to
 * step through it, with speed and a switch between the steps and the video.
 */
export function E2eStepPlayer({
  name,
  address,
  steps,
  loadImage,
  version,
  renderVideo,
}: E2eStepPlayerProps) {
  const { t } = useI18n();
  const total = steps.length;
  const [mode, setMode] = useState<Mode>(renderVideo ? 'video' : 'steps');
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof PLAYER_SPEEDS)[number]>(1);
  const images = useStepImages(
    loadImage,
    steps.map((step) => step.key),
    version,
  );
  const current = steps[index];
  const image = current ? images[index] : undefined;
  const stepping = mode === 'steps' && total > 0;

  useEffect(() => {
    if (!playing || !stepping) return;
    const timer = window.setInterval(
      () => setIndex((value) => Math.min(value + 1, total - 1)),
      STEP_MS / speed,
    );
    return () => window.clearInterval(timer);
  }, [playing, stepping, speed, total]);

  // The last step ends the playback.
  useEffect(() => {
    if (playing && index >= total - 1) setPlaying(false);
  }, [playing, index, total]);

  const play = () => {
    if (playing) return setPlaying(false);
    if (index >= total - 1) setIndex(0);
    setPlaying(true);
  };
  const cycleSpeed = () =>
    setSpeed((value) => PLAYER_SPEEDS[(PLAYER_SPEEDS.indexOf(value) + 1) % PLAYER_SPEEDS.length]!);
  const choose = (next: Mode) => {
    setPlaying(false);
    setMode(next);
  };

  return (
    <div
      className="mx-auto w-full max-w-4xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
      data-testid="e2e-evidence-player"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-sm">
        <i className="ti ti-world text-[var(--text-muted)]" aria-hidden="true" />
        <span className="font-semibold text-[var(--text-primary)]">{name}</span>
        <span className="truncate text-[var(--text-secondary)]" data-testid="e2e-player-address">
          {mode === 'steps' && current?.address ? current.address : address}
        </span>
      </div>

      <div className="aspect-video w-full bg-black">
        {mode === 'video' && renderVideo ? (
          renderVideo(speed)
        ) : image ? (
          <img
            src={image}
            alt={current!.alt}
            className="h-full w-full object-contain"
            data-testid="e2e-player-image"
          />
        ) : image === null ? (
          <Placeholder bare icon="ti-photo-off" text={t('e2e.screenshotFailed')} />
        ) : (
          <Placeholder bare icon="ti-loader-2 animate-spin" text={t('e2e.playerLoading')} />
        )}
      </div>

      {mode === 'steps' && (current?.note || current?.badge) && (
        <p
          className="flex items-start gap-2 border-t border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)]"
          data-testid="e2e-player-note"
        >
          {current.badge && (
            <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-primary)]">
              {current.badge}
            </span>
          )}
          {current.note && <span className="min-w-0 break-words">{current.note}</span>}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('e2e.playerPrevious')}
            disabled={!stepping || index === 0}
            onClick={() => setIndex(index - 1)}
          >
            <i className="ti ti-player-skip-back-filled" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(playing ? 'e2e.playerPause' : 'e2e.playerPlay')}
            disabled={!stepping}
            onClick={play}
          >
            <i
              className={cn('ti', playing ? 'ti-player-pause-filled' : 'ti-player-play-filled')}
              aria-hidden="true"
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('e2e.playerNext')}
            disabled={!stepping || index >= total - 1}
            onClick={() => setIndex(index + 1)}
          >
            <i className="ti ti-player-skip-forward-filled" aria-hidden="true" />
          </Button>
        </div>
        <span
          className="font-mono text-sm tabular-nums text-[var(--text-secondary)]"
          data-testid="e2e-player-counter"
        >
          {total > 0 ? `${index + 1} / ${total}` : '–'}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('e2e.playerSpeed', { speed })}
            onClick={cycleSpeed}
          >
            {speed}×
          </Button>
          <div className="flex gap-1 rounded-lg bg-[var(--surface-2)] p-1" role="group">
            <Button
              variant={mode === 'steps' ? 'secondary' : 'ghost'}
              size="icon"
              aria-label={t('e2e.playerSteps')}
              aria-pressed={mode === 'steps'}
              disabled={total === 0}
              onClick={() => choose('steps')}
            >
              <i className="ti ti-pointer" aria-hidden="true" />
            </Button>
            <Button
              variant={mode === 'video' ? 'secondary' : 'ghost'}
              size="icon"
              aria-label={t('e2e.playerVideo')}
              aria-pressed={mode === 'video'}
              disabled={!renderVideo}
              onClick={() => choose('video')}
            >
              <i className="ti ti-video" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function addressOf(test: E2eTestDetail): string {
  try {
    return new URL(test.creation.baseUrl).host;
  } catch {
    return test.creation.baseUrl;
  }
}

/** The evidence of a test run: its recording and the picture of each of its steps. */
export function E2eEvidencePlayer({
  apiClient,
  test,
  version,
}: {
  readonly apiClient: ApiClient;
  readonly test: E2eTestDetail;
  readonly version: string;
}) {
  const { t } = useI18n();
  const screens = test.stepResults.filter((step) => step.hasScreenshot);
  return (
    <E2eStepPlayer
      name={test.creation.name}
      address={addressOf(test)}
      steps={screens.map((step) => ({
        key: String(step.position),
        alt: t('e2e.screenshotAlt', { position: step.position }),
      }))}
      loadImage={(index, signal) =>
        apiClient.getE2eStepScreenshot(test.id, screens[index]!.position, signal)
      }
      version={version}
      {...(test.hasVideo
        ? {
            renderVideo: (rate: number) => (
              <TestVideo apiClient={apiClient} testId={test.id} version={version} rate={rate} />
            ),
          }
        : {})}
    />
  );
}
