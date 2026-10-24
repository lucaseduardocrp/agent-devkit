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
  spec: 'specs',
  releaseNotes: 'releaseNotes',
  design: 'design',
  testplans: 'testplans',
  e2e: 'e2e',
  integrationTests: 'integrationTests',
  loadTests: 'loadTests',
  connect: 'integrations',
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
  'brain',
  'design',
  'spec',
  'releaseNotes',
  'testplans',
  'e2e',
  'integrationTests',
  'loadTests',
  'connect',
  'settings',
];

export function canSeeTab(tab: NavTab, can: (module: PermissionModule) => boolean): boolean {
  const module = NAV_TAB_MODULES[tab];
  return !module || can(module);
}
