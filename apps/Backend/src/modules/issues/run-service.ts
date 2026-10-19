import { ApplicationError } from '../../shared/errors.js';
import type { RequestContext } from '../../shared/context.js';
import type { AgentService } from '../agents/application/agent-service.js';
import type { IssueComment, IssueStore } from './issue-store.js';
import type { AgentRun, CostRate, RunMode, RunStore } from './run-store.js';
import type { PbiStore } from '../pbi/pbi-store.js';
import { InMemoryUsageStore, type LlmUsageEvent, type UsageStore } from './usage-store.js';

const MAX_MICROS = 2_147_483_647;

export interface UsageInput {
  tool: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

/** Current-month token usage reported by MCP clients (host model reading and writing tool data). */
function summarizeMcpUsage(events: readonly LlmUsageEvent[]) {
  const tokens = (event: LlmUsageEvent) => event.inputTokens + event.outputTokens;
  const tools = new Map<string, { tool: string; calls: number; totalTokens: number }>();
  const clients = new Map<
    string,
    { provider: string; model: string; calls: number; totalTokens: number }
  >();
  for (const event of events) {
    const tool = tools.get(event.tool) ?? { tool: event.tool, calls: 0, totalTokens: 0 };
    tool.calls += 1;
    tool.totalTokens += tokens(event);
    tools.set(event.tool, tool);
    const key = `${event.provider}\u0000${event.model}`;
    const client = clients.get(key) ?? {
      provider: event.provider,
      model: event.model,
      calls: 0,
      totalTokens: 0,
    };
    client.calls += 1;
    client.totalTokens += tokens(event);
    clients.set(key, client);
  }
  const inputTokens = events.reduce((sum, event) => sum + event.inputTokens, 0);
  const outputTokens = events.reduce((sum, event) => sum + event.outputTokens, 0);
  const byTokens = (a: { totalTokens: number }, b: { totalTokens: number }) =>
    b.totalTokens - a.totalTokens;
  return {
    calls: events.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    spendMicros: events.reduce((sum, event) => sum + (event.costMicros ?? 0), 0),
    unpricedCalls: events.filter((event) => event.costMicros === null).length,
    estimated: events.some((event) => event.estimated),
    byTool: [...tools.values()].sort(byTokens).slice(0, 10),
    byClient: [...clients.values()].sort(byTokens),
  };
}

export class RunService {
  private readonly controllers = new Map<string, AbortController>();
  constructor(
    private readonly store: RunStore,
    private readonly issues: IssueStore,
    private readonly agents: AgentService,
    private readonly pbiItems?: PbiStore,
    private readonly usage: UsageStore = new InMemoryUsageStore(),
  ) {}

  async recover(): Promise<void> {
    for (const run of await this.store.incomplete()) {
      if (run.mode !== 'server') continue;
      if (run.status === 'queued')
        queueMicrotask(() => {
          void this.execute(run.id, run.workspaceId).catch((error: unknown) =>
            console.error('[RunService] Run failed:', error),
          );
        });
      else {
        await this.store.finish(run.workspaceId, run.id, 'failed', {
          error: 'Backend restarted during execution. Retry the issue.',
        });
        if (!this.store.managesIssueStatus)
          await this.issues.update(run.workspaceId, run.issueId, { status: 'blocked' });
      }
    }
  }

