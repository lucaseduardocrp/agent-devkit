import type { TranslationKey } from '../../lib/i18n/index.js';
import type { AgentWorkflowToolset } from './agent-types.js';
import {
  isNotificationAction,
  MAX_DELAY_MINUTES,
  type WorkflowConfigurableNode,
} from './workflow-graph.js';

/** The modules a rule or an action can cover, in the order the inspector lists them. */
export const toolsetLabels: Record<AgentWorkflowToolset, TranslationKey> = {
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
  development: 'agents.workflowModuleDevelopment',
  integrationtests: 'agents.workflowModuleIntegrationTests',
  loadtests: 'agents.workflowModuleLoadTests',
  audit: 'agents.workflowModuleAudit',
  workspaces: 'agents.workflowModuleWorkspaces',
  notifications: 'agents.workflowModuleNotifications',
};

/** What a configurable node says about itself under its title, so its form does not repeat it. */
export function configNodeSubtitle(
  node: WorkflowConfigurableNode,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (node.kind === 'condition') return t('agents.workflowConditionNodeHint');
  if (node.kind === 'delay') return t('agents.workflowDelayNodeHint', { max: MAX_DELAY_MINUTES });
  return isNotificationAction(node.action)
    ? t('agents.workflowNotificationNodeSubtitle')
    : t('agents.workflowActionNodeHint');
}
