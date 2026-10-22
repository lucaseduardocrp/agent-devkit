import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflow,
  type AgentWorkflowRule,
  type AgentWorkflowToolset,
} from '../domain/agent-workflow.js';
import type { AgentWorkflowRepository } from '../application/agent-workflow-repository.js';

interface RawWorkflowRecord {
  readonly definition: unknown;
  readonly updatedAt: Date;
}

interface AgentWorkflowDelegate {
  findUnique(args: { where: { workspaceId: string } }): Promise<RawWorkflowRecord | null>;
  upsert(args: {
    where: { workspaceId: string };
    create: { workspaceId: string; definition: unknown };
    update: { definition: unknown };
  }): Promise<RawWorkflowRecord>;
}

const workflowToolsets = new Set<AgentWorkflowToolset>([
  'all',
  'agents',
  'integrations',
  'brain',
  'issues',
  'pbi',
  'spec',
  'testplans',
  'design',
  'e2e',
  'releasenotes',
  'audit',
  'workspaces',
]);

function parseRules(raw: unknown): AgentWorkflowRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): AgentWorkflowRule[] => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    const allowedProviders = value['allowedProviders'];
    if (
      typeof value['id'] !== 'string' ||
      typeof value['name'] !== 'string' ||
      typeof value['toolset'] !== 'string' ||
      !workflowToolsets.has(value['toolset'] as AgentWorkflowToolset) ||
      (value['toolName'] !== undefined && typeof value['toolName'] !== 'string') ||
      (value['effect'] !== 'allow' && value['effect'] !== 'deny') ||
      (value['createIssueForAction'] !== undefined &&
        typeof value['createIssueForAction'] !== 'boolean') ||
      (value['requireApproval'] !== undefined && typeof value['requireApproval'] !== 'boolean') ||
      (allowedProviders !== undefined &&
        (!Array.isArray(allowedProviders) ||
          !allowedProviders.every((provider) => typeof provider === 'string')))
    )
      return [];
    return [
      {
        id: value['id'],
        name: value['name'],
        toolset: value['toolset'] as AgentWorkflowToolset,
        effect: value['effect'] as AgentWorkflowRule['effect'],
        ...(value['toolName'] ? { toolName: value['toolName'] as string } : {}),
        ...(allowedProviders !== undefined
          ? { allowedProviders: allowedProviders as string[] }
          : {}),
        ...(value['createIssueForAction'] !== undefined
          ? { createIssueForAction: value['createIssueForAction'] as boolean }
          : {}),
        ...(value['requireApproval'] !== undefined
          ? { requireApproval: value['requireApproval'] as boolean }
          : {}),
      },
    ];
  });
}

export interface PrismaAgentWorkflowClient {
  readonly agentWorkflowRecord: AgentWorkflowDelegate;
}

function parseWorkflow(raw: unknown): AgentWorkflow {
  if (!raw || typeof raw !== 'object') return EMPTY_AGENT_WORKFLOW;
  const value = raw as Record<string, unknown>;
  if (typeof value['enabled'] !== 'boolean' || !Array.isArray(value['steps']))
    return EMPTY_AGENT_WORKFLOW;
  return {
    enabled: value['enabled'],
    autonomy:
      value['autonomy'] === 'supervised' || value['autonomy'] === 'autonomous'
        ? value['autonomy']
        : 'balanced',
    finalReview: value['finalReview'] !== false,
    uncertaintyBehavior: value['uncertaintyBehavior'] === 'assume' ? 'assume' : 'ask',
    issueCreationBehavior: value['issueCreationBehavior'] === 'allow' ? 'allow' : 'ask',
    defaultAction: value['defaultAction'] === 'deny' ? 'deny' : 'allow',
    rules: parseRules(value['rules']),
    steps: value['steps'].filter(
      (step): step is AgentWorkflow['steps'][number] =>
        Boolean(step) &&
        typeof step === 'object' &&
        typeof (step as Record<string, unknown>)['id'] === 'string' &&
        typeof (step as Record<string, unknown>)['name'] === 'string' &&
        typeof (step as Record<string, unknown>)['instructions'] === 'string' &&
        ((step as Record<string, unknown>)['reviewRequired'] === undefined ||
          typeof (step as Record<string, unknown>)['reviewRequired'] === 'boolean') &&
        ((step as Record<string, unknown>)['agentId'] === undefined ||
          typeof (step as Record<string, unknown>)['agentId'] === 'string'),
    ),
  };
}

export class PrismaAgentWorkflowRepository implements AgentWorkflowRepository {
  public constructor(private readonly client: PrismaAgentWorkflowClient) {}

  public async findByWorkspace(workspaceId: string): Promise<AgentWorkflow> {
    const record = await this.client.agentWorkflowRecord.findUnique({ where: { workspaceId } });
    return record
      ? { ...parseWorkflow(record.definition), updatedAt: record.updatedAt.toISOString() }
      : EMPTY_AGENT_WORKFLOW;
  }

  public async save(workspaceId: string, workflow: AgentWorkflow): Promise<AgentWorkflow> {
    const record = await this.client.agentWorkflowRecord.upsert({
      where: { workspaceId },
      create: { workspaceId, definition: workflow },
      update: { definition: workflow },
    });
    return {
      ...parseWorkflow(record.definition),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
