import type { LlmPort, LlmRequest, LlmResponse } from '../application/agent-ports.js';

export interface OllamaLlmOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

interface OllamaResponse {
  readonly response?: unknown;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

export class OllamaLlmProvider implements LlmPort {
  public readonly provider = 'Ollama';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  public constructor(options: OllamaLlmOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.model = options.model?.trim() || 'llama3';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  public async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const url = `${this.baseUrl}/api/generate`;
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: request.prompt,
          ...(request.images?.length ? { images: request.images.map((image) => image.data) } : {}),
          options: { num_predict: 2048, temperature: 0.2 },
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama provider returned HTTP ${response.status}.`);
      }

      const body = (await response.json()) as OllamaResponse;
      if (typeof body.response !== 'string' || !body.response.trim()) {
        throw new Error('Ollama provider returned an invalid response.');
      }

      return {
        provider: this.provider,
        text: body.response,
        ...(Number.isFinite(body.prompt_eval_count) && Number.isFinite(body.eval_count)
          ? {
              model: this.model,
              usage: { inputTokens: body.prompt_eval_count!, outputTokens: body.eval_count! },
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
