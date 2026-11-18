import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import { FieldLabel } from '../../components/ui/help-tooltip.js';
import { MarkdownEditor } from '../shared/markdown-editor/MarkdownEditor.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import { E2eImage } from './E2eImage.js';
import { E2eStepPlayer, RecordedVideo, type VideoSource } from './E2eEvidencePlayer.js';
import { E2eExplorationCodePanel } from './E2eExplorationCode.js';
import {
  E2eExploreContext,
  NO_CONTEXT,
  contextCount,
  contextRequests,
  type ExploreContextSelection,
} from './E2eExploreContext.js';
import {
  e2eImagePath,
  formatDuration,
  isCreationActive,
  isExplorationActive,
  type E2eCreationDetail,
  type E2eExploration as Exploration,
  type E2eExplorationLogEntry,
  type E2eExplorationVideo,
} from './e2e-types.js';

const POLL_MS = 1500;
/** What the API accepts of the description of an exploration. */
const MAX_DESCRIPTION = 2000;

type StepState = 'done' | 'active' | 'todo';
type Tab = 'pages' | 'log';
type View = 'overview' | 'code';

export const EXPLORATION_ACTION_LABELS: Record<E2eExplorationLogEntry['action'], TranslationKey> = {
  navigate: 'e2e.exploreActionNavigate',
  sign_in: 'e2e.exploreActionSignIn',
  click: 'e2e.exploreActionClick',
  type: 'e2e.exploreActionType',
  select: 'e2e.exploreActionSelect',
  scroll: 'e2e.exploreActionScroll',
  press: 'e2e.exploreActionPress',
  note: 'e2e.exploreActionNote',
};

const NOTE_TEXTS: Record<string, TranslationKey> = {
  sign_in_no_account: 'e2e.exploreNoteSignInNoAccount',
  sign_in_no_form: 'e2e.exploreNoteSignInNoForm',
  sign_in_failed: 'e2e.exploreNoteSignInFailed',
  not_rendered: 'e2e.exploreNoteNotRendered',
  stopped_no_targets: 'e2e.exploreNoteNoTargets',
  stopped_steps: 'e2e.exploreNoteSteps',
  stopped_pages: 'e2e.exploreNotePages',
  stopped_time: 'e2e.exploreNoteTime',
  agent_done: 'e2e.exploreNoteAgentDone',
  agent_failed: 'e2e.exploreNoteAgentFailed',
  agent_stuck: 'e2e.exploreNoteAgentStuck',
  agent_unavailable: 'e2e.exploreNoteAgentUnavailable',
  agent_plan: 'e2e.exploreNoteAgentPlan',
};

/** The steps of the exploration that kept a picture, with their position in the log. */
function replayOf(exploration: Exploration) {
  return exploration.log.flatMap((entry, index) =>
    entry.hasScreenshot ? [{ entry, position: index + 1 }] : [],
  );
}

/** The address of a step as a browser shows it: without the protocol. */
function shortAddress(url: string): string {
  try {
    const { host, pathname, search } = new URL(url);
    return `${host}${pathname === '/' ? '' : pathname}${search}`;
  } catch {
    return url;
  }
}

