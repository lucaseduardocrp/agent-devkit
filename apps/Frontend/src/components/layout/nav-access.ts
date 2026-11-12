import type { PermissionModule } from '../../features/workspaces/workspace-types.js';
import type { NavTab } from './Sidebar.js';

/** Module a navigation tab belongs to; tabs without one (settings, workspaces) are always shown. */
export const NAV_TAB_MODULES: Readonly<Record<NavTab, PermissionModule | null>> = {
  dashboard: 'issues',
  inbox: 'issues',
  issues: 'issues',
  pbis: 'pbis',
  brain: 'brain',
  agents: 'agents',
  agentsPlayground: 'agents',
  agentsMap: 'agents',
  agentsWorkflow: 'agents',
  spec: 'specs',
  releaseNotes: 'releaseNotes',
  design: 'design',
  developmentArtifacts: 'development',
  developmentReview: 'development',
  developmentCode: 'development',
  developmentPipeline: 'development',
  testplans: 'testplans',
  e2eSources: 'e2e',
  e2e: 'e2e',
  integrationTests: 'integrationTests',
  loadTests: 'loadTests',
  connect: 'integrations',
  notifications: 'integrations',
  settings: null,
  workspaces: null,
};

/** Navigation order used to pick a visible tab when the current one is not allowed. */
export const NAV_TAB_ORDER: readonly NavTab[] = [
  'issues',
  'pbis',
  'dashboard',
  'inbox',
  'agents',
  'agentsPlayground',
  'agentsMap',
  'agentsWorkflow',
  'brain',
  'design',
  'spec',
  'releaseNotes',
  'developmentArtifacts',
  'developmentReview',
  'developmentCode',
  'developmentPipeline',
  'testplans',
  'e2e',
  'e2eSources',
  'integrationTests',
  'loadTests',
  'connect',
  'notifications',
  'settings',
];

export function canSeeTab(tab: NavTab, can: (module: PermissionModule) => boolean): boolean {
  const module = NAV_TAB_MODULES[tab];
  return !module || can(module);
}
