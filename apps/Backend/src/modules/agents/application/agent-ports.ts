export interface LlmImage {
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly data: string;
}

/**
 * A document that goes with a request, as base64. Only the provider CLIs read it for now: text
 * files and PDFs; a provider that cannot read the type refuses the request.
 */
export interface LlmFile {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

/** An MCP server a model may use while it answers, with the token that signs it in. */
export interface LlmMcpServer {
  readonly name: string;
  readonly url: string;
  readonly token: string;
}

export interface LlmRequest {
  readonly prompt: string;
  readonly instruction?: string;
  readonly images?: readonly LlmImage[];
  readonly files?: readonly LlmFile[];
  /** Set only for a provider that can use tools (`LlmPort.mcpAccess`); the others never see it. */
  readonly mcp?: LlmMcpServer;
}

export interface LlmResponse {
  readonly text: string;
  readonly provider: string;
  readonly model?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface LlmPort {
  readonly provider: string;
  /**
   * Present when the provider can use the ADK's MCP tools, and how much of the user's access they
   * get: `read` (safe methods only) or `full` (what the user may do). Absent: no tools.
   */
  readonly mcpAccess?: 'standard' | 'read' | 'full';
  /** Reads documents (PDFs) handed in `LlmRequest.files`. Text files never need it: they are in the prompt. */
  readonly readsFiles?: boolean;
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
