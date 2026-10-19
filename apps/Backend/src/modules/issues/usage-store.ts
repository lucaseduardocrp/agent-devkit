import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Token usage consumed outside agent runs, e.g. by the host model (Claude, Codex...) while it
 * reads ADK tool results and writes tool inputs through the MCP server.
 */
export interface LlmUsageEvent {
  id: string;
  workspaceId: string;
  actorId: string | null;
  source: string;
  tool: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  costMicros: number | null;
  createdAt: Date;
}

export type NewLlmUsageEvent = Omit<LlmUsageEvent, 'id' | 'createdAt'>;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageStore {
  record(event: NewLlmUsageEvent): Promise<LlmUsageEvent>;
  /** Events of a workspace created at or after `since`, newest first. */
  list(workspaceId: string, since: Date): Promise<LlmUsageEvent[]>;
  /** All-time token totals of a workspace. */
  totals(workspaceId: string): Promise<UsageTotals>;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly events: LlmUsageEvent[] = [];

  record(event: NewLlmUsageEvent): Promise<LlmUsageEvent> {
    const saved: LlmUsageEvent = { ...event, id: crypto.randomUUID(), createdAt: new Date() };
    this.events.push(saved);
    return Promise.resolve(saved);
  }

  list(workspaceId: string, since: Date): Promise<LlmUsageEvent[]> {
    return Promise.resolve(
      this.events
        .filter((event) => event.workspaceId === workspaceId && event.createdAt >= since)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  totals(workspaceId: string): Promise<UsageTotals> {
    const owned = this.events.filter((event) => event.workspaceId === workspaceId);
    return Promise.resolve({
      inputTokens: owned.reduce((sum, event) => sum + event.inputTokens, 0),
      outputTokens: owned.reduce((sum, event) => sum + event.outputTokens, 0),
    });
  }
}

export class PrismaUsageStore implements UsageStore {
  constructor(private readonly db: Pick<PrismaClient, 'llmUsageEventRecord'>) {}

  async record(event: NewLlmUsageEvent): Promise<LlmUsageEvent> {
    return this.db.llmUsageEventRecord.create({ data: event });
  }

  async list(workspaceId: string, since: Date): Promise<LlmUsageEvent[]> {
    return this.db.llmUsageEventRecord.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async totals(workspaceId: string): Promise<UsageTotals> {
    const result = await this.db.llmUsageEventRecord.aggregate({
      where: { workspaceId },
      _sum: { inputTokens: true, outputTokens: true },
    });
    return {
      inputTokens: result._sum.inputTokens ?? 0,
      outputTokens: result._sum.outputTokens ?? 0,
    };
  }
}
