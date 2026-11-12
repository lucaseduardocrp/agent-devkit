import type { Schedule } from './state-store.js';

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Reads a schedule from the start of `text` and returns it with the rest (the prompt):
 *   "every 30m check the build"   "cada 2h ..."   "daily 09:00 summarize the issues"
 */
export function parseSchedule(text: string): { schedule: Schedule; rest: string } | null {
  const every = /^(?:every|cada)\s+(\d+)\s*([mhd])\b\s*/i.exec(text);
  if (every) {
    const ms = Number(every[1]) * (UNITS[every[2]!.toLowerCase()] ?? 0);
    // One minute is the scheduler's resolution; shorter would only burn tokens.
    if (ms < UNITS.m!) return null;
    return { schedule: { kind: 'every', ms }, rest: text.slice(every[0].length).trim() };
  }
  const daily = /^(?:daily|diario|diário|todo dia)\s+(\d{1,2}):(\d{2})\b\s*/i.exec(text);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return null;
    return { schedule: { kind: 'daily', hour, minute }, rest: text.slice(daily[0].length).trim() };
  }
  return null;
}

/** The first run strictly after `after`. Daily times use the container's time zone (TZ). */
export function nextRun(schedule: Schedule, after: number): number {
  if (schedule.kind === 'every') return after + schedule.ms;
  const next = new Date(after);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (next.getTime() <= after) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === 'daily')
    return `daily ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  const { ms } = schedule;
  if (ms % UNITS.d! === 0) return `every ${ms / UNITS.d!}d`;
  if (ms % UNITS.h! === 0) return `every ${ms / UNITS.h!}h`;
  return `every ${ms / UNITS.m!}m`;
}
