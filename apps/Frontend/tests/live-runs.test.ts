import { describe, expect, it } from 'vitest';
import { mergeSnapshot, upsertRun } from '../src/features/agents/live-runs.js';
import type { AgentRun, AgentRunEvent } from '../src/features/issues/issue-types.js';

const run = (id: string, patch: Partial<AgentRun> = {}): AgentRun => ({
  id,
  issueId: `issue-${id}`,
  agentId: 'agent-1',
  status: 'queued',
  mode: 'host',
  attempt: 1,
  output: 'kept output',
  error: null,
  provider: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  costMicros: null,
  createdAt: '2026-01-01',
  startedAt: null,
  finishedAt: null,
  ...patch,
});
const event = (id: string, patch: Partial<AgentRunEvent> = {}): AgentRunEvent => {
  const { output: _output, ...rest } = run(id, patch);
  return rest;
};

describe('upsertRun', () => {
  it('puts a task that just arrived first, without an output', () => {
    const next = upsertRun([run('a')], event('b'));
    expect(next.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(next[0]!.output).toBeNull();
  });

  it('updates a known run in place and keeps the output the event leaves out', () => {
    const before = [run('a'), run('b')];
    const next = upsertRun(before, event('b', { status: 'running' }));
    expect(next.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(next[1]).toMatchObject({ status: 'running', output: 'kept output' });
    expect(next[0]).toBe(before[0]);
    expect(before[1]!.status).toBe('queued');
  });
});

describe('mergeSnapshot', () => {
  it('lets what the stream reported while loading win over the loaded run', () => {
    const merged = mergeSnapshot(
      [run('a'), run('b')],
      new Map([['a', event('a', { status: 'running' })]]),
    );
    expect(merged.map((entry) => `${entry.id}:${entry.status}`)).toEqual(['a:running', 'b:queued']);
    expect(merged[0]!.output).toBe('kept output');
  });

  it('adds a run the load did not know yet, first', () => {
    const merged = mergeSnapshot([run('a')], new Map([['z', event('z')]]));
    expect(merged.map((entry) => entry.id)).toEqual(['z', 'a']);
  });

  it('returns the loaded runs when nothing was reported', () => {
    const snapshot = [run('a')];
    expect(mergeSnapshot(snapshot, new Map())).toEqual(snapshot);
  });
});
