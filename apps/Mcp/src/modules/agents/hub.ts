import { segment, type AdkApi } from '../../api/http-client.js';
import type { AgentDto } from './tools.js';

// ADK Hub agents in the active workspace. Shared by the MCP tools (agents_hub_*) and the devkit
// CLI (`devkit agents`), which both go through the ADK API: the server downloads and checks the
// hub files and creates the agents, so every client installs the same way.

export type HubInstallStatus = 'available' | 'installed' | 'update-available';

export interface HubInstallState {
  readonly status: HubInstallStatus;
  readonly installed?: {
    readonly agentId: string;
    readonly name: string;
    readonly version: string;
  };
}

export interface HubAgentDto extends HubInstallState {
  readonly name: string;
  readonly description: string;
  readonly overview: string;
  readonly category: string;
  readonly role: AgentDto['role'];
  readonly temperature?: number;
  readonly tags: readonly string[];
  readonly toolsets: readonly string[];
  readonly author: string;
  readonly version: string;
  readonly license: string;
  readonly tier: 'official' | 'verified' | 'community';
}

export interface HubPluginDto {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version?: string;
  readonly maintainer: string;
  readonly tier: 'official' | 'verified' | 'community';
  readonly license: string;
  readonly repo: string;
  readonly sha: string;
  readonly agents: readonly ({ readonly name: string } & HubInstallState)[];
}

export interface HubAgentCatalogDto {
  readonly generatedAt: string;
  readonly categories: readonly {
    readonly id: string;
    readonly icon: string;
    readonly label: Readonly<Record<string, string>>;
  }[];
  readonly agents: readonly HubAgentDto[];
  readonly plugins: readonly HubPluginDto[];
}

/** A hub agent (`name`), one subagent of a plugin (`plugin` + `name`) or all of a plugin's. */
export interface HubAgentRef {
  readonly name?: string;
  readonly plugin?: string;
}

export function listHubAgents(api: AdkApi): Promise<HubAgentCatalogDto> {
  return api.request<HubAgentCatalogDto>({ method: 'GET', path: '/agents/hub' });
}

export async function installHubAgent(api: AdkApi, ref: HubAgentRef): Promise<readonly AgentDto[]> {
  const result = await api.request<{ agents: readonly AgentDto[] }>({
    method: 'POST',
    path: '/agents/hub/install',
    body: ref,
  });
  return result.agents;
}

export async function updateHubAgent(api: AdkApi, agentId: string): Promise<AgentDto> {
  const result = await api.request<{ agent: AgentDto }>({
    method: 'POST',
    path: `/agents/${segment(agentId)}/hub-update`,
  });
  return result.agent;
}
