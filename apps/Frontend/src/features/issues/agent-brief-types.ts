/** Mirrors the backend agent brief contract (issues/agent-brief/brief-types.ts). */
export const BRIEF_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type BriefEffort = (typeof BRIEF_EFFORTS)[number];

export type BriefLevel = 'trivial' | 'small' | 'medium' | 'large' | 'epic';

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

export type BriefEditableField =
  'recommendation' | 'readFirst' | 'considerations' | 'prompt' | 'budget';

export interface BriefAlternative {
  provider: string;
  model: string;
  effort: BriefEffort;
  reason: string;
}

export interface BriefRecommendation {
  provider: string;
  model: string;
  effort: BriefEffort;
  rationale: string;
  estimatedCostUsd: number | null;
  alternatives: BriefAlternative[];
}

export interface BriefReference {
  kind: BriefReferenceKind;
  label: string;
  ref: string;
  reason: string;
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
  source: 'engine' | 'edited';
  locked: BriefEditableField[];
  complexity: { score: number; level: BriefLevel; signals: string[] };
  recommendation: BriefRecommendation;
  readFirst: BriefReference[];
  considerations: string[];
  prompt: BriefPrompt;
  budget: BriefBudget;
}

export type IssueAgentBriefEdits = Partial<
  Pick<IssueAgentBrief, 'recommendation' | 'readFirst' | 'considerations' | 'prompt' | 'budget'>
>;
