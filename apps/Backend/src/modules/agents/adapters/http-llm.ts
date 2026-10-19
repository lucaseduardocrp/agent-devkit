import type { LlmPort, LlmRequest, LlmResponse } from '../application/agent-ports.js';
import { validateExternalUrl } from '../../integrations/security.js';

export interface HttpLlmAdapterOptions {
  readonly provider: string;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

interface ProviderResponse {
  readonly text?: unknown;
  readonly model?: unknown;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export class HttpLlmAdapter implements LlmPort {
  public readonly provider: string;
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  public constructor(options: HttpLlmAdapterOptions) {
    this.provider = options.provider;
    this.endpoint = validateExternalUrl(options.endpoint);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.apiKey = options.apiKey;
  }

  public async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM provider returned HTTP ${response.status}.`);
      }

      const body = (await response.json()) as ProviderResponse;
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new Error('LLM provider returned an invalid response.');
      }

      return {
        provider: this.provider,
        text: body.text,
        ...(typeof body.model === 'string' &&
        body.usage &&
        Number.isFinite(body.usage.inputTokens) &&
        Number.isFinite(body.usage.outputTokens)
          ? {
              model: body.model,
              usage: {
                inputTokens: body.usage.inputTokens!,
                outputTokens: body.usage.outputTokens!,
              },
            }
          : {}),
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  public async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    const response = await this.complete(request, signal);
    yield response.text;
  }
}
