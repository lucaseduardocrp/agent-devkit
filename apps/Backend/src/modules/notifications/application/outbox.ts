import type { NotificationMessage, Recipient } from '../domain/notification.js';

/** One message for one person on one channel, waiting to be delivered. */
export interface PendingDelivery {
  readonly workspaceId: string;
  readonly channel: string;
  readonly recipient: Recipient;
  readonly message: NotificationMessage;
}

/** A delivery a worker holds, with how many times it has been tried (including this one). */
export interface ClaimedDelivery extends PendingDelivery {
  readonly id: string;
  readonly attempts: number;
}

/**
 * The outbox: notifications are written here before anything is sent, so a restart cannot lose
 * them, and a worker delivers them. Several processes can share one outbox; a delivery is held by
 * one worker at a time, and a worker that dies lets go of it when its hold runs out.
 */
export interface NotificationOutbox {
  enqueue(deliveries: readonly PendingDelivery[]): Promise<void>;
  /** Takes up to `limit` deliveries that are due (or whose holder died), counting an attempt. */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedDelivery[]>;
  markSent(id: string, at: Date): Promise<void>;
  /** Puts it back to be tried again at `at`. */
  markRetry(id: string, at: Date, error: string): Promise<void>;
  /** Gives up on it for good. */
  markFailed(id: string, error: string): Promise<void>;
  /** Forgets delivered and abandoned deliveries older than `before`; returns how many. */
  purge(before: Date): Promise<number>;
}

type Status = 'pending' | 'sending' | 'sent' | 'failed';
interface Entry {
  readonly id: string;
  readonly delivery: PendingDelivery;
  status: Status;
  attempts: number;
  nextAttemptAt: Date;
  claimedUntil: Date | null;
  doneAt: Date | null;
  error: string | null;
}

/** For tests and for a server without a database: lives only as long as the process. */
export class InMemoryNotificationOutbox implements NotificationOutbox {
  private readonly entries = new Map<string, Entry>();

  enqueue(deliveries: readonly PendingDelivery[]): Promise<void> {
    for (const delivery of deliveries) {
      const id = crypto.randomUUID();
      this.entries.set(id, {
        id,
        delivery,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        claimedUntil: null,
        doneAt: null,
        error: null,
      });
    }
    return Promise.resolve();
  }

  claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedDelivery[]> {
    const due = [...this.entries.values()]
      .filter(
        (entry) =>
          (entry.status === 'pending' && entry.nextAttemptAt <= now) ||
          (entry.status === 'sending' && entry.claimedUntil !== null && entry.claimedUntil < now),
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    for (const entry of due) {
      entry.status = 'sending';
      entry.attempts += 1;
      entry.claimedUntil = new Date(now.getTime() + leaseMs);
    }
    return Promise.resolve(
      due.map((entry) => ({ ...entry.delivery, id: entry.id, attempts: entry.attempts })),
    );
  }

  markSent(id: string, at: Date): Promise<void> {
    this.finish(id, 'sent', at, null);
    return Promise.resolve();
  }

  markRetry(id: string, at: Date, error: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = 'pending';
      entry.nextAttemptAt = at;
      entry.claimedUntil = null;
      entry.error = error;
    }
    return Promise.resolve();
  }

  markFailed(id: string, error: string): Promise<void> {
    this.finish(id, 'failed', new Date(), error);
    return Promise.resolve();
  }

  purge(before: Date): Promise<number> {
    let removed = 0;
    for (const entry of [...this.entries.values()])
      if ((entry.status === 'sent' || entry.status === 'failed') && entry.doneAt! < before) {
        this.entries.delete(entry.id);
        removed += 1;
      }
    return Promise.resolve(removed);
  }

  /** What each delivery is up to, for tests and diagnostics. */
  snapshot(): { id: string; status: Status; attempts: number; error: string | null }[] {
    return [...this.entries.values()].map(({ id, status, attempts, error }) => ({
      id,
      status,
      attempts,
      error,
    }));
  }

  private finish(id: string, status: 'sent' | 'failed', at: Date, error: string | null): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = status;
    entry.claimedUntil = null;
    entry.doneAt = at;
    entry.error = error;
  }
}
