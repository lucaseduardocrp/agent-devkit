/** An MCP server a user connected to their CLIs (for example the ADK's own). */
export interface McpServer {
  readonly name: string;
  readonly url: string;
  /** Sent as `Authorization: Bearer <token>`. Never put it on a command line: other users can read those. */
  readonly token: string;
}

export const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_MCP_SERVERS = 10;

/** Environment variable that carries one server's token to a CLI that reads it from there. */
export function mcpTokenEnv(name: string): string {
  return `MCP_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Remote MCP servers are reached over HTTPS. Plain HTTP is only accepted for the private network
 * of the platform (`*.internal`) and for localhost, where the traffic never leaves the machine.
 */
export function isAcceptableMcpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.endsWith('.internal'))
  );
}
