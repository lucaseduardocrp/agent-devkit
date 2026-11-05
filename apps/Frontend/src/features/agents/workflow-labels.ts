import type { TranslationKey } from '../../lib/i18n/index.js';
import type { AgentWorkflowToolset } from './agent-types.js';

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
  integrationtests: 'agents.workflowModuleIntegrationTests',
  loadtests: 'agents.workflowModuleLoadTests',
  audit: 'agents.workflowModuleAudit',
  workspaces: 'agents.workflowModuleWorkspaces',
};
