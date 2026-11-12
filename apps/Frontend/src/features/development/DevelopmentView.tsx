import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { desktopDevelopment } from '../../lib/desktop.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { useRunStream } from '../agents/use-run-stream.js';
import { usePermissions } from '../workspaces/permissions.js';
import { ArtifactsSection } from './ArtifactsSection.js';
import { CodeSection } from './CodeSection.js';
import { PipelineSection } from './PipelineSection.js';
import { ReviewSection } from './ReviewSection.js';
import {
  LIVE_SESSION_STATUSES,
  REFRESH_INTERVAL_MS,
  type DevChange,
  type DevelopmentStreamEvent,
  type DevelopmentSection,
  type DevSession,
  type Pipeline,
  type PipelineItem,
  type PipelineStage,
} from './development-types.js';

interface Props {
  readonly apiClient: ApiClient;
  readonly workspaceId: string | null;
  readonly isReadOnly?: boolean;
  readonly section: DevelopmentSection;
  readonly onSelectSection: (section: DevelopmentSection) => void;
}

const PIPELINE_REFRESH_MS = 300;
const RECONCILE_INTERVAL_MS = 60_000;
const EMPTY_PIPELINE: Pipeline = { spec: [], approval: [], code: [], review: [], done: [] };

export function DevelopmentView({
  apiClient,
  workspaceId,
  isReadOnly = false,
  section,
  onSelectSection,
}: Props) {
  const { messages } = useI18n();
  const c = messages.development;
  const permissions = usePermissions();
  const [changes, setChanges] = useState<DevChange[]>([]);
  const [sessions, setSessions] = useState<DevSession[]>([]);
  const [pipeline, setPipeline] = useState<Pipeline>(EMPTY_PIPELINE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeId, setChangeId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seedChangeId, setSeedChangeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    try {
      const [nextChanges, nextSessions, nextPipeline] = await Promise.all([
        apiClient.getDevelopmentChanges(),
        apiClient.getDevelopmentSessions(),
        apiClient.getDevelopmentPipeline(),
      ]);
      setChanges(nextChanges);
      setSessions(nextSessions);
      setPipeline(nextPipeline);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c.loadError);
    } finally {
      setLoading(false);
    }
  }, [apiClient, workspaceId, c.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  // The desktop app executes the sessions itself, as the person signed in here.
  const token = apiClient.getToken();
  useEffect(() => {
    void desktopDevelopment()?.connect(token && workspaceId ? { token, workspaceId } : null);
  }, [token, workspaceId]);

  // The pipeline is derived on the server: read it again once a burst of events settles.
  const pipelineTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pipelineTimer.current), []);
  const refreshPipeline = useCallback(() => {
    window.clearTimeout(pipelineTimer.current);
    pipelineTimer.current = window.setTimeout(() => {
      void apiClient.getDevelopmentPipeline().then(setPipeline, () => undefined);
    }, PIPELINE_REFRESH_MS);
  }, [apiClient]);

  /** A change or a session moved: read that one and put it where it belongs. */
  const follow = useCallback(
    async (event: DevelopmentStreamEvent) => {
      const without = <Item extends { id: string }>(items: Item[]) =>
        items.filter((item) => item.id !== event.id);
      const upsert = <Item extends { id: string }>(items: Item[], item: Item) =>
        items.some((existing) => existing.id === item.id)
          ? items.map((existing) => (existing.id === item.id ? item : existing))
          : [item, ...items];
      try {
        if (event.kind === 'session') {
          if (event.deleted) setSessions(without);
          else {
            const session = await apiClient.getDevelopmentSession(event.id);
            setSessions((current) => upsert(current, session));
          }
        } else if (event.deleted) setChanges(without);
        else {
          const change = await apiClient.getDevelopmentChange(event.id);
          setChanges((current) => upsert(current, change));
        }
        refreshPipeline();
      } catch {
        // Gone before it could be read, or the server is busy: the full load sorts it out.
        void load();
      }
    },
    [apiClient, load, refreshPipeline],
  );

  // Everything follows the server live. Every connection starts with a full load, so nothing that
  // happened while offline is missed.
  const liveStatus = useRunStream<DevelopmentStreamEvent>({
    enabled: workspaceId !== null,
    connect: (handlers, signal) => apiClient.streamDevelopmentEvents(handlers, signal),
    onRun: (event) => void follow(event),
    onReady: () => void load(),
  });
  const working = sessions.some((session) => LIVE_SESSION_STATUSES.includes(session.status));
  useEffect(() => {
    // Live, the stream carries every change and this only corrects what could have been missed;
    // without the stream, a runner that reports from outside the app is polled while it works.
    if (liveStatus !== 'live' && !working) return;
    const timer = window.setInterval(
      () => void load(),
      liveStatus === 'live' ? RECONCILE_INTERVAL_MS : REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [liveStatus, working, load]);

  /** Runs a change and reloads, so every screen shows what the server now holds. */
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c.actionError);
    } finally {
      setBusy(false);
    }
  };
  const actions = {
    busy,
    readOnly: isReadOnly,
    canDelete: !isReadOnly && permissions.can('development', 'delete'),
    run,
  };

  const startSession = (id: string) => {
    setSeedChangeId(id);
    onSelectSection('code');
  };
  const openReview = (id: string) => {
    setSessionId(id);
    onSelectSection('review');
  };
  const openPipelineItem = (stage: PipelineStage, item: PipelineItem) => {
    setChangeId(item.changeId);
    setSessionId(item.session?.id ?? null);
    setSeedChangeId(stage === 'code' && !item.session ? item.changeId : null);
    onSelectSection(stage === 'code' || stage === 'review' ? stage : 'artifacts');
  };

  return (
    <main
      className={cn(
        'flex w-full flex-col gap-5 text-[var(--text-primary)]',
        // The layout already pads every page; Code also fills the available height.
        section === 'code' && 'min-h-0 flex-1',
        // An open session is a workspace sized to the page: its panels scroll, the page does not.
        section === 'code' && sessionId && 'overflow-hidden',
      )}
    >
      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
        >
          {error}
        </div>
      )}
      {loading ? (
        <SkeletonCard />
      ) : section === 'artifacts' ? (
        <ArtifactsSection
          {...actions}
          apiClient={apiClient}
          changes={changes}
          selectedId={changeId}
          onSelect={setChangeId}
          onStartSession={startSession}
        />
      ) : section === 'code' ? (
        <CodeSection
          {...actions}
          apiClient={apiClient}
          sessions={sessions}
          changes={changes}
          selectedId={sessionId}
          onSelect={setSessionId}
          seedChangeId={seedChangeId}
          onOpenReview={openReview}
        />
      ) : section === 'review' ? (
        <ReviewSection
          {...actions}
          apiClient={apiClient}
          sessions={sessions}
          selectedId={sessionId}
          onSelect={setSessionId}
        />
      ) : (
        <PipelineSection pipeline={pipeline} onOpen={openPipelineItem} />
      )}
    </main>
  );
}
