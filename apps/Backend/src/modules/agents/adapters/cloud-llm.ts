import type { LlmPort, LlmRequest, LlmResponse } from '../application/agent-ports.js';

interface CloudLlmOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

abstract class CloudLlmProvider implements LlmPort {
  public abstract readonly provider: string;
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly baseUrl: string;
  protected readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  protected constructor(options: CloudLlmOptions, baseUrl: string) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = (options.baseUrl?.trim() || baseUrl).replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    if (!this.apiKey || !this.model) throw new Error('API key and model are required.');
  }

  protected abstract request(
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<Pick<LlmResponse, 'text' | 'model' | 'usage'>>;

  public async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const result = await this.request(request, controller.signal);
      return { provider: this.provider, ...result };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  public async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    yield (await this.complete(request, signal)).text;
  }
}

abstract class OpenAiCompatibleProvider extends CloudLlmProvider {
  protected async request(
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<Pick<LlmResponse, 'text' | 'model' | 'usage'>> {
    const messages = [
      ...(request.instruction ? [{ role: 'system', content: request.instruction }] : []),
      {
        role: 'user',
        content: request.images?.length
          ? [
              { type: 'text', text: request.prompt },
              ...request.images.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.data}` },
              })),
            ]
          : request.prompt,
      },
    ];
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, max_tokens: 2048, temperature: 0.2 }),
      signal,
    });
    if (!response.ok)
      throw new Error(`${this.provider} provider returned HTTP ${response.status}.`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim())
      throw new Error(`${this.provider} returned an invalid response.`);
    return {
      text,
      ...(body.usage &&
      Number.isFinite(body.usage.prompt_tokens) &&
      Number.isFinite(body.usage.completion_tokens)
        ? {
            model: body.model ?? this.model,
            usage: {
              inputTokens: body.usage.prompt_tokens!,
              outputTokens: body.usage.completion_tokens!,
            },
          }
        : {}),
    };
  }
}

export class OpenAiLlmProvider extends OpenAiCompatibleProvider {
  public readonly provider = 'OpenAI';
  public constructor(options: CloudLlmOptions) {
    super(options, 'https://api.openai.com/v1');
  }
}

export class GroqLlmProvider extends OpenAiCompatibleProvider {
  public readonly provider = 'Groq';
  public constructor(options: CloudLlmOptions) {
    super(options, 'https://api.groq.com/openai/v1');
  }
}

export class AnthropicLlmProvider extends CloudLlmProvider {
  public readonly provider = 'Claude';
  public constructor(options: CloudLlmOptions) {
    super(options, 'https://api.anthropic.com/v1');
  }

  protected async request(
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<Pick<LlmResponse, 'text' | 'model' | 'usage'>> {
    const response = await this.fetcher(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        ...(request.instruction ? { system: request.instruction } : {}),
        messages: [
          {
            role: 'user',
            content: request.images?.length
              ? [
                  { type: 'text', text: request.prompt },
                  ...request.images.map((image) => ({
                    type: 'image',
                    source: { type: 'base64', media_type: image.mimeType, data: image.data },
                  })),
                ]
              : request.prompt,
          },
        ],
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Claude provider returned HTTP ${response.status}.`);
    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: unknown }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string' || !text.trim())
      throw new Error('Claude returned an invalid response.');
    return {
      text,
      ...(body.usage &&
      Number.isFinite(body.usage.input_tokens) &&
      Number.isFinite(body.usage.output_tokens)
        ? {
            model: body.model ?? this.model,
            usage: {
              inputTokens: body.usage.input_tokens!,
              outputTokens: body.usage.output_tokens!,
            },
          }
        : {}),
    };
  }
}
