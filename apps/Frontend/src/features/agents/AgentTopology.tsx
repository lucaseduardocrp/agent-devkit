import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import type { AgentRun, Issue } from '../issues/issue-types.js';
import type { AgentWorkflowDto, CustomAgentDto } from './agent-types.js';
import { AgentRunFlowModal } from './AgentRunFlowModal.js';
import { CanvasZoomControls } from './CanvasZoomControls.js';
import { useCanvasViewport, ZOOM_STEP } from './use-canvas-viewport.js';
import type { LiveStatus } from './use-run-stream.js';
import { edgePath } from './workflow-graph.js';

interface AgentTopologyProps {
  readonly agents: readonly CustomAgentDto[];
  readonly issues: readonly Issue[];
  readonly runs: readonly AgentRun[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  /** Whether the map is following the runs live; absent when it can only poll. */
  readonly liveStatus?: LiveStatus;
  /** Takes the user to the issue of a run, from the run flow. */
  readonly onOpenIssue?: (issueId: string) => void;
  /** The workspace workflow, shown on the canvas of the run modal. */
  readonly workflow: AgentWorkflowDto;
  /** Without it the empty map does not invite the member to create agents. */
  readonly canCreateAgents?: boolean;
}

/** How long a task that just arrived stays highlighted. */
const ARRIVAL_HIGHLIGHT_MS = 4_000;

/** The step a running run is on, when the workflow has named steps for it. */
function currentStepName(run: AgentRun): string | null {
  const state = run.workflowState;
  if (!state || run.status !== 'running') return null;
  const step = state.currentNodeId
    ? state.steps.find((candidate) => candidate.id === state.currentNodeId)
    : state.canvas
      ? undefined
      : state.steps[state.currentStepIndex];
  return step?.name ?? null;
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 84;
const COLUMN_GAP = 92;
const ROW_HEIGHT = 108;
const PADDING = 24;

/** The layout already keeps PADDING around the nodes; the fit only adds a little on top. */
const FIT_PADDING = 8;

interface AgentPosition {
  readonly agent: CustomAgentDto;
  readonly x: number;
  readonly y: number;
}

interface TopologyLayout {
  readonly positions: readonly AgentPosition[];
  readonly issueX: number;
  readonly width: number;
  readonly height: number;
}

interface TopologyCanvasProps {
  readonly layout: TopologyLayout;
  readonly activeRuns: readonly AgentRun[];
  readonly agentById: ReadonlyMap<string, CustomAgentDto>;
  readonly issueById: ReadonlyMap<string, Issue>;
  readonly selectedAgentId: string | null;
  readonly arrivedRunIds: readonly string[];
  readonly taskLabel: (run: AgentRun) => string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onSelectRun: (run: AgentRun) => void;
}

/**
 * The map as a canvas, like the one of the workflow: it fills the height it is given and frames
 * every agent and task at once, so nothing needs scrolling. It can still be panned (drag the
 * background) and zoomed (buttons or ctrl + wheel), and "fit" frames everything again.
 */
function TopologyCanvas({
  layout,
  activeRuns,
  agentById,
  issueById,
  selectedAgentId,
  arrivedRunIds,
  taskLabel,
  onSelectAgent,
  onSelectRun,
}: TopologyCanvasProps): React.JSX.Element {
  const { t } = useI18n();
  const [pan, setPan] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const { surfaceRef, viewport, zoomBy, panBy, resetView, handleWheel } = useCanvasViewport(
    () => ({ left: 0, top: 0, right: layout.width, bottom: layout.height }),
    `${layout.width}x${layout.height}`,
    FIT_PADDING,
  );
  const positionById = new Map(layout.positions.map((position) => [position.agent.id, position]));

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    // A press on a node is a click on it, not the start of a drag of the background.
    if ((event.target as Element).closest('button')) return;
    setPan({ x: event.clientX, y: event.clientY });
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pan) return;
    panBy(event.clientX - pan.x, event.clientY - pan.y);
    setPan({ x: event.clientX, y: event.clientY });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
      data-testid="topology-canvas-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
        <div
          className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--text-secondary)]"
          aria-label={t('agents.mapLegend')}
        >
          <span className="flex items-center gap-2">
            <span className="h-0 w-7 border-t-2 border-[var(--fill-accent)]" />
            {t('agents.configuredRelationship')}
          </span>
          <span className="flex items-center gap-2">
            <span className="h-0 w-7 border-t-2 border-dashed border-emerald-400" />
            {t('agents.activeRun')}
          </span>
          <span className="flex items-center gap-2">
            <span className="h-0 w-7 border-t-2 border-dashed border-amber-400" />
            {t('agents.pendingRun')}
          </span>
        </div>
        <CanvasZoomControls
          zoom={viewport.zoom}
          onZoomIn={() => zoomBy(ZOOM_STEP)}
          onZoomOut={() => zoomBy(-ZOOM_STEP)}
          onReset={resetView}
          testIdPrefix="topology"
        />
      </div>

      <div
        ref={surfaceRef}
        data-testid="topology-scroll-area"
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={() => setPan(null)}
        onPointerLeave={() => setPan(null)}
        onWheel={handleWheel}
        className={cn(
          // The canvas sits darker than its nodes, so a node reads as a card lifted off it.
          'relative min-h-[360px] flex-1 touch-none select-none overflow-hidden bg-[var(--surface-0)] [background-image:radial-gradient(var(--border-strong)_1px,transparent_1px)] [background-size:20px_20px]',
          pan ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <div
          className="absolute left-0 top-0"
          data-testid="topology-layer"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
            data-testid="topology-edges"
          >
            {layout.positions.map(({ agent, x, y }) => {
              const parent = agent.parentAgentId
                ? positionById.get(agent.parentAgentId)
                : undefined;
              if (!parent) return null;
              return (
                <path
                  key={`parent-${agent.id}`}
                  data-testid={`parent-edge-${agent.id}`}
                  d={edgePath(
                    { x: parent.x + NODE_WIDTH, y: parent.y + NODE_HEIGHT / 2 },
                    { x, y: y + NODE_HEIGHT / 2 },
                  )}
                  fill="none"
                  stroke="var(--fill-accent)"
                  strokeWidth="2"
                />
              );
            })}
            {activeRuns.map((run, index) => {
              const source = positionById.get(run.agentId);
              if (!source) return null;
              return (
                <path
                  key={`run-${run.id}`}
                  data-testid={`run-edge-${run.id}`}
                  d={edgePath(
                    { x: source.x + NODE_WIDTH, y: source.y + NODE_HEIGHT / 2 },
                    { x: layout.issueX, y: PADDING + index * ROW_HEIGHT + NODE_HEIGHT / 2 },
                  )}
                  fill="none"
                  stroke={run.status === 'running' ? '#34d399' : '#fbbf24'}
                  strokeWidth="2"
                  strokeDasharray="7 5"
                />
              );
            })}
          </svg>
          {layout.positions.map(({ agent, x, y }) => {
            const agentRuns = activeRuns.filter((run) => run.agentId === agent.id);
            const status = agentRuns.some((run) => run.status === 'running')
              ? 'running'
              : agentRuns.some((run) => run.status.startsWith('waiting_'))
                ? 'waiting'
                : agentRuns.length
                  ? 'queued'
                  : 'idle';
            const statusText =
              status === 'running'
                ? t('agents.statusRunning')
                : status === 'queued'
                  ? t('agents.statusQueued')
                  : status === 'waiting'
                    ? t('agents.waitingForUser')
                    : t('agents.idle');
            return (
              <Button
                key={agent.id}
                type="button"
                variant="outline"
                onClick={() => onSelectAgent(agent.id)}
                aria-label={`${agent.name}: ${statusText}`}
                aria-pressed={selectedAgentId === agent.id}
                data-testid={`topology-agent-${agent.id}`}
                className="absolute flex h-[84px] cursor-pointer flex-col items-start justify-center gap-1 overflow-hidden rounded-2xl border-[1.5px] border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-left shadow-md hover:border-[var(--fill-accent)] focus-visible:ring-2 focus-visible:ring-[var(--fill-accent)]"
                style={{ left: x, top: y, width: NODE_WIDTH }}
              >
                <span className="w-full truncate font-semibold text-[var(--text-primary)]">
                  {agent.name}
                </span>
                <span className="flex w-full items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
                  <span className="truncate">{agent.role}</span>
                  <span
                    className={
                      status === 'running'
                        ? 'text-emerald-400'
                        : status === 'queued'
                          ? 'text-amber-400'
                          : status === 'waiting'
                            ? 'text-sky-300'
                            : ''
                    }
                  >
                    {statusText}
                  </span>
                </span>
                {agentRuns[0] && (
                  <span
                    data-testid={`topology-agent-task-${agent.id}`}
                    className="w-full truncate text-xs text-emerald-300"
                  >
                    {taskLabel(agentRuns[0])}
                    {agentRuns.length > 1 ? ` +${agentRuns.length - 1}` : ''}
                  </span>
                )}
              </Button>
            );
          })}
          {activeRuns.map((run, index) => {
            const issue = issueById.get(run.issueId);
            return (
              <button
                key={run.id}
                type="button"
                data-testid={`topology-run-${run.id}`}
                onClick={() => onSelectRun(run)}
                className={`absolute flex h-[84px] cursor-pointer flex-col items-start justify-center gap-1 overflow-hidden rounded-2xl border-[1.5px] border-emerald-400/40 bg-[var(--surface-2)] px-4 text-left shadow-md hover:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fill-accent)] ${
                  arrivedRunIds.includes(run.id) ? 'animate-pulse ring-2 ring-emerald-400' : ''
                }`}
                style={{
                  left: layout.issueX,
                  top: PADDING + index * ROW_HEIGHT,
                  width: NODE_WIDTH,
                }}
              >
                <span className="w-full truncate text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                  {run.status === 'running'
                    ? t('agents.runningIssue')
                    : run.status.startsWith('waiting_')
                      ? t('agents.waitingIssue')
                      : t('agents.queuedIssue')}
                </span>
                <span className="w-full truncate text-sm font-medium text-[var(--text-primary)]">
                  {issue ? `#${issue.number} ${issue.title}` : `#${run.issueId.slice(0, 8)}`}
                </span>
                <span className="w-full truncate text-xs text-[var(--text-secondary)]">
                  {agentById.get(run.agentId)?.name ?? ''} ·{' '}
                  {currentStepName(run) ??
                    (run.mode === 'host' ? t('agents.clientModel') : t('agents.server'))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function AgentTopology({
  agents,
  issues,
  runs,
  isLoading,
  error,
  onRefresh,
  liveStatus,
  onOpenIssue,
  workflow,
  canCreateAgents = true,
}: AgentTopologyProps): React.JSX.Element {
  const { t } = useI18n();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const activeRuns = useMemo(
    () =>
      runs.filter((run) =>
        ['running', 'queued', 'waiting_review', 'waiting_input'].includes(run.status),
      ),
    [runs],
  );
  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const layout = useMemo(() => {
    const children = new Map<string, CustomAgentDto[]>();
    for (const agent of agents) {
      if (!agent.parentAgentId || !agentById.has(agent.parentAgentId)) continue;
      const siblings = children.get(agent.parentAgentId) ?? [];
      siblings.push(agent);
      children.set(agent.parentAgentId, siblings);
    }
    const sortByName = (a: CustomAgentDto, b: CustomAgentDto) => a.name.localeCompare(b.name);
    const positions: AgentPosition[] = [];
    const visited = new Set<string>();
    let maxDepth = 0;
    const visit = (agent: CustomAgentDto, depth: number) => {
      if (visited.has(agent.id)) return;
      visited.add(agent.id);
      maxDepth = Math.max(maxDepth, depth);
      positions.push({
        agent,
        x: PADDING + depth * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + positions.length * ROW_HEIGHT,
      });
      for (const child of (children.get(agent.id) ?? []).sort(sortByName)) visit(child, depth + 1);
    };
    for (const root of agents
      .filter((agent) => !agent.parentAgentId || !agentById.has(agent.parentAgentId))
      .sort(sortByName))
      visit(root, 0);
    for (const agent of [...agents].sort(sortByName)) visit(agent, 0);
    const issueX = PADDING + (maxDepth + 1) * (NODE_WIDTH + COLUMN_GAP);
    return {
      positions,
      issueX,
      width: issueX + NODE_WIDTH + PADDING,
      height: PADDING * 2 + Math.max(positions.length, activeRuns.length, 1) * ROW_HEIGHT,
    };
  }, [agents, agentById, activeRuns.length]);

  const selectedAgent = selectedAgentId ? agentById.get(selectedAgentId) : undefined;
  const selectedRuns = selectedAgent
    ? activeRuns.filter((run) => run.agentId === selectedAgent.id)
    : [];
  const taskLabel = (run: AgentRun) => {
    const issue = issueById.get(run.issueId);
    return issue ? `#${issue.number} ${issue.title}` : `#${run.issueId.slice(0, 8)}`;
  };
  // A task that reaches the queue while the map is live is highlighted and announced. Changes that
  // come from loading the map (first view, reconnecting, refresh) are not arrivals.
  const [arrivedRunIds, setArrivedRunIds] = useState<readonly string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const view = useRef<{ ids: ReadonlySet<string>; loading: boolean; live: boolean } | null>(null);
  useEffect(() => {
    const previous = view.current;
    const live = liveStatus === 'live';
    view.current = { ids: new Set(activeRuns.map((run) => run.id)), loading: isLoading, live };
    if (!previous || previous.loading || isLoading || !previous.live || !live) return;
    const arrived = activeRuns.filter(
      (run) => run.status === 'queued' && !previous.ids.has(run.id),
    );
    if (arrived.length === 0) return;
    setArrivedRunIds(arrived.map((run) => run.id));
    setAnnouncement(
      t('agents.newTaskAnnouncement', {
        agent: agentById.get(arrived[0]!.agentId)?.name ?? '',
        task: taskLabel(arrived[0]!),
      }),
    );
    const timer = setTimeout(() => setArrivedRunIds([]), ARRIVAL_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
    // taskLabel and t only format the message; the effect follows the runs and the live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRuns, isLoading, liveStatus]);

  const runningCount = activeRuns.filter((run) => run.status === 'running').length;
  const waitingCount = activeRuns.filter((run) => run.status.startsWith('waiting_')).length;
  const queuedCount = activeRuns.length - runningCount - waitingCount;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" data-testid="agent-topology">
      <div aria-live="polite" className="sr-only" data-testid="topology-announcement">
        {announcement}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="sr-only">{t('agents.map')}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">
            {agents.length} {t('agents.agentsUnit')}
          </Badge>
          <Badge variant="success">
            {runningCount} {t('agents.running')}
          </Badge>
          <Badge variant="default">
            {queuedCount} {t('agents.queued')}
          </Badge>
          <Badge variant="outline">
            {waitingCount} {t('agents.waitingForUser')}
          </Badge>
          {liveStatus && (
            <Badge
              variant={liveStatus === 'live' ? 'success' : 'outline'}
              data-testid="topology-live"
            >
              <span
                aria-hidden="true"
                className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                  liveStatus === 'live' ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'
                }`}
              />
              {liveStatus === 'live'
                ? t('agents.liveLive')
                : liveStatus === 'connecting'
                  ? t('agents.liveConnecting')
                  : t('agents.liveOffline')}
            </Badge>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400"
        >
          {error}{' '}
          <Button type="button" variant="link" onClick={onRefresh}>
            {t('agents.retry')}
          </Button>
        </div>
      )}

      {isLoading && agents.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-secondary)]">
          {canCreateAgents ? t('agents.createAgentForMap') : t('agents.noAgents')}
        </div>
      ) : (
        <TopologyCanvas
          layout={layout}
          activeRuns={activeRuns}
          agentById={agentById}
          issueById={issueById}
          selectedAgentId={selectedAgentId}
          arrivedRunIds={arrivedRunIds}
          taskLabel={taskLabel}
          onSelectAgent={(agentId) => {
            setSelectedRunId(null);
            setSelectedAgentId(agentId);
          }}
          onSelectRun={(run) => {
            setSelectedRunId(run.id);
            setSelectedAgentId(run.agentId);
          }}
        />
      )}

      <AgentRunFlowModal
        agent={selectedAgent ?? null}
        runs={selectedRuns}
        issues={issues}
        agents={agents}
        workflow={workflow}
        initialRunId={selectedRunId}
        {...(onOpenIssue ? { onOpenIssue } : {})}
        onClose={() => {
          setSelectedAgentId(null);
          setSelectedRunId(null);
        }}
      />
    </section>
  );
}
