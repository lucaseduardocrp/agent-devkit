export type ChangeStatus = 'draft' | 'proposed' | 'approved' | 'rejected' | 'archived';
export type ChangeFramework = 'openspec' | 'speckit' | 'custom';
export type ArtifactKind = 'proposal' | 'design' | 'tasks' | 'spec' | 'other';
export type ChangeAction = 'propose' | 'approve' | 'reject' | 'reopen' | 'archive';

export interface ChangeArtifact {
  id: string;
  kind: ArtifactKind;
  path: string;
  content: string;
}

export interface RepositoryRef {
  provider: 'github' | 'azure_devops';
  id: string;
  name: string;
  baseBranch: string;
}

export interface DevChange {
  id: string;
  slug: string;
  title: string;
  summary: string;
  framework: ChangeFramework;
  status: ChangeStatus;
  artifacts: ChangeArtifact[];
  repository: RepositoryRef | null;
  specificationId: string | null;
  updatedAt: string;
}

export interface ChangeFields {
  title: string;
  summary?: string;
  framework?: ChangeFramework;
}
export interface ChangeChanges {
  title?: string;
  summary?: string;
  artifacts?: ChangeArtifact[];
}

export type SessionStatus =
  'queued' | 'running' | 'waiting_review' | 'approved' | 'failed' | 'cancelled';
export type SessionCli = 'claude' | 'codex' | 'gemini';
export type SessionEventKind =
  'status' | 'message' | 'tool' | 'subagent' | 'compaction' | 'feedback';

export interface SessionSubagent {
  id: string;
  name: string;
  role: string;
  status: 'running' | 'done' | 'failed';
  summary: string;
  usedTokens: number;
}
export interface SessionEvent {
  id: string;
  at: string;
  kind: SessionEventKind;
  text: string;
  subagentId: string | null;
}
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
}
export interface ReviewComment {
  id: string;
  author: 'user' | 'agent';
  authorName: string;
  path: string | null;
  line: number | null;
  body: string;
  resolved: boolean;
  createdAt: string;
}

export interface DevSession {
  id: string;
  changeId: string | null;
  /** The backlog item and the issue the session was linked to. */
  pbiItemId?: string | null;
  issueId?: string | null;
  title: string;
  prompt: string;
  cli: SessionCli;
  status: SessionStatus;
  attempt: number;
  worktree: { branch: string; baseBranch: string; path: string | null };
  context: {
    windowTokens: number;
    usedTokens: number;
    compactAtPercent: number;
    compactions: number;
  };
  maxSubagents: number;
  subagents: SessionSubagent[];
  events: SessionEvent[];
  diff: DiffFile[];
  comments: ReviewComment[];
  summary: string;
  error: string | null;
  runner: string | null;
  updatedAt: string;
}

/** A repository of a connected Git provider, as the API lists them. */
export interface RepositoryOption {
  id: string;
  provider: RepositoryRef['provider'];
  name: string;
  defaultBranch: string;
}
export interface BranchOption {
  name: string;
  isDefault: boolean;
}

export interface SessionFields {
  title: string;
  prompt: string;
  changeId?: string;
  pbiItemId?: string;
  issueId?: string;
  repository?: RepositoryRef;
  cli?: SessionCli;
  agentIds?: string[];
  baseBranch?: string;
  compactAtPercent?: number;
  maxSubagents?: number;
}

export const PIPELINE_STAGES = ['spec', 'approval', 'code', 'review', 'done'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export interface PipelineItem {
  changeId: string;
  slug: string;
  title: string;
  status: ChangeStatus;
  tasks: { done: number; total: number };
  session: { id: string; status: SessionStatus; attempt: number; branch: string } | null;
}
export type Pipeline = Record<PipelineStage, PipelineItem[]>;

/** What the Development stream announces: which change or session moved (read it by its id). */
export interface DevelopmentStreamEvent {
  kind: 'change' | 'session';
  id: string;
  deleted?: boolean;
}

/** The four screens of the Development module. */
export type DevelopmentSection = 'artifacts' | 'review' | 'code' | 'pipeline';

/** Sessions a runner is still expected to change: the screens refresh while one exists. */
export const LIVE_SESSION_STATUSES: readonly SessionStatus[] = ['queued', 'running'];

/** How often the screens refresh while a runner is expected to report progress. */
export const REFRESH_INTERVAL_MS = 5000;
