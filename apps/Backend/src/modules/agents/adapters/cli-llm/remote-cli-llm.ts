import type { LlmPort, LlmRequest, LlmResponse } from '../../application/agent-ports.js';
import type { BridgeEndpoint } from './cli-config.js';
import {
  CliLlmError,
  collectCompletion,
  type CliLlmErrorCode,
  type CliStatus,
  type CliStreamItem,
} from './cli-llm.js';
import { attachmentProblem, CLI_SPECS, isValidModelId, type CliId } from './cli-specs.js';

export interface RemoteCliLlmOptions {
  readonly cli: CliId;
  readonly bridge: BridgeEndpoint;
  /** Whose CLI login this is: the Bridge keeps one private space per workspace. */
  readonly workspaceId: string;
  /** The workspace's token for the CLI (kept encrypted by ADK, sent on each request). */
  readonly credential?: string;
  readonly model?: string;
  /** Lets the CLI use the ADK's MCP tools, with this much of the user's access. */
  readonly mcpAccess?: 'standard' | 'read' | 'full';
  readonly timeoutMs?: number;
  readonly fetcher: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 200_000;
/** Base64 characters of images and files in one request (about 36 MB of content); the Bridge caps its body above this. */
const MAX_ATTACHED_CHARS = 48_000_000;
const ERROR_CODES: readonly CliLlmErrorCode[] = [
  'NOT_INSTALLED',
  'NOT_AUTHENTICATED',
  'TIMEOUT',
  'UNSUPPORTED',
  'QUOTA_EXCEEDED',
  'FAILED',
];

/**
 * An LLM that is a provider CLI running in the Bridge container. It answers the same `LlmPort` as
 * the local CLI and the API-key providers, so nothing above it knows the difference. The Bridge
 * streams what the CLI writes as server-sent events:
 * `delta {text}`, `usage {inputTokens, outputTokens, model?}`, then `done`, or `error {code, message}`.
 */
export class RemoteCliLlmProvider implements LlmPort {
  public readonly provider: string;
  public readonly readsFiles = true;
  public readonly mcpAccess: 'standard' | 'read' | 'full' | undefined;
  private readonly model: string | undefined;
  private readonly credential: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: RemoteCliLlmOptions) {
    this.provider = `${CLI_SPECS[options.cli].label} CLI`;
    const model = options.model?.trim();
    if (model && !isValidModelId(model)) {
      throw new CliLlmError(
        'UNSUPPORTED',
        'The CLI model id contains characters that are not allowed.',
      );
    }
    this.model = model || undefined;
    this.mcpAccess = options.mcpAccess;
    this.credential = options.credential?.trim() || undefined;
    this.fetcher = options.fetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    return collectCompletion(this.run(request, signal), this.provider, this.model);
  }