  async list(workspaceId: string, issueId?: string): Promise<AgentRun[]> {
    return this.store.list(workspaceId, issueId);
  }
  async get(workspaceId: string, runId: string): Promise<AgentRun> {
    const run = await this.store.get(workspaceId, runId);
    if (!run) throw new ApplicationError('RUN_NOT_FOUND', 'Agent run not found.', 404);
    return run;
  }
  async costs(workspaceId: string) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [runs, rates, monthlyBudgetMicros, usageTotals, monthUsage] = await Promise.all([
      this.store.list(workspaceId),
      this.store.rates(workspaceId),
      this.store.getBudget(workspaceId),
      this.usage.totals(workspaceId),
      this.usage.list(workspaceId, monthStart),
    ]);
    const monthly = runs.filter((run) => run.createdAt >= monthStart);
    const mcpUsage = summarizeMcpUsage(monthUsage);
    // Totals cover agent runs and MCP usage so the dashboard reflects every token consumed.
    const totalInputTokens =
      runs.reduce((sum, run) => sum + (run.inputTokens ?? 0), 0) + usageTotals.inputTokens;
    const totalOutputTokens =
      runs.reduce((sum, run) => sum + (run.outputTokens ?? 0), 0) + usageTotals.outputTokens;
    const byAgent = Object.fromEntries(
      [...new Set(monthly.map((run) => run.agentId))].map((agentId) => {
        const owned = monthly.filter((run) => run.agentId === agentId);
        return [
          agentId,
          {
            spendMicros: owned.reduce((sum, run) => sum + (run.costMicros ?? 0), 0),
            runs: owned.length,
            unpricedRuns: owned.filter(
              (run) => run.status === 'succeeded' && run.costMicros === null,
            ).length,
          },
        ];
      }),
    );
    return {
      monthlyBudgetMicros,
      monthSpendMicros:
        monthly.reduce((sum, run) => sum + (run.costMicros ?? 0), 0) + mcpUsage.spendMicros,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      unpricedRuns: monthly.filter((run) => run.status === 'succeeded' && run.costMicros === null)
        .length,
      rates,
      byAgent,
      recentRuns: runs.slice(0, 20),
      mcpUsage,
    };
  }
  /** Records tokens consumed by an MCP client, priced with the workspace rate table. */
  async recordUsage(
    workspaceId: string,
    actorId: string | null,
    input: UsageInput,
  ): Promise<LlmUsageEvent> {
    const provider = input.provider.trim().toLowerCase();
    const model = input.model.trim();
    const costMicros = await this.calculateCost(workspaceId, provider, model, input);
    return this.usage.record({
      workspaceId,
      actorId,
      source: 'mcp',
      tool: input.tool,
      provider,
      model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimated: input.estimated,
      costMicros,
    });
  }
  async setBudget(workspaceId: string, monthlyBudgetMicros: number) {
    await this.store.setBudget(workspaceId, monthlyBudgetMicros);
    return this.costs(workspaceId);
  }
  async setRate(rate: CostRate): Promise<CostRate> {
    return this.store.setRate({
      ...rate,
      provider: rate.provider.trim().toLowerCase(),
      model: rate.model.trim(),
    });
  }
  async removeRate(workspaceId: string, provider: string, model: string): Promise<boolean> {
    return this.store.removeRate(workspaceId, provider.trim().toLowerCase(), model.trim());
  }

