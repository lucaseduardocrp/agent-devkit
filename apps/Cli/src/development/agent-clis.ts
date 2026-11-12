/**
 * The coding CLIs a development session can run on, and how their output becomes the progress
 * ADK shows: timeline events, context usage and the subagents at work.
 */

export type ProgressKind = 'status' | 'message' | 'tool' | 'subagent' | 'compaction';

export interface ProgressEvent {
  readonly kind: ProgressKind;
  readonly text: string;
  readonly subagentId?: string;
}

export interface Subagent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly status: 'running' | 'done' | 'failed';
  readonly summary: string;
  readonly usedTokens: number;
}

export interface ProgressReport {
  readonly events: readonly ProgressEvent[];
  readonly usedTokens?: number;
  readonly subagents: readonly Subagent[];
}

const MAX_EVENT_TEXT = 4000;
const MAX_REPORT_EVENTS = 100;
const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

function relative(text: string, root: string): string {
  if (!root) return text;
  let result = text;
  for (const prefix of [root, root.replace(/\\/g, '/')])
    for (const separator of ['\\', '/']) result = result.split(prefix + separator).join('');
  return result;
}

/** What a session produced since the last report, plus its running totals. */
export class Progress {
  public summary = '';
  public error: string | null = null;
  private events: ProgressEvent[] = [];
  private usedTokens: number | undefined;
  private readonly subagents = new Map<string, Subagent>();
  private dirty = false;

  /** `root` is the worktree folder: it is cut from every line, so paths read as relative. */
  public constructor(private readonly root = '') {}

  public add(kind: ProgressKind, text: string, subagentId?: string): void {
    const trimmed = relative(text, this.root).trim();
    if (!trimmed) return;
    this.events.push({
      kind,
      text: clip(trimmed, MAX_EVENT_TEXT),
      ...(subagentId ? { subagentId } : {}),
    });
    this.dirty = true;
  }

  public setUsedTokens(tokens: number): void {
    this.usedTokens = tokens;
    this.dirty = true;
  }

  public setSubagent(subagent: Subagent): void {
    this.subagents.set(subagent.id, subagent);
    this.dirty = true;
  }

  public subagent(id: string): Subagent | undefined {
    return this.subagents.get(id);
  }

  /** The next report, or null when nothing changed. Events beyond the limit wait for the next one. */
  public take(): ProgressReport | null {
    if (!this.dirty) return null;
    const events = this.events.slice(0, MAX_REPORT_EVENTS);
    this.events = this.events.slice(MAX_REPORT_EVENTS);
    this.dirty = this.events.length > 0;
    return {
      events,
      ...(this.usedTokens === undefined ? {} : { usedTokens: this.usedTokens }),
      subagents: [...this.subagents.values()],
    };
  }
}

