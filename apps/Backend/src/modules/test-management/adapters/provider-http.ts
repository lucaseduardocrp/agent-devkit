import { ApplicationError } from '../../../shared/errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

export interface ProviderRequest {
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialized as JSON unless it is FormData. */
  readonly body?: unknown;
  /** Short name of the operation, reported in error details (never the URL or a secret). */
  readonly stage: string;
}

export interface ProviderResponse<T> {
  readonly data: T;
  readonly headers: Headers;
}

/**
 * Small JSON client shared by the test management adapters: timeout, one retry for
 * throttling and transient errors, and errors that never echo URLs, tokens or bodies.
 */
export class ProviderHttp {
  constructor(
    private readonly provider: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly options: { readonly timeoutMs?: number; readonly retryDelayMs?: number } = {},
  ) {}

  async request<T>(url: string | URL, request: ProviderRequest): Promise<ProviderResponse<T>> {
    const response = await this.send(url, request, 0);
    if (response.status === 204) return { data: {} as T, headers: response.headers };
    const text = await response.text();
    if (!text.trim()) return { data: {} as T, headers: response.headers };
    try {
      return { data: JSON.parse(text) as T, headers: response.headers };
    } catch {
      throw this.failure(request.stage, response.status);
    }
  }

  async json<T>(url: string | URL, request: ProviderRequest): Promise<T> {
    return (await this.request<T>(url, request)).data;
  }

  private async send(
    url: string | URL,
    request: ProviderRequest,
    attempt: number,
  ): Promise<Response> {
    const isForm = request.body instanceof FormData;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: request.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(request.body === undefined || isForm ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        },
        ...(request.body === undefined
          ? {}
          : {
              body: request.body instanceof FormData ? request.body : JSON.stringify(request.body),
            }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch {
      throw this.failure(request.stage);
    }
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
      await wait(Math.min(delay ?? this.options.retryDelayMs ?? 1_000, 10_000));
      return this.send(url, request, attempt + 1);
    }
    // Azure DevOps answers 203 with a sign-in page when the token is not accepted.
    if (!response.ok || response.status === 203) throw this.failure(request.stage, response.status);
    return response;
  }

  private failure(stage: string, status?: number): ApplicationError {
    return new ApplicationError(
      'TEST_MANAGEMENT_REQUEST_FAILED',
      status
        ? `${this.provider} returned HTTP ${status} (${stage}).`
        : `Could not reach ${this.provider} (${stage}).`,
      status === 401 || status === 403 || status === 404 ? 400 : 502,
      [{ provider: this.provider, stage, ...(status ? { status } : {}) }],
    );
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export function parsePositiveId(value: string | undefined, field: string): number {
  const id = Number(value);
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))
    throw new ApplicationError('TEST_MANAGEMENT_INVALID_ID', `Invalid ${field}.`, 400, [{ field }]);
  return id;
}

export function requireText(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text)
    throw new ApplicationError('TEST_MANAGEMENT_INVALID_ID', `Missing ${field}.`, 400, [{ field }]);
  return text;
}