  async create(
    issueId: string,
    context: RequestContext,
    mode: RunMode = 'server',
    responseTo?: IssueComment,
  ): Promise<AgentRun> {
    const workspaceId = context.workspaceId;
    if (!workspaceId)
      throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
    const issue = await this.issues.get(workspaceId, issueId);
    if (!issue) throw new ApplicationError('ISSUE_NOT_FOUND', 'Issue not found.', 404);
    if (!issue.assigneeAgentId)
      throw new ApplicationError(
        'AGENT_REQUIRED',
        'Assign an agent before starting the issue.',
        400,
      );
    if (!responseTo && ['done', 'cancelled'].includes(issue.status))
      throw new ApplicationError('ISSUE_CLOSED', 'Closed issues cannot be run.', 409);
    await this.agents.getAgent(workspaceId, issue.assigneeAgentId);
    const cost = await this.costs(workspaceId);
    if (cost.monthlyBudgetMicros > 0 && cost.monthSpendMicros >= cost.monthlyBudgetMicros)
      throw new ApplicationError('BUDGET_EXCEEDED', 'Monthly agent budget has been reached.', 409);
    const attempt = (await this.store.list(workspaceId, issue.id)).length + 1;
    let pbiContext = '';
    if (issue.pbiItemId && this.pbiItems) {
      const item = await this.pbiItems.get(workspaceId, issue.pbiItemId);
      if (item) {
        const all = await this.pbiItems.list(workspaceId);
        const visit = (parentId: string, depth: number): string[] =>
          all
            .filter((child) => child.parentId === parentId)
            .flatMap((child) => [
              `${'  '.repeat(depth)}- ${child.title}: ${child.description}`,
              ...visit(child.id, depth + 1),
            ]);
        pbiContext = `\n\nCurrent PBI context:\n${item.title}: ${item.description}\n${visit(item.id, 0).join('\n')}`;
      }
    }
    const comments = await this.issues.comments(issue.id);
    const conversation = comments.length
      ? `\n\nConversation on this issue (oldest first):\n${comments
          .map(
            (comment) =>
              `[${comment.id}] ${comment.authorId === issue.assigneeAgentId ? 'Agent' : 'User'}: ${comment.body}`,
          )
          .join('\n')}`
      : '';
    const instruction = responseTo
      ? `\n\nThe latest user comment [${responseTo.id}] is a new request. Consider the issue, previous work and the full conversation. Carry out the requested work when possible. If clarification or a decision is needed, ask a specific question. Write a concise, direct reply to the user; the application will publish your answer as an issue comment. Do not claim changes you did not make.`
      : '\n\nProvide the work performed, result, and any remaining blockers. Do not claim external changes you did not make.';
    const prompt = `Work on issue #${issue.number}: ${issue.title}\n\n${issue.description}${pbiContext}${conversation}${instruction}`;
    const run = await this.store.claim({
      workspaceId,
      issueId: issue.id,
      agentId: issue.assigneeAgentId,
      actorId: context.actorId ?? issue.createdBy,
      ownerId: context.ownerId ?? workspaceId,
      mode,
      prompt,
      attempt,
    });
    if (!run)
      throw new ApplicationError(
        'ISSUE_ALREADY_RUNNING',
        'This issue already has an active run.',
        409,
      );
    if (!this.store.managesIssueStatus)
      await this.issues.update(workspaceId, issue.id, { status: 'in_progress' });
    if (mode === 'server')
      queueMicrotask(() => {
        void this.execute(run.id, workspaceId).catch((error: unknown) =>
          console.error('[RunService] Run failed:', error),
        );
      });
    return run;
  }

  private async execute(runId: string, workspaceId: string): Promise<void> {
    const run = await this.store.start(workspaceId, runId);
    if (!run) return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    try {
      const result = await this.agents.executeAgent(
        workspaceId,
        run.agentId,
        { prompt: run.prompt, includeKnowledge: true },
        { requestId: run.id, workspaceId, ownerId: run.ownerId, actorId: run.actorId },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const costMicros = await this.calculateCost(
        workspaceId,
        result.provider,
        result.model,
        result.usage,
      );
      const finished = await this.store.finish(workspaceId, runId, 'succeeded', {
        output: result.result,
        provider: result.provider,
        model: result.model ?? null,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        costMicros,
      });
      if (finished && !this.store.managesIssueStatus)
        await this.issues.update(workspaceId, run.issueId, { status: 'in_review' });
      if (finished && this.isCommentResponse(run))
        await this.issues.addComment(run.issueId, run.agentId, result.result);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Agent execution failed.';
        const finished = await this.store.finish(workspaceId, runId, 'failed', {
          error: message.slice(0, 4000),
        });
        if (finished && !this.store.managesIssueStatus)
          await this.issues.update(workspaceId, run.issueId, { status: 'blocked' });
      }
    } finally {
      this.controllers.delete(runId);
      await this.followUpOnNewComments(run);
    }
  }

  private isCommentResponse(run: AgentRun): boolean {
    return run.prompt.includes('is a new request. Consider the issue');
  }

