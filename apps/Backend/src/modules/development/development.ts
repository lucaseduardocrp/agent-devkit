/**
 * Development: spec-driven changes (Artifacts), agent coding sessions in git worktrees (Code),
 * human review of what the agents wrote (Review) and the flow that ties them together (Pipeline).
 *
 * The API never touches a repository: a runner on the developer's computer claims a session,
 * creates the worktree, drives the coding CLI and reports back through the session routes.
 */

export const CHANGE_STATUSES = ['draft', 'proposed', 'approved', 'rejected', 'archived'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/** Which spec-driven process the artifacts of a change follow. */
export const CHANGE_FRAMEWORKS = ['openspec', 'speckit', 'custom'] as const;
export type ChangeFramework = (typeof CHANGE_FRAMEWORKS)[number];

export const ARTIFACT_KINDS = ['proposal', 'design', 'tasks', 'spec', 'other'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const CHANGE_ACTIONS = ['propose', 'approve', 'reject', 'reopen', 'archive'] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export interface ChangeArtifact {
  id: string;
  kind: ArtifactKind;
  /** Where the file lives in the repository, e.g. `openspec/changes/add-login/proposal.md`. */
  path: string;
  content: string;
}

export interface RepositoryRef {
  provider: 'github' | 'azure_devops';
  id: string;
  name: string;
  baseBranch: string;
}

export interface ChangeBody {
  slug: string;
  title: string;
  summary: string;
  framework: ChangeFramework;
  status: ChangeStatus;
  artifacts: ChangeArtifact[];
  repository: RepositoryRef | null;
  /** The specification of the Specs module this change implements, when there is one. */
  specificationId: string | null;
  createdBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface DevChange extends ChangeBody {
  id: string;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export const SESSION_STATUSES = [
  'queued',
  'running',
  'waiting_review',
  'approved',
  'failed',
  'cancelled',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** A session in one of these states still holds its worktree and may change the code. */
export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = [
  'queued',
  'running',
  'waiting_review',
];

export const SESSION_CLIS = ['claude', 'codex', 'gemini'] as const;
export type SessionCli = (typeof SESSION_CLIS)[number];

export interface SessionWorktree {
  branch: string;
  baseBranch: string;
  /** Set by the runner once the worktree exists on its disk. */
  path: string | null;
}

export interface SessionContext {
  windowTokens: number;
  usedTokens: number;
  /** Share of the window (1-100) at which the runner is told to compact the conversation. */
  compactAtPercent: number;
  compactions: number;
}

export const SUBAGENT_STATUSES = ['running', 'done', 'failed'] as const;
export interface SessionSubagent {
  id: string;
  name: string;
  role: string;
  status: (typeof SUBAGENT_STATUSES)[number];
  summary: string;
  usedTokens: number;
}

export const EVENT_KINDS = [
  'status',
  'message',
  'tool',
  'subagent',
  'compaction',
  'feedback',
] as const;
export type SessionEventKind = (typeof EVENT_KINDS)[number];
export interface SessionEvent {
  id: string;
  at: string;
  kind: SessionEventKind;
  text: string;
  subagentId: string | null;
}

export const DIFF_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export interface DiffFile {
  path: string;
  status: (typeof DIFF_STATUSES)[number];
  additions: number;
  deletions: number;
  /** Unified diff of the file against the base branch. */
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

export interface SessionBody {
  changeId: string | null;
  /** The backlog item (task, bug, analysis...) the session works on, when linked to one. */
  pbiItemId: string | null;
  /** The issue the session works on, when linked to one. */
  issueId: string | null;
  title: string;
  prompt: string;
  cli: SessionCli;
  agentId: string | null;
  /** Every workspace agent picked for the session (`agentId` is the first of them). */
  agentIds: string[];
  status: SessionStatus;
  /** Grows by one each time the session goes back to the queue (changes requested or retry). */
  attempt: number;
  repository: RepositoryRef | null;
  worktree: SessionWorktree;
  context: SessionContext;
  maxSubagents: number;
  subagents: SessionSubagent[];
  events: SessionEvent[];
  diff: DiffFile[];
  comments: ReviewComment[];
  summary: string;
  error: string | null;
  runner: string | null;
  createdBy: string | null;
  reviewedBy: string | null;
}

export interface DevSession extends SessionBody {
  id: string;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What the runner must do next, answered on every report. */
export interface SessionDirectives {
  /** The context passed its limit: summarize the conversation before the next step. */
  compact: boolean;
  /** The session was cancelled by a person: stop and leave the worktree as it is. */
  cancel: boolean;
  /** Fewer subagents are running than the session allows. */
  spawnSubagents: boolean;
}

export const PIPELINE_STAGES = ['spec', 'approval', 'code', 'review', 'done'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface PipelineItem {
  changeId: string;
  slug: string;
  title: string;
  status: ChangeStatus;
  tasks: TaskProgress;
  /** The most recent session of the change, when it has one. */
  session: { id: string; status: SessionStatus; attempt: number; branch: string } | null;
}

export interface TaskProgress {
  done: number;
  total: number;
}

export const MAX_EVENTS = 500;

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'change'
  );
}

/** The folder the artifacts of a change are written to in the repository. */
export function changeFolder(framework: ChangeFramework, slug: string): string {
  if (framework === 'openspec') return `openspec/changes/${slug}`;
  return framework === 'speckit' ? `specs/${slug}` : `changes/${slug}`;
}

const TEMPLATES: Record<ChangeFramework, readonly [ArtifactKind, string, string][]> = {
  openspec: [
    [
      'proposal',
      'proposal.md',
      '## Why\n\n\n## What Changes\n\n- \n\n## Impact\n\n- Affected specs: \n- Affected code: \n',
    ],
    ['design', 'design.md', '## Context\n\n\n## Decisions\n\n\n## Risks / Trade-offs\n\n'],
    ['tasks', 'tasks.md', '## 1. Implementation\n\n- [ ] 1.1 \n\n## 2. Validation\n\n- [ ] 2.1 \n'],
    [
      'spec',
      'specs/{slug}/spec.md',
      '## ADDED Requirements\n\n### Requirement: \n\nThe system SHALL \n\n#### Scenario: \n\n- **WHEN** \n- **THEN** \n',
    ],
  ],
  speckit: [
    [
      'spec',
      'spec.md',
      '## User Scenarios\n\n\n## Requirements\n\n- **FR-001**: \n\n## Success Criteria\n\n',
    ],
    ['design', 'plan.md', '## Summary\n\n\n## Technical Context\n\n\n## Structure\n\n'],
    [
      'tasks',
      'tasks.md',
      '## Phase 1: Setup\n\n- [ ] T001 \n\n## Phase 2: Implementation\n\n- [ ] T002 \n',
    ],
  ],
  custom: [],
};

/** The empty artifacts a new change starts with, laid out the way its framework expects. */
export function templateArtifacts(framework: ChangeFramework, slug: string): ChangeArtifact[] {
  const folder = changeFolder(framework, slug);
  return TEMPLATES[framework].map(([kind, file, content]) => ({
    id: crypto.randomUUID(),
    kind,
    path: `${folder}/${file.replace('{slug}', slug)}`,
    content,
  }));
}

/** Counts the Markdown checkboxes of the task artifacts. */
export function taskProgress(artifacts: readonly ChangeArtifact[]): TaskProgress {
  let done = 0;
  let total = 0;
  for (const artifact of artifacts) {
    if (artifact.kind !== 'tasks') continue;
    for (const match of artifact.content.matchAll(/^\s*[-*] \[( |x|X)\]/gm)) {
      total += 1;
      if (match[1] !== ' ') done += 1;
    }
  }
  return { done, total };
}

const TRANSITIONS: Record<ChangeAction, { from: readonly ChangeStatus[]; to: ChangeStatus }> = {
  propose: { from: ['draft'], to: 'proposed' },
  approve: { from: ['proposed'], to: 'approved' },
  reject: { from: ['proposed'], to: 'rejected' },
  reopen: { from: ['proposed', 'rejected'], to: 'draft' },
  archive: { from: ['approved'], to: 'archived' },
};

/** The status an action leads to, or null when the change is not in a state that allows it. */
export function nextChangeStatus(status: ChangeStatus, action: ChangeAction): ChangeStatus | null {
  const transition = TRANSITIONS[action];
  return transition.from.includes(status) ? transition.to : null;
}

export function sessionDirectives(session: SessionBody): SessionDirectives {
  const { usedTokens, windowTokens, compactAtPercent } = session.context;
  const running = session.subagents.filter((subagent) => subagent.status === 'running').length;
  return {
    compact: usedTokens * 100 >= windowTokens * compactAtPercent,
    cancel: session.status === 'cancelled',
    spawnSubagents: running < session.maxSubagents,
  };
}

export function worktreeBranch(name: string): string {
  return `adk/${slugify(name).slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`;
}

function stageOf(change: DevChange, latest: DevSession | undefined): PipelineStage {
  if (change.status === 'draft') return 'spec';
  if (change.status === 'proposed') return 'approval';
  if (latest?.status === 'approved') return 'done';
  return latest?.status === 'waiting_review' ? 'review' : 'code';
}

/** Places every open change in the stage it is waiting at; rejected and archived ones are left out. */
export function buildPipeline(
  changes: readonly DevChange[],
  sessions: readonly DevSession[],
): Record<PipelineStage, PipelineItem[]> {
  const stages: Record<PipelineStage, PipelineItem[]> = {
    spec: [],
    approval: [],
    code: [],
    review: [],
    done: [],
  };
  for (const change of changes) {
    if (change.status === 'rejected' || change.status === 'archived') continue;
    const latest = sessions
      .filter((session) => session.changeId === change.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    stages[stageOf(change, latest)].push({
      changeId: change.id,
      slug: change.slug,
      title: change.title,
      status: change.status,
      tasks: taskProgress(change.artifacts),
      session: latest
        ? {
            id: latest.id,
            status: latest.status,
            attempt: latest.attempt,
            branch: latest.worktree.branch,
          }
        : null,
    });
  }
  return stages;
}
