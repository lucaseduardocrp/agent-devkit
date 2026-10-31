import React, { useState } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/index.js';
import type {
  AgentRole,
  AgentWorkflowDto,
  AgentWorkflowRuleDto,
  AgentWorkflowStepDto,
  AgentWorkflowToolset,
  CustomAgentDto,
} from './agent-types.js';

export interface AgentWorkflowBoardProps {
  readonly workflow: AgentWorkflowDto;
  readonly agents: readonly CustomAgentDto[];
  readonly isReadOnly?: boolean;
  readonly isSaving?: boolean;
  /** Shows the unsaved marker and enables the save button. */
  readonly isDirty?: boolean;
  /** The MCP actions of each module, suggested while a rule is edited. */
  readonly toolNames: Record<AgentWorkflowToolset, readonly string[]>;
  readonly providerOptions: readonly { readonly id: string; readonly name: string }[];
  readonly onChange: (next: AgentWorkflowDto) => void;
  readonly onSave: () => void;
}

/** The node icon and colours of each role, so a step reads as its agent at a glance. */
const roleVisuals: Record<AgentRole, { readonly icon: string; readonly className: string }> = {
  QA: { icon: 'ti-test-pipe', className: 'bg-emerald-500/15 text-emerald-300' },
  DOCUMENTATION: { icon: 'ti-file-description', className: 'bg-sky-500/15 text-sky-300' },
  REFACTOR: { icon: 'ti-wand', className: 'bg-violet-500/15 text-violet-300' },
  CUSTOM: { icon: 'ti-bolt', className: 'bg-amber-500/15 text-amber-300' },
};

const unassignedVisual = {
  icon: 'ti-bolt',
  className: 'bg-[var(--surface-1)] text-[var(--text-secondary)]',
};

/** Four nodes per row, so the flow snakes down instead of scrolling sideways forever. */
const COLUMNS = 4;
/** Node width: the row minus its three 56px connectors, split evenly. */
const NODE_WIDTH = 'calc((100% - 168px) / 4)';

/** The modules a rule can cover, in the order the inspector lists them. */
const toolsetLabels: Record<AgentWorkflowToolset, TranslationKey> = {
  all: 'agents.workflowModuleAll',
  agents: 'agents.workflowModuleAgents',
  integrations: 'agents.workflowModuleIntegrations',
  brain: 'agents.workflowModuleBrain',
  issues: 'agents.workflowModuleIssues',
  pbi: 'agents.workflowModulePbi',
  spec: 'agents.workflowModuleSpec',
  testplans: 'agents.workflowModuleTestPlans',
  design: 'agents.workflowModuleDesign',
  e2e: 'agents.workflowModuleE2e',
  releasenotes: 'agents.workflowModuleReleaseNotes',
  integrationtests: 'agents.workflowModuleIntegrationTests',
  loadtests: 'agents.workflowModuleLoadTests',
  audit: 'agents.workflowModuleAudit',
  workspaces: 'agents.workflowModuleWorkspaces',
};

const padNumber = (value: number) => (value < 10 ? `0${value}` : String(value));

function newId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/** The pill switch of the header and of the approval rows. */
function Switch({
  checked,
  label,
  disabled,
  onChange,
  testId,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onChange: () => void;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      data-testid={testId}
      className={cn(
        'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-[var(--fill-accent)]' : 'bg-[var(--border)]',
      )}
    >
      <span
        className={cn(
          'absolute top-[3px] h-4 w-4 rounded-full bg-white transition-[left]',
          checked ? 'left-[19px]' : 'left-[3px]',
        )}
      />
    </button>
  );
}

/** The approval gate on a connector: on means the run pauses after the previous step. */
function GateButton({
  on,
  label,
  disabled,
  onToggle,
  className,
}: {
  readonly on: boolean;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'absolute flex h-7 w-7 items-center justify-center rounded-full border text-xs transition-colors disabled:cursor-not-allowed',
        on
          ? 'border-[var(--fill-accent)] bg-[var(--fill-accent)] text-white'
          : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-muted)] hover:border-[var(--fill-accent)] hover:text-[var(--text-primary)]',
        className,
      )}
    >
      <i className="ti ti-user-check text-sm" aria-hidden="true" />
    </button>
  );
}

