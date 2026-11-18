/** A message of a paired chat, for the CLI Bridge (apps/Bridge) to run. */
export interface BridgeMessage {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly userId: string;
  /** The ADK member who paired the chat: the owner of its CLI accounts. */
  readonly memberId: string;
  readonly text: string;
}

/** What the Telegram bot needs from the Bridge. */
export interface CliBridge {
  /** The ids of the CLIs the Bridge can run. */
  listClis(): Promise<string[]>;
  /** Hands over a message; the answer comes back through the bridge routes of the API. */
  forward(message: BridgeMessage): Promise<void>;
}

export interface HttpCliBridgeOptions {
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/** The Bridge's chat id carries the workspace, because a chat id is only unique per bot. */
export function bridgeChatId(workspaceId: string, chatId: string): string {
  return `${workspaceId}:${chatId}`;
}

export function parseBridgeChatId(value: string): { workspaceId: string; chatId: string } | null {
  const index = value.lastIndexOf(':');
  if (index <= 0 || index === value.length - 1) return null;
  return { workspaceId: value.slice(0, index), chatId: value.slice(index + 1) };
}

export class HttpCliBridge implements CliBridge {
  private readonly fetcher: typeof fetch;
  private readonly base: string;

  constructor(private readonly options: HttpCliBridgeOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.base = options.url.replace(/\/$/, '');
  }

  async listClis(): Promise<string[]> {
    const payload = (await this.call('GET', '/clis')) as { clis?: unknown };
    return Array.isArray(payload.clis) ? payload.clis.map(String) : [];
  }

  async forward(message: BridgeMessage): Promise<void> {
    await this.call('POST', '/messages', {
      chatId: bridgeChatId(message.workspaceId, message.chatId),
      userId: message.userId,
      memberId: message.memberId,
      text: message.text,
    });
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`The CLI Bridge answered ${response.status}.`);
    return response.json().catch(() => ({}));
  }
}
