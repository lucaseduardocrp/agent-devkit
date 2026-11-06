import {
  BRIEF_ENGINE_VERSION,
  BRIEF_EFFORTS,
  type BriefAlternative,
  type BriefBudget,
  type BriefEffort,
  type BriefLevel,
  type BriefPrompt,
  type BriefRecommendation,
  type BriefReference,
  type IssueAgentBrief,
} from './brief-types.js';

export type ModelTier = 'fast' | 'balanced' | 'frontier';
const TIERS: readonly ModelTier[] = ['fast', 'balanced', 'frontier'];

/** A model the workspace can actually call (or is already calling through its host client). */
export interface AvailableModel {
  provider: string;
  model: string;
  /** The model is configured for an integration or agent, or consumed recently. */
  inUse: boolean;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

export interface BriefEngineInput {
  issue: {
    id: string;
    workspaceId: string;
    number: number;
    title: string;
    description: string;
    type: string;
    priority: string;
    attachmentCount: number;
  };
  pbi: { title: string; childCount: number } | null;
  commentCount: number;
  models: readonly AvailableModel[];
  /** Context the service already found (PBI, sibling issues, attachments, Brain pages...). */
  references: readonly BriefReference[];
  now: Date;
}

const LEVELS: readonly { max: number; level: BriefLevel }[] = [
  { max: 2, level: 'trivial' },
  { max: 4, level: 'small' },
  { max: 6, level: 'medium' },
  { max: 8, level: 'large' },
  { max: 10, level: 'epic' },
];

const HEAVY_SIGNALS =
  /architect|arquitet|refactor|refator|migrat|migra[cç]|security|seguran|performance|desempenho|integrat|integra[cç]|concurren|concorr|database|banco de dados|multi-?tenant|schema|authoriz|permiss/i;
const LIGHT_SIGNALS = /typo|ortografia|label|r[óo]tulo|rename|renomear|copy ?text|texto d[oe]/i;
const SECURITY =
  /security|seguran|authoriz|autoriz|permiss|token|senha|password|secret|xss|inje[cç]/i;
const DATA = /migrat|migra[cç]|database|banco de dados|schema|sql|prisma/i;
const PERFORMANCE = /performance|desempenho|lent|slow|otimiz|optimi[sz]/i;

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function levelForScore(score: number): BriefLevel {
  return (LEVELS.find((entry) => score <= entry.max) ?? LEVELS[LEVELS.length - 1]!).level;
}

export function assessComplexity(input: BriefEngineInput): IssueAgentBrief['complexity'] {
  const { issue } = input;
  const text = `${issue.title}\n${issue.description}`;
  const signals: string[] = [];
  let score = 1;
  const add = (points: number, signal: string) => {
    score += points;
    signals.push(signal);
  };
  const words = countWords(issue.description);
  if (words >= 400) add(3, `Long description (${words} words)`);
  else if (words >= 120) add(2, `Detailed description (${words} words)`);
  else if (words >= 30) add(1, `Short description (${words} words)`);
  if (/epic|feature|funcionalidade/i.test(issue.type))
    add(2, `Type "${issue.type}" spans many parts`);
  else if (/bug|defect|defeito/i.test(issue.type)) add(1, 'Bug: needs root-cause investigation');
  if (HEAVY_SIGNALS.test(text)) add(2, 'Touches architecture, data, security or integrations');
  if (LIGHT_SIGNALS.test(text)) add(-1, 'Looks like a small text or naming change');
  if (input.pbi && input.pbi.childCount >= 10) add(2, `PBI has ${input.pbi.childCount} children`);
  else if (input.pbi && input.pbi.childCount >= 3)
    add(1, `PBI has ${input.pbi.childCount} children`);
  if (issue.attachmentCount > 0) add(1, `${issue.attachmentCount} attachment(s) to interpret`);
  if (input.commentCount >= 5) add(1, `${input.commentCount} comments of discussion`);
  if (['urgent', 'high'].includes(issue.priority))
    add(1, `${issue.priority} priority asks for care`);
  const clamped = Math.min(10, Math.max(1, score));
  return { score: clamped, level: levelForScore(clamped), signals };
}

export function tierOf(model: string): ModelTier {
  const name = model.toLowerCase();
  if (/haiku|mini|nano|lite|instant|\b(1|2|3|7|8)b\b|small|phi|gemma/.test(name)) return 'fast';
  if (/opus|fable|\bo[134]\b|gpt-5|gpt-4\.5|pro\b|ultra|405b|reasoner/.test(name))
    return 'frontier';
  return 'balanced';
}

const REQUIRED_TIER: Record<BriefLevel, ModelTier> = {
  trivial: 'fast',
  small: 'fast',
  medium: 'balanced',
  large: 'frontier',
  epic: 'frontier',
};
const BASE_EFFORT: Record<BriefLevel, BriefEffort> = {
  trivial: 'low',
  small: 'low',
  medium: 'medium',
  large: 'high',
  epic: 'max',
};
const BUDGETS: Record<BriefLevel, BriefBudget> = {
  trivial: { maxInputTokens: 4000, maxOutputTokens: 1000 },
  small: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  medium: { maxInputTokens: 16000, maxOutputTokens: 4000 },
  large: { maxInputTokens: 32000, maxOutputTokens: 8000 },
  epic: { maxInputTokens: 64000, maxOutputTokens: 16000 },
};
const WORD_LIMIT: Record<BriefLevel, number> = {
  trivial: 80,
  small: 150,
  medium: 300,
  large: 500,
  epic: 800,
};

function bump(effort: BriefEffort, steps: number): BriefEffort {
  const index = Math.min(BRIEF_EFFORTS.length - 1, BRIEF_EFFORTS.indexOf(effort) + steps);
  return BRIEF_EFFORTS[index]!;
}

export function effortFor(level: BriefLevel, input: BriefEngineInput): BriefEffort {
  let effort = BASE_EFFORT[level];
  if (/bug|defect|defeito/i.test(input.issue.type) && level === 'small') effort = 'medium';
  if (input.issue.priority === 'urgent' && level !== 'trivial') effort = bump(effort, 1);
  return effort;
}

function blendedPrice(model: AvailableModel): number {
  if (model.inputUsdPerMillion === null || model.outputUsdPerMillion === null)
    return Number.POSITIVE_INFINITY;
  return model.inputUsdPerMillion + model.outputUsdPerMillion * 3;
}

function cheapestFirst(a: AvailableModel, b: AvailableModel): number {
  return (
    Number(b.inUse) - Number(a.inUse) ||
    blendedPrice(a) - blendedPrice(b) ||
    a.model.localeCompare(b.model)
  );
}

function estimateCost(model: AvailableModel | undefined, budget: BriefBudget): number | null {
  if (!model || model.inputUsdPerMillion === null || model.outputUsdPerMillion === null)
    return null;
  const cost =
    (budget.maxInputTokens * model.inputUsdPerMillion +
      budget.maxOutputTokens * model.outputUsdPerMillion) /
    1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

/** Picks the required tier, then the nearest one above it (quality first), then below. */
function pickModel(
  models: readonly AvailableModel[],
  required: ModelTier,
): { model: AvailableModel; exact: boolean } | undefined {
  const start = TIERS.indexOf(required);
  const order = [...TIERS.slice(start), ...TIERS.slice(0, start).reverse()];
  for (const tier of order) {
    const candidates = models.filter((model) => tierOf(model.model) === tier).sort(cheapestFirst);
    if (candidates[0]) return { model: candidates[0], exact: tier === required };
  }
  return undefined;
}

export function recommend(
  level: BriefLevel,
  effort: BriefEffort,
  budget: BriefBudget,
  models: readonly AvailableModel[],
): BriefRecommendation {
  const required = REQUIRED_TIER[level];
  const picked = pickModel(models, required);
  if (!picked)
    return {
      provider: '',
      model: '',
      effort,
      rationale:
        'No LLM provider is configured. Add one in Integrations so runs can use a recommended model.',
      estimatedCostUsd: null,
      alternatives: [],
    };
  const { model, exact } = picked;
  const alternatives: BriefAlternative[] = [];
  const tierIndex = TIERS.indexOf(tierOf(model.model));
  const cheaper = pickModel(
    models.filter((candidate) => TIERS.indexOf(tierOf(candidate.model)) < tierIndex),
    TIERS[Math.max(0, tierIndex - 1)]!,
  );
  if (cheaper)
    alternatives.push({
      provider: cheaper.model.provider,
      model: cheaper.model.model,
      effort: bump(effort, -1),
      reason: 'Cheaper option when the first attempt only needs a quick pass.',
    });
  const stronger = pickModel(
    models.filter((candidate) => TIERS.indexOf(tierOf(candidate.model)) > tierIndex),
    TIERS[Math.min(TIERS.length - 1, tierIndex + 1)]!,
  );
  if (stronger)
    alternatives.push({
      provider: stronger.model.provider,
      model: stronger.model.model,
      effort: bump(effort, 1),
      reason: 'Escalate here if the result misses acceptance criteria.',
    });
  const tier = tierOf(model.model);
  const reasons = [
    `A ${level} task needs a ${required} model; ${model.model} (${model.provider}) is ${exact ? 'the best match' : `the closest available (${tier})`}.`,
    model.inUse
      ? 'It is already in use in this workspace.'
      : 'It is available through your providers.',
    model.inputUsdPerMillion === null
      ? 'No cost rate is set, so the cost cannot be estimated.'
      : 'It is the cheapest option in its tier.',
  ];
  return {
    provider: model.provider,
    model: model.model,
    effort,
    rationale: reasons.join(' '),
    estimatedCostUsd: estimateCost(model, budget),
    alternatives,
  };
}

export function buildConsiderations(input: BriefEngineInput): string[] {
  const { issue } = input;
  const text = `${issue.title}\n${issue.description}`;
  const items: string[] = [];
  if (/bug|defect|defeito/i.test(issue.type))
    items.push(
      'Reproduce first and confirm the root cause with evidence before changing code; add a regression test.',
    );
  if (input.pbi)
    items.push(
      `Stay inside the scope of the PBI "${input.pbi.title}"; its children define the acceptance criteria.`,
    );
  if (issue.attachmentCount > 0)
    items.push('Inspect the attached images: they carry visual requirements.');
  if (input.commentCount > 0)
    items.push('Honour the decisions in the issue conversation; the latest comment wins.');
  if (SECURITY.test(text))
    items.push('Check authorization, input validation and that no secret is logged or returned.');
  if (DATA.test(text))
    items.push('Keep data changes reversible and consider volume, locking and backfill.');
  if (PERFORMANCE.test(text))
    items.push('Measure before and after; do not optimize without a baseline.');
  if (issue.priority === 'urgent')
    items.push('Prefer the smallest safe change; defer extras to a follow-up issue.');
  items.push(
    'Follow existing patterns in the code base and run the related tests; add coverage for new behavior.',
  );
  items.push('If a requirement is ambiguous, ask one specific question instead of guessing.');
  return items;
}

export function buildPrompt(
  input: BriefEngineInput,
  level: BriefLevel,
  readFirst: readonly BriefReference[],
  considerations: readonly string[],
): BriefPrompt {
  const { issue } = input;
  const reads = readFirst.length
    ? `\n\nRead first, in this order:\n${readFirst.map((item, index) => `${index + 1}. [${item.kind}] ${item.label} (${item.ref}) - ${item.reason}`).join('\n')}`
    : '';
  const rules = considerations.map((item) => `- ${item}`).join('\n');
  return {
    system:
      'You are a senior engineer working through the ADK. Be precise and economical: read only what is listed, do not repeat the issue back, and never claim changes you did not make.',
    task: `Work on issue #${issue.number}: ${issue.title}\n\n${issue.description.trim() || '(no description)'}${reads}\n\nConstraints:\n${rules}`,
    outputFormat: `Answer in at most ${WORD_LIMIT[level]} words with: Result, Files changed, Tests run, Blockers.`,
  };
}

function dedupe(references: readonly BriefReference[]): BriefReference[] {
  const seen = new Set<string>();
  const result: BriefReference[] = [];
  for (const reference of references) {
    const key = `${reference.kind}:${reference.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

/**
 * Builds the brief. Fields a human edited (`existing.locked`) are kept; everything derived from
 * them, such as the prompt, is built from the final values so the brief stays consistent.
 */
export function generateBrief(
  input: BriefEngineInput,
  existing: IssueAgentBrief | null = null,
): IssueAgentBrief {
  const locked = existing?.locked ?? [];
  const complexity = assessComplexity(input);
  const effort = effortFor(complexity.level, input);
  const budget = locked.includes('budget') ? existing!.budget : { ...BUDGETS[complexity.level] };
  const readFirst = locked.includes('readFirst')
    ? existing!.readFirst
    : dedupe(input.references).slice(0, 12);
  const considerations = locked.includes('considerations')
    ? existing!.considerations
    : buildConsiderations(input);
  const stamp = input.now.toISOString();
  return {
    issueId: input.issue.id,
    workspaceId: input.issue.workspaceId,
    engineVersion: BRIEF_ENGINE_VERSION,
    generatedAt: stamp,
    updatedAt: stamp,
    source: locked.length ? 'edited' : 'engine',
    locked: [...locked],
    complexity,
    recommendation: locked.includes('recommendation')
      ? existing!.recommendation
      : recommend(complexity.level, effort, budget, input.models),
    readFirst,
    considerations,
    prompt: locked.includes('prompt')
      ? existing!.prompt
      : buildPrompt(input, complexity.level, readFirst, considerations),
    budget,
  };
}
