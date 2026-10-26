import type { AdkApi } from '../api/http-client.js';
import type { McpTool, ToolContext, ToolResult } from './tool.js';
import { getWorkflow } from '../modules/agents/tools.js';

interface WorkflowRule {
  readonly id: string;
  readonly name: string;
  readonly toolset: string;
  readonly toolName?: string;
  readonly effect: 'allow' | 'deny';
  readonly allowedProviders?: readonly string[];
  readonly createIssueForAction?: boolean;
  readonly requireApproval?: boolean;
}

interface CreatedIssue {
  readonly issue: { readonly id: string };
}

const PROVIDER_KEYS = new Set(['provider', 'providerid']);
const TRACKING_ISSUE_TOOLS = new Set(['issues_create', 'pbi_create_issue']);
const SECRET_FIELD = /(password|secret|token|api.?key|authorization|cookie)/i;

function providerValues(input: unknown, values: string[] = []): string[] {
  if (Array.isArray(input)) {
    for (const item of input) providerValues(item, values);
  } else if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (PROVIDER_KEYS.has(key.toLowerCase()) && typeof value === 'string') values.push(value);
      else providerValues(value, values);
    }
  }
  return values;
}

function message(code: string, detail: string): Error {
  return Object.assign(new Error(detail), { code });
}

function redactInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_FIELD.test(key) ? '[redacted]' : redactInput(nested),
    ]),
  );
}

async function requireUserApproval(context: ToolContext, prompt: string): Promise<void> {
  if (!context.requestApproval)
    throw message(
      'WORKFLOW_APPROVAL_UNAVAILABLE',
      'This action needs human approval, but the connected MCP client does not support approval requests. No action was taken.',
    );
  let approved = false;
  try {
    approved = await context.requestApproval(prompt);
  } catch {
    throw message(
      'WORKFLOW_APPROVAL_UNAVAILABLE',
      'Could not request human approval from the connected MCP client. No action was taken.',
    );
  }
  if (!approved)
    throw message('WORKFLOW_APPROVAL_DECLINED', 'The user declined or canceled this action.');
}

async function createTrackingIssue(
  api: AdkApi,
  rule: WorkflowRule,
  tool: McpTool,
  input: unknown,
): Promise<string> {
  const response = await api.request<CreatedIssue>({
    method: 'POST',
    path: '/issues',
    body: {
      title: `MCP action: ${tool.title}`.slice(0, 240),
      description: [
        `This Issue tracks the MCP action “${tool.name}”.`,
        `Opened automatically by workflow rule “${rule.name}”.`,
        '',
        'Action input:',
        JSON.stringify(redactInput(input), null, 2).slice(0, 20_000),
      ].join('\n'),
      status: 'in_progress',
    },
  });
  return response.issue.id;
}

async function finishTrackingIssue(
  api: AdkApi,
  issueId: string,
  tool: McpTool,
  succeeded: boolean,
): Promise<void> {
  const path = `/issues/${encodeURIComponent(issueId)}`;
  const comment = succeeded
    ? `MCP action '${tool.name}' completed.`
    : `MCP action '${tool.name}' failed before completion.`;
  await Promise.allSettled([
    api.request({ method: 'PATCH', path, body: { status: succeeded ? 'done' : 'blocked' } }),
    api.request({ method: 'POST', path: `${path}/comments`, body: { body: comment } }),
  ]);
}

/** Enforces workspace action rules before any MCP tool can reach the backend or a provider. */
export async function executeWithWorkflowPolicy(
  tool: McpTool,
  rawInput: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const input = tool.parseInput(rawInput);
  const session = await context.session.state();
  if (!session.workspaceId || tool.toolset === 'account') return tool.execute(input, context);

  const workflow = await getWorkflow(context.api);
  if (
    !workflow.rules.length &&
    workflow.defaultAction !== 'deny' &&
    workflow.autonomy !== 'supervised' &&
    workflow.issueCreationBehavior !== 'ask'
  )
    return tool.execute(input, context);

  const matching = workflow.rules.filter(
    (rule) =>
      (rule.toolset === 'all' || rule.toolset === tool.toolset) &&
      (!rule.toolName || rule.toolName === tool.name),
  );
  if (matching.some((rule) => rule.effect === 'deny'))
    throw message(
      'WORKFLOW_ACTION_BLOCKED',
      `Workflow blocked ${tool.name} in the ${tool.toolset} module.`,
    );

  const allowedAction = matching.some((rule) => rule.effect === 'allow');
  if (workflow.defaultAction === 'deny' && tool.access !== 'read' && !allowedAction)
    throw message(
      'WORKFLOW_ACTION_BLOCKED',
      `Workflow denies unlisted write action ${tool.name} in the ${tool.toolset} module.`,
    );

  const providerRules = matching.filter(
    (rule) => rule.effect === 'allow' && rule.allowedProviders !== undefined,
  );
  if (providerRules.length) {
    let allowed = new Set(providerRules[0]!.allowedProviders);
    for (const rule of providerRules.slice(1))
      allowed = new Set(
        [...allowed].filter((provider) => rule.allowedProviders!.includes(provider)),
      );
    const actual = providerValues(input);
    if (!actual.length || !actual.every((provider) => allowed.has(provider)))
      throw message(
        'WORKFLOW_PROVIDER_BLOCKED',
        `Workflow allows ${tool.name} only with these provider IDs: ${[...allowed].join(', ') || '(none)'}.`,
      );
  }

  const issueCreationNeedsApproval =
    workflow.issueCreationBehavior === 'ask' && TRACKING_ISSUE_TOOLS.has(tool.name);
  const ruleRequiresApproval = matching.some(
    (rule) => rule.effect === 'allow' && rule.requireApproval,
  );
  if (
    tool.access !== 'read' &&
    (workflow.autonomy === 'supervised' || issueCreationNeedsApproval || ruleRequiresApproval)
  ) {
    await requireUserApproval(
      context,
      [
        `Approve this ${tool.access} action: ${tool.title} (${tool.name})?`,
        '',
        'Action input:',
        JSON.stringify(redactInput(input), null, 2).slice(0, 8_000),
      ].join('\n'),
    );
  }

  const issueRule = matching.find((rule) => rule.effect === 'allow' && rule.createIssueForAction);
  const needsTrackingIssue =
    Boolean(issueRule) && tool.access !== 'read' && !TRACKING_ISSUE_TOOLS.has(tool.name);
  const trackingIssueId = needsTrackingIssue
    ? await createTrackingIssue(context.api, issueRule!, tool, input)
    : undefined;

  try {
    const result = await tool.execute(input, context);
    if (trackingIssueId) await finishTrackingIssue(context.api, trackingIssueId, tool, true);
    if (!trackingIssueId) return result;
    if (result.kind === 'text')
      return {
        ...result,
        text: `${result.text}\n\nWorkflow tracking Issue: ${trackingIssueId}`,
      };
    return {
      ...result,
      data:
        result.data && typeof result.data === 'object' && !Array.isArray(result.data)
          ? { ...result.data, workflowTrackingIssueId: trackingIssueId }
          : { result: result.data, workflowTrackingIssueId: trackingIssueId },
    };
  } catch (error) {
    if (trackingIssueId) await finishTrackingIssue(context.api, trackingIssueId, tool, false);
    throw error;
  }
}
