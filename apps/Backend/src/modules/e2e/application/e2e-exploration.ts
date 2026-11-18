import type { E2eCreation } from '../domain/e2e.js';
import {
  explorationLiveKey,
  explorationPageKey,
  explorationStepKey,
  explorationVideoKey,
  MAX_EXPLORATION_STEP_SHOTS,
  explorationPrefix,
  explorationStateKey,
  type E2eExploration,
  type E2eExplorationLogEntry,
  type E2eExplorationPage,
  type E2eExplorationStatus,
  type E2eExplorationVideo,
  type NewE2eExplorationScript,
} from '../domain/e2e-insight.js';
import type { E2eArtifactStore } from './artifact-store.js';
import type { E2eExploreEvent, E2ePageSnapshot, E2eVideoTranscoder } from './e2e-runner.js';
import type { E2eExplorationAgentRef, E2eExplorationContextRef } from '../domain/e2e-insight.js';

const MAX_LOG = 400;
const MAX_PAGES = 60;
/** Frames closer than this are dropped: the page that follows the exploration polls slower. */
const FRAME_INTERVAL_MS = 600;

type Creation = Pick<E2eCreation, 'workspaceId' | 'id'>;

/**
 * Keeps the script of a finished exploration; resolves with where it was kept, or null when it
 * was not kept (a failed exploration never replaces the Source).
 */
export type ExplorationKeeper = (script: NewE2eExplorationScript) => Promise<string | null>;

/** Reads what a recorder stored; null when the run was never explored. */
export async function readExploration(
  artifacts: E2eArtifactStore,
  creation: Creation,
): Promise<E2eExploration | null> {
  const content = await artifacts.get(explorationStateKey(creation));
  if (!content) return null;
  try {
    return JSON.parse(content.toString('utf8')) as E2eExploration;
  } catch {
    return null;
  }
}

function describePage(index: number, page: E2ePageSnapshot, hasScreenshot: boolean, flow?: string) {
  const screen = page.headings[0] || page.title || page.url;
  // The dialog open over the screen is what the capture shows, so it is part of the name.
  const name = page.dialog && page.dialog !== screen ? `${screen} · ${page.dialog}` : screen;
  const summary = [...new Set([page.title, page.dialog, page.tab, ...page.headings.slice(0, 4)])]
    .filter(Boolean)
    .join(' · ');
  return {
    index,
    url: page.url,
    // The evidence of a flow is called by the flow; the screen it shows leads the summary.
    title: flow ?? name,
    summary: (flow ? `${name} · ${summary}` : summary).slice(0, 300),
    elements: page.buttons.slice(0, 8),
    hasScreenshot,
    ...(flow ? { flow } : {}),
  } satisfies E2eExplorationPage;
}

/**
 * Keeps what the agent does while it explores a site (phase, log, captured pages and the latest
 * frame of its browser) in the artifact store, so anyone watching the run can follow it. Events
 * are applied one after the other, in the order the runner reports them.
 */