  public async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    for await (const item of this.run(request, signal)) {
      if (item.type === 'delta') yield item.text;
    }
  }

  private async *run(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<CliStreamItem> {
    // Refused here, before megabytes of base64 travel to a Bridge that would refuse them too.
    const problem = attachmentProblem(CLI_SPECS[this.options.cli], request);
    if (problem) throw new CliLlmError('UNSUPPORTED', problem);
    const attached = [...(request.images ?? []), ...(request.files ?? [])];
    if (attached.reduce((total, item) => total + item.data.length, 0) > MAX_ATTACHED_CHARS) {
      throw new CliLlmError(
        'UNSUPPORTED',
        'The images and files are too large to send to the CLI.',
      );
    }
    signal?.throwIfAborted();
    const { bridge } = this.options;
    const limit = AbortSignal.timeout(this.timeoutMs);
    const response = await this.send(
      `${bridge.url}/llm/stream`,
      {
        method: 'POST',
        headers: { ...authorization(bridge), 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: this.options.workspaceId,
          cli: this.options.cli,
          prompt: request.prompt,
          ...(request.instruction ? { instruction: request.instruction } : {}),
          ...(this.model ? { model: this.model } : {}),
          ...(this.credential ? { credential: this.credential } : {}),
          ...(this.mcpAccess && request.mcp ? { mcp: request.mcp } : {}),
          ...(request.images?.length ? { images: request.images } : {}),
          ...(request.files?.length ? { files: request.files } : {}),
        }),
      },
      signal ? AbortSignal.any([signal, limit]) : limit,
      signal,
    );
    if (!response.ok) throw await failureOf(response);
    if (!response.body) throw unavailable('The Bridge sent no answer.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const messages: SseMessage[] = [];
    const parse = createSseParser((message) => messages.push(message));
    let finished = false;
    try {
      while (!finished) {
        // Aborting the request also ends this read, so it cannot hang past the time limit.
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
        for (const { event, data } of messages.splice(0)) {
          const payload = safeJson(data);
          if (event === 'delta') yield { type: 'delta', text: text(payload['text']) };
          else if (event === 'usage') {
            yield {
              type: 'usage',
              inputTokens: count(payload['inputTokens']),
              outputTokens: count(payload['outputTokens']),
              ...(typeof payload['model'] === 'string' ? { model: payload['model'] } : {}),
            };
          } else if (event === 'error') throw errorFrom(payload);
          else if (event === 'done') finished = true;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (limit.aborted) throw new CliLlmError('TIMEOUT', 'The CLI took too long to answer.');
      if (error instanceof CliLlmError) throw error;
      throw unavailable('The connection to the Bridge was lost.');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    // The Bridge always ends a good answer with `done`: anything else is a cut connection.
    if (!finished) throw unavailable('The Bridge closed the connection before the answer ended.');
  }

  private async send(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    caller?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetcher(url, { ...init, signal });
    } catch (error) {
      if (caller?.aborted) throw error; // the caller cancelled: not a failure of the Bridge
      if (signal.aborted) throw new CliLlmError('TIMEOUT', 'The CLI took too long to answer.');
      throw unavailable('The Bridge could not be reached.');
    }
  }
}

/** The CLIs the Bridge can run for a workspace, with what each one needs to sign in. */
export interface BridgeCliStatus extends CliStatus {
  /** Where the user gets the token this CLI accepts. */
  readonly hint?: string;
}

export async function fetchBridgeClis(
  bridge: BridgeEndpoint,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<BridgeCliStatus[]> {
  let response: Response;
  try {
    response = await fetcher(
      `${bridge.url}/llm/clis?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        headers: authorization(bridge),
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw unavailable('The Bridge could not be reached.');
  }
  if (!response.ok) throw await failureOf(response);
  const body = safeJson(await response.text());
  return Array.isArray(body['clis']) ? (body['clis'] as BridgeCliStatus[]) : [];
}

const authorization = (bridge: BridgeEndpoint) => ({ authorization: `Bearer ${bridge.token}` });

const unavailable = (message: string) => new CliLlmError('BRIDGE_UNAVAILABLE', message);

async function failureOf(response: Response): Promise<CliLlmError> {
  const body = safeJson(await response.text().catch(() => ''));
  if (response.status === 401 || response.status === 403)
    return unavailable('The Bridge rejected the shared token (BRIDGE_SHARED_TOKEN).');
  return typeof body['code'] === 'string'
    ? errorFrom(body)
    : unavailable(`The Bridge answered ${response.status}.`);
}

function errorFrom(payload: Record<string, unknown>): CliLlmError {
  const code = ERROR_CODES.find((known) => known === payload['code']) ?? 'FAILED';
  return new CliLlmError(code, text(payload['message']) || 'The CLI failed.');
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface SseMessage {
  readonly event: string;
  readonly data: string;
}

/** Incremental parser of a server-sent events stream: feed it text in chunks of any size. */
function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const readLine = (line: string): void => {
    if (line === '') {
      if (data.length > 0) onMessage({ event, data: data.join('\n') });
      event = 'message';
      data = [];
      return;
    }
    if (line.startsWith(':')) return; // heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() as string;
    for (const line of lines) readLine(line);
  };
}
