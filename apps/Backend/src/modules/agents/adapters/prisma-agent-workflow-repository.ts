import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflow,
  type AgentWorkflowActionConfig,
  type AgentWorkflowNotificationConfig,
  type AgentWorkflowCanvas,
  type AgentWorkflowCanvasEdge,
  type AgentWorkflowCanvasNode,
  type AgentWorkflowConditionConfig,
  type AgentWorkflowConditionOperator,
  type AgentWorkflowDelayConfig,
  type AgentWorkflowNodeKind,
  type AgentWorkflowProductEvent,
  type AgentWorkflowRule,
  type AgentWorkflowTriggerConfig,
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
  'integrationtests',
  'loadtests',
  'audit',
  'workspaces',
  'notifications',
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
        effect: value['effect'],
        ...(value['toolName'] ? { toolName: value['toolName'] } : {}),
        ...(allowedProviders !== undefined ? { allowedProviders: allowedProviders } : {}),
        ...(value['createIssueForAction'] !== undefined
          ? { createIssueForAction: value['createIssueForAction'] }
          : {}),
        ...(value['requireApproval'] !== undefined
          ? { requireApproval: value['requireApproval'] }
          : {}),
      },
    ];
  });
}

const nodeKinds = new Set<AgentWorkflowNodeKind>([
  'trigger',
  'step',
  'approval',
  'action',
  'condition',
  'delay',
  'rule',
]);

const conditionOperators = new Set<AgentWorkflowConditionOperator>([
  'contains',
  'not-contains',
  'matches',
]);

const productEvents = new Set<AgentWorkflowProductEvent>([
  'pbi.created',
  'pbi.moved',
  'spec.published',
  'issue.commented',
]);

/**
 * A node's configuration bag, kept only when it matches the node's kind. A bag that does not is
 * dropped rather than failing the whole canvas: the editor fills it with its defaults again.
 */
function parseTrigger(raw: unknown): AgentWorkflowTriggerConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const kind = value['kind'];
  if (kind !== 'issue-assigned' && kind !== 'product-event' && kind !== 'schedule')
    return undefined;
  const events = Array.isArray(value['events'])
    ? value['events'].filter((event): event is AgentWorkflowProductEvent =>
        productEvents.has(event as AgentWorkflowProductEvent),
      )
    : undefined;
  return {
    kind,
    ...(events ? { events } : {}),
    ...(typeof value['cron'] === 'string' ? { cron: value['cron'] } : {}),
  };
}

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];

function parseNotification(raw: unknown): AgentWorkflowNotificationConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  return {
    channels: strings(value['channels']),
    userIds: strings(value['userIds']),
    roles: strings(value['roles']).filter(
      (role): role is 'assignee' | 'proofreader' => role === 'assignee' || role === 'proofreader',
    ),
    subject: typeof value['subject'] === 'string' ? value['subject'] : '',
    message: typeof value['message'] === 'string' ? value['message'] : '',
  };
}

function parseAction(raw: unknown): AgentWorkflowActionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (!workflowToolsets.has(value['toolset'] as AgentWorkflowToolset)) return undefined;
  const notification = parseNotification(value['notification']);
  return {
    toolset: value['toolset'] as AgentWorkflowToolset,
    ...(typeof value['toolName'] === 'string' ? { toolName: value['toolName'] } : {}),
    ...(typeof value['provider'] === 'string' ? { provider: value['provider'] } : {}),
    ...(notification ? { notification } : {}),
  };
}

function parseCondition(raw: unknown): AgentWorkflowConditionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (
    !conditionOperators.has(value['operator'] as AgentWorkflowConditionOperator) ||
    typeof value['value'] !== 'string'
  )
    return undefined;
  return {
    operator: value['operator'] as AgentWorkflowConditionOperator,
    value: value['value'],
  };
}

function parseDelay(raw: unknown): AgentWorkflowDelayConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const minutes = (raw as Record<string, unknown>)['minutes'];
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return undefined;
  return { minutes };
}

/** The saved canvas, dropped whole when anything about it is malformed: the editor re-lays it out. */
function parseCanvas(raw: unknown): AgentWorkflowCanvas | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value['nodes']) || !Array.isArray(value['edges'])) return undefined;

  const nodes: AgentWorkflowCanvasNode[] = [];
  for (const entry of value['nodes']) {
    if (!entry || typeof entry !== 'object') return undefined;
    const node = entry as Record<string, unknown>;
    // `start` is the name the trigger node had before triggers were configurable.
    const kind = node['kind'] === 'start' ? 'trigger' : node['kind'];
    if (
      typeof node['id'] !== 'string' ||
      !nodeKinds.has(kind as AgentWorkflowNodeKind) ||
      typeof node['x'] !== 'number' ||
      !Number.isFinite(node['x']) ||
      typeof node['y'] !== 'number' ||
      !Number.isFinite(node['y'])
    )
      return undefined;
    const trigger = parseTrigger(node['trigger']);
    const action = parseAction(node['action']);
    const condition = parseCondition(node['condition']);
    const delay = parseDelay(node['delay']);
    nodes.push({
      id: node['id'],
      kind: kind as AgentWorkflowNodeKind,
      x: node['x'],
      y: node['y'],
      ...(trigger ? { trigger } : {}),
      ...(action ? { action } : {}),
      ...(condition ? { condition } : {}),
      ...(delay ? { delay } : {}),
    });
  }

  const edges: AgentWorkflowCanvasEdge[] = [];
  for (const entry of value['edges']) {
    if (!entry || typeof entry !== 'object') return undefined;
    const edge = entry as Record<string, unknown>;
    if (
      typeof edge['id'] !== 'string' ||
      typeof edge['from'] !== 'string' ||
      typeof edge['to'] !== 'string'
    )
      return undefined;
    const port = edge['fromPort'];
    edges.push({
      id: edge['id'],
      from: edge['from'],
      to: edge['to'],
      ...(port === 'true' || port === 'false' ? { fromPort: port } : {}),
    });
  }

  return { nodes, edges };
}

export interface PrismaAgentWorkflowClient {
  readonly agentWorkflowRecord: AgentWorkflowDelegate;
}

function parseWorkflow(raw: unknown): AgentWorkflow {
  if (!raw || typeof raw !== 'object') return EMPTY_AGENT_WORKFLOW;
  const value = raw as Record<string, unknown>;
  if (typeof value['enabled'] !== 'boolean' || !Array.isArray(value['steps']))
    return EMPTY_AGENT_WORKFLOW;
  const canvas = parseCanvas(value['canvas']);
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
    ...(canvas ? { canvas } : {}),
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
