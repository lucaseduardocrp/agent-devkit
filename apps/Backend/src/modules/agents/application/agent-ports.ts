export interface LlmImage {
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly data: string;
}

export interface LlmRequest {
  readonly prompt: string;
  readonly instruction?: string;
  readonly images?: readonly LlmImage[];
}

export interface LlmResponse {
  readonly text: string;
  readonly provider: string;
  readonly model?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface LlmPort {
  readonly provider: string;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string>;
}

export class DeterministicLlm implements LlmPort {
  public readonly provider = 'deterministic';

  public complete(request: LlmRequest): Promise<LlmResponse> {
    if (!request.prompt.trim()) {
      return Promise.reject(new Error('Prompt is required.'));
    }

    const prefix = request.instruction ? `${request.instruction}: ` : '';
    return Promise.resolve({ provider: this.provider, text: `${prefix}${request.prompt}` });
  }

  public async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    const response = await this.complete(request);
    for (const token of response.text.split(' ')) {
      signal?.throwIfAborted();
      yield token;
    }
  }
}

export class LlmRegistry {
  private readonly providers = new Map<string, LlmPort>();

  public register(provider: LlmPort): void {
    this.providers.set(provider.provider, provider);
  }

  public get(provider: string): LlmPort {
    const result = this.providers.get(provider);
    if (!result) {
      throw new Error(`LLM provider '${provider}' is not registered.`);
    }

    return result;
  }
}
