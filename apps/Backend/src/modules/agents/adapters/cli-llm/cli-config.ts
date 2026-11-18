/**
 * Where a provider CLI runs when a workspace picks "AI CLI" instead of an API key:
 *
 * - `local`: on the machine of the API, as its user, with that user's CLI login. Right for the
 *   Desktop app or a box with one team; on a shared server it would let every workspace spend one
 *   account, so it only turns on with `ADK_LLM_CLI=true`.
 * - `bridge`: in the Bridge container (BRIDGE_URL and BRIDGE_SHARED_TOKEN, the same one that drives
 *   Telegram chats). Each workspace brings its own token, kept encrypted by ADK and used only for
 *   that workspace, so it is safe on a shared server and is the way to use CLIs with the Docker
 *   image, which has none. It turns on by itself when the Bridge is configured.
 *
 * `ADK_LLM_CLI=false` turns both off, and `ADK_LLM_CLI=bridge` skips `local` explicitly.
 */
export type LlmCliTransport = 'local' | 'bridge';

export interface BridgeEndpoint {
  readonly url: string;
  readonly token: string;
}

export function bridgeEndpoint(env: NodeJS.ProcessEnv = process.env): BridgeEndpoint | null {
  const url = env['BRIDGE_URL']?.trim().replace(/\/+$/, '');
  const token = env['BRIDGE_SHARED_TOKEN']?.trim();
  return url && token ? { url, token } : null;
}

export function llmCliTransport(env: NodeJS.ProcessEnv = process.env): LlmCliTransport | null {
  const mode = env['ADK_LLM_CLI']?.trim().toLowerCase() ?? '';
  if (/^(1|true|yes|on|local)$/.test(mode)) return 'local';
  if (mode === '' || mode === 'bridge') return bridgeEndpoint(env) ? 'bridge' : null;
  return null; // false, off, or anything else: a typo must not turn a CLI on
}

export function isLlmCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmCliTransport(env) !== null;
}

export type LlmMcpAccessSetting = 'standard' | 'read' | 'full' | 'off';

/**
 * How much of the ADK an AI CLI may use through MCP. The agent reads text nobody vetted and acts
 * with the user's rights, so the default is not everything:
 *
 * - "standard" (default, nothing to set up): the tools that read and write, without credentials,
 *   people and permissions, deletion, running code or reaching systems outside ADK.
 * - "read": only the tools that read, under a token that can only read.
 * - "full": everything the user may do. An explicit choice.
 * - "off": no tools.
 */
export function llmMcpAccess(settings: Readonly<Record<string, unknown>>): LlmMcpAccessSetting {
  const value = settings['mcpAccess'];
  return value === 'read' || value === 'full' || value === 'off' ? value : 'standard';
}

/** The level a provider is given; none when the tools are off. */
export function mcpAccessOf(
  settings: Readonly<Record<string, unknown>>,
): 'standard' | 'read' | 'full' | undefined {
  const access = llmMcpAccess(settings);
  return access === 'off' ? undefined : access;
}

export type LlmAuthMode = 'api_key' | 'cli';

/** How an LLM integration authenticates: its API key (the default) or the provider's CLI. */
export function llmAuthMode(settings: Readonly<Record<string, unknown>>): LlmAuthMode {
  return settings['authMode'] === 'cli' ? 'cli' : 'api_key';
}
