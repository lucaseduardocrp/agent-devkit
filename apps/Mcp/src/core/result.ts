import { ZodError } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AdkApiError } from '../api/http-client.js';
import type { ToolResult } from './tool.js';

/** Upper bound for one tool result so a huge document cannot flood the model context. */
export const MAX_RESULT_CHARACTERS = 200_000;

export function limitText(value: string, max = MAX_RESULT_CHARACTERS): string {
  if (value.length <= max) return value;
  const hint = 'Narrow the request (filters, limit, includeContent: false) to see the rest.';
  return `${value.slice(0, max)}\n\n[Truncated: ${value.length - max} more characters. ${hint}]`;
}

export function toCallToolResult(result: ToolResult): CallToolResult {
  if (result.kind === 'text') return { content: [{ type: 'text', text: limitText(result.text) }] };
  const data = result.data === undefined ? { success: true } : result.data;
  return { content: [{ type: 'text', text: limitText(JSON.stringify(data, null, 2)) }] };
}

const HINTS: Readonly<Record<number, string>> = {
  401: 'Not authenticated. Ask the user to run `devkit login` in a terminal, set ADK_TOKEN, or use auth_login.',
  403: 'The current workspace role lacks permission for this action. Check the role with workspaces_get or switch workspace with workspaces_select.',
  404: 'Not found in the active workspace. List the resources first or confirm the active workspace.',
  429: 'Rate or quota limit reached. Wait before retrying.',
  502: 'An upstream provider failed. If it is the workspace LLM, use the host-mode tool instead.',
  503: 'A required integration is not configured. If it is the LLM provider, use the host-mode tool instead (no API key needed).',
};

/** Converts any failure into an MCP tool error the model can reason about and recover from. */
export function toErrorResult(error: unknown): CallToolResult {
  let message: string;
  if (error instanceof AdkApiError) {
    const hint = HINTS[error.status];
    message = [
      `ADK API error ${error.status || ''} ${error.code}: ${error.message}`.replace(/\s+/g, ' '),
      error.details.length ? `Details: ${JSON.stringify(error.details)}` : '',
      error.correlationId ? `Correlation id: ${error.correlationId}` : '',
      hint ? `Hint: ${hint}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } else if (error instanceof ZodError) {
    message = `Invalid tool input: ${error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('; ')}`;
  } else {
    message = error instanceof Error ? error.message : 'Unexpected error.';
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}
