import type { NewLlmUsageEvent } from '../../issues/usage-store.js';
import type { LlmPort, LlmRequest, LlmResponse } from './agent-ports.js';

/** Where metered usage goes; the usage store satisfies it. */
export interface LlmUsageRecorder {
  record(event: NewLlmUsageEvent): Promise<unknown>;
}

export interface MeterContext {
  readonly workspaceId: string;
  readonly actorId?: string | null;
  /** What asked for the model (a feature such as `spec_chat`), shown in the dashboard. */
  readonly tool: string;
  /** How the model is reached: `api` (API key) or `cli` (a provider CLI). */
  readonly source: 'api' | 'cli';
  readonly model?: string;
}

/** About four characters per token: only used when the provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function requestText(request: LlmRequest): string {
  return `${request.instruction ?? ''}${request.prompt}`;
}

/**
 * Counts every token a model spends so the dashboard shows all AI usage, not only agent runs.
 * A provider that reports usage is recorded as exact; otherwise it is estimated from the text.
 * Recording never breaks the request: a failed write is logged and the answer still returns.
 */
export class MeteredLlm implements LlmPort {
  public readonly provider: string;
  public readonly mcpAccess?: 'standard' | 'read' | 'full';
  public readonly readsFiles?: boolean;

  public constructor(
    private readonly inner: LlmPort,
    private readonly recorder: LlmUsageRecorder,
    private readonly context: MeterContext,
  ) {
    this.provider = inner.provider;
    if (inner.mcpAccess) this.mcpAccess = inner.mcpAccess;
    if (inner.readsFiles !== undefined) this.readsFiles = inner.readsFiles;
  }

  public async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const response = await this.inner.complete(request, signal);
    await this.record(request, response.text, response.usage, response.model);
    return response;
  }

  public async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    let text = '';
    try {
      for await (const chunk of this.inner.stream(request, signal)) {
        text += chunk;
        yield chunk;
      }
    } finally {
      // A stream that was cut short still spent the tokens it produced.
      if (text) await this.record(request, text, undefined, undefined);
    }
  }

  private async record(
    request: LlmRequest,
    output: string,
    usage: LlmResponse['usage'],
    model: string | undefined,
  ): Promise<void> {
    if (this.inner.provider === 'deterministic') return;
    try {
      await this.recorder.record({
        workspaceId: this.context.workspaceId,
        actorId: this.context.actorId ?? null,
        source: this.context.source,
        tool: this.context.tool,
        provider: this.inner.provider.toLowerCase(),
        model: model ?? this.context.model ?? 'unknown',
        inputTokens: usage?.inputTokens ?? estimateTokens(requestText(request)),
        outputTokens: usage?.outputTokens ?? estimateTokens(output),
        estimated: !usage,
        costMicros: null,
      });
    } catch (error) {
      console.error('[MeteredLlm] Could not record usage:', error);
    }
  }
}
