import React, { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/modal.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { AgentRun, Issue } from '../issues/issue-types.js';
import type { AgentWorkflowDto, CustomAgentDto } from './agent-types.js';
import { AgentWorkflowCanvas, type WorkflowRunState } from './AgentWorkflowCanvas.js';
import { describeWorkflowNode } from './AgentWorkflowBoard.js';
import { normalizeGraph, WORKFLOW_TRIGGER_NODE_ID } from './workflow-graph.js';

interface AgentRunFlowModalProps {
  /** The agent whose runs are shown; null closes the modal. */
  readonly agent: CustomAgentDto | null;
  readonly runs: readonly AgentRun[];
  readonly issues: readonly Issue[];
  readonly agents: readonly CustomAgentDto[];
  /** The workspace workflow, drawn on the same canvas the editor uses. */
  readonly workflow: AgentWorkflowDto;
  /** Run to show first, when the modal opens from a task instead of an agent. */
  readonly initialRunId?: string | null;
  /** Takes the user to the issue of the run; without it the modal offers no link. */
  readonly onOpenIssue?: (issueId: string) => void;
  readonly onClose: () => void;
}

// The canvas is read-only here, so it never calls these handlers.
/* v8 ignore next */
const noop = () => undefined;

/** Where a run is in its workflow: the same canvas as the editor, with the current step marked. */
export function AgentRunFlowModal({
  agent,
  runs,
  issues,
  agents,
  workflow,
  initialRunId = null,
  onOpenIssue,
  onClose,
}: AgentRunFlowModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId);
  useEffect(() => setSelectedRunId(initialRunId), [initialRunId, agent?.id]);

  const run = runs.find((entry) => entry.id === selectedRunId) ?? runs[0] ?? null;
  const state = run?.workflowState ?? null;
  const waiting = run?.status.startsWith('waiting_') ?? false;
  const graph = useMemo(() => normalizeGraph(workflow), [workflow]);

  const nodeStates = useMemo(() => {
    const states: Record<string, WorkflowRunState> = {};
    if (!state) return states;
    for (const node of graph.nodes) states[node.id] = 'pending';
    states[WORKFLOW_TRIGGER_NODE_ID] = 'done';
    const active = run?.status === 'running' ? 'current' : waiting ? 'waiting' : 'pending';
    if (state.canvas) {
      // A flow is walked node by node: what the run recorded is done, the node it is on is current.
      const recorded = new Set(state.results.map((result) => result.stepId));
      for (const node of graph.nodes) if (recorded.has(node.id)) states[node.id] = 'done';
      if (state.currentNodeId) states[state.currentNodeId] = active;
      return states;
    }
    state.steps.forEach((step, index) => {
      if (index < state.currentStepIndex) states[step.id] = 'done';
      else if (index === state.currentStepIndex) states[step.id] = active;
    });
    return states;
  }, [graph, state, run?.status, waiting]);

  const issueLabel = (entry: AgentRun) => {
    const found = issues.find((item) => item.id === entry.issueId);
    return found ? `#${found.number} ${found.title}` : `#${entry.issueId.slice(0, 8)}`;
  };
  const currentStep = state
    ? state.currentNodeId
      ? state.steps.find((step) => step.id === state.currentNodeId)
      : state.canvas
        ? undefined
        : state.steps[state.currentStepIndex]
    : undefined;

  return (
    <Modal open={agent !== null} onClose={onClose} labelledBy="agent-run-flow-title">
      {agent && (
        <div
          data-testid="agent-run-flow"
          className="flex h-[min(92vh,980px)] w-[min(96vw,1600px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
        >
          <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-6 py-4">
            <div className="min-w-0">
              <p className="text-xs text-[var(--text-accent)]">{agent.role}</p>
              <h2 id="agent-run-flow-title" className="mt-1 truncate text-xl font-semibold">
                {agent.name}
              </h2>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {t('agents.activeRunsCount', { count: runs.length })}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('common.close')}
              onClick={onClose}
            >
              <i className="ti ti-x" aria-hidden="true" />
            </Button>
          </div>

          {!run ? (
            <div className="space-y-2 p-6 text-sm">
              {agent.description && (
                <p className="text-[var(--text-secondary)]">{agent.description}</p>
              )}
              <p role="status" className="text-[var(--text-muted)]">
                {t('agents.noActiveRun')}
              </p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
              {runs.length > 1 && (
                <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('agents.runs')}>
                  {runs.map((entry) => (
                    <Button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={entry.id === run.id}
                      variant={entry.id === run.id ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSelectedRunId(entry.id)}
                    >
                      {issueLabel(entry)}
                    </Button>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-[var(--text-primary)]">{issueLabel(run)}</span>
                {onOpenIssue && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="run-flow-open-issue"
                    onClick={() => onOpenIssue(run.issueId)}
                  >
                    <i className="ti ti-external-link mr-1.5" aria-hidden="true" />
                    {t('agents.openIssue')}
                  </Button>
                )}
                <Badge variant={run.status === 'running' ? 'success' : 'outline'}>
                  {run.status === 'running'
                    ? t('agents.statusRunning')
                    : waiting
                      ? t('agents.waitingForUser')
                      : t('agents.statusQueued')}
                </Badge>
                <span className="text-xs text-[var(--text-secondary)]">
                  {run.mode === 'host' ? t('agents.clientModel') : t('agents.server')}
                  {run.model ? ` · ${run.model}` : ''}
                </span>
                {/* A queued run has not started: its first step is next, not running. */}
                {currentStep && run.status !== 'queued' && (
                  <span
                    data-testid="run-flow-current-step"
                    className="text-xs text-[var(--text-accent)]"
                  >
                    {t('agents.stepRunning')}: {currentStep.name}
                  </span>
                )}
              </div>

              <section
                aria-label={t('agents.workflowFlow')}
                data-testid="run-flow-canvas"
                className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)]"
              >
                <AgentWorkflowCanvas
                  graph={graph}
                  isReadOnly
                  isDimmed={false}
                  selectedNodeId={null}
                  nodeStates={nodeStates}
                  canvasClassName="h-auto min-h-[420px] flex-1 cursor-grab"
                  describeNode={(node) =>
                    describeWorkflowNode(node, workflow.steps, agents, workflow.rules, t)
                  }
                  onOpenNode={noop}
                  onMoveNode={noop}
                  onRemoveNode={noop}
                  onConnect={noop}
                  onDisconnect={noop}
                />
              </section>

              {state?.question && (
                <p
                  role="status"
                  className="rounded-md border border-sky-400/30 bg-sky-500/10 p-3 text-sm text-sky-200"
                >
                  {state.question}
                </p>
              )}

              {state && state.results.length > 0 && (
                <section aria-label={t('agents.runResults')}>
                  <h3 className="mb-2 text-sm font-semibold">{t('agents.runResults')}</h3>
                  <ul className="space-y-2">
                    {state.results.map((result, index) => (
                      <li
                        key={`${result.stepId}-${index}`}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm"
                      >
                        <p className="text-xs font-semibold text-[var(--text-secondary)]">
                          {result.name}
                        </p>
                        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words">
                          {result.output}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
