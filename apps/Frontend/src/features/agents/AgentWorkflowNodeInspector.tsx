import React from 'react';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/index.js';
import {
  MAX_DELAY_MINUTES,
  WORKFLOW_CONDITION_OPERATORS,
  type WorkflowConditionOperator,
  type WorkflowConfigurableNode,
} from './workflow-graph.js';
import { toolsetLabels } from './workflow-labels.js';
import type { AgentWorkflowToolset } from './agent-types.js';

const operatorLabels: Record<WorkflowConditionOperator, TranslationKey> = {
  contains: 'agents.workflowConditionContains',
  'not-contains': 'agents.workflowConditionNotContains',
  matches: 'agents.workflowConditionMatches',
};

/**
 * A server run walks the flow itself, but it cannot reach the MCP server, so it carries out only
 * the few actions it can perform on its own. Saying so on the node keeps the editor honest about
 * what a run will actually do.
 */
function ServerRunLimit(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <p
      className="flex items-center gap-2 rounded-lg border border-[var(--bg-warning)] bg-[var(--bg-warning)] p-3 text-xs text-[var(--text-warning)]"
      data-testid="workflow-action-server-limit"
    >
      <i className="ti ti-alert-triangle shrink-0 text-sm" aria-hidden="true" />
      {t('agents.workflowActionServerLimit')}
    </p>
  );
}

export interface AgentWorkflowNodeInspectorProps {
  /** The node being edited; a step or an approval has no configuration of its own. */
  readonly node: WorkflowConfigurableNode;
  readonly isReadOnly: boolean;
  readonly toolNames: Record<AgentWorkflowToolset, readonly string[]>;
  readonly providerOptions: readonly { readonly id: string; readonly name: string }[];
  readonly onChange: (next: WorkflowConfigurableNode) => void;
}

/**
 * The form of an action, condition or delay node. Each one edits its own configuration bag, and
 * the canvas marks the node while that configuration cannot run.
 */
export function AgentWorkflowNodeInspector({
  node,
  isReadOnly,
  toolNames,
  providerOptions,
  onChange,
}: AgentWorkflowNodeInspectorProps): React.JSX.Element {
  const { t } = useI18n();

  if (node.kind === 'action') {
    const action = node.action;
    return (
      <div className="flex flex-col gap-4" data-testid="workflow-action-inspector">
        <ServerRunLimit />
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
          {t('agents.workflowActionNodeHint')}
        </p>
        <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
          {t('agents.workflowRuleModule')}
          <Select
            value={action.toolset}
            disabled={isReadOnly}
            onChange={(event) =>
              onChange({
                ...node,
                action: {
                  ...action,
                  toolset: event.target.value as AgentWorkflowToolset,
                  toolName: undefined,
                },
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
            value={action.toolName ?? ''}
            list={`workflow-node-actions-${node.id}`}
            placeholder={t('agents.workflowActionNamePlaceholder')}
            disabled={isReadOnly}
            onChange={(event) =>
              onChange({
                ...node,
                action: { ...action, toolName: event.target.value.trim() || undefined },
              })
            }
          />
          <datalist id={`workflow-node-actions-${node.id}`}>
            {toolNames[action.toolset].map((toolName) => (
              <option key={toolName} value={toolName} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
          {t('agents.workflowActionProvider')}
          <Select
            value={action.provider ?? ''}
            disabled={isReadOnly}
            onChange={(event) =>
              onChange({
                ...node,
                action: { ...action, provider: event.target.value || undefined },
              })
            }
          >
            <option value="">{t('agents.workflowAllProviders')}</option>
            {providerOptions.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
    );
  }

  if (node.kind === 'condition') {
    const condition = node.condition;
    return (
      <div className="flex flex-col gap-4" data-testid="workflow-condition-inspector">
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
          {t('agents.workflowConditionNodeHint')}
        </p>
        <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
          {t('agents.workflowConditionOperator')}
          <Select
            value={condition.operator}
            disabled={isReadOnly}
            onChange={(event) =>
              onChange({
                ...node,
                condition: {
                  ...condition,
                  operator: event.target.value as WorkflowConditionOperator,
                },
              })
            }
          >
            {WORKFLOW_CONDITION_OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {t(operatorLabels[operator])}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
          {t('agents.workflowConditionValue')}
          <Input
            value={condition.value}
            placeholder={t('agents.workflowConditionValuePlaceholder')}
            disabled={isReadOnly}
            onChange={(event) =>
              onChange({ ...node, condition: { ...condition, value: event.target.value } })
            }
          />
        </label>
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-xs">
          <span className="flex items-center gap-2 text-[var(--text-secondary)]">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--fill-success)]" />
            {t('agents.workflowConditionTrueHint')}
          </span>
          <span className="flex items-center gap-2 text-[var(--text-secondary)]">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--fill-danger)]" />
            {t('agents.workflowConditionFalseHint')}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-delay-inspector">
      <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
        {t('agents.workflowDelayNodeHint', { max: MAX_DELAY_MINUTES })}
      </p>
      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
        {t('agents.workflowDelayMinutes')}
        <Input
          type="number"
          min={1}
          max={MAX_DELAY_MINUTES}
          value={String(node.delay.minutes)}
          disabled={isReadOnly}
          onChange={(event) =>
            onChange({ ...node, delay: { minutes: Number(event.target.value) } })
          }
        />
      </label>
    </div>
  );
}
