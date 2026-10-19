import type { PrismaClient } from '../../generated/prisma/client.js';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunMode = 'server' | 'host';

export interface AgentRun {
  id: string;
  workspaceId: string;
  issueId: string;
  agentId: string;
  actorId: string;
  ownerId: string;
  status: RunStatus;
  mode: RunMode;
  attempt: number;
  prompt: string;
  output: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface CostRate {
  workspaceId: string;
  provider: string;
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface RunStore {
  readonly managesIssueStatus: boolean;
  incomplete(): Promise<AgentRun[]>;
  list(workspaceId: string, issueId?: string): Promise<AgentRun[]>;
  get(workspaceId: string, runId: string): Promise<AgentRun | null>;
  claim(
    input: Pick<
      AgentRun,
      'workspaceId' | 'issueId' | 'agentId' | 'actorId' | 'ownerId' | 'mode' | 'prompt' | 'attempt'
    >,
  ): Promise<AgentRun | null>;
  start(workspaceId: string, runId: string): Promise<AgentRun | null>;
  finish(
    workspaceId: string,
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: Partial<
      Pick<
        AgentRun,
        'output' | 'error' | 'provider' | 'model' | 'inputTokens' | 'outputTokens' | 'costMicros'
      >
    >,
  ): Promise<AgentRun | null>;
  getBudget(workspaceId: string): Promise<number>;
  setBudget(workspaceId: string, micros: number): Promise<void>;
  rates(workspaceId: string): Promise<CostRate[]>;
  setRate(rate: CostRate): Promise<CostRate>;
  removeRate(workspaceId: string, provider: string, model: string): Promise<boolean>;
}

export class InMemoryRunStore implements RunStore {
  readonly managesIssueStatus = false;
  private readonly runs = new Map<string, AgentRun>();
  private readonly activeIssues = new Set<string>();
  private readonly budgets = new Map<string, number>();
  private readonly costRates = new Map<string, CostRate>();
  incomplete(): Promise<AgentRun[]> {
    return Promise.resolve(
      [...this.runs.values()].filter((run) => ['queued', 'running'].includes(run.status)),
    );
  }

  list(workspaceId: string, issueId?: string): Promise<AgentRun[]> {
    return Promise.resolve(
      [...this.runs.values()]
        .filter((run) => run.workspaceId === workspaceId && (!issueId || run.issueId === issueId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }
  get(workspaceId: string, runId: string): Promise<AgentRun | null> {
    const run = this.runs.get(runId);
    return Promise.resolve(run?.workspaceId === workspaceId ? run : null);
  }
  claim(input: Parameters<RunStore['claim']>[0]): Promise<AgentRun | null> {
    if (this.activeIssues.has(input.issueId)) return Promise.resolve(null);
    const now = new Date();
    const run: AgentRun = {
      ...input,
      id: crypto.randomUUID(),
      status: 'queued',
      output: null,
      error: null,
      provider: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    this.activeIssues.add(input.issueId);
    return Promise.resolve(run);
  }
  async start(workspaceId: string, runId: string): Promise<AgentRun | null> {
    const run = await this.get(workspaceId, runId);
    if (!run || run.status !== 'queued') return null;
    const next = { ...run, status: 'running' as const, startedAt: new Date() };
    this.runs.set(runId, next);
    return next;
  }
  async finish(
    workspaceId: string,
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: Parameters<RunStore['finish']>[3],
  ): Promise<AgentRun | null> {
    const run = await this.get(workspaceId, runId);
    if (!run || !['queued', 'running'].includes(run.status)) return null;
    const next = { ...run, ...result, status, finishedAt: new Date() };
    this.runs.set(runId, next);
    this.activeIssues.delete(run.issueId);
    return next;
  }
  getBudget(workspaceId: string): Promise<number> {
    return Promise.resolve(this.budgets.get(workspaceId) ?? 0);
  }
  setBudget(workspaceId: string, micros: number): Promise<void> {
    this.budgets.set(workspaceId, micros);
    return Promise.resolve();
  }
  rates(workspaceId: string): Promise<CostRate[]> {
    return Promise.resolve(
      [...this.costRates.values()].filter((rate) => rate.workspaceId === workspaceId),
    );
  }
  setRate(rate: CostRate): Promise<CostRate> {
    this.costRates.set(`${rate.workspaceId}:${rate.provider}:${rate.model}`, rate);
    return Promise.resolve(rate);
  }
  removeRate(workspaceId: string, provider: string, model: string): Promise<boolean> {
    return Promise.resolve(this.costRates.delete(`${workspaceId}:${provider}:${model}`));
  }
}

export class PrismaRunStore implements RunStore {
  readonly managesIssueStatus = true;
  constructor(private readonly db: PrismaClient) {}
  async incomplete(): Promise<AgentRun[]> {
    return this.db.agentRunRecord.findMany({
      where: { status: { in: ['queued', 'running'] } },
    }) as Promise<AgentRun[]>;
  }
  async list(workspaceId: string, issueId?: string): Promise<AgentRun[]> {
    return this.db.agentRunRecord.findMany({
      where: { workspaceId, ...(issueId ? { issueId } : {}) },
      orderBy: { createdAt: 'desc' },
    }) as Promise<AgentRun[]>;
  }
  async get(workspaceId: string, runId: string): Promise<AgentRun | null> {
    return this.db.agentRunRecord.findFirst({
      where: { id: runId, workspaceId },
    }) as Promise<AgentRun | null>;
  }
  async claim(input: Parameters<RunStore['claim']>[0]): Promise<AgentRun | null> {
    const id = crypto.randomUUID();
    return this.db.$transaction(async (tx) => {
      const claimed = await tx.issueRecord.updateMany({
        where: { id: input.issueId, workspaceId: input.workspaceId, activeRunId: null },
        data: { activeRunId: id, status: 'in_progress' },
      });
      if (!claimed.count) return null;
      return tx.agentRunRecord.create({ data: { id, ...input } }) as Promise<AgentRun>;
    });
  }
  async start(workspaceId: string, runId: string): Promise<AgentRun | null> {
    const result = await this.db.agentRunRecord.updateMany({
      where: { id: runId, workspaceId, status: 'queued' },
      data: { status: 'running', startedAt: new Date() },
    });
    return result.count ? this.get(workspaceId, runId) : null;
  }
  async finish(
    workspaceId: string,
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: Parameters<RunStore['finish']>[3],
  ): Promise<AgentRun | null> {
    return this.db.$transaction(async (tx) => {
      const run = await tx.agentRunRecord.findFirst({ where: { id: runId, workspaceId } });
      if (!run || !['queued', 'running'].includes(run.status)) return null;
      await tx.agentRunRecord.update({
        where: { id: runId },
        data: { ...result, status, finishedAt: new Date() },
      });
      await tx.issueRecord.updateMany({
        where: { id: run.issueId, workspaceId, activeRunId: runId },
        data: {
          activeRunId: null,
          status: status === 'succeeded' ? 'in_review' : status === 'failed' ? 'blocked' : 'todo',
        },
      });
      return tx.agentRunRecord.findUnique({ where: { id: runId } }) as Promise<AgentRun>;
    });
  }
  async getBudget(workspaceId: string): Promise<number> {
    return (
      (
        await this.db.workspaceRecord.findUnique({
          where: { id: workspaceId },
          select: { monthlyBudgetMicros: true },
        })
      )?.monthlyBudgetMicros ?? 0
    );
  }
  async setBudget(workspaceId: string, micros: number): Promise<void> {
    await this.db.workspaceRecord.update({
      where: { id: workspaceId },
      data: { monthlyBudgetMicros: micros },
    });
  }
  async rates(workspaceId: string): Promise<CostRate[]> {
    return this.db.costRateRecord.findMany({ where: { workspaceId } });
  }
  async setRate(rate: CostRate): Promise<CostRate> {
    return this.db.costRateRecord.upsert({
      where: {
        workspaceId_provider_model: {
          workspaceId: rate.workspaceId,
          provider: rate.provider,
          model: rate.model,
        },
      },
      create: rate,
      update: {
        inputUsdPerMillion: rate.inputUsdPerMillion,
        outputUsdPerMillion: rate.outputUsdPerMillion,
      },
    });
  }
  async removeRate(workspaceId: string, provider: string, model: string): Promise<boolean> {
    return (
      (await this.db.costRateRecord.deleteMany({ where: { workspaceId, provider, model } })).count >
      0
    );
  }
}
