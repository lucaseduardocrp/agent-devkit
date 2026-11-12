import { describe, expect, it } from 'vitest';
import {
  AGENT_CLIS,
  claudeCli,
  codexCli,
  geminiCli,
  Progress,
} from '../src/development/agent-clis.js';

const feed = (cli: typeof claudeCli, events: readonly unknown[], progress = new Progress()) => {
  for (const event of events)
    cli.parse(typeof event === 'string' ? event : JSON.stringify(event), progress);
  return progress;
};

describe('Progress', () => {
  it('reports only what changed, in batches, with paths relative to the worktree', () => {
    const progress = new Progress('C:\\work\\tree');
    expect(progress.take()).toBeNull();
    progress.add('message', '   ');
    expect(progress.take()).toBeNull();

    progress.add('tool', 'Read: C:\\work\\tree\\src\\a.ts and C:/work/tree/b.ts', 'sub-1');
    progress.add('message', 'x'.repeat(5000));
    const first = progress.take()!;
    expect(first.events[0]).toEqual({
      kind: 'tool',
      text: 'Read: src\\a.ts and b.ts',
      subagentId: 'sub-1',
    });
    expect(first.events[1]!.text).toHaveLength(4000);
    expect(first.events[1]).not.toHaveProperty('subagentId');
    expect(first).not.toHaveProperty('usedTokens');
    expect(first.subagents).toEqual([]);
    expect(progress.take()).toBeNull();

    for (let index = 0; index < 130; index += 1) progress.add('message', `line ${index}`);
    progress.setUsedTokens(42);
    expect(progress.take()).toMatchObject({ usedTokens: 42, events: { length: 100 } });
    expect(progress.take()!.events).toHaveLength(30);
    expect(progress.take()).toBeNull();

    const subagent = {
      id: 's',
      name: 'Tests',
      role: 'qa',
      status: 'running' as const,
      summary: '',
      usedTokens: 0,
    };
    progress.setSubagent(subagent);
    expect(progress.subagent('s')).toEqual(subagent);
    expect(progress.subagent('missing')).toBeUndefined();
    expect(progress.take()!.subagents).toEqual([subagent]);
    expect(new Progress().take()).toBeNull();
  });
});

describe('Claude Code', () => {
  it('asks for edits only in safe mode and for everything in auto mode', () => {
    expect(claudeCli.invocation('safe', 70)).toEqual({
      command: 'claude',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
      ],
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' },
    });
    expect(claudeCli.invocation('auto', 80).args).toContain('--dangerously-skip-permissions');
  });

  it('turns the stream into messages, tools, context usage and subagents', () => {
    const progress = feed(claudeCli, [
      'not json',
      '"a string"',
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
            output_tokens: 8,
          },
          content: [
            { type: 'thinking' },
            { type: 'text', text: 'Reading the code' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
            { type: 'tool_use', name: 'TodoWrite', input: {} },
            { type: 'tool_use', name: 'Agent', input: { description: 'Check' } },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_started',
        tool_use_id: 'tool-1',
        description: 'Check the tests',
        subagent_type: 'general-purpose',
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'tool-1',
        message: {
          usage: { input_tokens: 999999 },
          content: [
            { type: 'text', text: 'subagent chatter' },
            { type: 'tool_use', name: 'Skill', input: { description: 'Run the suite' } },
          ],
        },
      },
      { type: 'assistant', message: { content: 'plain' } },
      {
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'tool-1',
        status: 'completed',
        summary: 'All green',
        usage: { total_tokens: 3700 },
      },
      { type: 'system', subtype: 'task_started', tool_use_id: 'tool-2' },
      { type: 'system', subtype: 'task_notification', tool_use_id: 'tool-2', status: 'failed' },
      { type: 'system', subtype: 'task_notification', tool_use_id: 'tool-3', status: 'killed' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'rate_limit_event' },
      { type: 'result', subtype: 'success', result: 'Done: added the form.' },
    ]);
    expect(progress.summary).toBe('Done: added the form.');
    expect(progress.error).toBeNull();
    const report = progress.take()!;
    expect(report.usedTokens).toBe(1110);
    expect(report.events).toEqual([
      { kind: 'message', text: 'Reading the code' },
      { kind: 'tool', text: 'Read: src/a.ts' },
      { kind: 'tool', text: 'Bash: npm test' },
      { kind: 'tool', text: 'Grep: TODO' },
      { kind: 'tool', text: 'TodoWrite' },
      { kind: 'subagent', text: 'Started: Check the tests', subagentId: 'tool-1' },
      { kind: 'tool', text: 'Skill: Run the suite', subagentId: 'tool-1' },
      { kind: 'subagent', text: 'Finished: Check the tests', subagentId: 'tool-1' },
      { kind: 'subagent', text: 'Started: Subagent', subagentId: 'tool-2' },
      { kind: 'subagent', text: 'Failed: Subagent', subagentId: 'tool-2' },
      { kind: 'subagent', text: 'Failed: Subagent', subagentId: 'tool-3' },
      { kind: 'compaction', text: 'The conversation was compacted.' },
    ]);
    expect(report.subagents).toEqual([
      {
        id: 'tool-1',
        name: 'Check the tests',
        role: 'general-purpose',
        status: 'done',
        summary: 'All green',
        usedTokens: 3700,
      },
      { id: 'tool-2', name: 'Subagent', role: '', status: 'failed', summary: '', usedTokens: 0 },
      { id: 'tool-3', name: 'Subagent', role: '', status: 'failed', summary: '', usedTokens: 0 },
    ]);
  });

  it('keeps the reason when the run ends in an error', () => {
    expect(
      feed(claudeCli, [{ type: 'result', subtype: 'success', is_error: true, result: 'No credit' }])
        .error,
    ).toBe('No credit');
    expect(feed(claudeCli, [{ type: 'result', subtype: 'error_max_turns' }]).error).toBe(
      'error_max_turns',
    );
    expect(feed(claudeCli, [{ type: 'result' }]).error).toBe('The agent reported an error.');
  });
});

