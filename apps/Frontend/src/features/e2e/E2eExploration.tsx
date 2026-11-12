import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Modal } from '../../components/ui/modal.js';
import { Textarea } from '../../components/ui/textarea.js';
import { E2eImage } from './E2eImage.js';
import {
  e2eImagePath,
  formatDuration,
  isCreationActive,
  isExplorationActive,
  type E2eCreationDetail,
  type E2eExploration as Exploration,
  type E2eExplorationLogEntry,
} from './e2e-types.js';

const POLL_MS = 1500;

type StepState = 'done' | 'active' | 'todo';
type Tab = 'pages' | 'log';

export const EXPLORATION_ACTION_LABELS: Record<E2eExplorationLogEntry['action'], TranslationKey> = {
  navigate: 'e2e.exploreActionNavigate',
  sign_in: 'e2e.exploreActionSignIn',
  click: 'e2e.exploreActionClick',
};

const TITLES: Record<Exploration['status'], TranslationKey> = {
  signing_in: 'e2e.exploreTitleSigning',
  exploring: 'e2e.exploreTitleExploring',
  ready: 'e2e.exploreTitleReady',
  failed: 'e2e.exploreTitleFailed',
};

const HINTS: Record<Exploration['status'], TranslationKey> = {
  signing_in: 'e2e.exploreHintSigning',
  exploring: 'e2e.exploreHintExploring',
  ready: 'e2e.exploreHintReady',
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
  const closeInstructions = () => setEditing(false);
  const [tab, setTab] = useState<Tab>('pages');
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

  const explore = async () => {
    setStarting(true);
    setError(null);
    try {
      setExploration(
        await apiClient.exploreE2eCreation(creationId, {
          ...(description.trim() ? { description: description.trim() } : {}),
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
          <Skeleton className="h-96 w-full" />
        )}
      </div>
    );

  const host = creation.baseUrl.replace(/^https?:\/\//, '');
  const planned = creation.tests.length;
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
          <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">
            {t(exploration ? HINTS[exploration.status] : 'e2e.exploreHintNone')}
          </p>
          {exploration?.status === 'ready' && exploration.savedTo && (
            <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">
              {exploration.savedTo === 'source'
                ? t('e2e.exploreSavedSource')
                : t('e2e.exploreSavedDatabase')}
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
        </div>
        <div className="flex shrink-0 gap-2">
          {canExplore && (
            <Button
              variant="outline"
              onClick={() => {
                setDraft(description);
                setEditing(true);
              }}
            >
              <i className="ti ti-file-description" aria-hidden="true" />
              {t('e2e.exploreInstructions')}
              {description.trim() && (
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
          {planned > 0 && onOpenRun && (
            <Button onClick={onOpenRun}>
              <i className="ti ti-player-play" aria-hidden="true" />
              {t('e2e.exploreViewRun')}
            </Button>
          )}
        </div>
      </div>

      <Modal open={editing} labelledBy="explore-instructions-title" onClose={closeInstructions}>
        <div className="flex w-[560px] max-w-full flex-col gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6">
          <h2
            id="explore-instructions-title"
            className="text-lg font-semibold text-[var(--text-primary)]"
          >
            {t('e2e.exploreInstructions')}
          </h2>
          <Textarea
            aria-label={t('e2e.exploreDescriptionLabel')}
            value={draft}
            maxLength={2000}
            rows={5}
            autoFocus
            placeholder={t('e2e.exploreDescriptionPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeInstructions}>
              {t('e2e.cancel')}
            </Button>
            <Button
              onClick={() => {
                setDescription(draft);
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

      {exploration && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          {exploring ? (
            <div className="self-start overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
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
                  className="aspect-video max-h-[65vh] w-full bg-black/30 object-contain object-top"
                />
              ) : (
                <p className="flex aspect-video max-h-[65vh] items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
                  <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
                  {t('e2e.exploreWaitingFrame')}
                </p>
              )}
            </div>
          ) : (
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
          )}

          <aside className="flex max-h-[70vh] flex-col self-start rounded-lg lg:sticky lg:top-4 border border-[var(--border)] bg-[var(--surface-1)]">
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
                        {entry.target}
                        {entry.result && (
                          <span className="block text-xs text-[var(--text-secondary)]">
                            {t('e2e.exploreLogResult', { result: entry.result })}
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
