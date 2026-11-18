import { nextRun } from './schedule.js';
import type { ScheduledTask, StateStore } from './state-store.js';

export interface SchedulerOptions {
  readonly store: StateStore;
  /** Runs a due task. Failures are reported by the callback itself; a throw only marks it failed. */
  readonly run: (task: ScheduledTask) => Promise<void>;
  readonly now?: () => number;
  readonly tickMs?: number;
}

/** Fires scheduled tasks when they are due. A task never overlaps with its own previous run. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<number>();
  private readonly now: () => number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts every due task. Resolves when those runs finish (tests wait on it). */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.options.store
      .tasks()
      .filter((task) => task.nextRunAt <= now && !this.running.has(task.id));
    await Promise.all(due.map((task) => this.fire(task, now)));
  }

  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  private async fire(task: ScheduledTask, now: number): Promise<void> {
    this.running.add(task.id);
    // Moved forward before running: a crash mid-run must not repeat the task on restart.
    task.nextRunAt = nextRun(task.schedule, now);
    task.lastRunAt = now;
    this.options.store.save();
    try {
      await this.options.run(task);
      task.lastStatus = 'ok';
    } catch {
      task.lastStatus = 'error';
    } finally {
      this.running.delete(task.id);
      this.options.store.save();
    }
  }
}
