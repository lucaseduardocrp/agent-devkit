import { describe, expect, it, vi } from 'vitest';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryUsageStore } from '../src/modules/issues/usage-store.js';
import {
  InMemoryIssueBriefStore,
  PrismaIssueBriefStore,
} from '../src/modules/issues/agent-brief/brief-store.js';
import {
  IssueBriefService,
  briefRunContext,
  type BriefServiceDeps,
} from '../src/modules/issues/agent-brief/brief-service.js';
import type { PbiStore } from '../src/modules/pbi/pbi-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { CostRate } from '../src/modules/issues/run-store.js';

const ws = 'ws';
const context = { requestId: 'r', workspaceId: ws, ownerId: 'owner', actorId: 'u' };
const NOW = new Date('2026-11-05T12:00:00Z');
const rate = (provider: string, model: string): CostRate => ({
  workspaceId: ws,
  provider,
  model,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 5,
});

function setup(overrides: Partial<BriefServiceDeps> = {}) {
  const issues = new InMemoryIssueStore();
  const store = new InMemoryIssueBriefStore();
  const usage = new InMemoryUsageStore();
  const deps: BriefServiceDeps = {
    store,
    issues,
    rates: () => Promise.resolve([]),
    usage,
    now: () => NOW,
    ...overrides,
  };
  return { issues, store, usage, service: new IssueBriefService(deps) };
}

