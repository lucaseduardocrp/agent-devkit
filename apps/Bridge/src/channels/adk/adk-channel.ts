import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage as HttpRequest, type Server } from 'node:http';
import type { Channel, MessageHandler } from '../../core/types.js';

export interface AdkChannelOptions {
  /** Port the ADK API calls. */
  readonly port: number;
  /** Shared secret (BRIDGE_SHARED_TOKEN), in both directions. */
  readonly token: string;
  /** The ADK API, which delivers replies through its Telegram bot. */
  readonly apiUrl: string;
  /** The CLI ids, for `GET /clis`. */
  readonly listClis: () => string[];
  readonly fetch?: typeof fetch;
}

const MAX_BODY_BYTES = 200_000;

/**
 * The ADK API is the front door: it owns the Telegram bot, the token and the paired chats (the
 * allowlist), and forwards each message here with `POST /messages`. Replies go back through the
 * API's `/messaging/bridge` routes, so there is a single poller on the bot and nothing here
 * talks to Telegram. The API already checked who may talk, so this channel is `trusted`.
 */
export class AdkChannel implements Channel {
  readonly id = 'adk';
  readonly maxMessageLength = 4096;
  readonly trusted = true;
  private readonly fetcher: typeof fetch;
  private readonly apiUrl: string;
  private server: Server | null = null;

  constructor(private readonly options: AdkChannelOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
  }

  /** The port the server listens on (useful when started on port 0). */
  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  async start(handler: MessageHandler, signal: AbortSignal): Promise<void> {
    const server = createServer((request, response) => {
      const reply = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      this.route(request, handler, reply).catch(() => reply(500, { error: 'internal' }));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, resolve);
    });
    await new Promise<void>((resolve) => {
      const close = (): void => void server.close(() => resolve());
      if (signal.aborted) close();
      else signal.addEventListener('abort', close, { once: true });
    });
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.post('/messaging/bridge/send', { chatId, text });
  }

  async indicateBusy(chatId: string): Promise<void> {
    await this.post('/messaging/bridge/typing', { chatId });
  }

  private async route(
    request: HttpRequest,
    handler: MessageHandler,
    reply: (status: number, body: unknown) => void,
  ): Promise<void> {
    if (request.url === '/health') return reply(200, { ok: true });
    if (!this.authorized(request.headers.authorization))
      return reply(401, { error: 'unauthorized' });
    if (request.method === 'GET' && request.url === '/clis')
      return reply(200, { clis: this.options.listClis() });
    if (request.method !== 'POST' || request.url !== '/messages')
      return reply(404, { error: 'not found' });

    const body = (await readJson(request)) as {
      chatId?: unknown;
      userId?: unknown;
      memberId?: unknown;
      text?: unknown;
    } | null;
    if (
      typeof body?.chatId !== 'string' ||
      typeof body.userId !== 'string' ||
      typeof body.text !== 'string' ||
      !body.chatId ||
      !body.text
    )
      return reply(400, { error: 'chatId, userId and text are required' });

    // Answered right away: a CLI run can take minutes, the reply travels back on its own.
    reply(202, { accepted: true });
    void handler({
      channel: this.id,
      chatId: body.chatId,
      userId: body.userId,
      memberId: typeof body.memberId === 'string' && body.memberId ? body.memberId : undefined,
      text: body.text,
      isPrivate: true,
    }).catch((error: unknown) => console.warn('[Bridge] Handler failed:', error));
  }

  private authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.options.token}`);
    const given = Buffer.from(header ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    const response = await this.fetcher(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`The ADK API answered ${response.status}.`);
  }
}

async function readJson(request: HttpRequest): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
