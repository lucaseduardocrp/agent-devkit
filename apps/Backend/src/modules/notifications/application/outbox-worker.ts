import type { NotificationChannelRegistry } from './channel.js';
import type { ClaimedDelivery, NotificationOutbox } from './outbox.js';

const MINUTE = 60_000;

export interface NotificationOutboxWorkerOptions {
  readonly outbox: NotificationOutbox;
  readonly channels: NotificationChannelRegistry;
  /** How often it looks for work; a kick makes it look at once. */
  readonly intervalMs?: number;
  /** How many deliveries it takes at a time. */
  readonly batchSize?: number;
  /** How long a worker may hold a delivery before another one takes it over. */
  readonly leaseMs?: number;
  /** Tries before giving up on a delivery (the first one included). */
  readonly maxAttempts?: number;
  /** Wait before each new try; the last one repeats. */
  readonly backoffMs?: readonly number[];
  /** Delivered and abandoned deliveries are forgotten after this long. */
  readonly keepMs?: number;
  readonly now?: () => Date;
  readonly log?: (message: string, error?: unknown) => void;
}

/**
 * Delivers what the outbox holds. A delivery that fails is tried again after a wait that grows,
 * up to a limit; one left behind by a restart is picked up on the next look. Safe to run in several
 * processes at once: the outbox gives each delivery to only one of them.
 */
export class NotificationOutboxWorker {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly keepMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private lastPurge = 0;

  constructor(private readonly options: NotificationOutboxWorkerOptions) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? MINUTE;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? [30_000, 2 * MINUTE, 10 * MINUTE, 60 * MINUTE];
    this.keepMs = options.keepMs ?? 7 * 24 * 60 * MINUTE;
    this.now = options.now ?? (() => new Date());
  }

  /** Looks for work now, and then every `intervalMs`; also takes what a restart left behind. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  /** Stops looking, and waits for the delivery in hand. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Something was just queued: deliver it without waiting for the next look. */
  kick(): void {
    void this.runOnce();
  }

  /** One look: delivers what is due. Never throws; a look that overlaps another one runs after it. */
  runOnce(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.work().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.runOnce();
      }
    });
    return this.running;
  }

  private async work(): Promise<void> {
    try {
      const claimed = await this.options.outbox.claimDue(this.now(), this.batchSize, this.leaseMs);
      for (const delivery of claimed) await this.deliver(delivery);
      await this.purgeOld();
    } catch (error) {
      this.log('[Notifications] The delivery worker could not read the outbox:', error);
    }
  }

  private async deliver(delivery: ClaimedDelivery): Promise<void> {
    const { outbox, channels } = this.options;
    try {
      const channel = channels.get(delivery.channel);
      if (!channel) return await outbox.markFailed(delivery.id, 'Unknown channel.');
      if (!(await channel.isAvailable(delivery.workspaceId)))
        throw new Error('The channel is not set up.');
      await channel.send({
        workspaceId: delivery.workspaceId,
        recipient: delivery.recipient,
        message: delivery.message,
      });
      await outbox.markSent(delivery.id, this.now());
    } catch (error) {
      const reason = (error instanceof Error ? error.message : 'Delivery failed.').slice(0, 300);
      this.log(`[Notifications] ${delivery.channel} delivery ${delivery.id} failed:`, error);
      await this.retryOrGiveUp(delivery, reason);
    }
  }

  private async retryOrGiveUp(delivery: ClaimedDelivery, reason: string): Promise<void> {
    const { outbox } = this.options;
    try {
      if (delivery.attempts >= this.maxAttempts)
        return await outbox.markFailed(delivery.id, reason);
      const wait = this.backoffMs[Math.min(delivery.attempts - 1, this.backoffMs.length - 1)]!;
      await outbox.markRetry(delivery.id, new Date(this.now().getTime() + wait), reason);
    } catch (error) {
      // The delivery stays held until its lease runs out, and is taken again then.
      this.log('[Notifications] Could not record the outcome of a delivery:', error);
    }
  }

  /** Forgets old results, at most once an hour. */
  private async purgeOld(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastPurge < 60 * MINUTE) return;
    this.lastPurge = now;
    await this.options.outbox.purge(new Date(now - this.keepMs));
  }

  private log(message: string, error?: unknown): void {
    (this.options.log ?? ((text, cause) => console.error(text, cause)))(message, error);
  }
}
