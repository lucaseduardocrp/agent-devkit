import { ApplicationError } from '../../../shared/errors.js';
import type { RequestContext } from '../../../shared/context.js';
import type { KnowledgeSearchPort } from '../../knowledge/application/knowledge-search.js';
import type { PbiStore } from '../../pbi/pbi-store.js';
import type { Issue, IssueStore } from '../issue-store.js';
import type { CostRate } from '../run-store.js';
import type { UsageStore } from '../usage-store.js';
import { generateBrief, type AvailableModel } from './brief-engine.js';
import type { IssueBriefStore } from './brief-store.js';
import {
  BRIEF_EDITABLE_FIELDS,
  type BriefEditableField,
  type BriefReference,
  type IssueAgentBrief,
  type IssueAgentBriefEdits,
} from './brief-types.js';

interface LlmIntegration {
  category: string;
  providerId: string;
  isEnabled: boolean;
  settings: Record<string, unknown>;
}

export interface BriefServiceDeps {
  store: IssueBriefStore;
  issues: IssueStore;
  pbiItems?: Pick<PbiStore, 'get' | 'listChildren'>;
  integrations?: { listIntegrations(ownerId: string): Promise<readonly LlmIntegration[]> };
  rates: (workspaceId: string) => Promise<readonly CostRate[]>;
  usage: UsageStore;
  knowledge?: KnowledgeSearchPort;
  now?: () => Date;
}

const USAGE_WINDOW_DAYS = 30;
const MAX_CHILDREN = 5;
const MAX_SIBLINGS = 4;
const MAX_BRAIN_PAGES = 3;
/** Characters of the matching passage kept with a Brain reference. */
const MAX_EXCERPT = 1000;
/** Local runtimes cost nothing per token. */
const LOCAL_PROVIDERS = new Set(['ollama']);