/** The recording of the browsers of the exploration; with several, one is chosen at a time. */
function ExplorationVideo({
  apiClient,
  creationId,
  videos,
  version,
  rate,
}: {
  readonly apiClient: ApiClient;
  readonly creationId: string;
  readonly videos: readonly E2eExplorationVideo[];
  readonly version: string;
  readonly rate: number;
}) {
  const { t } = useI18n();
  const [worker, setWorker] = useState(videos[0]!.worker);
  const load = useCallback(
    async (signal: AbortSignal): Promise<VideoSource> => {
      const blob = await apiClient.getE2eExplorationVideo(creationId, worker, signal);
      return { url: URL.createObjectURL(blob), type: blob.type, temporary: true };
    },
    [apiClient, creationId, worker],
  );
  return (
    <div className="relative h-full w-full">
      <RecordedVideo load={load} name={`exploration-${worker}`} version={version} rate={rate} />
      {videos.length > 1 && (
        <div
          className="absolute left-2 top-2 flex gap-1 rounded-md bg-black/60 p-1"
          role="group"
          aria-label={t('e2e.exploreVideoBrowsers')}
        >
          {videos.map((video) => (
            <Button
              key={video.worker}
              variant={video.worker === worker ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={video.worker === worker}
              onClick={() => setWorker(video.worker)}
            >
              {t('e2e.exploreReplayBrowser', { worker: video.worker })}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Replays what the agent did: one picture per action, with the cursor and the reason. */
function ExplorationReplay(props: {
  readonly apiClient: ApiClient;
  readonly creationId: string;
  readonly name: string;
  readonly host: string;
  readonly exploration: Exploration;
}) {
  const { t } = useI18n();
  const steps = replayOf(props.exploration);
  const { videos } = props.exploration;
  return (
    <E2eStepPlayer
      name={props.name}
      address={props.host}
      version={props.exploration.startedAt}
      steps={steps.map(({ entry, position }) => ({
        key: String(position),
        alt: t('e2e.screenshotAlt', { position }),
        note: [
          `${t(EXPLORATION_ACTION_LABELS[entry.action])} ${explorationTarget(entry, t)}`,
          entry.reason,
        ]
          .filter(Boolean)
          .join(' — '),
        ...(entry.url ? { address: shortAddress(entry.url) } : {}),
        ...(entry.worker ? { badge: t('e2e.exploreReplayBrowser', { worker: entry.worker }) } : {}),
      }))}
      loadImage={(index, signal) =>
        props.apiClient.getE2eImage(
          e2eImagePath.explorationStep(props.creationId, steps[index]!.position),
          signal,
        )
      }
      {...(videos?.length
        ? {
            renderVideo: (rate: number) => (
              <ExplorationVideo
                apiClient={props.apiClient}
                creationId={props.creationId}
                videos={videos}
                version={props.exploration.startedAt}
                rate={rate}
              />
            ),
          }
        : {})}
    />
  );
}

/** What an entry of the log targets; a note carries a code its reason is looked up by. */
export function explorationTarget(
  entry: Pick<E2eExplorationLogEntry, 'action' | 'target'>,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (entry.action !== 'note') return entry.target;
  const [code = '', count = '0'] = entry.target.split(':');
  const key = NOTE_TEXTS[code];
  return key ? t(key, { count }) : entry.target;
}

const TITLES: Record<Exploration['status'], TranslationKey> = {
  signing_in: 'e2e.exploreTitleSigning',
  exploring: 'e2e.exploreTitleExploring',
  ready: 'e2e.exploreTitleReady',
  failed: 'e2e.exploreTitleFailed',
};

const HINTS: Record<Exclude<Exploration['status'], 'ready'>, TranslationKey> = {
  signing_in: 'e2e.exploreHintSigning',
  exploring: 'e2e.exploreHintExploring',
  failed: 'e2e.exploreHintFailed',
};

function Step({ state, label }: { readonly state: StepState; readonly label: string }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 text-sm font-medium',
        'sm:[&:not(:last-child)]:after:ml-4 sm:[&:not(:last-child)]:after:block sm:[&:not(:last-child)]:after:h-px sm:[&:not(:last-child)]:after:w-10 sm:[&:not(:last-child)]:after:bg-[var(--border-strong)] sm:[&:not(:last-child)]:after:content-[""]',
        state === 'todo' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]',
      )}
      data-state={state}
      aria-current={state === 'active' ? 'step' : undefined}
    >
      <i
        className={cn(
          'ti text-base',
          state === 'done'
            ? 'ti-circle-check-filled text-emerald-400'
            : state === 'active'
              ? 'ti-loader-2 animate-spin text-sky-400'
              : 'ti-circle',
        )}
        aria-hidden="true"
      />
      <span>{label}</span>
    </li>
  );
}

/** Placeholder with the shape of the page: header, steps, captured pages and the side panel. */
function ExplorationSkeleton() {
  return (
    <div className="flex flex-col gap-5" data-testid="e2e-exploration-skeleton" aria-hidden="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-80 max-w-full rounded-md" />
          <Skeleton className="h-4 w-[32rem] max-w-full rounded-md" />
        </div>
        <div className="flex shrink-0 gap-2">
          <Skeleton className="h-10 w-36 rounded-md" />
          <Skeleton className="h-10 w-36 rounded-md" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
        {[28, 24, 32].map((width, index) => (
          <div key={index} className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 rounded-md" style={{ width: width * 4 }} />
            {index < 2 && <Skeleton className="ml-2 hidden h-px w-10 sm:block" />}
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="self-start rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-40 rounded-md" />
            <Skeleton className="h-5 w-7 rounded" />
          </div>
          <Skeleton className="mt-2 h-4 w-96 max-w-full rounded-md" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="min-w-0">
                <Skeleton className="aspect-video w-full rounded" />
                <Skeleton className="mt-2 h-4 w-3/4 rounded-md" />
                <Skeleton className="mt-1.5 h-3 w-full rounded-md" />
              </div>
            ))}
          </div>
        </div>

        <div className="self-start rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <div className="flex gap-2 border-b border-[var(--border)] px-2 py-2">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
          <div className="flex flex-col gap-4 p-3">
            {Array.from({ length: 2 }).map((_, index) => (
              <div
                key={index}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3"
              >
                <Skeleton className="h-3 w-3/4 rounded-md" />
                <Skeleton className="mt-3 h-3 w-full rounded-md" />
                <Skeleton className="mt-1.5 h-3 w-5/6 rounded-md" />
                <div className="mt-3 flex flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-2.5">
                  <Skeleton className="h-3 w-2/3 rounded-md" />
                  <Skeleton className="h-3 w-1/2 rounded-md" />
                  <Skeleton className="h-3 w-3/5 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface E2eExplorationProps {
  readonly apiClient: ApiClient;
  readonly creationId: string;
  readonly isReadOnly?: boolean;
  readonly onBack: () => void;
  /** Opens the run once its tests are planned; without it there is no button for that. */
  readonly onOpenRun?: () => void;
  /** Only follows the exploration (the Source's): no instructions, re-exploring or tests. */
  readonly following?: boolean;
}

/**
 * Follows the agent while it gets to know the application of a run: it signs in with the test
 * account, browses the site and then plans the tests. Afterwards, shows the pages it captured.
 */
export function E2eExploration({
  apiClient,
  creationId,
  isReadOnly = false,
  onBack,
  onOpenRun,
  following = false,
}: E2eExplorationProps) {
  const { t } = useI18n();
  const [creation, setCreation] = useState<E2eCreationDetail | null>(null);
  /** Undefined until loaded; null when the run was never explored. */
  const [exploration, setExploration] = useState<Exploration | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [description, setDescription] = useState('');
  /** Text being edited in the instructions modal; only kept when saved. */
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  /** The PBIs, issues and Brain documents the next exploration reads. */
  const [context, setContext] = useState<ExploreContextSelection>(NO_CONTEXT);
  const [contextDraft, setContextDraft] = useState<ExploreContextSelection>(NO_CONTEXT);
  /** Null until the instructions are first opened; empty when the list cannot be loaded. */
  const [agents, setAgents] = useState<readonly CustomAgentDto[] | null>(null);
  /** The agent chosen to explore; empty while the agent of the run explores. */
  const [agentId, setAgentId] = useState('');
  const [agentDraft, setAgentDraft] = useState('');
  const closeInstructions = () => setEditing(false);
  const [tab, setTab] = useState<Tab>('pages');
  const [view, setView] = useState<View>('overview');
  /** Counts the refreshes, so the live frame is loaded again on each one. */
  const [tick, setTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const logLength = exploration?.log.length;

  const load = useCallback(async () => {
    try {
      const [run, state] = await Promise.all([
        apiClient.getE2eCreation(creationId),
        apiClient.getE2eExploration(creationId),
      ]);
      setCreation(run);
      setExploration(state);
      setTick((value) => value + 1);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.loadFailed'));
    }
  }, [apiClient, creationId, t]);
  useEffect(() => void load(), [load]);

  const exploring = isExplorationActive(exploration ?? null);
  // After the exploration the run goes on to plan its tests: keep following until it has them.
  const planning = Boolean(creation && isCreationActive(creation.status) && !creation.tests.length);
  const polling = exploring || planning;
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, polling]);

  // The newest step of the agent stays in view while the log grows.
  useEffect(() => {
    if (tab === 'log' && panelRef.current)
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
  }, [tab, logLength]);

  // The agents are only needed to choose one: they load when the instructions are first opened.
  useEffect(() => {
    if (!editing || agents) return;
    let active = true;
    void apiClient
      .getAgents()
      .catch(() => [] as readonly CustomAgentDto[])
      .then((list) => {
        if (active) setAgents(list);
      });
    return () => {
      active = false;
    };
  }, [apiClient, editing, agents]);

  const explore = async () => {
    setStarting(true);
    setError(null);
    try {
      setExploration(
        await apiClient.exploreE2eCreation(creationId, {
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(contextCount(context) ? { context: contextRequests(context) } : {}),
          ...(agentId ? { agentId } : {}),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.actionFailed'));
    } finally {
      setStarting(false);
    }
  };

  const back = (
    <div>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <i className="ti ti-chevron-left" aria-hidden="true" />
        {t('e2e.back')}
      </Button>
    </div>
  );

  if (!creation || exploration === undefined)
    return (
      <div className="flex flex-col gap-4" data-testid="e2e-exploration">
        {back}
        {error ? (
          <div className="flex flex-col items-start gap-3" role="alert">
            <p className="text-sm text-red-400">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('e2e.retry')}
            </Button>
          </div>
        ) : (
          <ExplorationSkeleton />
        )}
      </div>
    );

  const host = creation.baseUrl.replace(/^https?:\/\//, '');
  const planned = creation.tests.length;
  // What the select shows: the choice, or the first agent when the chosen one is gone.
  const pickable = agents ?? [];
  const chosenAgent = pickable.find((item) => item.id === agentDraft) ?? pickable[0];
  // The API takes at most this much text; Markdown marks count too, so the editor cannot cut it.
  const draftTooLong = draft.trim().length > MAX_DESCRIPTION;
  const canExplore = !isReadOnly && !polling && !following && creation.mode === 'frontend';
  const signStep: StepState | null =
    exploration?.signedInMs != null
      ? 'done'
      : exploration?.status === 'signing_in'
        ? 'active'
        : null;
  const exploreStep: StepState =
    exploration?.status === 'ready'
      ? 'done'
      : exploration?.status === 'exploring'
        ? 'active'
        : 'todo';
  const planStep: StepState = planned ? 'done' : planning && !exploring ? 'active' : 'todo';

  return (
    <div className="flex flex-col gap-5" data-testid="e2e-exploration">
      {back}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-xl font-bold tracking-tight text-[var(--text-primary)]">
            {t(exploration ? TITLES[exploration.status] : 'e2e.exploreTitleNone', { host })}
            {exploration && exploring && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-300">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true" />
                {formatDuration(
                  Date.parse(exploration.updatedAt) - Date.parse(exploration.startedAt),
                )}
              </span>
            )}
          </h1>
          {exploration?.status !== 'ready' && (
            <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">
              {t(exploration ? HINTS[exploration.status] : 'e2e.exploreHintNone')}
            </p>
          )}
          {exploration?.saveError && (
            <p className="mt-1 max-w-3xl text-sm text-red-300" role="alert">
              {t('e2e.exploreSaveFailed', { error: exploration.saveError })}
            </p>
          )}
          {exploration?.description && (
            <p className="mt-1 max-w-3xl text-sm text-[var(--text-primary)]">
              {t('e2e.exploreScope', { description: exploration.description })}
            </p>
          )}
          {exploration?.context?.length ? (
            <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">
              {t('e2e.contextUsed', {
                items: exploration.context.map((item) => item.title).join(' · '),
              })}
            </p>
          ) : null}
          {exploration?.agent && (
            <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">
              {t('e2e.exploreAgentUsed', { name: exploration.agent.name })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {canExplore && (
            <Button
              variant="outline"
              onClick={() => {
                setDraft(description);
                setContextDraft(context);
                setAgentDraft(agentId || creation.agentId);
                setEditing(true);
              }}
            >
              <i className="ti ti-file-description" aria-hidden="true" />
              {t('e2e.exploreInstructions')}
              {(description.trim() || contextCount(context) > 0 || agentId) && (
                <span
                  className="h-2 w-2 rounded-full bg-[var(--fill-accent)]"
                  role="img"
                  aria-label={t('e2e.exploreInstructionsSet')}
                />
              )}
            </Button>
          )}
          {canExplore && (
            <Button variant="outline" isLoading={starting} onClick={() => void explore()}>
              <i className="ti ti-refresh" aria-hidden="true" />
              {t(exploration ? 'e2e.exploreReexplore' : 'e2e.exploreStart')}
            </Button>
          )}
          {onOpenRun && (
            <Button onClick={onOpenRun}>
              <i className="ti ti-list-check" aria-hidden="true" />
              {t('e2e.exploreViewRun')}
            </Button>
          )}
        </div>
      </div>

      <Modal open={editing} labelledBy="explore-instructions-title" onClose={closeInstructions}>
        <div className="flex max-h-[90vh] w-[1200px] max-w-full flex-col gap-4 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6">
          <div className="flex items-center justify-between gap-4">
            <h2
              id="explore-instructions-title"
              className="text-lg font-semibold text-[var(--text-primary)]"
            >
              {t('e2e.exploreInstructions')}
            </h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('e2e.exploreInstructionsClose')}
              onClick={closeInstructions}
            >
              <i className="ti ti-x text-lg" aria-hidden="true" />
            </Button>
          </div>
          {chosenAgent && (
            <div className="flex flex-col gap-1.5" data-testid="e2e-explore-agent">
              <FieldLabel htmlFor="explore-agent" hint={t('e2e.exploreAgentHint')}>
                {t('e2e.exploreAgentLabel')}
              </FieldLabel>
              <Select
                id="explore-agent"
                value={chosenAgent.id}
                onChange={(event) => setAgentDraft(event.target.value)}
              >
                {pickable.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
              {chosenAgent.skills?.length ? (
                <p className="text-xs text-[var(--text-muted)]">
                  {t('e2e.exploreAgentSkills', {
                    skills: chosenAgent.skills.map((skill) => skill.name).join(', '),
                  })}
                </p>
              ) : null}
            </div>
          )}
          <E2eExploreContext
            apiClient={apiClient}
            value={contextDraft}
            onChange={setContextDraft}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('e2e.exploreDescriptionLabel')}</span>
            <MarkdownEditor
              scope="e2e"
              images={false}
              value={draft}
              onChange={setDraft}
              placeholder={t('e2e.exploreDescriptionPlaceholder')}
              testId="e2e-explore-description"
            />
            {draftTooLong && (
              <p className="text-xs text-red-400" role="alert">
                {t('e2e.exploreDescriptionTooLong', { max: MAX_DESCRIPTION })}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeInstructions}>
              {t('e2e.cancel')}
            </Button>
            <Button
              disabled={draftTooLong}
              onClick={() => {
                setDescription(draft);
                setContext(contextDraft);
                // Only an agent other than the run's own is sent.
                setAgentId(
                  chosenAgent && chosenAgent.id !== creation.agentId ? chosenAgent.id : '',
                );
                closeInstructions();
              }}
            >
              {t('e2e.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <ol
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3"
        aria-label={t('e2e.exploreSteps')}
      >
        {signStep && (
          <Step
            state={signStep}
            label={
              signStep === 'done'
                ? t('e2e.exploreStepSignedIn', {
                    time: formatDuration(exploration!.signedInMs!),
                  })
                : t('e2e.exploreStepSignIn')
            }
          />
        )}
        <Step state={exploreStep} label={t('e2e.exploreStepExplore')} />
        {!following && (
          <Step
            state={planStep}
            label={planned ? t('e2e.explorePlanned', { count: planned }) : t('e2e.exploreStepPlan')}
          />
        )}
      </ol>

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
      {exploration?.status === 'failed' && exploration.error && (
        <p
          className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          role="alert"
        >
          <i className="ti ti-alert-triangle mt-0.5 shrink-0" aria-hidden="true" />
          {exploration.error}
        </p>
      )}

      {exploration && !exploring && (
        <div
          className="flex gap-1 border-b border-[var(--border)]"
          role="tablist"
          aria-label={t('e2e.exploreViews')}
        >
          {(['overview', 'code'] as const).map((item) => (
            <Button
              key={item}
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={view === item}
              className={cn(
                'rounded-b-none border-b-2 border-transparent',
                view === item && 'border-[var(--fill-accent)] text-[var(--text-primary)]',
              )}
              onClick={() => setView(item)}
            >
              <i
                className={item === 'code' ? 'ti ti-code' : 'ti ti-layout-grid'}
                aria-hidden="true"
              />
              {t(item === 'code' ? 'e2e.exploreViewCode' : 'e2e.exploreViewOverview')}
            </Button>
          ))}
        </div>
      )}

      {exploration && !exploring && view === 'code' && (
        <E2eExplorationCodePanel
          apiClient={apiClient}
          creationId={creationId}
          version={exploration.startedAt}
          isReadOnly={isReadOnly}
        />
      )}

      {exploration && (exploring || view === 'overview') && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          {exploring ? (
            <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)] lg:h-[70vh]">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                <span className="inline-flex items-center gap-1.5 font-semibold text-red-400">
                  <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
                  {t('e2e.exploreLive')}
                </span>
                <span className="truncate">{host}</span>
                <span>{t('e2e.exploreFollowing', { step: exploration.log.length })}</span>
              </div>
              {exploration.hasLiveFrame ? (
                <E2eImage
                  apiClient={apiClient}
                  path={e2eImagePath.explorationLive(creationId)}
                  version={tick}
                  alt={t('e2e.exploreLiveAlt')}
                  className="aspect-video min-h-0 w-full flex-1 bg-black/30 object-contain object-top lg:aspect-auto"
                />
              ) : (
                <p className="flex aspect-video min-h-0 w-full flex-1 items-center justify-center gap-2 text-sm text-[var(--text-muted)] lg:aspect-auto">
                  <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
                  {t('e2e.exploreWaitingFrame')}
                </p>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-4">
              {replayOf(exploration).length > 0 && (
                <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <h2 className="font-semibold text-[var(--text-primary)]">
                    {t('e2e.exploreReplay')}
                  </h2>
                  <p className="mb-3 mt-1 text-sm text-[var(--text-secondary)]">
                    {t('e2e.exploreReplayHint')}
                  </p>
                  <ExplorationReplay
                    apiClient={apiClient}
                    creationId={creationId}
                    name={creation.name}
                    host={host}
                    exploration={exploration}
                  />
                </section>
              )}
              <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                <h2 className="font-semibold text-[var(--text-primary)]">
                  {t('e2e.exploreCaptured')}
                  <span className="ml-2 rounded bg-[var(--surface-2)] px-1.5 text-xs text-[var(--text-secondary)]">
                    {exploration.pages.length}
                  </span>
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  {t('e2e.exploreCapturedHint')}
                </p>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {exploration.pages.map((page) => (
                    <li key={page.index} className="min-w-0">
                      {page.hasScreenshot && (
                        <E2eImage
                          apiClient={apiClient}
                          path={e2eImagePath.explorationPage(creationId, page.index)}
                          version={exploration.startedAt}
                          alt={t('e2e.explorePageAlt', { title: page.title })}
                          className="aspect-video w-full rounded border border-[var(--border)] object-cover object-top"
                        />
                      )}
                      <p className="mt-1 truncate text-sm font-medium text-[var(--text-primary)]">
                        {page.title}
                      </p>
                      <p className="truncate font-mono text-xs text-[var(--text-muted)]">
                        {page.url}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}

          <aside
            className={cn(
              'flex max-h-[70vh] flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-1)]',
              // While live, the panel is as tall as the browser view beside it; once
              // finished it matches the captured-pages card (size containment keeps
              // its own long list from stretching the row, so it scrolls instead).
              exploring ? 'lg:h-[70vh] lg:max-h-none' : 'lg:max-h-none lg:[contain:size]',
            )}
          >
            <div className="flex gap-1 border-b border-[var(--border)] px-2 pt-2" role="tablist">
              {(['pages', 'log'] as const).map((item) => (
                <Button
                  key={item}
                  variant="ghost"
                  size="sm"
                  role="tab"
                  aria-selected={tab === item}
                  className={cn(
                    'rounded-b-none border-b-2 border-transparent',
                    tab === item && 'border-[var(--fill-accent)] text-[var(--text-primary)]',
                  )}
                  onClick={() => setTab(item)}
                >
                  {t(item === 'pages' ? 'e2e.explorePagesFound' : 'e2e.exploreLiveLog')}
                  <span className="text-[var(--text-muted)]">
                    {item === 'pages' ? exploration.pages.length : exploration.log.length}
                  </span>
                </Button>
              ))}
            </div>
            <div ref={panelRef} className="flex-1 overflow-y-auto p-3" role="tabpanel">
              {tab === 'pages' ? (
                exploration.pages.length ? (
                  <ul className="flex flex-col gap-4">
                    {exploration.pages.map((page) => (
                      <li
                        key={page.index}
                        className="flex gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm"
                      >
                        <div className="min-w-0 flex-1">
                          <p
                            className="flex items-center gap-1 truncate font-mono text-[11px] text-[var(--text-muted)]"
                            title={page.url}
                          >
                            <i className="ti ti-link shrink-0" aria-hidden="true" />
                            <span className="truncate">{page.url}</span>
                          </p>
                          <p
                            className="mt-2 line-clamp-3 text-xs leading-relaxed text-[var(--text-secondary)]"
                            title={page.summary}
                          >
                            {page.summary}
                          </p>
                          <ul className="mt-3 flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-1)]">
                            {page.elements.map((element) => (
                              <li
                                key={element}
                                className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--text-secondary)]"
                              >
                                {element}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">{t('e2e.exploreNoPages')}</p>
                )
              ) : exploration.log.length ? (
                <ol className="flex flex-col gap-3 border-l border-[var(--border)] pl-3">
                  {exploration.log.map((entry, index) => (
                    <li key={index} className="grid grid-cols-[3.5rem_1fr] gap-x-2 text-sm">
                      <span className="font-mono text-xs text-[var(--text-muted)]">
                        {t('e2e.exploreLogTime', { time: formatDuration(entry.atMs) })}
                      </span>
                      <span className="min-w-0 break-words text-[var(--text-primary)]">
                        <strong className="font-semibold">
                          {t(EXPLORATION_ACTION_LABELS[entry.action])}
                        </strong>{' '}
                        {explorationTarget(entry, t)}
                        {entry.result && (
                          <span className="block text-xs text-[var(--text-secondary)]">
                            {t('e2e.exploreLogResult', { result: entry.result })}
                          </span>
                        )}
                        {entry.reason && (
                          <span className="block text-xs italic text-[var(--text-muted)]">
                            {entry.reason}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">{t('e2e.exploreNoLog')}</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
