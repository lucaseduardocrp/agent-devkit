import type { CustomAgentDto } from '../agents/agent-types.js';
import type { ImageAttachment } from '../shared/image-attachment-types.js';

export type IssueStatus =
  'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Issue {
  readonly id: string;
  readonly workspaceId: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly attachments?: readonly ImageAttachment[];
  readonly status: IssueStatus;
  readonly priority: IssuePriority;
  /** Key of a configured work item type; empty when untyped. */
  readonly type?: string;
  readonly assigneeAgentId: string | null;
  readonly assigneeUserId: string | null;
  /** Reviewer: the issue also shows in this user's inbox. */
  readonly proofreaderUserId?: string | null;
  readonly pbiItemId?: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueComment {
  readonly id: string;
  readonly issueId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
}

/** A run executed while its issue was assigned to the signed-in user. */
export interface InboxRun {
  readonly id: string;
  readonly agentId: string;
  readonly status: AgentRun['status'];
  readonly attempt: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** Private inbox entry: an issue with the runs executed while it was assigned to the user. */
export interface InboxItem {
  readonly issue: Issue;
  /** Newest first; never empty. */
  readonly runs: readonly InboxRun[];
  readonly readAt: string | null;
  readonly archivedAt: string | null;
}

export interface DashboardSummary {
  readonly agents: readonly CustomAgentDto[];
  readonly recentRuns?: readonly AgentRun[];
  readonly activeRuns?: number;
  readonly costs?: Pick<
    CostSummary,
    | 'monthSpendMicros'
    | 'monthlyBudgetMicros'
    | 'totalInputTokens'
    | 'totalOutputTokens'
    | 'totalTokens'
    | 'unpricedRuns'
    | 'rates'
    | 'byAgent'
    | 'mcpUsage'
  >;
  readonly recentIssues: readonly Issue[];
  readonly recentActivity: readonly Issue[];
  readonly totalIssues: number;
  readonly inProgress: number;
  readonly open: number;
  readonly byStatus: Readonly<Record<IssueStatus, number>>;
  readonly byPriority: Readonly<Record<IssuePriority, number>>;
}

export interface AgentRun {
  readonly id: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly status:
    | 'queued'
    | 'running'
    | 'waiting_review'
    | 'waiting_input'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  readonly mode: 'server' | 'host';
  readonly attempt: number;
  readonly output: string | null;
  readonly error: string | null;
  readonly workflowState?: {
    readonly autonomy: 'supervised' | 'balanced' | 'autonomous';
    readonly steps: readonly {
      readonly id: string;
      readonly name: string;
      readonly reviewRequired?: boolean;
    }[];
    readonly currentStepIndex: number;
    readonly results: readonly {
      readonly stepId: string;
      readonly name: string;
      readonly output: string;
      readonly kind?: 'result' | 'question' | 'answer' | 'event';
    }[];
    readonly question?: string;
    /** Set when the workflow is a flow (conditions, module actions) walked node by node. */
    readonly canvas?: { readonly nodes: readonly { readonly id: string }[] };
    /** The node the run is on; absent between nodes and once the flow has ended. */
    readonly currentNodeId?: string;
  } | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicros: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/**
 * A run as the live stream sends it: everything but its output, which can be large. The prompt is
 * not part of the run the app loads either.
 */
export type AgentRunEvent = Omit<AgentRun, 'output'>;

export interface CostRate {
  readonly provider: string;
  readonly model: string;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export interface CostSummary {
  readonly monthSpendMicros: number;
  readonly monthlyBudgetMicros: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly unpricedRuns: number;
  readonly rates: readonly CostRate[];
  readonly byAgent: Readonly<
    Record<
      string,
      { readonly spendMicros: number; readonly runs: number; readonly unpricedRuns: number }
    >
  >;
  readonly recentRuns: readonly AgentRun[];
  /** Current-month tokens spent by MCP clients; absent on backends without usage accounting. */
  readonly mcpUsage?: McpUsageSummary;
}

/** Tokens the host model of an MCP client spent on ADK tool calls this month. */
export interface McpUsageSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly spendMicros: number;
  readonly unpricedCalls: number;
  /** True when any event is a character-based estimate rather than reported usage. */
  readonly estimated: boolean;
  readonly byTool: readonly {
    readonly tool: string;
    readonly calls: number;
    readonly totalTokens: number;
  }[];
  readonly byClient: readonly {
    readonly provider: string;
    readonly model: string;
    readonly calls: number;
    readonly totalTokens: number;
  }[];
}

export type IssueChanges = Partial<
  Pick<
    Issue,
    | 'title'
    | 'description'
    | 'attachments'
    | 'status'
    | 'priority'
    | 'type'
    | 'assigneeAgentId'
    | 'assigneeUserId'
    | 'proofreaderUserId'
  >
>;