const key = (provider: string, model: string) => `${provider}\u0000${model}`;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export class IssueBriefService {
  private readonly now: () => Date;
  constructor(private readonly deps: BriefServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get(workspaceId: string, issueId: string): Promise<IssueAgentBrief | null> {
    return this.deps.store.get(workspaceId, issueId);
  }

  /** Builds and stores the brief of an issue, keeping what a human edited. */
  async generate(context: RequestContext, issue: Issue): Promise<IssueAgentBrief> {
    const existing = await this.deps.store.get(issue.workspaceId, issue.id);
    const brief = await this.build(context, issue, existing);
    return this.deps.store.save(brief);
  }

  /**
   * Runs the engine after an issue is created or edited. A failure here must never block the
   * issue itself, so errors are logged and swallowed.
   */
  async refresh(context: RequestContext, issue: Issue): Promise<IssueAgentBrief | null> {
    try {
      return await this.generate(context, issue);
    } catch (error) {
      console.error('[IssueBriefService] Brief generation failed:', error);
      return null;
    }
  }

  async regenerate(
    context: RequestContext,
    issue: Issue,
    force: boolean,
  ): Promise<IssueAgentBrief> {
    const existing = await this.deps.store.get(issue.workspaceId, issue.id);
    const base = force && existing ? { ...existing, locked: [] } : existing;
    return this.deps.store.save(await this.build(context, issue, base));
  }

  /** Applies human edits and locks the edited fields against regeneration. */
  async edit(
    context: RequestContext,
    issue: Issue,
    edits: IssueAgentBriefEdits,
  ): Promise<IssueAgentBrief> {
    const current =
      (await this.deps.store.get(issue.workspaceId, issue.id)) ??
      (await this.generate(context, issue));
    const fields = BRIEF_EDITABLE_FIELDS.filter((field) => edits[field] !== undefined);
    if (fields.length === 0)
      throw new ApplicationError('VALIDATION_ERROR', 'Nothing to update in the brief.', 400);
    const locked = [...new Set<BriefEditableField>([...current.locked, ...fields])];
    const next = {
      ...current,
      ...Object.fromEntries(fields.map((field) => [field, edits[field]])),
      locked,
      source: 'edited' as const,
      updatedAt: this.now().toISOString(),
    } satisfies IssueAgentBrief;
    return this.deps.store.save(next);
  }

  private async build(
    context: RequestContext,
    issue: Issue,
    existing: IssueAgentBrief | null,
  ): Promise<IssueAgentBrief> {
    const [models, pbi, comments, references] = await Promise.all([
      this.availableModels(context, issue),
      this.pbiSummary(issue),
      this.deps.issues.comments(issue.id),
      this.references(context, issue),
    ]);
    return generateBrief(
      {
        issue: {
          id: issue.id,
          workspaceId: issue.workspaceId,
          number: issue.number,
          title: issue.title,
          description: issue.description,
          type: issue.type,
          priority: issue.priority,
          attachmentCount: issue.attachments?.length ?? 0,
        },
        pbi,
        commentCount: comments.length,
        models,
        references,
        now: this.now(),
      },
      existing,
    );
  }

  private async pbiSummary(issue: Issue): Promise<{ title: string; childCount: number } | null> {
    if (!issue.pbiItemId || !this.deps.pbiItems) return null;
    const item = await this.deps.pbiItems.get(issue.workspaceId, issue.pbiItemId);
    if (!item) return null;
    const children = await this.deps.pbiItems.listChildren(issue.workspaceId, item.id);
    return { title: item.title, childCount: children.length };
  }

  /** Models the workspace can call plus those its host client already consumes. */
  private async availableModels(context: RequestContext, issue: Issue): Promise<AvailableModel[]> {
    const ownerId = context.ownerId ?? issue.workspaceId;
    const since = new Date(this.now().getTime() - USAGE_WINDOW_DAYS * 86_400_000);
    const [integrations, rates, usage] = await Promise.all([
      this.deps.integrations?.listIntegrations(ownerId) ?? Promise.resolve([]),
      this.deps.rates(issue.workspaceId),
      this.deps.usage.list(issue.workspaceId, since),
    ]);
    const rateOf = new Map(
      rates.map((rate) => [key(rate.provider.toLowerCase(), rate.model), rate] as const),
    );
    const found = new Map<string, AvailableModel>();
    const add = (provider: string, model: string, inUse: boolean) => {
      if (!model) return;
      const id = key(provider, model);
      const rate = rateOf.get(id);
      const local = LOCAL_PROVIDERS.has(provider);
      const previous = found.get(id);
      found.set(id, {
        provider,
        model,
        inUse: inUse || previous?.inUse === true,
        inputUsdPerMillion: rate ? rate.inputUsdPerMillion : local ? 0 : null,
        outputUsdPerMillion: rate ? rate.outputUsdPerMillion : local ? 0 : null,
      });
    };
    const enabled = integrations.filter((item) => item.category === 'LLM' && item.isEnabled);
    for (const integration of enabled) {
      const provider = integration.providerId.toLowerCase();
      const configured = text(integration.settings['model']);
      add(provider, configured, true);
      // Priced models of an enabled provider are callable too, just not the configured default.
      for (const rate of rates)
        if (rate.provider.toLowerCase() === provider) add(provider, rate.model, false);
    }
    for (const event of usage) add(event.provider.toLowerCase(), event.model, true);
    return [...found.values()];
  }

  /**
   * Context worth reading, most valuable first; the engine keeps only the first few, so the PBI,
   * attachments and Brain pages come before child items and sibling issues.
   */
  private async references(context: RequestContext, issue: Issue): Promise<BriefReference[]> {
    const parent: BriefReference[] = [];
    const related: BriefReference[] = [];
    if (issue.pbiItemId && this.deps.pbiItems) {
      const item = await this.deps.pbiItems.get(issue.workspaceId, issue.pbiItemId);
      if (item) {
        parent.push({
          kind: 'pbi',
          label: item.title,
          ref: item.id,
          reason: 'Parent PBI: scope and acceptance criteria.',
        });
        const children = await this.deps.pbiItems.listChildren(issue.workspaceId, item.id);
        for (const child of children.slice(0, MAX_CHILDREN))
          related.push({
            kind: 'pbi',
            label: child.title,
            ref: child.id,
            reason: 'Child item that details the parent PBI.',
          });
        const siblings = (await this.deps.issues.list(issue.workspaceId))
          .filter((other) => other.pbiItemId === item.id && other.id !== issue.id)
          .slice(0, MAX_SIBLINGS);
        for (const sibling of siblings)
          related.push({
            kind: 'issue',
            label: `#${sibling.number} ${sibling.title}`,
            ref: sibling.id,
            reason: 'Related issue of the same PBI; avoid overlapping work.',
          });
      }
    }
    const attachments = (issue.attachments ?? []).map((attachment): BriefReference => ({
      kind: 'attachment',
      label: attachment.name,
      ref: attachment.id,
      reason: 'Attached image with visual requirements.',
    }));
    const brain = this.deps.knowledge ? await this.brainPages(context, issue) : [];
    return [...parent, ...attachments, ...brain, ...related];
  }

  private async brainPages(context: RequestContext, issue: Issue): Promise<BriefReference[]> {
    const query = `${issue.title} ${issue.description}`.trim().slice(0, 400);
    if (!query) return [];
    try {
      const chunks = await this.deps.knowledge!.search(query, context);
      const pages = new Map<string, BriefReference>();
      for (const chunk of chunks) {
        if (pages.size >= MAX_BRAIN_PAGES) break;
        if (!pages.has(chunk.pageId))
          pages.set(chunk.pageId, {
            kind: 'brain',
            label: chunk.source,
            ref: chunk.pageId,
            reason: 'Brain page that matches this issue.',
            excerpt: chunk.content.slice(0, MAX_EXCERPT),
          });
      }
      return [...pages.values()];
    } catch {
      // Knowledge is optional context; the brief is still useful without it.
      return [];
    }
  }
}

/**
 * What a host agent (an MCP client running on the user's own model) does before the work: the
 * recommended model is only a suggestion it cannot apply itself, so it asks the user once, unless
 * the client already runs on it, and leaves the choice in the result.
 */
export function modelCheck(brief: IssueAgentBrief): string[] {
  const { provider, model, effort } = brief.recommendation;
  // Nothing is recommended, or the recommendation is the host client itself.
  if (!model || provider === 'mcp') return [];
  const recommended = `${provider}/${model}, effort ${effort}`;
  return [
    'Model check (do this before any work):',
    `- Recommended for this issue: ${recommended}.`,
    '- If you already run on this model with this effort, do not ask anything: carry out the work.',
    `- Otherwise ask the user ONE question and wait: switch to ${recommended}, or continue with the model and effort currently selected. Name both options.`,
    '- If the user continues with the current model, carry out the work and add this note to the issue comment and to your result: "Note: run with <current model / effort> instead of the recommended ' +
      recommended +
      '."',
  ];
}

/** The part of a brief a running agent needs, as text appended to its prompt. */
export function briefRunContext(brief: IssueAgentBrief, options: { host?: boolean } = {}): string {
  const reads = brief.readFirst.map(
    (item, index) => `${index + 1}. [${item.kind}] ${item.label} (${item.ref}) - ${item.reason}`,
  );
  const lines = [
    ...(options.host ? [...modelCheck(brief), ''] : []),
    `Execution brief (${brief.complexity.level}, effort ${brief.recommendation.effort}):`,
    ...(reads.length ? ['Read first, in this order:', ...reads] : []),
    'Constraints:',
    ...brief.considerations.map((item) => `- ${item}`),
    brief.prompt.outputFormat,
  ];
  return `\n\n${lines.join('\n')}`;
}
