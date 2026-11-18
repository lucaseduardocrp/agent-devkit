import type { McpTool, Toolset } from './tool.js';

/**
 * What one MCP connection may do, chosen by whoever opens it (the URL, never the model): a client
 * that reads untrusted text and acts for a user, such as the AI CLI behind an agent, is given a
 * smaller set of tools than the user has. A connection with no profile keeps every tool.
 *
 * - `read`: tools that only read.
 * - `standard`: tools that read or write.
 *
 * Both drop what turns a hijacked model into a bigger problem: credentials and identity, people
 * and permissions, notifications to others, running code, anything destructive, and anything that
 * reaches a system outside ADK (an attacker-chosen address is a way to send data out).
 */
export const ACCESS_PROFILES = ['read', 'standard'] as const;
export type AccessProfile = (typeof ACCESS_PROFILES)[number];

/** Toolsets a restricted connection never gets, whatever their tools declare. */
export const PROFILE_BLOCKED_TOOLSETS: ReadonlySet<Toolset> = new Set<Toolset>([
  'account', // sessions and personal access tokens
  'workspaces', // members, roles and permissions
  'integrations', // provider credentials
  'notifications', // messages to other people
  'development', // sessions that run code on a runner
]);

export function profileAllows(profile: AccessProfile, tool: McpTool): boolean {
  if (PROFILE_BLOCKED_TOOLSETS.has(tool.toolset)) return false;
  if (tool.access === 'destructive' || tool.openWorld) return false;
  return profile === 'standard' || tool.access === 'read';
}

/** The profile a connection asked for. Anything unrecognized gets the narrowest one, not none. */
export function parseAccessProfile(value: unknown): AccessProfile | undefined {
  if (value === undefined) return undefined;
  return (ACCESS_PROFILES as readonly unknown[]).includes(value)
    ? (value as AccessProfile)
    : 'read';
}

/** Said to the model, so it does not look for tools it was not given. */
export function profileInstructions(profile: AccessProfile): string {
  return [
    `This connection is restricted (${profile}): it has no tools for accounts, integrations, workspace members, notifications or development sessions, none that delete, and none that reach systems outside ADK${profile === 'read' ? ', and none that change data' : ''}.`,
    'The workspace is already selected for you: do not look for a tool to choose another.',
    'If the user asks for something that needs a tool you do not have, say so and tell them to do it in ADK themselves.',
  ].join('\n');
}
