/**
 * Thin, typed HTTP client for the ADK backend. It knows nothing about MCP: tools depend on the
 * `AdkApi` port so they can be exercised with fakes and reused by any other adapter.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | undefined | null;

export interface ApiRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** Skip the `x-workspace-id` header (workspace-agnostic routes such as `/auth/*`). */
  readonly withoutWorkspace?: boolean;
  /** Binary upload sent as-is instead of a JSON `body` (e.g. test evidence). */
  readonly rawBody?: { readonly data: Uint8Array; readonly contentType: string };
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the client timeout, e.g. for long polls or large uploads. */
  readonly timeoutMs?: number;
}

export interface Credentials {
  readonly token?: string;
  readonly workspaceId?: string;
  readonly locale?: string;
}

export interface AdkApi {
  request<T = unknown>(request: ApiRequest): Promise<T>;
}

export interface ApiErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly details?: readonly unknown[];
  readonly correlationId?: string;
}

export class AdkApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: readonly unknown[] = [],
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'AdkApiError';
  }
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly credentials: () => Credentials | Promise<Credentials>;
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, QueryValue>>,
): string {
  const url = new URL(path.replace(/^\/+/, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Encodes a single dynamic path segment so ids can never escape their route. */
export function segment(value: string): string {
  // encodeURIComponent keeps dots, and URL resolution would turn '..' into a parent route.
  if (!value || value === '.' || value === '..') throw new Error(`Invalid identifier: "${value}".`);
  return encodeURIComponent(value);
}

/** Error bodies from proxies can be whole HTML pages; keep messages readable and bounded. */
export const MAX_ERROR_MESSAGE = 500;

export class HttpAdkClient implements AdkApi {
  private readonly fetcher: typeof fetch;

  public constructor(private readonly options: HttpClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  public async request<T = unknown>(request: ApiRequest): Promise<T> {
    const credentials = await this.options.credentials();
    const headers: Record<string, string> = {
      accept: 'application/json, text/markdown, text/csv, text/plain',
      'user-agent': this.options.userAgent ?? 'devkit',
    };
    if (credentials.token) headers['authorization'] = `Bearer ${credentials.token}`;
    if (credentials.workspaceId && !request.withoutWorkspace) {
      headers['x-workspace-id'] = credentials.workspaceId;
    }
    if (credentials.locale) headers['x-locale'] = credentials.locale;
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    if (request.rawBody) headers['content-type'] = request.rawBody.contentType;
    Object.assign(headers, request.headers);

    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(buildUrl(this.options.baseUrl, request.path, request.query), {
        method: request.method,
        headers,
        body: request.rawBody
          ? new Uint8Array(request.rawBody.data)
          : request.body === undefined
            ? undefined
            : JSON.stringify(request.body),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AdkApiError(
        0,
        timedOut ? 'ADK_API_TIMEOUT' : 'ADK_API_UNREACHABLE',
        timedOut
          ? `The ADK API did not answer within ${timeoutMs} ms.`
          : `The ADK API at ${this.options.baseUrl} is unreachable.`,
      );
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    const payload: unknown = await (contentType.includes('application/json')
      ? response.json()
      : response.text());

    if (!response.ok) {
      const body = (typeof payload === 'object' && payload ? payload : {}) as ApiErrorBody;
      throw new AdkApiError(
        response.status,
        body.code ?? `HTTP_${response.status}`,
        (
          body.message ?? (typeof payload === 'string' && payload ? payload : response.statusText)
        ).slice(0, MAX_ERROR_MESSAGE),
        body.details ?? [],
        body.correlationId,
      );
    }
    return payload as T;
  }
}
