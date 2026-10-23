import type { HubAgentEntry, HubIndex, HubPluginEntry } from '../domain/hub-index.js';

/**
 * Read access to the ADK Hub. The adapter decides where the index comes from (GitHub by default,
 * ADK_HUB_URL for a mirror) and checks every file it returns: hub agents against the sha256 in the
 * index, plugin subagents by reading them at the plugin's pinned commit.
 */
export interface HubCatalog {
  index(): Promise<HubIndex>;
  /** Text of agents/<name>/AGENT.md, at the commit the index pins it to. */
  agentFile(index: HubIndex, agent: HubAgentEntry): Promise<string>;
  /** Text of agents/<agent>.md in the plugin's repository, at its pinned commit. */
  pluginAgentFile(plugin: HubPluginEntry, agent: string): Promise<string>;
}
