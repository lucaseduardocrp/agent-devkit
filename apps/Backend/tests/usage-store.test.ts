import { describe, expect, it, vi } from 'vitest';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import {
  InMemoryUsageStore,
  PrismaUsageStore,
  type NewLlmUsageEvent,
} from '../src/modules/issues/usage-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';

const event = (overrides: Partial<NewLlmUsageEvent> = {}): NewLlmUsageEvent => ({
  workspaceId: 'workspace-a',
  actorId: 'user-a',
  source: 'mcp',
  tool: 'brain_search',
  provider: 'mcp',
  model: 'claude-code',
  inputTokens: 10,
  outputTokens: 5,
  estimated: true,
  costMicros: null,
  ...overrides,
});

describe('LLM usage ledger', () => {
  it('stores events per workspace in memory, newest first, with all-time totals', async () => {
    const store = new InMemoryUsageStore();
    const first = await store.record(event());
    first.createdAt = new Date('2020-01-01T00:00:00.000Z');
    const second = await store.record(event({ tool: 'spec_get', inputTokens: 1, outputTokens: 2 }));
    await store.record(event({ workspaceId: 'workspace-b', inputTokens: 100 }));
    expect(second).toMatchObject({ id: expect.any(String), tool: 'spec_get' });
    expect((await store.list('workspace-a', new Date(0))).map((item) => item.tool)).toEqual([
      'spec_get',
      'brain_search',
    ]);
    expect(await store.list('workspace-a', new Date('2021-01-01T00:00:00.000Z'))).toEqual([second]);
    expect(await store.totals('workspace-a')).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(await store.totals('workspace-c')).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('maps the ledger to Prisma queries', async () => {
    const saved = { ...event(), id: 'usage-1', createdAt: new Date() };
    const delegate = {
      create: vi.fn().mockResolvedValue(saved),
      findMany: vi.fn().mockResolvedValue([saved]),
      aggregate: vi
        .fn()
        .mockResolvedValueOnce({ _sum: { inputTokens: 30, outputTokens: 12 } })
        .mockResolvedValueOnce({ _sum: { inputTokens: null, outputTokens: null } }),
    };
    const store = new PrismaUsageStore({ llmUsageEventRecord: delegate } as never);
    const since = new Date('2026-10-01T00:00:00.000Z');
    expect(await store.record(event())).toBe(saved);
    expect(delegate.create).toHaveBeenCalledWith({ data: event() });
    expect(await store.list('workspace-a', since)).toEqual([saved]);
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
    expect(await store.totals('workspace-a')).toEqual({ inputTokens: 30, outputTokens: 12 });
    expect(await store.totals('workspace-a')).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(delegate.aggregate).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a' },
      _sum: { inputTokens: true, outputTokens: true },
    });
  });

  it('summarizes the current month of MCP usage by tool and client', async () => {
    const usage = new InMemoryUsageStore();
    const runs = new RunService(
      new InMemoryRunStore(),
      new InMemoryIssueStore(),
      {} as AgentService,
      undefined,
      usage,
    );
    await runs.setRate({
      workspaceId: 'workspace-a',
      provider: 'MCP',
      model: 'claude-code',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    });
    for (let index = 0; index < 12; index += 1)
      await runs.recordUsage('workspace-a', 'user-a', {
        tool: `tool_${index}`,
        provider: ' MCP ',
        model: ' claude-code ',
        inputTokens: index,
        outputTokens: 0,
        estimated: false,
      });
    await runs.recordUsage('workspace-a', null, {
      tool: 'tool_11',
      provider: 'mcp',
      model: 'codex',
      inputTokens: 100,
      outputTokens: 1,
      estimated: false,
    });
    const old = await usage.record(event({ inputTokens: 1000, outputTokens: 0, costMicros: 99 }));
    old.createdAt = new Date('2020-01-01T00:00:00.000Z');

    const costs = await runs.costs('workspace-a');
    expect(costs.totalTokens).toBe(66 + 101 + 1000);
    expect(costs.monthSpendMicros).toBe(66);
    expect(costs.mcpUsage).toMatchObject({
      calls: 13,
      inputTokens: 166,
      outputTokens: 1,
      totalTokens: 167,
      spendMicros: 66,
      unpricedCalls: 1,
      estimated: false,
      byClient: [
        { provider: 'mcp', model: 'codex', calls: 1, totalTokens: 101 },
        { provider: 'mcp', model: 'claude-code', calls: 12, totalTokens: 66 },
      ],
    });
    expect(costs.mcpUsage.byTool).toHaveLength(10);
    expect(costs.mcpUsage.byTool[0]).toEqual({ tool: 'tool_11', calls: 2, totalTokens: 112 });
    expect(costs.mcpUsage.byTool.map((item) => item.tool)).not.toContain('tool_0');
  });
});
