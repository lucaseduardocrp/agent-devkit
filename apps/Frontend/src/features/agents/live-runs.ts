import type { AgentRun, AgentRunEvent } from '../issues/issue-types.js';

/** A run that is not on the list yet is a task that just arrived: it goes first, newest first. */
export function upsertRun(runs: readonly AgentRun[], event: AgentRunEvent): readonly AgentRun[] {
  const index = runs.findIndex((run) => run.id === event.id);
  if (index === -1) return [{ ...event, output: null }, ...runs];
  const next = [...runs];
  // The event leaves out the output, so the run keeps the one it already has.
  next[index] = { ...runs[index]!, ...event };
  return next;
}

/**
 * The runs loaded from the server, with the changes the stream reported while they were loading.
 * Those are newer than the load, so they win; a run the load did not know yet is added.
 */
export function mergeSnapshot(
  snapshot: readonly AgentRun[],
  reported: ReadonlyMap<string, AgentRunEvent>,
): readonly AgentRun[] {
  const known = new Set(snapshot.map((run) => run.id));
  const merged = snapshot.map((run) => {
    const event = reported.get(run.id);
    return event ? { ...run, ...event } : run;
  });
  const added = [...reported.values()]
    .filter((event) => !known.has(event.id))
    .map((event): AgentRun => ({ ...event, output: null }));
  return [...added, ...merged];
}