  private async followUpOnNewComments(run: AgentRun): Promise<void> {
    const issue = await this.issues.get(run.workspaceId, run.issueId);
    if (!issue?.assigneeAgentId) return;
    const agentIds = new Set(
      (await this.store.list(run.workspaceId, run.issueId)).map((previous) => previous.agentId),
    );
    const pending = (await this.issues.comments(run.issueId)).filter(
      (comment) => !agentIds.has(comment.authorId) && !run.prompt.includes(`[${comment.id}]`),
    );
    const latest = pending.at(-1);
    if (!latest) return;
    try {
      await this.create(
        run.issueId,
        {
          requestId: run.id,
          workspaceId: run.workspaceId,
          ownerId: run.ownerId,
          actorId: latest.authorId,
        },
        run.mode,
        latest,
      );
    } catch (error) {
      if (!(error instanceof ApplicationError && error.code === 'ISSUE_ALREADY_RUNNING'))
        console.error('[RunService] Could not start comment follow-up:', error);
    }
  }

  async checkout(workspaceId: string, runId: string): Promise<AgentRun> {
    const run = await this.get(workspaceId, runId);
    if (run.mode !== 'host')
      throw new ApplicationError('INVALID_RUN_MODE', 'This run uses the backend model.', 409);
    if (run.status !== 'queued')
      throw new ApplicationError(
        'INVALID_RUN_STATE',
        'Run is already checked out or finished.',
        409,
      );
    const checked = await this.store.start(workspaceId, runId);
    if (!checked)
      throw new ApplicationError(
        'INVALID_RUN_STATE',
        'Run is already checked out or finished.',
        409,
      );
    return checked;
  }
  async completeHost(
    workspaceId: string,
    runId: string,
    result: {
      output: string;
      provider?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<AgentRun> {
    const run = await this.get(workspaceId, runId);
    if (run.mode !== 'host' || run.status !== 'running')
      throw new ApplicationError(
        'INVALID_RUN_STATE',
        'Only a checked-out host run can be completed.',
        409,
      );
    const costMicros = await this.calculateCost(
      workspaceId,
      result.provider,
      result.model,
      result.inputTokens !== undefined && result.outputTokens !== undefined
        ? { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
        : undefined,
    );
    const finished = await this.store.finish(workspaceId, runId, 'succeeded', {
      output: result.output,
      provider: result.provider ?? 'host',
      model: result.model ?? null,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      costMicros,
    });
    if (!finished) throw new ApplicationError('INVALID_RUN_STATE', 'Run already finished.', 409);
    if (!this.store.managesIssueStatus)
      await this.issues.update(workspaceId, run.issueId, { status: 'in_review' });
    if (this.isCommentResponse(run))
      await this.issues.addComment(run.issueId, run.agentId, result.output);
    await this.followUpOnNewComments(run);
    return finished;
  }
  async cancel(workspaceId: string, runId: string): Promise<AgentRun> {
    const run = await this.get(workspaceId, runId);
    if (!['queued', 'running'].includes(run.status))
      throw new ApplicationError('INVALID_RUN_STATE', 'Run already finished.', 409);
    this.controllers.get(runId)?.abort();
    const finished = await this.store.finish(workspaceId, runId, 'cancelled', {});
    if (!finished) throw new ApplicationError('INVALID_RUN_STATE', 'Run already finished.', 409);
    if (!this.store.managesIssueStatus)
      await this.issues.update(workspaceId, run.issueId, { status: 'todo' });
    return finished;
  }
  private async calculateCost(
    workspaceId: string,
    provider?: string,
    model?: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): Promise<number | null> {
    if (
      !provider ||
      !model ||
      !usage ||
      !Number.isSafeInteger(usage.inputTokens) ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.inputTokens < 0 ||
      usage.outputTokens < 0
    )
      return null;
    const rate = (await this.store.rates(workspaceId)).find(
      (item) => item.provider.toLowerCase() === provider.toLowerCase() && item.model === model,
    );
    if (!rate) return null;
    const micros = Math.round(
      usage.inputTokens * rate.inputUsdPerMillion + usage.outputTokens * rate.outputUsdPerMillion,
    );
    return Number.isSafeInteger(micros) && micros <= MAX_MICROS ? micros : null;
  }
}
