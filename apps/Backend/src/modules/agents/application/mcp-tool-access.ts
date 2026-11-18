import type { AccessTokenService } from '../../identity/application/access-tokens.js';
import type { LlmMcpServer } from './agent-ports.js';

/**
 * Name the MCP server has for the CLI: its tools show up as mcp__adk-tools__<tool>. Not "adk" on
 * purpose: many people already have an MCP server of their own with that name, and a CLI that
 * remembers it as "needs sign-in" then never even connects to this one.
 */
export const MCP_SERVER_NAME = 'adk-tools';

/** Name of the access tokens issued here, apart from the Telegram one (a new one never revokes it). */
export const MCP_AI_CLI_TOKEN_NAME = 'ADK AI CLI';

/** How much of the ADK's MCP tools a run gets; see llmMcpAccess in cli-config.ts. */
export type McpAccessLevel = 'standard' | 'read' | 'full';

/** What an agent run asks for: the ADK's MCP tools, acting as a user in a workspace. */
export interface McpToolAccessPort {
  connect(userId: string, workspaceId: string, access: McpAccessLevel): Promise<LlmMcpServer>;
}

const TOKEN_DAYS = 1;
/** A token is reused for this long, so it still has most of its life left when a run uses it. */
const REUSE_MS = 12 * 60 * 60_000;

interface Minted {
  readonly token: string;
  readonly at: number;
}

/**
 * Gives the AI CLI behind an agent the ADK's MCP tools without the user configuring anything. The

 * may do themselves, "read" is limited to safe methods. The token lasts a day, is kept only in
 * memory and reused for half of that, so busy agents do not create one token per message.
 */
export class McpToolAccess implements McpToolAccessPort {
  private readonly minted = new Map<string, Minted>();
  private readonly pending = new Map<string, Promise<string>>();

  public constructor(
    private readonly url: string,
    private readonly tokens: Pick<AccessTokenService, 'list' | 'create' | 'revoke'>,
    private readonly now: () => number = Date.now,
  ) {}

  public async connect(
    userId: string,
    workspaceId: string,
    access: McpAccessLevel,
  ): Promise<LlmMcpServer> {
    // The workspace and the profile travel in the URL, which the CLI has in its own config and the
    // model cannot change: the MCP server pins its session to the workspace (the API still checks
    // on every call that this user belongs to it) and offers only the tools of the profile.
    const url = new URL(this.url);
    url.searchParams.set('workspace', workspaceId);
    if (access !== 'full') url.searchParams.set('profile', access);
    return {
      name: MCP_SERVER_NAME,
      url: url.toString(),
      // Only reading gets a token that cannot write at all. The others need one that can, and are
      // narrowed by the profile instead.
      token: await this.tokenFor(userId, access === 'read' ? 'read' : 'full'),
    };
  }

  private tokenFor(userId: string, scope: 'full' | 'read'): Promise<string> {
    const key = `${userId}:${scope}`;
    const current = this.minted.get(key);
    if (current && this.now() - current.at < REUSE_MS) return Promise.resolve(current.token);
    // Requests that arrive together share one mint.
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const mint = this.mint(userId, scope)
      .then((token) => {
        this.minted.set(key, { token, at: this.now() });
        return token;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, mint);
    return mint;
  }

  private async mint(userId: string, scope: 'full' | 'read'): Promise<string> {
    const create = () =>
      this.tokens.create(userId, { name: MCP_AI_CLI_TOKEN_NAME, scope, expiresInDays: TOKEN_DAYS });
    try {
      return (await create()).token;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ACCESS_TOKEN_LIMIT_REACHED') throw error;
      // Tokens of earlier runs of this process (or of another API instance) fill the limit: they
      // expire by themselves, so replacing them frees room without touching the user's own tokens.
      for (const existing of await this.tokens.list(userId))
        if (existing.name === MCP_AI_CLI_TOKEN_NAME) await this.tokens.revoke(userId, existing.id);
      return (await create()).token;
    }
  }
}
