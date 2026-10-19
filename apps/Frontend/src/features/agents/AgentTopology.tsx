import React, { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { AgentRun, Issue } from '../issues/issue-types.js';
import type { CustomAgentDto } from './agent-types.js';

interface AgentTopologyProps {
  readonly agents: readonly CustomAgentDto[];
  readonly issues: readonly Issue[];
  readonly runs: readonly AgentRun[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  /** Without it the empty map does not invite the member to create agents. */
  readonly canCreateAgents?: boolean;
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 84;
const COLUMN_GAP = 92;
const ROW_HEIGHT = 108;
const PADDING = 24;

interface AgentPosition {
  readonly agent: CustomAgentDto;
  readonly x: number;
  readonly y: number;
}

export function AgentTopology({
  agents,
  issues,
  runs,
  isLoading,
  error,
  onRefresh,
  canCreateAgents = true,
}: AgentTopologyProps): React.JSX.Element {
  const { t } = useI18n();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const activeRuns = useMemo(
    () => runs.filter((run) => run.status === 'running' || run.status === 'queued'),
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

  const positionById = new Map(layout.positions.map((position) => [position.agent.id, position]));
  const selectedAgent = selectedAgentId ? agentById.get(selectedAgentId) : undefined;
  const selectedRuns = selectedAgent
    ? activeRuns.filter((run) => run.agentId === selectedAgent.id)
    : [];
  const runningCount = activeRuns.filter((run) => run.status === 'running').length;
  const queuedCount = activeRuns.length - runningCount;

  return (
    <section className="space-y-4" data-testid="agent-topology">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('agents.map')}</h2>
          <p className="text-sm text-[var(--text-secondary)]">{t('agents.mapDescription')}</p>
        </div>
        <Button type="button" variant="outline" onClick={onRefresh} disabled={isLoading}>
          <i className="ti ti-refresh mr-2" aria-hidden="true" />
          {t('agents.refreshMap')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">
          {agents.length} {t('agents.agentsUnit')}
        </Badge>
        <Badge variant="success">
          {runningCount} {t('agents.running')}
        </Badge>
        <Badge variant="default">
          {queuedCount} {t('agents.queued')}
        </Badge>
      </div>

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
        <div
          className="overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface-0)]"
          data-testid="topology-scroll-area"
        >
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
              data-testid="topology-edges"
            >
              {layout.positions.map(({ agent, x, y }) => {
                const parent = agent.parentAgentId
                  ? positionById.get(agent.parentAgentId)
                  : undefined;
                if (!parent) return null;
                const x1 = parent.x + NODE_WIDTH;
                const y1 = parent.y + NODE_HEIGHT / 2;
                const x2 = x;
                const y2 = y + NODE_HEIGHT / 2;
                return (
                  <path
                    key={`parent-${agent.id}`}
                    data-testid={`parent-edge-${agent.id}`}
                    d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--fill-accent)"
                    strokeWidth="2"
                  />
                );
              })}
              {activeRuns.map((run, index) => {
                const source = positionById.get(run.agentId);
                if (!source) return null;
                const x1 = source.x + NODE_WIDTH;
                const y1 = source.y + NODE_HEIGHT / 2;
                const x2 = layout.issueX;
                const y2 = PADDING + index * ROW_HEIGHT + NODE_HEIGHT / 2;
                return (
                  <path
                    key={`run-${run.id}`}
                    data-testid={`run-edge-${run.id}`}
                    d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
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
                : agentRuns.length
                  ? 'queued'
                  : 'idle';
              const statusText =
                status === 'running'
                  ? t('agents.statusRunning')
                  : status === 'queued'
                    ? t('agents.statusQueued')
                    : t('agents.idle');
              return (
                <Button
                  key={agent.id}
                  type="button"
                  variant="outline"
                  onClick={() => setSelectedAgentId(agent.id)}
                  aria-label={`${agent.name}: ${statusText}`}
                  aria-pressed={selectedAgentId === agent.id}
                  data-testid={`topology-agent-${agent.id}`}
                  className="absolute flex h-[84px] flex-col items-start justify-center gap-1 overflow-hidden rounded-xl border-[var(--border)] bg-[var(--surface-1)] px-4 text-left shadow-sm focus-visible:ring-2 focus-visible:ring-[var(--fill-accent)]"
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
                            : ''
                      }
                    >
                      {statusText}
                    </span>
                  </span>
                </Button>
              );
            })}
            {activeRuns.map((run, index) => {
              const issue = issueById.get(run.issueId);
              return (
                <div
                  key={run.id}
                  data-testid={`topology-run-${run.id}`}
                  className="absolute flex h-[84px] flex-col justify-center gap-1 rounded-xl border border-emerald-400/40 bg-[var(--surface-1)] px-4 shadow-sm"
                  style={{
                    left: layout.issueX,
                    top: PADDING + index * ROW_HEIGHT,
                    width: NODE_WIDTH,
                  }}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                    {run.status === 'running' ? t('agents.runningIssue') : t('agents.queuedIssue')}
                  </span>
                  <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                    {issue ? `#${issue.number} ${issue.title}` : `#${run.issueId.slice(0, 8)}`}
                  </span>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {run.mode === 'host' ? t('agents.clientModel') : t('agents.server')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedAgent && (
        <div
          className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm"
          data-testid="topology-selection"
        >
          <h3 className="font-semibold text-[var(--text-primary)]">{selectedAgent.name}</h3>
          <p className="mt-1 text-[var(--text-secondary)]">
            {selectedAgent.description || t('agents.noDescription')}
          </p>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            {t('agents.activeRunsCount', { count: selectedRuns.length })}
          </p>
        </div>
      )}
    </section>
  );
}