export class ExplorationRecorder {
  private status: E2eExplorationStatus;
  private readonly startedAt: number;
  private signedInMs: number | null = null;
  private finishedAt: number | null = null;
  private error: string | null = null;
  private hasLiveFrame = false;
  private stepShots = 0;
  private lastFrameAt = 0;
  private readonly pages: E2eExplorationPage[] = [];
  private readonly log: E2eExplorationLogEntry[] = [];
  private readonly videos: E2eExplorationVideo[] = [];
  private savedTo: string | null = null;
  private saveError: string | null = null;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly artifacts: E2eArtifactStore,
    private readonly creation: Creation,
    signsIn: boolean,
    private readonly now: () => number,
    private readonly description: string | null,
    private readonly keep: ExplorationKeeper | null,
    private readonly source: boolean,
    private readonly context: readonly E2eExplorationContextRef[],
    private readonly transcoder: E2eVideoTranscoder | null,
    private readonly agent: E2eExplorationAgentRef | null,
  ) {
    this.startedAt = now();
    this.status = signsIn ? 'signing_in' : 'exploring';
  }

  /**
   * Replaces whatever an earlier exploration of the run left behind. With `keep`, the script of
   * the exploration is also kept in the database when it ends; that copy is never replaced.
   */
  static async start(
    artifacts: E2eArtifactStore,
    creation: Creation,
    signsIn: boolean,
    now: () => number = Date.now,
    options: {
      readonly description?: string | null;
      readonly keep?: ExplorationKeeper | null;
      /** The exploration replaces the Source of the workspace. */
      readonly source?: boolean;
      /** The PBIs, issues and Brain documents the agent explores with. */
      readonly context?: readonly E2eExplorationContextRef[];
      /** Converts the recordings to MP4, which every browser plays. */
      readonly transcoder?: E2eVideoTranscoder | null;
      /** The agent the user chose to explore; the run's own agent when omitted. */
      readonly agent?: E2eExplorationAgentRef | null;
    } = {},
  ): Promise<ExplorationRecorder> {
    await artifacts.removePrefix(explorationPrefix(creation));
    const recorder = new ExplorationRecorder(
      artifacts,
      creation,
      signsIn,
      now,
      options.description?.trim() || null,
      options.keep ?? null,
      options.source ?? false,
      options.context ?? [],
      options.transcoder ?? null,
      options.agent ?? null,
    );
    await recorder.save();
    return recorder;
  }

  /** Handed to the runner; never throws and never makes the exploration wait. */
  readonly onProgress = (event: E2eExploreEvent): void => {
    this.pending = this.pending
      .then(() => this.apply(event))
      .catch((error: unknown) => console.error('[E2eExploration] Could not record:', error));
  };

  async finish(): Promise<void> {
    await this.close('ready', null);
  }

  async fail(error: string): Promise<void> {
    await this.close('failed', error);
  }

  private async close(status: E2eExplorationStatus, error: string | null): Promise<void> {
    await this.pending;
    this.status = status;
    this.error = error;
    this.finishedAt = this.now();
    this.hasLiveFrame = false;
    await this.artifacts.removePrefix(explorationLiveKey(this.creation));
    await this.save();
    await this.keepScript();
  }

  /**
   * Never throws: the run's own state is already saved. Where the script went (or why it could
   * not be kept) is added to that state.
   */
  private async keepScript(): Promise<void> {
    if (!this.keep || this.finishedAt === null) return;
    try {
      this.savedTo = await this.keep({
        workspaceId: this.creation.workspaceId,
        creationId: this.creation.id,
        description: this.description,
        status: this.status === 'failed' ? 'failed' : 'ready',
        error: this.error,
        signedInMs: this.signedInMs,
        script: this.log,
        // Screenshots belong to the run and are replaced by its next exploration.
        pages: this.pages.map((page) => ({ ...page, hasScreenshot: false })),
        startedAt: new Date(this.startedAt),
        finishedAt: new Date(this.finishedAt),
      });
    } catch (error) {
      console.error('[E2eExploration] Could not keep the script:', error);
      this.saveError = error instanceof Error ? error.message : String(error);
    }
    await this.save().catch((error: unknown) =>
      console.error('[E2eExploration] Could not record:', error),
    );
  }

  private async apply(event: E2eExploreEvent): Promise<void> {
    if (event.kind === 'frame') {
      const now = this.now();
      if (now - this.lastFrameAt < FRAME_INTERVAL_MS) return;
      this.lastFrameAt = now;
      await this.artifacts.put(explorationLiveKey(this.creation), event.image);
      if (this.hasLiveFrame) return;
      this.hasLiveFrame = true;
    } else if (event.kind === 'video') {
      await this.keepVideo(event.worker, event.video);
    } else if (event.kind === 'phase') {
      this.status = event.phase;
    } else if (event.kind === 'log') {
      if (event.action === 'sign_in') this.signedInMs = this.now() - this.startedAt;
      if (this.log.length < MAX_LOG) {
        // The picture of the action, found later by the position of the action in the log.
        const kept =
          event.screenshot && this.stepShots < MAX_EXPLORATION_STEP_SHOTS
            ? await this.keepStepShot(this.log.length + 1, event.screenshot)
            : false;
        this.log.push({
          atMs: this.now() - this.startedAt,
          action: event.action,
          target: event.target,
          result: event.result,
          ...(event.reason ? { reason: event.reason } : {}),
          ...(kept ? { hasScreenshot: true } : {}),
          ...(event.url ? { url: event.url } : {}),
          ...(event.worker ? { worker: event.worker } : {}),
        });
      }
    } else {
      if (this.pages.length >= MAX_PAGES) return;
      const index = this.pages.length + 1;
      if (event.screenshot)
        await this.artifacts.put(explorationPageKey(this.creation, index), event.screenshot);
      this.pages.push(describePage(index, event.page, Boolean(event.screenshot), event.flow));
    }
    await this.save();
  }

  /** A recording that cannot be stored only costs the video: the exploration goes on. */
  private async keepVideo(worker: number, video: Uint8Array): Promise<void> {
    try {
      const mp4 = await this.transcoder?.toMp4(video);
      const mimeType = mp4 ? 'video/mp4' : 'video/webm';
      await this.artifacts.put(explorationVideoKey(this.creation, worker, mimeType), mp4 ?? video);
      this.videos.push({ worker, mimeType });
      this.videos.sort((a, b) => a.worker - b.worker);
    } catch (error) {
      console.error('[E2eExploration] Could not keep a video:', error);
    }
  }

  /** False when the picture could not be stored: the step is then a line of the log only. */
  private async keepStepShot(index: number, image: Uint8Array): Promise<boolean> {
    try {
      await this.artifacts.put(explorationStepKey(this.creation, index), image);
      this.stepShots += 1;
      return true;
    } catch (error) {
      console.error('[E2eExploration] Could not keep a step picture:', error);
      return false;
    }
  }

  private async save(): Promise<void> {
    const state: E2eExploration = {
      status: this.status,
      description: this.description,
      ...(this.source ? { source: true } : {}),
      ...(this.context.length ? { context: this.context } : {}),
      ...(this.agent ? { agent: this.agent } : {}),
      savedTo: this.savedTo,
      saveError: this.saveError,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      signedInMs: this.signedInMs,
      finishedAt: this.finishedAt === null ? null : new Date(this.finishedAt).toISOString(),
      error: this.error,
      pages: this.pages,
      log: this.log,
      hasLiveFrame: this.hasLiveFrame,
      ...(this.videos.length ? { videos: this.videos } : {}),
    };
    await this.artifacts.put(
      explorationStateKey(this.creation),
      Buffer.from(JSON.stringify(state), 'utf8'),
    );
  }
}