/**
 * The workflow as a flow board: a settings node, the steps in order, and an add card, joined by
 * connectors whose circles turn the approval gates on and off. A node opens in the inspector.
 */
export function AgentWorkflowBoard({
  workflow,
  agents,
  isReadOnly = false,
  isSaving = false,
  isDirty = false,
  toolNames,
  providerOptions,
  onChange,
  onSave,
}: AgentWorkflowBoardProps): React.JSX.Element {
  const { t } = useI18n();
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const steps = workflow.steps;
  const rules = workflow.rules;
  const gateCount = steps.filter((step) => step.reviewRequired).length;

  const updateStep = (stepId: string, patch: Partial<AgentWorkflowStepDto>) =>
    onChange({
      ...workflow,
      steps: steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
    });

  const addStep = () => {
    const step: AgentWorkflowStepDto = {
      id: newId('step'),
      name: '',
      instructions: '',
      reviewRequired: false,
    };
    onChange({ ...workflow, steps: [...steps, step] });
    setOpenNode(step.id);
  };

  const removeStep = (stepId: string) => {
    onChange({ ...workflow, steps: steps.filter((step) => step.id !== stepId) });
    setOpenNode(null);
  };

  const addRule = () => {
    const rule: AgentWorkflowRuleDto = {
      id: newId('rule'),
      name: `${t('agents.workflowRule')} ${rules.length + 1}`,
      toolset: 'pbi',
      effect: 'allow',
    };
    onChange({ ...workflow, rules: [...rules, rule] });
    setOpenNode(rule.id);
  };

  const updateRule = (ruleId: string, patch: Partial<AgentWorkflowRuleDto>) =>
    onChange({
      ...workflow,
      rules: rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
    });

  const removeRule = (ruleId: string) => {
    onChange({ ...workflow, rules: rules.filter((rule) => rule.id !== ruleId) });
    setOpenNode(null);
  };

  const reorder = (fromId: string, toId: string) => {
    setDragId(null);
    setOverId(null);
    if (fromId === toId) return;
    const from = steps.findIndex((step) => step.id === fromId);
    const to = steps.findIndex((step) => step.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange({ ...workflow, steps: next });
  };

  const gateLabel = (index: number, on: boolean) =>
    on
      ? t('agents.workflowGateRemove', { number: padNumber(index + 1) })
      : t('agents.workflowGateAdd', { number: padNumber(index + 1) });

  /** The nodes in flow order: settings, every step, then the add card. */
  const nodes: readonly {
    readonly id: string;
    readonly kind: 'settings' | 'step' | 'add';
    readonly step?: AgentWorkflowStepDto;
    readonly index: number;
  }[] = [
    { id: 'settings', kind: 'settings', index: -1 },
    ...steps.map((step, index) => ({ id: step.id, kind: 'step' as const, step, index })),
    { id: 'add', kind: 'add', index: steps.length },
  ];

  /** The gate a connector carries belongs to the node before it. */
  const gateBefore = (position: number) => {
    const previous = nodes[position - 1];
    if (!previous || previous.kind !== 'step' || !previous.step) return null;
    return {
      on: previous.step.reviewRequired ?? false,
      label: gateLabel(previous.index, previous.step.reviewRequired ?? false),
      toggle: () =>
        updateStep(previous.step!.id, { reviewRequired: !previous.step!.reviewRequired }),
    };
  };

  const rows: (typeof nodes)[] = [];
  for (let index = 0; index < nodes.length; index += COLUMNS) {
    rows.push(nodes.slice(index, index + COLUMNS));
  }

  const openStep = steps.find((step) => step.id === openNode) ?? null;
  const openIndex = openStep ? steps.indexOf(openStep) : -1;
  const openRule = rules.find((rule) => rule.id === openNode) ?? null;
  const openRuleIndex = openRule ? rules.indexOf(openRule) : -1;
  const agentName = (step: AgentWorkflowStepDto) =>
    agents.find((agent) => agent.id === step.agentId)?.name ?? t('agents.workflowRequestedAgent');

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-board">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            {t('agents.workflow')}
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {t('agents.workflowSummary', { steps: steps.length, gates: gateCount })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {isDirty && (
            <span className="flex items-center gap-2 text-xs text-[var(--fill-accent)]">
              <span className="h-[7px] w-[7px] rounded-full bg-[var(--fill-accent)]" />
              {t('agents.workflowUnsaved')}
            </span>
          )}
          <div className="flex items-center gap-2.5">
            <Switch
              checked={workflow.enabled}
              label={t('agents.workflowEnabled')}
              disabled={isReadOnly}
              onChange={() => onChange({ ...workflow, enabled: !workflow.enabled })}
              testId="workflow-enabled-toggle"
            />
            <span className="text-sm text-[var(--text-secondary)]">
              {t('agents.workflowEnabled')}
            </span>
          </div>
          <Button
            type="button"
            onClick={onSave}
            isLoading={isSaving}
            disabled={isReadOnly || isSaving || !isDirty}
            data-testid="workflow-save-button"
          >
            <i className="ti ti-check mr-2 text-base" aria-hidden="true" />
            {isSaving ? t('agents.savingWorkflow') : t('agents.saveWorkflow')}
          </Button>
        </div>
      </div>

      {/* Canvas */}
      <section
        aria-label={t('agents.workflowFlow')}
        className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:20px_20px]"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {t('agents.workflowFlow')}
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--text-muted)]">
            <span>{t('agents.workflowFlowHint')}</span>
            <span className="flex items-center gap-2">
              <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--fill-accent)] text-white">
                <i className="ti ti-user-check text-[11px]" aria-hidden="true" />
              </span>
              {t('agents.workflowGateLegend')}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto px-7 pb-11 pt-8">
          <div
            className={cn(
              'flex w-full min-w-[880px] flex-col items-stretch transition-opacity',
              !workflow.enabled && 'opacity-50',
            )}
          >
            {rows.map((row, rowIndex) => {
              const returnGate = rowIndex > 0 ? gateBefore(rowIndex * COLUMNS) : null;
              return (
                <div key={`row-${rowIndex}`} className="flex flex-col items-stretch">
                  {rowIndex > 0 && (
                    /* The turn back to the left edge, drawn with borders. */
                    <div className="relative h-14 w-full">
                      <div
                        className={cn(
                          'absolute left-[calc((100%-168px)/8)] right-[calc((100%-168px)/8)] top-0 box-border h-7 border-b-2 border-r-2',
                          returnGate?.on ? 'border-[var(--fill-accent)]' : 'border-[var(--border)]',
                        )}
                      />
                      <div
                        className={cn(
                          'absolute left-[calc((100%-168px)/8)] top-7 h-[21px] border-l-2',
                          returnGate?.on ? 'border-[var(--fill-accent)]' : 'border-[var(--border)]',
                        )}
                      />
                      <i
                        className={cn(
                          'ti ti-caret-down-filled absolute left-[calc((100%-168px)/8-7px)] top-[42px] text-sm leading-none',
                          returnGate?.on ? 'text-[var(--fill-accent)]' : 'text-[var(--border)]',
                        )}
                        aria-hidden="true"
                      />
                      {returnGate && (
                        <GateButton
                          on={returnGate.on}
                          label={returnGate.label}
                          disabled={isReadOnly}
                          onToggle={returnGate.toggle}
                          className="left-[calc(50%-14px)] top-3.5"
                        />
                      )}
                    </div>
                  )}

                  <div className="flex h-[104px] w-full items-center">
                    {row.map((node, columnIndex) => {
                      const position = rowIndex * COLUMNS + columnIndex;
                      const gate = columnIndex === 0 ? null : gateBefore(position);
                      const stepAgent = node.step
                        ? agents.find((agent) => agent.id === node.step?.agentId)
                        : undefined;
                      const visual = stepAgent ? roleVisuals[stepAgent.role] : unassignedVisual;
                      return (
                        <React.Fragment key={node.id}>
                          {columnIndex > 0 && (
                            /* Connector between two nodes of the same row. */
                            <span className="relative block h-7 w-14 shrink-0">
                              <span
                                className={cn(
                                  'absolute left-0 right-[7px] top-[13px] border-t-2',
                                  node.kind === 'add' ? 'border-dashed' : 'border-solid',
                                  gate?.on
                                    ? 'border-[var(--fill-accent)]'
                                    : 'border-[var(--border)]',
                                )}
                              />
                              <i
                                className={cn(
                                  'ti ti-caret-right-filled absolute right-0 top-[5px] text-sm leading-none',
                                  gate?.on ? 'text-[var(--fill-accent)]' : 'text-[var(--border)]',
                                )}
                                aria-hidden="true"
                              />
                              {gate && (
                                <GateButton
                                  on={gate.on}
                                  label={gate.label}
                                  disabled={isReadOnly}
                                  onToggle={gate.toggle}
                                  className="left-3 top-0"
                                />
                              )}
                            </span>
                          )}

                          {node.kind === 'add' ? (
                            <button
                              type="button"
                              onClick={addStep}
                              disabled={isReadOnly || steps.length >= 20}
                              style={{ width: NODE_WIDTH }}
                              data-testid="workflow-add-step"
                              className="flex h-[104px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-[var(--border)] text-sm font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--fill-accent)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <i className="ti ti-plus text-xl" aria-hidden="true" />
                              {t('agents.addWorkflowStep')}
                            </button>
                          ) : (
                            <div
                              draggable={node.kind === 'step' && !isReadOnly}
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', node.id);
                                setDragId(node.id);
                              }}
                              onDragOver={(event) => {
                                if (!dragId || node.kind !== 'step') return;
                                event.preventDefault();
                                if (overId !== node.id) setOverId(node.id);
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                if (dragId && node.kind === 'step') reorder(dragId, node.id);
                              }}
                              onDragEnd={() => {
                                setDragId(null);
                                setOverId(null);
                              }}
                              style={{ width: NODE_WIDTH }}
                              className={cn(
                                'relative h-[104px] shrink-0 rounded-xl',
                                node.kind === 'step' &&
                                  !isReadOnly &&
                                  'cursor-grab active:cursor-grabbing',
                                dragId === node.id && 'opacity-40',
                                overId === node.id &&
                                  dragId &&
                                  dragId !== node.id &&
                                  'outline outline-2 outline-offset-4 outline-dashed outline-[var(--fill-accent)]',
                              )}
                            >
                              <button
                                type="button"
                                aria-pressed={openNode === node.id}
                                onClick={() => setOpenNode(node.id)}
                                data-testid={
                                  node.kind === 'settings'
                                    ? 'workflow-settings-node'
                                    : `workflow-step-node-${node.index + 1}`
                                }
                                className={cn(
                                  'flex h-[104px] w-full items-start gap-3 border-[1.5px] bg-[var(--surface-2)] p-3.5 text-left transition-colors hover:border-[var(--fill-accent)]',
                                  node.kind === 'settings'
                                    ? 'rounded-l-[36px] rounded-r-xl'
                                    : 'rounded-xl',
                                  openNode === node.id
                                    ? 'border-[var(--fill-accent)] ring-4 ring-[var(--fill-accent)]/15'
                                    : 'border-[var(--border)]',
                                )}
                              >
                                <span
                                  className={cn(
                                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]',
                                    node.kind === 'settings'
                                      ? 'bg-[var(--surface-1)] text-[var(--text-secondary)]'
                                      : visual.className,
                                  )}
                                >
                                  <i
                                    className={cn(
                                      'ti text-lg',
                                      node.kind === 'settings' ? 'ti-adjustments' : visual.icon,
                                    )}
                                    aria-hidden="true"
                                  />
                                </span>
                                <span className="flex min-w-0 flex-col gap-0.5">
                                  <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                                    {node.kind === 'settings'
                                      ? t('agents.workflowSetup')
                                      : t('agents.workflowStep', {
                                          number: padNumber(node.index + 1),
                                        })}
                                  </span>
                                  <span className="line-clamp-2 text-sm font-semibold text-[var(--text-primary)]">
                                    {node.kind === 'settings'
                                      ? t('agents.workflowSettings')
                                      : node.step?.name || t('agents.workflowUntitledStep')}
                                  </span>
                                  <span className="truncate text-xs text-[var(--text-secondary)]">
                                    {node.kind === 'settings'
                                      ? t('agents.workflowControls')
                                      : agentName(node.step!)}
                                  </span>
                                </span>
                              </button>
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Module rules: nodes of the same board, opened and added like the steps. */}
        <div className="flex flex-col gap-4 overflow-x-auto border-t border-[var(--border)] px-7 pb-8 pt-6">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {t('agents.workflowRules')}
          </span>
          <div className="flex min-w-[880px] flex-wrap gap-x-14 gap-y-5">
            {rules.map((rule, index) => (
              <button
                key={rule.id}
                type="button"
                aria-pressed={openNode === rule.id}
                onClick={() => setOpenNode(rule.id)}
                style={{ width: NODE_WIDTH }}
                data-testid={`workflow-rule-node-${index + 1}`}
                className={cn(
                  'flex h-[104px] shrink-0 items-start gap-3 rounded-xl border-[1.5px] bg-[var(--surface-2)] p-3.5 text-left transition-colors hover:border-[var(--fill-accent)]',
                  openNode === rule.id
                    ? 'border-[var(--fill-accent)] ring-4 ring-[var(--fill-accent)]/15'
                    : 'border-[var(--border)]',
                )}
              >
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]',
                    rule.effect === 'deny'
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-[var(--fill-accent)]/15 text-[var(--fill-accent)]',
                  )}
                >
                  <i
                    className={cn(
                      'ti text-lg',
                      rule.effect === 'deny' ? 'ti-shield-x' : 'ti-shield-check',
                    )}
                    aria-hidden="true"
                  />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    {t('agents.workflowRuleNumber', { number: padNumber(index + 1) })}
                  </span>
                  <span className="line-clamp-2 text-sm font-semibold text-[var(--text-primary)]">
                    {rule.name || t('agents.workflowRule')}
                  </span>
                  <span className="truncate text-xs text-[var(--text-secondary)]">
                    {`${t(toolsetLabels[rule.toolset])} · ${
                      rule.effect === 'deny'
                        ? t('agents.workflowActionBlocked')
                        : t('agents.workflowActionAllowed')
                    }`}
                  </span>
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={addRule}
              disabled={isReadOnly || rules.length >= 100}
              style={{ width: NODE_WIDTH }}
              data-testid="workflow-add-rule"
              className="flex h-[104px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-[var(--border)] text-sm font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--fill-accent)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <i className="ti ti-plus text-xl" aria-hidden="true" />
              {t('agents.workflowAddRule')}
            </button>
          </div>
        </div>
      </section>

      {/* Inspector */}
      <Modal
        open={openNode !== null}
        onClose={() => setOpenNode(null)}
        labelledBy="workflow-inspector-title"
      >
        <div
          className="w-[780px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] shadow-2xl"
          data-testid="workflow-inspector"
        >
          {openStep ? (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-5">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    {t('agents.workflowStepOf', {
                      number: padNumber(openIndex + 1),
                      total: padNumber(steps.length),
                    })}
                  </span>
                  <h2
                    id="workflow-inspector-title"
                    className="break-words text-base font-semibold text-[var(--text-primary)]"
                  >
                    {openStep.name || t('agents.workflowUntitledStep')}
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    variant="subtle"
                    size="sm"
                    icon={<i className="ti ti-trash" aria-hidden="true" />}
                    label={t('agents.removeWorkflowStep', { number: openIndex + 1 })}
                    disabled={isReadOnly}
                    onClick={() => removeStep(openStep.id)}
                    className="text-red-400"
                  />
                  <IconButton
                    variant="subtle"
                    size="sm"
                    icon={<i className="ti ti-x" aria-hidden="true" />}
                    label={t('common.close')}
                    onClick={() => setOpenNode(null)}
                  />
                </div>
              </div>

              <div className="flex max-h-[calc(100vh-14rem)] flex-col gap-4 overflow-y-auto p-5">
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowStepName')}
                  <Input
                    value={openStep.name}
                    placeholder={t('agents.workflowStepNamePlaceholder')}
                    disabled={isReadOnly}
                    onChange={(event) => updateStep(openStep.id, { name: event.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowAgent')}
                  <Select
                    value={openStep.agentId ?? ''}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      updateStep(openStep.id, { agentId: event.target.value || undefined })
                    }
                  >
                    <option value="">{t('agents.workflowRequestedAgent')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowInstructions')}
                  <Textarea
                    value={openStep.instructions}
                    rows={14}
                    placeholder={t('agents.workflowInstructionsPlaceholder')}
                    disabled={isReadOnly}
                    className="min-h-[340px] font-mono text-xs leading-relaxed"
                    onChange={(event) =>
                      updateStep(openStep.id, { instructions: event.target.value })
                    }
                  />
                </label>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {t('agents.workflowStepReview')}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]">
                      {t('agents.workflowStepReviewHint')}
                    </span>
                  </div>
                  <Switch
                    checked={openStep.reviewRequired ?? false}
                    label={t('agents.workflowStepReview')}
                    disabled={isReadOnly}
                    onChange={() =>
                      updateStep(openStep.id, { reviewRequired: !openStep.reviewRequired })
                    }
                  />
                </div>
              </div>
            </>
          ) : openRule ? (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-5">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    {t('agents.workflowRuleNumber', { number: padNumber(openRuleIndex + 1) })}
                  </span>
                  <h2
                    id="workflow-inspector-title"
                    className="break-words text-base font-semibold text-[var(--text-primary)]"
                  >
                    {openRule.name || t('agents.workflowRule')}
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    variant="subtle"
                    size="sm"
                    icon={<i className="ti ti-trash" aria-hidden="true" />}
                    label={t('agents.workflowRemoveRule', { name: openRule.name })}
                    disabled={isReadOnly}
                    onClick={() => removeRule(openRule.id)}
                    className="text-red-400"
                  />
                  <IconButton
                    variant="subtle"
                    size="sm"
                    icon={<i className="ti ti-x" aria-hidden="true" />}
                    label={t('common.close')}
                    onClick={() => setOpenNode(null)}
                  />
                </div>
              </div>

              <div className="flex max-h-[calc(100vh-14rem)] flex-col gap-4 overflow-y-auto p-5">
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowRuleName')}
                  <Input
                    value={openRule.name}
                    disabled={isReadOnly}
                    onChange={(event) => updateRule(openRule.id, { name: event.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowRuleModule')}
                  <Select
                    value={openRule.toolset}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      updateRule(openRule.id, {
                        toolset: event.target.value as AgentWorkflowToolset,
                      })
                    }
                  >
                    {(Object.keys(toolsetLabels) as AgentWorkflowToolset[]).map((toolset) => (
                      <option key={toolset} value={toolset}>
                        {t(toolsetLabels[toolset])}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowRuleAction')}
                  <Input
                    value={openRule.toolName ?? ''}
                    list={`workflow-actions-${openRule.id}`}
                    placeholder={t('agents.workflowAllActions')}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      updateRule(openRule.id, { toolName: event.target.value.trim() || undefined })
                    }
                  />
                  <datalist id={`workflow-actions-${openRule.id}`}>
                    {toolNames[openRule.toolset].map((toolName) => (
                      <option key={toolName} value={toolName} />
                    ))}
                  </datalist>
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowAllowedProviders')}
                  <Input
                    value={(openRule.allowedProviders ?? []).join(', ')}
                    list={`workflow-providers-${openRule.id}`}
                    placeholder={t('agents.workflowAllProviders')}
                    disabled={isReadOnly || !openRule.toolName}
                    onChange={(event) => {
                      const providers = event.target.value
                        .split(',')
                        .map((provider) => provider.trim())
                        .filter(Boolean);
                      updateRule(openRule.id, {
                        allowedProviders: providers.length ? [...new Set(providers)] : undefined,
                      });
                    }}
                  />
                  <datalist id={`workflow-providers-${openRule.id}`}>
                    {providerOptions.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </datalist>
                </label>

                <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {t('agents.workflowRequireApproval')}
                  </span>
                  <Switch
                    checked={openRule.requireApproval ?? false}
                    label={t('agents.workflowRequireApproval')}
                    disabled={isReadOnly}
                    onChange={() =>
                      updateRule(openRule.id, { requireApproval: !openRule.requireApproval })
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {t('agents.workflowCreateIssuePerAction')}
                  </span>
                  <Switch
                    checked={openRule.createIssueForAction ?? false}
                    label={t('agents.workflowCreateIssuePerAction')}
                    disabled={isReadOnly}
                    onChange={() =>
                      updateRule(openRule.id, {
                        createIssueForAction: !openRule.createIssueForAction,
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {t('agents.workflowBlockAction')}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]">
                      {openRule.effect === 'deny'
                        ? t('agents.workflowActionBlocked')
                        : t('agents.workflowActionAllowed')}
                    </span>
                  </div>
                  <Switch
                    checked={openRule.effect === 'deny'}
                    label={t('agents.workflowBlockAction')}
                    disabled={isReadOnly}
                    onChange={() =>
                      updateRule(openRule.id, {
                        effect: openRule.effect === 'deny' ? 'allow' : 'deny',
                      })
                    }
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start gap-3 border-b border-[var(--border)] p-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-1)] text-[var(--text-secondary)]">
                  <i className="ti ti-adjustments text-lg" aria-hidden="true" />
                </span>
                <div className="flex flex-col gap-1">
                  <h2
                    id="workflow-inspector-title"
                    className="text-base font-semibold text-[var(--text-primary)]"
                  >
                    {t('agents.workflowControls')}
                  </h2>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {t('agents.workflowDescription')}
                  </span>
                </div>
                <IconButton
                  variant="subtle"
                  size="sm"
                  icon={<i className="ti ti-x" aria-hidden="true" />}
                  label={t('common.close')}
                  onClick={() => setOpenNode(null)}
                  className="ml-auto shrink-0"
                />
              </div>

              <div className="flex max-h-[calc(100vh-14rem)] flex-col gap-4 overflow-y-auto p-5">
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowAutonomy')}
                  <Select
                    value={workflow.autonomy}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      onChange({
                        ...workflow,
                        autonomy: event.target.value as AgentWorkflowDto['autonomy'],
                      })
                    }
                  >
                    <option value="supervised">{t('agents.workflowAutonomySupervised')}</option>
                    <option value="balanced">{t('agents.workflowAutonomyBalanced')}</option>
                    <option value="autonomous">{t('agents.workflowAutonomyAutonomous')}</option>
                  </Select>
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowUncertainty')}
                  <Select
                    value={workflow.uncertaintyBehavior}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      onChange({
                        ...workflow,
                        uncertaintyBehavior: event.target
                          .value as AgentWorkflowDto['uncertaintyBehavior'],
                      })
                    }
                  >
                    <option value="ask">{t('agents.workflowUncertaintyAsk')}</option>
                    <option value="assume">{t('agents.workflowUncertaintyAssume')}</option>
                  </Select>
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowIssueCreation')}
                  <Select
                    value={workflow.issueCreationBehavior}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      onChange({
                        ...workflow,
                        issueCreationBehavior: event.target
                          .value as AgentWorkflowDto['issueCreationBehavior'],
                      })
                    }
                  >
                    <option value="ask">{t('agents.workflowIssueCreationAsk')}</option>
                    <option value="allow">{t('agents.workflowIssueCreationAllow')}</option>
                  </Select>
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  {t('agents.workflowDefaultAction')}
                  <Select
                    value={workflow.defaultAction}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      onChange({
                        ...workflow,
                        defaultAction: event.target.value as AgentWorkflowDto['defaultAction'],
                      })
                    }
                  >
                    <option value="allow">{t('agents.workflowDefaultAllow')}</option>
                    <option value="deny">{t('agents.workflowDefaultDeny')}</option>
                  </Select>
                </label>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {t('agents.workflowFinalReview')}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]">
                      {t('agents.workflowFinalReviewHint')}
                    </span>
                  </div>
                  <Switch
                    checked={workflow.finalReview}
                    label={t('agents.workflowFinalReview')}
                    disabled={isReadOnly}
                    onChange={() => onChange({ ...workflow, finalReview: !workflow.finalReview })}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
