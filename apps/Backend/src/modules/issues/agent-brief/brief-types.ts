/**
 * Agent brief: the execution plan the engine derives for an issue so an AI agent can do the work
 * with the right model, effort and context at the lowest cost that still yields quality. Humans
 * can read and edit it; fields they edit are `locked` and survive regeneration.
 */
export const BRIEF_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type BriefEffort = (typeof BRIEF_EFFORTS)[number];

export const BRIEF_LEVELS = ['trivial', 'small', 'medium', 'large', 'epic'] as const;
export type BriefLevel = (typeof BRIEF_LEVELS)[number];

export const BRIEF_REFERENCE_KINDS = [
  'pbi',
  'issue',
  'attachment',
  'brain',
  'spec',
  'testplan',
  'file',
] as const;
export type BriefReferenceKind = (typeof BRIEF_REFERENCE_KINDS)[number];

/** Fields a human can edit. Editing one locks it against regeneration. */
export const BRIEF_EDITABLE_FIELDS = [
  'recommendation',
  'readFirst',
  'considerations',
  'prompt',
  'budget',
] as const;
export type BriefEditableField = (typeof BRIEF_EDITABLE_FIELDS)[number];

export interface BriefModelChoice {
  provider: string;
  model: string;
  effort: BriefEffort;
}

export interface BriefAlternative extends BriefModelChoice {
  reason: string;
}

export interface BriefRecommendation extends BriefModelChoice {
  rationale: string;
  /** Estimated USD of one run, from the workspace cost rates; null when no rate is configured. */
  estimatedCostUsd: number | null;
  alternatives: BriefAlternative[];
}

export interface BriefReference {
  kind: BriefReferenceKind;
  label: string;
  /** Id, path or URL that lets the agent open it. */
  ref: string;
  reason: string;
  /** The exact passage that matched (Brain pages), so a person can open that part of the text. */
  excerpt?: string;
}

export interface BriefPrompt {
  system: string;
  task: string;
  outputFormat: string;
}

export interface BriefBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface IssueAgentBrief {
  issueId: string;
  workspaceId: string;
  engineVersion: number;
  generatedAt: string;
  updatedAt: string;
  /** 'edited' once a human changed at least one field. */
  source: 'engine' | 'edited';
  locked: BriefEditableField[];
  complexity: { score: number; level: BriefLevel; signals: string[] };
  recommendation: BriefRecommendation;
  readFirst: BriefReference[];
  considerations: string[];
  prompt: BriefPrompt;
  budget: BriefBudget;
}

/** What a human may send; every field is optional and replaces the stored value. */
export type IssueAgentBriefEdits = Partial<
  Pick<IssueAgentBrief, 'recommendation' | 'readFirst' | 'considerations' | 'prompt' | 'budget'>
>;

export const BRIEF_ENGINE_VERSION = 1;
