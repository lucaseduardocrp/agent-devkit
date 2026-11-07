import React, { useMemo, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/index.js';
import { NotificationSection } from '../notifications/NotificationSection.js';
import type { NotificationOptions } from '../notifications/notification-types.js';
import { AgentWorkflowCanvas, type WorkflowNodeView } from './AgentWorkflowCanvas.js';
import {
  InspectorField,
  InspectorFrame,
  InspectorSwitchRow,
} from './AgentWorkflowInspectorFrame.js';
import { AgentWorkflowNodeInspector } from './AgentWorkflowNodeInspector.js';
import { configNodeSubtitle, toolsetLabels } from './workflow-labels.js';
import {
  ADDABLE_NODE_KINDS,
  addNode,
  applyGraph,
  connectNodes,
  countApprovalGates,
  disconnectEdge,
  findChainTail,
  findNode,
  incompleteNodes,
  isNotificationAction,
  moveNode,
  newWorkflowId,
  normalizeGraph,
  NOTIFICATION_ACTION,
  removeNode,
  updateNode,
  WORKFLOW_PRODUCT_EVENTS,
  WORKFLOW_TRIGGER_NODE_ID,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowPort,
  type WorkflowProductEvent,
  type WorkflowTriggerKind,
} from './workflow-graph.js';
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
  /** Channels and members for the notifications action of a node. */
  readonly notificationOptions?: NotificationOptions;
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

/** Rule card width: the row minus its three 56px gaps, split evenly. */

/** The palette entry of each node kind the canvas can add. */
const nodeKindVisuals: Record<
  WorkflowNodeKind,
  { readonly icon: string; readonly className: string; readonly label: TranslationKey }
> = {
  trigger: {
    icon: 'ti-bolt-filled',
    className: 'bg-[var(--fill-warning)]/15 text-[var(--text-warning)]',
    label: 'agents.workflowTriggerNode',
  },
  step: {
    icon: 'ti-bolt',
    className: 'bg-amber-500/15 text-amber-300',
    label: 'agents.addWorkflowStep',
  },
  approval: {
    icon: 'ti-user-check',
    className: 'bg-[var(--fill-accent)]/15 text-[var(--fill-accent)]',
    label: 'agents.workflowApprovalNode',
  },
  action: {
    icon: 'ti-plug-connected',
    className: 'bg-[var(--fill-success)]/15 text-[var(--text-success)]',
    label: 'agents.workflowActionNode',
  },
  condition: {
    icon: 'ti-git-branch',
    className: 'bg-[var(--fill-pro)]/15 text-[var(--text-pro)]',
    label: 'agents.workflowConditionNode',
  },
  rule: {
    icon: 'ti-shield-check',
    className: 'bg-[var(--fill-accent)]/15 text-[var(--fill-accent)]',
    label: 'agents.workflowAddRule',
  },
  delay: {
    icon: 'ti-clock-pause',
    className: 'bg-[var(--surface-1)] text-[var(--text-secondary)]',
    label: 'agents.workflowDelayNode',
  },
};

/**
 * A notification is an action node that starts out as `notifications_send`, so it has its own look
 * and its own palette entry while it is stored and run like any other action.
 */
const notificationVisual = {
  icon: 'ti-bell',
  className: 'bg-sky-500/15 text-sky-300',
  label: 'agents.workflowNotificationNode' as TranslationKey,
};

type PaletteEntry = (typeof ADDABLE_NODE_KINDS)[number] | 'notification';

/** The palette in display order: the notification sits right after the module action. */
const PALETTE: readonly PaletteEntry[] = ADDABLE_NODE_KINDS.flatMap((kind) =>
  kind === 'action' ? [kind, 'notification' as const] : [kind],
);

const paletteVisual = (entry: PaletteEntry) =>
  entry === 'notification' ? notificationVisual : nodeKindVisuals[entry];

/** The icon, colours and name of a node: a notification action looks like a notification. */
const visualOfNode = (node: WorkflowNode) =>
  node.kind === 'action' && isNotificationAction(node.action)
    ? notificationVisual
    : nodeKindVisuals[node.kind];

const triggerKinds: readonly WorkflowTriggerKind[] = [
  'issue-assigned',
  'product-event',
  'schedule',
];

const triggerLabels: Record<WorkflowTriggerKind, TranslationKey> = {
  'issue-assigned': 'agents.workflowTriggerIssueAssigned',
  'product-event': 'agents.workflowTriggerProductEvent',
  schedule: 'agents.workflowTriggerSchedule',
};

const productEventLabels: Record<WorkflowProductEvent, TranslationKey> = {
  'pbi.created': 'agents.workflowEventPbiCreated',
  'pbi.moved': 'agents.workflowEventPbiMoved',
  'spec.published': 'agents.workflowEventSpecPublished',
  'issue.commented': 'agents.workflowEventIssueCommented',
};

const padNumber = (value: number) => (value < 10 ? `0${value}` : String(value));

/** What a canvas node shows, by kind; shared by the editor and the read-only run view. */
export function describeWorkflowNode(
  node: WorkflowNode,
  steps: readonly AgentWorkflowStepDto[],
  agents: readonly CustomAgentDto[],
  rules: readonly AgentWorkflowRuleDto[],
  t: ReturnType<typeof useI18n>['t'],
): WorkflowNodeView {
  const agentName = (step: AgentWorkflowStepDto) =>
    agents.find((agent) => agent.id === step.agentId)?.name ?? t('agents.workflowRequestedAgent');

  /** What each canvas node shows, by kind. */
  return ((node: WorkflowNode): WorkflowNodeView => {
    const visual = visualOfNode(node);
    const chrome = { icon: visual.icon, iconClassName: visual.className };
    switch (node.kind) {
      case 'rule': {
        const index = rules.findIndex((rule) => rule.id === node.id);
        const rule = rules[index];
        const denied = rule?.effect === 'deny';
        return {
          icon: denied ? 'ti-shield-x' : 'ti-shield-check',
          iconClassName: denied
            ? 'bg-red-500/15 text-red-300'
            : 'bg-[var(--fill-accent)]/15 text-[var(--fill-accent)]',
          kicker: t('agents.workflowRuleNumber', { number: padNumber(index + 1) }),
          title: rule?.name || t('agents.workflowRule'),
          subtitle: rule
            ? `${t(toolsetLabels[rule.toolset])} · ${
                denied ? t('agents.workflowActionBlocked') : t('agents.workflowActionAllowed')
              }`
            : '',
        };
      }
      case 'approval':
        return {
          ...chrome,
          kicker: t('agents.workflowApproval'),
          title: t('agents.workflowApprovalNode'),
          subtitle: t('agents.workflowApprovalNodeHint'),
        };
      case 'trigger':
        return {
          ...chrome,
          kicker: t('agents.workflowTrigger'),
          title: t(triggerLabels[node.trigger.kind]),
          subtitle:
            node.trigger.kind === 'schedule'
              ? (node.trigger.cron ?? '')
              : node.trigger.kind === 'product-event'
                ? (node.trigger.events ?? [])
                    .map((event) => t(productEventLabels[event]))
                    .join(', ')
                : t('agents.workflowControls'),
        };
      case 'action':
        if (isNotificationAction(node.action)) {
          return {
            ...chrome,
            kicker: t('agents.workflowNotificationNode'),
            title: node.action.notification?.subject || t('agents.workflowNotificationNode'),
            subtitle:
              node.action.notification?.channels.join(', ') ||
              t('agents.workflowNotificationNoChannels'),
          };
        }
        return {
          ...chrome,
          kicker: t(toolsetLabels[node.action.toolset]),
          title: node.action.toolName ?? t('agents.workflowActionNode'),
          subtitle: node.action.provider ?? t('agents.workflowAllProviders'),
        };
      case 'condition':
        return {
          ...chrome,
          kicker: t('agents.workflowConditionNode'),
          title: node.condition.value || t('agents.workflowConditionNode'),
          subtitle: t('agents.workflowConditionBranches'),
        };
      case 'delay':
        return {
          ...chrome,
          kicker: t('agents.workflowDelayNode'),
          title: t('agents.workflowDelayOf', { minutes: node.delay.minutes }),
          subtitle: t('agents.workflowDelayNodeSubtitle'),
        };
      default: {
        const index = steps.findIndex((step) => step.id === node.id);
        const step = steps[index]!;
        const stepAgent = agents.find((agent) => agent.id === step.agentId);
        const stepVisual = stepAgent ? roleVisuals[stepAgent.role] : unassignedVisual;
        return {
          icon: stepVisual.icon,
          iconClassName: stepVisual.className,
          kicker: t('agents.workflowStep', { number: padNumber(index + 1) }),
          title: step.name || t('agents.workflowUntitledStep'),
          subtitle: agentName(step),
        };
      }
    }
  })(node);
}

/**
 * The workflow as a free flow canvas: a settings node, the steps, and the approval nodes, each
 * sitting where it was dropped and wired to as many others as the flow needs. A click on a node
 * opens it in the inspector; a step whose output reaches an approval node pauses the run.
 */
export function AgentWorkflowBoard({
  workflow,
  agents,
  isReadOnly = false,
  isSaving = false,
  isDirty = false,
  toolNames,
  providerOptions,
  notificationOptions,
  onChange,
  onSave,
}: AgentWorkflowBoardProps): React.JSX.Element {
  const { t } = useI18n();
  const [openNode, setOpenNode] = useState<string | null>(null);

  const steps = workflow.steps;
  const rules = workflow.rules;
  const gateCount = countApprovalGates(steps);
  /** The canvas as stored, repaired against the steps the workflow actually has. */
  const graph = useMemo(() => normalizeGraph(workflow), [workflow]);

  /** Every canvas change re-derives the step order and the approval gates from the connections. */
  const commitGraph = (next: WorkflowGraph, base: AgentWorkflowDto = workflow) =>
    onChange(applyGraph(base, next));

  const updateStep = (stepId: string, patch: Partial<AgentWorkflowStepDto>) =>
    onChange({
      ...workflow,
      steps: steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
    });

  /** New nodes continue the open end of the flow, so adding one does not leave it stranded. */
  const appendNode = (
    id: string,
    kind: WorkflowNodeKind,
    base: AgentWorkflowDto,
    action?: typeof NOTIFICATION_ACTION,
  ) => {
    const placed = addNode(graph, id, kind, action);
    const tail = findChainTail(graph);
    commitGraph(tail ? connectNodes(placed, tail, id) : placed, base);
  };

  /** A step is the only node kind that also carries a record outside the canvas. */
  const addNodeOfKind = (kind: PaletteEntry) => {
    if (kind === 'rule') {
      addRule();
      return;
    }
    if (kind === 'notification') {
      const id = newWorkflowId('notification');
      appendNode(id, 'action', workflow, NOTIFICATION_ACTION);
      setOpenNode(id);
      return;
    }
    if (kind !== 'step') {
      const id = newWorkflowId(kind);
      appendNode(id, kind, workflow);
      setOpenNode(id);
      return;
    }
    const step: AgentWorkflowStepDto = {
      id: newWorkflowId('step'),
      name: '',
      instructions: '',
      reviewRequired: false,
    };
    appendNode(step.id, 'step', { ...workflow, steps: [...steps, step] });
    setOpenNode(step.id);
  };

  const removeStep = (stepId: string) => {
    commitGraph(removeNode(graph, stepId), {
      ...workflow,
      steps: steps.filter((step) => step.id !== stepId),
    });
    setOpenNode(null);
  };

  /** A node removed from the canvas takes its step with it; an approval node is only a node. */
  const removeCanvasNode = (nodeId: string) => {
    if (rules.some((rule) => rule.id === nodeId)) {
      removeRule(nodeId);
      return;
    }
    if (steps.some((step) => step.id === nodeId)) {
      removeStep(nodeId);
      return;
    }
    commitGraph(removeNode(graph, nodeId));
    if (openNode === nodeId) setOpenNode(null);
  };

  const addRule = () => {
    const rule: AgentWorkflowRuleDto = {
      id: newWorkflowId('rule'),
      name: `${t('agents.workflowRule')} ${rules.length + 1}`,
      toolset: 'pbi',
      effect: 'allow',
    };
    commitGraph(addNode(graph, rule.id, 'rule'), { ...workflow, rules: [...rules, rule] });
    setOpenNode(rule.id);
  };

  const updateRule = (ruleId: string, patch: Partial<AgentWorkflowRuleDto>) =>
    onChange({
      ...workflow,
      rules: rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
    });

  const removeRule = (ruleId: string) => {
    commitGraph(removeNode(graph, ruleId), {
      ...workflow,
      rules: rules.filter((rule) => rule.id !== ruleId),
    });
    setOpenNode(null);
  };

  const describeNode = (node: WorkflowNode): WorkflowNodeView =>
    describeWorkflowNode(node, steps, agents, rules, t);

  const openStep = steps.find((step) => step.id === openNode) ?? null;
  const openIndex = openStep ? steps.indexOf(openStep) : -1;
  const openRule = rules.find((rule) => rule.id === openNode) ?? null;
  const openRuleIndex = openRule ? rules.indexOf(openRule) : -1;
  /** An action, condition or delay node, which edits its configuration on the graph itself. */
  const openConfigNode =
    openNode !== null && openStep === null
      ? ((node) =>
          node && (node.kind === 'action' || node.kind === 'condition' || node.kind === 'delay')
            ? node
            : null)(findNode(graph, openNode))
      : null;
  // normalizeGraph always leaves a trigger node on the canvas, carrying its configuration.
  const triggerNode = findNode(graph, WORKFLOW_TRIGGER_NODE_ID) as Extract<
    WorkflowNode,
    { kind: 'trigger' }
  >;
  const trigger = triggerNode.trigger;
  const isInspectorOpen =
    openNode !== null &&
    (openStep !== null ||
      openRule !== null ||
      openConfigNode !== null ||
      openNode === WORKFLOW_TRIGGER_NODE_ID);
  /** Nodes that cannot run as configured; saving is refused while any remains. */
  const problems = incompleteNodes(graph);

  /** The icon and colours of a step or a rule node, as the canvas draws it. */
  const nodeView = (id: string) => describeNode(findNode(graph, id)!);
  const closeInspector = () => setOpenNode(null);
  const inspectorTitleId = 'workflow-inspector-title';

  /** What the canvas toolbar offers on the right: the state of the flow and the way to save it. */
  const toolbarActions = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:border-l sm:border-[var(--border)] sm:pl-4">
      {isDirty && (
        <span className="flex items-center gap-2 text-xs text-[var(--fill-accent)]">
          <span className="h-[7px] w-[7px] rounded-full bg-[var(--fill-accent)]" />
          {t('agents.workflowUnsaved')}
        </span>
      )}
      <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Switch
          aria-label={t('agents.workflowEnabled')}
          checked={workflow.enabled}
          disabled={isReadOnly}
          onChange={() => onChange({ ...workflow, enabled: !workflow.enabled })}
          data-testid="workflow-enabled-toggle"
        />
        {t('agents.workflowEnabled')}
      </label>
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        isLoading={isSaving}
        disabled={isReadOnly || isSaving || !isDirty || problems.length > 0}
        data-testid="workflow-save-button"
      >
        <i className="ti ti-check text-sm" aria-hidden="true" />
        {isSaving ? t('agents.savingWorkflow') : t('agents.saveWorkflow')}
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workflow-board">
      {/*
        One card, and the canvas takes the height that is left: the toolbar, the flow and the
        palette are all in view at once, whatever the size of the screen.
      */}
      <section
        aria-label={t('agents.workflowFlow')}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
      >
        <AgentWorkflowCanvas
          graph={graph}
          isReadOnly={isReadOnly}
          isDimmed={!workflow.enabled}
          canvasClassName="h-auto min-h-0 flex-1"
          heading={
            <span className="text-sm font-medium text-[var(--text-secondary)]">
              {t('agents.workflowSummary', { steps: steps.length, gates: gateCount })}
            </span>
          }
          toolbarActions={toolbarActions}
          selectedNodeId={openNode}
          describeNode={describeNode}
          onOpenNode={setOpenNode}
          onMoveNode={(id, x, y) => commitGraph(moveNode(graph, id, x, y))}
          onRemoveNode={removeCanvasNode}
          onConnect={(from: string, to: string, port?: WorkflowPort) =>
            commitGraph(connectNodes(graph, from, to, port))
          }
          onDisconnect={(edgeId) => commitGraph(disconnectEdge(graph, edgeId))}
        />

        {/* Palette: the nodes that can be dropped on the canvas. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
          {PALETTE.map((kind) => (
            <Button
              key={kind}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addNodeOfKind(kind)}
              disabled={
                isReadOnly ||
                (kind === 'step' && steps.length >= 20) ||
                (kind === 'rule' && rules.length >= 100)
              }
              data-testid={`workflow-add-${kind}`}
            >
              <i className={cn('ti text-base', paletteVisual(kind).icon)} aria-hidden="true" />
              {t(paletteVisual(kind).label)}
            </Button>
          ))}
          {problems.length > 0 && (
            <span
              className="flex items-center gap-2 text-xs text-[var(--text-warning)]"
              data-testid="workflow-incomplete-warning"
            >
              <i className="ti ti-alert-triangle text-sm" aria-hidden="true" />
              {t('agents.workflowIncompleteNodes', { count: problems.length })}
            </span>
          )}
        </div>
      </section>

      {/* Inspector */}
      <Modal open={isInspectorOpen} onClose={closeInspector} labelledBy={inspectorTitleId}>
        {openStep ? (
          <InspectorFrame
            titleId={inspectorTitleId}
            size="lg"
            icon={nodeView(openStep.id).icon}
            iconClassName={nodeView(openStep.id).iconClassName}
            kicker={t('agents.workflowStepOf', {
              number: padNumber(openIndex + 1),
              total: padNumber(steps.length),
            })}
            title={openStep.name || t('agents.workflowUntitledStep')}
            removeLabel={t('agents.removeWorkflowStep', { number: openIndex + 1 })}
            isReadOnly={isReadOnly}
            onRemove={() => removeStep(openStep.id)}
            onClose={closeInspector}
          >
            <InspectorField label={t('agents.workflowStepName')}>
              <Input
                value={openStep.name}
                placeholder={t('agents.workflowStepNamePlaceholder')}
                disabled={isReadOnly}
                onChange={(event) => updateStep(openStep.id, { name: event.target.value })}
              />
            </InspectorField>
            <InspectorField label={t('agents.workflowAgent')}>
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
            </InspectorField>
            <InspectorField label={t('agents.workflowInstructions')}>
              <Textarea
                value={openStep.instructions}
                rows={10}
                placeholder={t('agents.workflowInstructionsPlaceholder')}
                disabled={isReadOnly}
                className="min-h-[200px] font-mono text-xs leading-relaxed"
                onChange={(event) => updateStep(openStep.id, { instructions: event.target.value })}
              />
            </InspectorField>
          </InspectorFrame>
        ) : openRule ? (
          <InspectorFrame
            titleId={inspectorTitleId}
            size="lg"
            icon={nodeView(openRule.id).icon}
            iconClassName={nodeView(openRule.id).iconClassName}
            kicker={t('agents.workflowRuleNumber', { number: padNumber(openRuleIndex + 1) })}
            title={openRule.name || t('agents.workflowRule')}
            removeLabel={t('agents.workflowRemoveRule', { name: openRule.name })}
            isReadOnly={isReadOnly}
            onRemove={() => removeRule(openRule.id)}
            onClose={closeInspector}
          >
            <InspectorField label={t('agents.workflowRuleName')}>
              <Input
                value={openRule.name}
                disabled={isReadOnly}
                onChange={(event) => updateRule(openRule.id, { name: event.target.value })}
              />
            </InspectorField>
            <InspectorField label={t('agents.workflowRuleModule')}>
              <Select
                value={openRule.toolset}
                disabled={isReadOnly}
                onChange={(event) =>
                  updateRule(openRule.id, { toolset: event.target.value as AgentWorkflowToolset })
                }
              >
                {(Object.keys(toolsetLabels) as AgentWorkflowToolset[]).map((toolset) => (
                  <option key={toolset} value={toolset}>
                    {t(toolsetLabels[toolset])}
                  </option>
                ))}
              </Select>
            </InspectorField>
            <InspectorField label={t('agents.workflowRuleAction')}>
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
            </InspectorField>
            <InspectorField label={t('agents.workflowAllowedProviders')}>
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
            </InspectorField>

            <InspectorSwitchRow
              label={t('agents.workflowRequireApproval')}
              checked={openRule.requireApproval ?? false}
              disabled={isReadOnly}
              onChange={(checked) => updateRule(openRule.id, { requireApproval: checked })}
            />
            <InspectorSwitchRow
              label={t('agents.workflowCreateIssuePerAction')}
              checked={openRule.createIssueForAction ?? false}
              disabled={isReadOnly}
              onChange={(checked) => updateRule(openRule.id, { createIssueForAction: checked })}
            />
            <InspectorSwitchRow
              label={t('agents.workflowBlockAction')}
              hint={
                openRule.effect === 'deny'
                  ? t('agents.workflowActionBlocked')
                  : t('agents.workflowActionAllowed')
              }
              checked={openRule.effect === 'deny'}
              disabled={isReadOnly}
              onChange={(checked) =>
                updateRule(openRule.id, { effect: checked ? 'deny' : 'allow' })
              }
            />
          </InspectorFrame>
        ) : openConfigNode ? (
          <InspectorFrame
            titleId={inspectorTitleId}
            icon={visualOfNode(openConfigNode).icon}
            iconClassName={visualOfNode(openConfigNode).className}
            title={t(visualOfNode(openConfigNode).label)}
            subtitle={configNodeSubtitle(openConfigNode, t)}
            removeLabel={t('agents.workflowRemoveNode', {
              name: t(visualOfNode(openConfigNode).label),
            })}
            isReadOnly={isReadOnly}
            onRemove={() => removeCanvasNode(openConfigNode.id)}
            onClose={closeInspector}
          >
            <AgentWorkflowNodeInspector
              node={openConfigNode}
              isReadOnly={isReadOnly}
              toolNames={toolNames}
              providerOptions={providerOptions}
              {...(notificationOptions ? { notificationOptions } : {})}
              onChange={(next) => commitGraph(updateNode(graph, next))}
            />
          </InspectorFrame>
        ) : (
          <InspectorFrame
            titleId={inspectorTitleId}
            size="lg"
            icon={nodeKindVisuals.trigger.icon}
            iconClassName={nodeKindVisuals.trigger.className}
            title={t('agents.workflowTriggerNode')}
            subtitle={t('agents.workflowDescription')}
            onClose={closeInspector}
          >
            <div className="flex flex-col gap-6" data-testid="workflow-trigger-inspector">
              <NotificationSection>
                <InspectorField label={t('agents.workflowTriggerKind')}>
                  <Select
                    value={trigger.kind}
                    disabled={isReadOnly}
                    onChange={(event) =>
                      commitGraph(
                        updateNode(graph, {
                          ...triggerNode,
                          trigger: {
                            ...trigger,
                            kind: event.target.value as WorkflowTriggerKind,
                          },
                        }),
                      )
                    }
                  >
                    {triggerKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(triggerLabels[kind])}
                      </option>
                    ))}
                  </Select>
                </InspectorField>

                {trigger.kind === 'product-event' && (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-2 text-sm text-[var(--text-secondary)]">
                      {t('agents.workflowTriggerEvents')}
                    </legend>
                    {WORKFLOW_PRODUCT_EVENTS.map((event) => {
                      const listening = trigger.events ?? [];
                      const selected = listening.includes(event);
                      return (
                        <InspectorSwitchRow
                          key={event}
                          label={t(productEventLabels[event])}
                          checked={selected}
                          disabled={isReadOnly}
                          onChange={() =>
                            commitGraph(
                              updateNode(graph, {
                                ...triggerNode,
                                trigger: {
                                  ...trigger,
                                  events: selected
                                    ? listening.filter((item) => item !== event)
                                    : [...listening, event],
                                },
                              }),
                            )
                          }
                        />
                      );
                    })}
                  </fieldset>
                )}

                {trigger.kind === 'schedule' && (
                  <InspectorField label={t('agents.workflowTriggerCron')}>
                    <Input
                      value={trigger.cron ?? ''}
                      placeholder={t('agents.workflowTriggerCronPlaceholder')}
                      disabled={isReadOnly}
                      onChange={(event) =>
                        commitGraph(
                          updateNode(graph, {
                            ...triggerNode,
                            trigger: {
                              ...trigger,
                              cron: event.target.value.trim() || undefined,
                            },
                          }),
                        )
                      }
                    />
                  </InspectorField>
                )}
              </NotificationSection>

              <NotificationSection>
                <InspectorField label={t('agents.workflowAutonomy')}>
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
                </InspectorField>
                <InspectorField label={t('agents.workflowUncertainty')}>
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
                </InspectorField>
                <InspectorField label={t('agents.workflowIssueCreation')}>
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
                </InspectorField>
                <InspectorField label={t('agents.workflowDefaultAction')}>
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
                </InspectorField>
                <InspectorSwitchRow
                  label={t('agents.workflowFinalReview')}
                  hint={t('agents.workflowFinalReviewHint')}
                  checked={workflow.finalReview}
                  disabled={isReadOnly}
                  onChange={(checked) => onChange({ ...workflow, finalReview: checked })}
                />
              </NotificationSection>
            </div>
          </InspectorFrame>
        )}
      </Modal>
    </div>
  );
}
