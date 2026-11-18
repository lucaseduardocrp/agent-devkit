import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage as HttpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { LlmCliStatus, LlmEvent, LlmInput } from '../../app/llm-host.js';
import type { Channel, MessageHandler } from '../../core/types.js';

/** What the API may ask of the bridge besides chatting: answer as an LLM, per workspace. */
export interface LlmEndpoint {
  clis(workspaceId: string): Promise<LlmCliStatus[]>;
  stream(input: LlmInput, signal: AbortSignal): AsyncGenerator<LlmEvent>;
}

export interface AdkChannelOptions {
  /** Port the ADK API calls. */
  readonly port: number;
  /** Shared secret (BRIDGE_SHARED_TOKEN), in both directions. */
  readonly token: string;
  /** The ADK API, which delivers replies through its Telegram bot. */
  readonly apiUrl: string;
  /** The CLI ids, for `GET /clis`. */
  readonly listClis: () => string[];
  /** Absent: the bridge only chats. */
  readonly llm?: LlmEndpoint;
  readonly fetch?: typeof fetch;
}

const MAX_BODY_BYTES = 200_000;
/**
 * An LLM prompt carries the agent's instructions, its knowledge and the conversation, and now and
 * then images and files as base64 (the API keeps those under 48 MB of base64).
 */
const MAX_LLM_BODY_BYTES = 64_000_000;
const MAX_ATTACHMENTS = 20;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEARTBEAT_MS = 15_000;

/** Which HTTP status each failure of a CLI answers with (never 401: that is the shared token). */
const LLM_STATUS = {
  UNSUPPORTED: 400,
  NOT_AUTHENTICATED: 422,
  NOT_INSTALLED: 503,
  TIMEOUT: 504,
  FAILED: 502,
} as const;

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
      this.route(request, response, handler, reply).catch(() => {
        if (response.headersSent) response.end();
        else reply(500, { error: 'internal' });
      });
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
    response: ServerResponse,
    handler: MessageHandler,
    reply: (status: number, body: unknown) => void,
  ): Promise<void> {
    if (request.url === '/health') return reply(200, { ok: true });
    if (!this.authorized(request.headers.authorization))
      return reply(401, { error: 'unauthorized' });
    if (request.method === 'GET' && request.url === '/clis')
      return reply(200, { clis: this.options.listClis() });
    const { llm } = this.options;
    if (llm && request.method === 'GET' && request.url?.startsWith('/llm/clis'))
      return this.llmClis(request, llm, reply);
    if (llm && request.method === 'POST' && request.url === '/llm/stream')
      return this.llmStream(request, response, llm, reply);
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

  private async llmClis(
    request: HttpRequest,
    llm: LlmEndpoint,
    reply: (status: number, body: unknown) => void,
  ): Promise<void> {
    const workspaceId = new URL(request.url ?? '', 'http://bridge').searchParams.get('workspaceId');
    if (!workspaceId) return reply(400, { error: 'workspaceId is required' });
    try {
      reply(200, { clis: await llm.clis(workspaceId) });
    } catch (error) {
      replyLlmFailure(error, reply);
    }
  }

  /**
   * Streams one answer as server-sent events (`delta`, `usage`, then `done`, or `error`). The
   * first event is awaited before the headers go out, so a request that cannot start (bad token,
   * CLI missing) is a plain JSON error with a status code.
   */
  private async llmStream(
    request: HttpRequest,
    response: ServerResponse,
    llm: LlmEndpoint,
    reply: (status: number, body: unknown) => void,
  ): Promise<void> {
    const body = (await readJson(request, MAX_LLM_BODY_BYTES)) as Record<string, unknown> | null;
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value ? value : undefined;
    const workspaceId = text(body?.workspaceId);
    const cli = text(body?.cli);
    const prompt = text(body?.prompt);
    if (!workspaceId || !cli || !prompt)
      return reply(400, { error: 'workspaceId, cli and prompt are required' });
    const images = attachmentsOf(body?.images, false);
    const files = attachmentsOf(body?.files, true);
    if (!images || !files)
      return reply(400, { error: 'images and files must be lists of base64 attachments' });

    // The API going away must stop the CLI, not leave it running.
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    const events = llm.stream(
      {
        workspaceId,
        cli,
        prompt,
        instruction: text(body?.instruction),
        model: text(body?.model),
        credential: text(body?.credential),
        mcp: mcpOf(body?.mcp),
        ...(images.length ? { images: images as LlmInput['images'] } : {}),
        ...(files.length ? { files: files as LlmInput['files'] } : {}),
      },
      controller.signal,
    );
    let first: IteratorResult<LlmEvent>;
    try {
      first = await events.next();
    } catch (error) {
      return replyLlmFailure(error, reply);
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), HEARTBEAT_MS);
    try {
      let step = first;
      while (!step.done) {
        send(step.value.type, step.value.type === 'delta' ? { text: step.value.text } : step.value);
        step = await events.next();
      }
      send('done', {});
    } catch (error) {
      if (!controller.signal.aborted) {
        const failure = llmFailure(error);
        send('error', { code: failure.code, message: failure.message });
      }
    } finally {
      clearInterval(heartbeat);
      response.end();
    }
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

/**
 * The images or files of a request: none when absent, `null` when they are not a short list of
 * `{ mimeType, data }` (plus `name` for files) with base64 data.
 */
function attachmentsOf(
  value: unknown,
  named: boolean,
): Array<{ name?: string; mimeType: string; data: string }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const items: Array<{ name?: string; mimeType: string; data: string }> = [];
  for (const entry of value as unknown[]) {
    const { name, mimeType, data } = (entry ?? {}) as Record<string, unknown>;
    if (typeof mimeType !== 'string' || typeof data !== 'string' || !BASE64.test(data)) return null;
    if (named && typeof name !== 'string') return null;
    items.push({ ...(named ? { name: name as string } : {}), mimeType, data });
  }
  return items;
}

/** The MCP server of a request, or nothing when it is absent or not made of three strings. */
function mcpOf(value: unknown): LlmInput['mcp'] {
  const { name, url, token } = (value ?? {}) as Record<string, unknown>;
  return typeof name === 'string' && typeof url === 'string' && typeof token === 'string'
    ? { name, url, token }
    : undefined;
}

/** The code and message a failure of the LLM host is reported with. */
function llmFailure(error: unknown): { code: keyof typeof LLM_STATUS; message: string } {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code in LLM_STATUS)
    return { code: code as keyof typeof LLM_STATUS, message: (error as Error).message };
  // Anything else is a bug here: it is logged, and the ADK gets no detail.
  console.warn('[Bridge] LLM request failed:', error);
  return { code: 'FAILED', message: 'The CLI failed.' };
}

function replyLlmFailure(error: unknown, reply: (status: number, body: unknown) => void): void {
  const failure = llmFailure(error);
  reply(LLM_STATUS[failure.code], failure);
}

async function readJson(request: HttpRequest, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
