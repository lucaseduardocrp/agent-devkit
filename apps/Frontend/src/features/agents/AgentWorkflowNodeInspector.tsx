import React from 'react';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/index.js';
import {
  isNotificationAction,
  MAX_DELAY_MINUTES,
  WORKFLOW_CONDITION_OPERATORS,
  type WorkflowConditionOperator,
  type WorkflowConfigurableNode,
} from './workflow-graph.js';
import { NotificationActionEditor } from '../notifications/NotificationActionEditor.js';
import {
  EMPTY_NOTIFICATION_OPTIONS,
  type NotificationOptions,
} from '../notifications/notification-types.js';
import { InspectorField, InspectorNotice } from './AgentWorkflowInspectorFrame.js';
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
    <InspectorNotice icon="ti-alert-triangle" testId="workflow-action-server-limit">
      {t('agents.workflowActionServerLimit')}
    </InspectorNotice>
  );
}

export interface AgentWorkflowNodeInspectorProps {
  /** The node being edited; a step or an approval has no configuration of its own. */
  readonly node: WorkflowConfigurableNode;
  readonly isReadOnly: boolean;
  readonly toolNames: Record<AgentWorkflowToolset, readonly string[]>;
  readonly providerOptions: readonly { readonly id: string; readonly name: string }[];
  /** Channels and members the notifications action can choose from. */
  readonly notificationOptions?: NotificationOptions;
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
  notificationOptions = EMPTY_NOTIFICATION_OPTIONS,
  onChange,
}: AgentWorkflowNodeInspectorProps): React.JSX.Element {
  const { t } = useI18n();

  if (node.kind === 'action') {
    const action = node.action;
    const isNotification = isNotificationAction(action);
    // The module, the MCP action and the provider: the whole form of a plain action, and the
    // fine print of a notification, which has a form of its own above them.
    const technicalFields = (
      <>
        <InspectorField label={t('agents.workflowRuleModule')}>
          <Select
            value={action.toolset}
            disabled={isReadOnly}
            onChange={(event) =>
              onChange({
                ...node,
                action: {
                  ...action,
                  toolset: event.target.value as AgentWorkflowToolset,
                  // The notifications module has one action, so it is chosen for the member.
                  toolName:
                    event.target.value === 'notifications' ? 'notifications_send' : undefined,
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
        </InspectorField>
        <InspectorField label={t('agents.workflowRuleAction')}>
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
        </InspectorField>
        <InspectorField label={t('agents.workflowActionProvider')}>
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
        </InspectorField>
      </>
    );
    return (
      <div className="flex flex-col gap-4" data-testid="workflow-action-inspector">
        {isNotification ? (
          <>
            <NotificationActionEditor
              value={action.notification}
              options={notificationOptions}
              disabled={isReadOnly}
              onChange={(notification) =>
                onChange({ ...node, action: { ...action, notification } })
              }
            />
            <details className="group rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fill-accent)]">
                {t('agents.workflowAdvanced')}
                <i
                  className="ti ti-chevron-down text-base transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="flex flex-col gap-4 border-t border-[var(--border)] p-3">
                {technicalFields}
              </div>
            </details>
          </>
        ) : (
          <>
            <ServerRunLimit />
            {technicalFields}
          </>
        )}
      </div>
    );
  }

  if (node.kind === 'condition') {
    const condition = node.condition;
    return (
      <div className="flex flex-col gap-4" data-testid="workflow-condition-inspector">
        <InspectorField label={t('agents.workflowConditionOperator')}>
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
        </InspectorField>
        <InspectorField label={t('agents.workflowConditionValue')}>
          <Input
            value={condition.value}
            placeholder={t('agents.workflowConditionValuePlaceholder')}
            disabled={isReadOnly}
            onChange={(event) =>
              onChange({ ...node, condition: { ...condition, value: event.target.value } })
            }
          />
        </InspectorField>
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-secondary)]">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--fill-success)]" />
            {t('agents.workflowConditionTrueHint')}
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--fill-danger)]" />
            {t('agents.workflowConditionFalseHint')}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-delay-inspector">
      <InspectorField label={t('agents.workflowDelayMinutes')}>
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
      </InspectorField>
    </div>
  );
}