/** `safe` lets the agent edit files of the worktree only; `auto` also lets it run commands. */
export type Autonomy = 'safe' | 'auto';

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentCli {
  /** The prompt always goes through stdin, so no argument needs shell quoting. */
  invocation(autonomy: Autonomy, compactAtPercent: number): Invocation;
  /** Reads one line of the CLI's output into the progress. */
  parse(line: string, progress: Progress): void;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' ? (value as Json) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

function parseJson(line: string): Json | null {
  try {
    return record(JSON.parse(line));
  } catch {
    return null;
  }
}

/** The part of a tool call worth a line in the timeline. */
function toolLine(name: string, input: Json): string {
  const detail =
    text(input['file_path']) ||
    text(input['command']) ||
    text(input['pattern']) ||
    text(input['description']);
  return detail ? `${name}: ${clip(detail, 300)}` : name;
}

/** Claude Code, `--output-format stream-json`. */
export const claudeCli: AgentCli = {
  invocation(autonomy, compactAtPercent) {
    return {
      command: 'claude',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        ...(autonomy === 'auto'
          ? ['--dangerously-skip-permissions']
          : ['--permission-mode', 'acceptEdits']),
      ],
      // Claude Code compacts on its own; this moves its threshold to the one the session asks for.
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(compactAtPercent) },
    };
  },

  parse(line, progress) {
    const event = parseJson(line);
    if (!event) return;
    const type = text(event['type']);
    if (type === 'assistant') {
      const message = record(event['message']);
      const parent = text(event['parent_tool_use_id']);
      const usage = record(message['usage']);
      // The main conversation's last request is what fills its context window.
      if (!parent && message['usage'])
        progress.setUsedTokens(
          number(usage['input_tokens']) +
            number(usage['cache_creation_input_tokens']) +
            number(usage['cache_read_input_tokens']) +
            number(usage['output_tokens']),
        );
      for (const part of Array.isArray(message['content']) ? message['content'] : []) {
        const content = record(part);
        if (content['type'] === 'text' && !parent) progress.add('message', text(content['text']));
        // Subagents are reported by their own events below.
        if (content['type'] === 'tool_use' && content['name'] !== 'Agent')
          progress.add(
            'tool',
            toolLine(text(content['name']), record(content['input'])),
            parent || undefined,
          );
      }
    } else if (type === 'system') {
      const subtype = text(event['subtype']);
      const id = text(event['tool_use_id']);
      if (subtype === 'task_started') {
        const name = text(event['description']) || 'Subagent';
        progress.setSubagent({
          id,
          name,
          role: text(event['subagent_type']),
          status: 'running',
          summary: '',
          usedTokens: 0,
        });
        progress.add('subagent', `Started: ${name}`, id);
      } else if (subtype === 'task_notification') {
        const known = progress.subagent(id);
        const done = event['status'] === 'completed';
        const subagent: Subagent = {
          id,
          name: known?.name ?? 'Subagent',
          role: known?.role ?? '',
          status: done ? 'done' : 'failed',
          summary: clip(text(event['summary']), MAX_EVENT_TEXT),
          usedTokens: number(record(event['usage'])['total_tokens']),
        };
        progress.setSubagent(subagent);
        progress.add('subagent', `${done ? 'Finished' : 'Failed'}: ${subagent.name}`, id);
      } else if (subtype === 'compact_boundary') {
        progress.add('compaction', 'The conversation was compacted.');
      }
    } else if (type === 'result') {
      const result = text(event['result']);
      if (event['is_error'] === true || event['subtype'] !== 'success')
        progress.error = result || text(event['subtype']) || 'The agent reported an error.';
      else progress.summary = result;
    }
  },
};

/** Codex, `exec --json`. */
export const codexCli: AgentCli = {
  invocation(autonomy) {
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        ...(autonomy === 'auto'
          ? ['--dangerously-bypass-approvals-and-sandbox']
          : ['--sandbox', 'workspace-write']),
        '-',
      ],
      env: {},
    };
  },

  parse(line, progress) {
    const event = parseJson(line);
    if (!event) return;
    const type = text(event['type']);
    if (type === 'item.completed') {
      const item = record(event['item']);
      if (item['type'] === 'agent_message') {
        progress.summary = text(item['text']);
        progress.add('message', progress.summary);
      } else if (item['type'] === 'command_execution') {
        progress.add('tool', toolLine('shell', { command: item['command'] }));
      } else if (item['type'] === 'file_change') {
        const paths = (Array.isArray(item['changes']) ? item['changes'] : [])
          .map((change) => text(record(change)['path']))
          .filter(Boolean);
        progress.add('tool', toolLine('edit', { file_path: paths.join(', ') }));
      }
    } else if (type === 'turn.completed') {
      const usage = record(event['usage']);
      progress.setUsedTokens(number(usage['input_tokens']) + number(usage['output_tokens']));
    } else if (type === 'turn.failed' || type === 'error') {
      progress.error =
        text(record(event['error'])['message']) || text(event['message']) || 'Codex failed.';
    }
  },
};

/** Gemini CLI prints plain text: every line is a message and the whole output is the summary. */
export const geminiCli: AgentCli = {
  invocation(autonomy) {
    return { command: 'gemini', args: autonomy === 'auto' ? ['--yolo'] : [], env: {} };
  },

  parse(line, progress) {
    if (!line.trim()) return;
    progress.add('message', line);
    progress.summary = clip(`${progress.summary}\n${line}`.trim(), 20_000);
  },
};

export const AGENT_CLIS: Readonly<Record<string, AgentCli>> = {
  claude: claudeCli,
  codex: codexCli,
  gemini: geminiCli,
};
