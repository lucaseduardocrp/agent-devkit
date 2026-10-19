import type { LlmPort, LlmRequest, LlmResponse } from '../application/agent-ports.js';

export interface GeminiLlmOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

interface GeminiCandidate {
  readonly content?: {
    readonly parts?: readonly { readonly text?: string }[];
  };
}

interface GeminiResponse {
  readonly candidates?: readonly GeminiCandidate[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
}

export class GeminiLlmProvider implements LlmPort {
  public readonly provider = 'Gemini';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  public constructor(options: GeminiLlmOptions) {
    this.apiKey = options.apiKey.trim();
    const configuredModel = options.model?.trim();
    this.model =
      configuredModel && configuredModel !== 'gemini-1.5-flash'
        ? configuredModel
        : 'gemini-2.5-flash';
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/+$/,
      '',
    );
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  public async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const isJsonRequested =
        Boolean(request.instruction && /json/i.test(request.instruction)) ||
        /json/i.test(request.prompt);

      const requestBody: Record<string, unknown> = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: request.prompt },
              ...(request.images ?? []).map((image) => ({
                inline_data: { mime_type: image.mimeType, data: image.data },
              })),
            ],
          },
        ],
      };

      if (request.instruction?.trim()) {
        requestBody.system_instruction = {
          parts: [{ text: request.instruction.trim() }],
        };
      }

      if (isJsonRequested) {
        requestBody.generationConfig = {
          temperature: 0.1,
          responseMimeType: 'application/json',
        };
      }
      requestBody.generationConfig = {
        ...(requestBody.generationConfig as Record<string, unknown> | undefined),
        maxOutputTokens: 2048,
        temperature: 0.2,
      };

      let lastError: Error = new Error('Gemini request failed.');
      const maxRetries = 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          const delayMs = attempt * 50;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        const response = await this.fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!response.ok) {
          // Quota/rate-limit failures do not recover through immediate retries and
          // retrying them only consumes more requests. Transient server failures can retry.
          const isRetryable = [500, 502, 503, 504].includes(response.status);
          lastError = new Error(`Gemini provider returned HTTP ${response.status}.`);
          if (isRetryable) {
            continue;
          }
          throw lastError;
        }

        const body = (await response.json()) as GeminiResponse;
        const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string' || !text.trim()) {
          throw new Error('Gemini provider returned an empty or invalid candidate.');
        }

        const usage = body.usageMetadata;
        return {
          provider: this.provider,
          text,
          ...(usage &&
          Number.isFinite(usage.promptTokenCount) &&
          Number.isFinite(usage.candidatesTokenCount)
            ? {
                model: this.model,
                usage: {
                  inputTokens: usage.promptTokenCount!,
                  outputTokens: usage.candidatesTokenCount!,
                },
              }
            : {}),
        };
      }

      throw lastError;
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