describe('Codex', () => {
  it('sandboxes writes to the workspace unless autonomy is auto', () => {
    expect(codexCli.invocation('safe', 80)).toEqual({
      command: 'codex',
      args: ['exec', '--json', '--sandbox', 'workspace-write', '-'],
      env: {},
    });
    expect(codexCli.invocation('auto', 80).args).toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('reads messages, commands, file changes, usage and failures', () => {
    const progress = feed(codexCli, [
      'garbage',
      { type: 'thread.started' },
      { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } },
      {
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }, {}] },
      },
      { type: 'item.completed', item: { type: 'file_change' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Added the form.' } },
      { type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 100 } },
    ]);
    expect(progress.summary).toBe('Added the form.');
    const report = progress.take()!;
    expect(report.usedTokens).toBe(1000);
    expect(report.events).toEqual([
      { kind: 'tool', text: 'shell: npm test' },
      { kind: 'tool', text: 'edit: a.ts, b.ts' },
      { kind: 'tool', text: 'edit' },
      { kind: 'message', text: 'Added the form.' },
    ]);
    expect(
      feed(codexCli, [{ type: 'turn.failed', error: { message: 'Rate limited' } }]).error,
    ).toBe('Rate limited');
    expect(feed(codexCli, [{ type: 'error', message: 'Not signed in' }]).error).toBe(
      'Not signed in',
    );
    expect(feed(codexCli, [{ type: 'error' }]).error).toBe('Codex failed.');
  });
});

describe('Gemini CLI', () => {
  it('treats every printed line as a message and the output as the summary', () => {
    expect(geminiCli.invocation('safe', 80)).toEqual({ command: 'gemini', args: [], env: {} });
    expect(geminiCli.invocation('auto', 80).args).toEqual(['--yolo']);
    const progress = feed(geminiCli, ['Created the file.', '   ', 'All done.']);
    expect(progress.summary).toBe('Created the file.\nAll done.');
    expect(progress.take()!.events.map((event) => event.text)).toEqual([
      'Created the file.',
      'All done.',
    ]);
  });
});

it('knows the three CLIs a session can ask for', () => {
  expect(Object.keys(AGENT_CLIS)).toEqual(['claude', 'codex', 'gemini']);
});