describe('IssueBriefService', () => {
  it('generates, stores and reads a brief per workspace', async () => {
    const { issues, service } = setup();
    const issue = await issues.create(ws, 'u', { title: 'Fix typo', description: 'small' });
    const brief = await service.generate(context, issue);
    expect(brief.complexity.level).toBe('trivial');
    expect(await service.get(ws, issue.id)).toEqual(brief);
    expect(await service.get('other', issue.id)).toBeNull();
    expect(await service.get(ws, 'missing')).toBeNull();
  });

  it('uses the system clock when none is injected', async () => {
    const { issues, store, usage } = setup();
    const service = new IssueBriefService({
      store,
      issues,
      usage,
      rates: () => Promise.resolve([]),
    });
    const issue = await issues.create(ws, 'u', { title: 'Now' });
    const brief = await service.generate(context, issue);
    expect(Date.parse(brief.generatedAt)).toBeGreaterThan(Date.parse('2026-01-01'));
  });

  it('builds the model list from integrations, rates and recent usage', async () => {
    const llm = (providerId: string, settings: Record<string, unknown>, isEnabled = true) => ({
      category: 'LLM',
      providerId,
      isEnabled,
      settings,
    });
    const { issues, usage, service } = setup({
      integrations: {
        listIntegrations: () =>
          Promise.resolve([
            llm('Anthropic', { model: 'claude-sonnet-5-5' }),
            llm('openai', {}),
            llm('ollama', { model: 'llama3-8b' }),
            llm('groq', { model: 'off' }, false),
            { category: 'KNOWLEDGE', providerId: 'notion', isEnabled: true, settings: {} },
          ]),
      },
      rates: () =>
        Promise.resolve([
          rate('anthropic', 'claude-sonnet-5-5'),
          rate('anthropic', 'claude-haiku-5-5'),
          rate('openai', 'gpt-5-mini'),
          rate('mistral', 'ignored'),
        ]),
    });
    await usage.record({
      workspaceId: ws,
      actorId: null,
      source: 'mcp',
      tool: 't',
      provider: 'Claude',
      model: 'claude-opus-5-5',
      inputTokens: 1,
      outputTokens: 1,
      estimated: true,
      costMicros: null,
    });
    // The local model is free, so it is the cheapest fast option of all.
    const trivial = await service.generate(
      context,
      await issues.create(ws, 'u', { title: 'Plain' }),
    );
    expect(trivial.recommendation).toMatchObject({ provider: 'ollama', model: 'llama3-8b' });
    expect(trivial.recommendation.estimatedCostUsd).toBe(0);
    const epic = await issues.create(ws, 'u', {
      title: 'Refactor architecture',
      description: Array.from({ length: 420 }, () => 'w').join(' '),
      type: 'epic',
      priority: 'urgent',
    });
    const big = await service.generate(context, epic);
    expect(big.recommendation).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    expect(big.recommendation.estimatedCostUsd).toBeNull();
    // A model seen in both the integration and the usage keeps its in-use flag.
    const medium = await service.generate(
      context,
      await issues.create(ws, 'u', {
        title: 'Medium',
        description: Array.from({ length: 130 }, () => 'w').join(' '),
      }),
    );
    expect(medium.complexity.level).toBe('small');
  });

  it('falls back to the workspace id as the integration owner', async () => {
    const listIntegrations = vi.fn().mockResolvedValue([]);
    const { issues, service } = setup({ integrations: { listIntegrations } });
    const issue = await issues.create(ws, 'u', { title: 'Owner' });
    const brief = await service.generate({ requestId: 'r' }, issue);
    expect(listIntegrations).toHaveBeenCalledWith(ws);
    expect(brief.recommendation.provider).toBe('');
  });

  it('lists the PBI, its children, sibling issues, attachments and Brain pages to read', async () => {
    const children = Array.from({ length: 7 }, (_, index) => ({
      id: `c${index}`,
      title: `Child ${index}`,
    }));
    const pbiItems = {
      get: vi.fn(async (_ws: string, id: string) =>
        id === 'pbi-1' ? { id, title: 'Checkout', description: '' } : null,
      ),
      listChildren: vi.fn().mockResolvedValue(children),
    } as unknown as Pick<PbiStore, 'get' | 'listChildren'>;
    const chunk = (source: string, pageId: string, chunkIndex = 0) => ({
      source,
      pageId,
      chunkIndex,
      content: `${source} passage ${chunkIndex}`,
      createdAt: '',
    });
    const search = vi
      .fn()
      .mockResolvedValue([
        chunk('Checkout guide', 'page-1'),
        chunk('Checkout guide', 'page-1', 1),
        chunk('Payments', 'page-2'),
        chunk('Refunds', 'page-3'),
        chunk('Extra', 'page-4'),
      ]);
    const { issues, service } = setup({ pbiItems, knowledge: { search } });
    for (let index = 0; index < 6; index += 1)
      await issues.create(ws, 'u', { title: `Sibling ${index}`, pbiItemId: 'pbi-1' });
    const issue = await issues.create(ws, 'u', {
      title: 'Checkout',
      description: 'Pay',
      pbiItemId: 'pbi-1',
      attachments: [
        {
          id: 'img-1',
          name: 'mock.png',
          kind: 'image',
          scope: 'issue',
          source: 'adk',
          url: '/attachments/files/img-1',
        },
      ],
    });
    await issues.addComment(issue.id, 'u', 'hello');
    const brief = await service.generate(context, issue);
    const refs = brief.readFirst.map((item) => `${item.kind}:${item.label}`);
    expect(refs).toContain('pbi:Checkout');
    expect(refs.filter((ref) => ref.startsWith('pbi:Child'))).toHaveLength(5);
    // The engine keeps 12 references, so sibling issues are the first to be cut.
    expect(refs.filter((ref) => ref.startsWith('issue:'))).toHaveLength(2);
    expect(refs).toContain('attachment:mock.png');
    expect(refs.filter((ref) => ref.startsWith('brain:'))).toEqual([
      'brain:Checkout guide',
      'brain:Payments',
      'brain:Refunds',
    ]);
    // A Brain reference keeps the passage that matched, so a person can open that exact part.
    expect(
      brief.readFirst.filter((item) => item.kind === 'brain').map((item) => item.excerpt),
    ).toEqual(['Checkout guide passage 0', 'Payments passage 0', 'Refunds passage 0']);
    expect(search).toHaveBeenCalledWith('Checkout Pay', context);
  });

  it('skips missing PBIs, empty queries and failing knowledge', async () => {
    const pbiItems = {
      get: vi.fn().mockResolvedValue(null),
      listChildren: vi.fn(),
    } as unknown as Pick<PbiStore, 'get' | 'listChildren'>;
    const search = vi.fn().mockRejectedValue(new Error('down'));
    const { issues, service } = setup({ pbiItems, knowledge: { search } });
    const orphan = await issues.create(ws, 'u', { title: 'Orphan', pbiItemId: 'gone' });
    expect((await service.generate(context, orphan)).readFirst).toEqual([]);
    expect(search).toHaveBeenCalled();
    search.mockClear();
    await service.generate(context, { ...orphan, title: ' ', description: '', pbiItemId: null });
    expect(search).not.toHaveBeenCalled();
    const noPbiStore = setup();
    const issue = await noPbiStore.issues.create(ws, 'u', { title: 'x', pbiItemId: 'p' });
    expect((await noPbiStore.service.generate(context, issue)).complexity.level).toBe('trivial');
  });

  it('treats an issue without an attachment list as having none', async () => {
    const { issues, service } = setup();
    const issue = await issues.create(ws, 'u', { title: 'No list' });
    const brief = await service.generate(context, { ...issue, attachments: undefined });
    expect(brief.readFirst).toEqual([]);
    expect(brief.complexity.signals).toEqual([]);
  });

  it('refresh never throws, even when the engine inputs fail', async () => {
    const { issues, service } = setup({ rates: () => Promise.reject(new Error('db down')) });
    const issue = await issues.create(ws, 'u', { title: 'Broken' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await service.refresh(context, issue)).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    const healthy = setup();
    const ok = await healthy.issues.create(ws, 'u', { title: 'Fine' });
    expect((await healthy.service.refresh(context, ok))?.issueId).toBe(ok.id);
  });

  it('locks edited fields, keeps them on regeneration and releases them with force', async () => {
    const { issues, service } = setup();
    const issue = await issues.create(ws, 'u', { title: 'Edit me' });
    const edited = await service.edit(context, issue, { considerations: ['Mine'] });
    expect(edited).toMatchObject({
      source: 'edited',
      locked: ['considerations'],
      considerations: ['Mine'],
    });
    expect(edited.updatedAt).toBe(NOW.toISOString());
    const again = await service.edit(context, issue, {
      budget: { maxInputTokens: 1, maxOutputTokens: 1 },
      considerations: ['Mine too'],
    });
    expect(again.locked).toEqual(['considerations', 'budget']);
    const kept = await service.regenerate(context, issue, false);
    expect(kept.considerations).toEqual(['Mine too']);
    const reset = await service.regenerate(context, issue, true);
    expect(reset).toMatchObject({ source: 'engine', locked: [] });
    expect(reset.considerations).not.toEqual(['Mine too']);
    const fresh = await setup().service.regenerate(context, issue, true);
    expect(fresh.locked).toEqual([]);
  });

  it('creates the brief on first edit and rejects empty edits', async () => {
    const { issues, service, store } = setup();
    const issue = await issues.create(ws, 'u', { title: 'First edit' });
    expect(await store.get(ws, issue.id)).toBeNull();
    const brief = await service.edit(context, issue, {
      prompt: { system: 's', task: 't', outputFormat: 'o' },
    });
    expect(brief.locked).toEqual(['prompt']);
    await expect(service.edit(context, issue, {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('briefRunContext', () => {
  it('summarises what an agent must read and respect', async () => {
    const { issues, service } = setup();
    const issue = await issues.create(ws, 'u', { title: 'Run' });
    const brief = await service.generate(context, issue);
    const plain = briefRunContext(brief);
    expect(plain).toContain('Execution brief (trivial, effort low):');
    expect(plain).not.toContain('Read first');
    const withReads = briefRunContext({
      ...brief,
      readFirst: [{ kind: 'file', label: 'a.ts', ref: 'src/a.ts', reason: 'entry point' }],
    });
    expect(withReads).toContain('1. [file] a.ts (src/a.ts) - entry point');
  });

  it('asks a host run to confirm the recommended model, and tells it to just run when it matches', async () => {
    const { issues, service } = setup();
    const issue = await issues.create(ws, 'u', { title: 'Run' });
    const brief = await service.generate(context, issue);
    const recommended = {
      ...brief,
      recommendation: {
        ...brief.recommendation,
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        effort: 'high' as const,
      },
    };
    const host = briefRunContext(recommended, { host: true });
    expect(host).toContain('Model check (do this before any work):');
    expect(host).toContain('Recommended for this issue: claude/claude-sonnet-5-5, effort high.');
    expect(host).toContain('do not ask anything: carry out the work');
    expect(host).toContain('ask the user ONE question');
    expect(host).toContain('continue with the model and effort currently selected');
    expect(host).toContain('Note: run with <current model / effort> instead of the recommended');
    // The check comes before the brief itself.
    expect(host.indexOf('Model check')).toBeLessThan(host.indexOf('Execution brief'));
    // Server runs use the configured model, so they carry no check.
    expect(briefRunContext(recommended)).not.toContain('Model check');
  });

  it('skips the model check when nothing is recommended or the host itself is', async () => {
    const { issues, service } = setup();
    const issue = await issues.create(ws, 'u', { title: 'Run' });
    const brief = await service.generate(context, issue);
    const withModel = (provider: string, model: string) => ({
      ...brief,
      recommendation: { ...brief.recommendation, provider, model },
    });
    expect(briefRunContext(withModel('', ''), { host: true })).not.toContain('Model check');
    expect(briefRunContext(withModel('mcp', 'Anthropic/ClaudeAI'), { host: true })).not.toContain(
      'Model check',
    );
  });
});

describe('brief stores', () => {
  it('keeps independent copies in memory', async () => {
    const { issues, service, store } = setup();
    const issue = await issues.create(ws, 'u', { title: 'Copy' });
    const brief = await service.generate(context, issue);
    brief.considerations.push('mutated');
    expect((await store.get(ws, issue.id))!.considerations).not.toContain('mutated');
  });

  it('upserts and reads briefs through Prisma', async () => {
    const row = { data: { issueId: 'i' } };
    const db = {
      issueBriefRecord: {
        findFirst: vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const store = new PrismaIssueBriefStore(db as unknown as PrismaClient);
    expect(await store.get(ws, 'i')).toEqual({ issueId: 'i' });
    expect(await store.get(ws, 'none')).toBeNull();
    const brief = { issueId: 'i', workspaceId: ws } as never;
    expect(await store.save(brief)).toBe(brief);
    expect(db.issueBriefRecord.upsert).toHaveBeenCalledWith({
      where: { issueId: 'i' },
      create: { issueId: 'i', workspaceId: ws, data: brief },
      update: { data: brief },
    });
  });
});
