import type { AccessTokenService } from '../../identity/application/access-tokens.js';

/** Name of the access token the bot issues, so a new one can replace the previous. */
export const MCP_TOKEN_NAME = 'ADK Telegram CLIs';

/** Lets a member connect the ADK MCP server to their AI CLIs without handling a token. */
export interface McpConnector {
  /** The ADK MCP server's address (…/mcp). */
  readonly url: string;
  /** A fresh access token of the member, valid for the MCP server. The previous one is revoked. */
  issueToken(userId: string, scope: 'full' | 'read'): Promise<string>;
}

/** Tokens last 90 days: the member runs `/mcp adk` again to renew. */
const TOKEN_DAYS = 90;

export class AccessTokenMcpConnector implements McpConnector {
  constructor(
    readonly url: string,
    private readonly tokens: Pick<AccessTokenService, 'list' | 'create' | 'revoke'>,
  ) {}

  async issueToken(userId: string, scope: 'full' | 'read'): Promise<string> {
    // Revoke first: a member holds a limited number of tokens, and the old one is replaced anyway.
    for (const existing of await this.tokens.list(userId))
      if (existing.name === MCP_TOKEN_NAME) await this.tokens.revoke(userId, existing.id);
    const created = await this.tokens.create(userId, {
      name: MCP_TOKEN_NAME,
      scope,
      expiresInDays: TOKEN_DAYS,
    });
    return created.token;
  }
}
