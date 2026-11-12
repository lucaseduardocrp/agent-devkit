import { randomUUID } from 'node:crypto';
import {
  InMemoryEventBus,
  type EventBus,
  type RealtimeEventType,
  type RealtimeListener,
} from './event-bus.js';

/** What the bus needs from a Postgres connection; `pg.Client` fits it. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
  on(event: 'notification', listener: (message: { payload?: string | undefined }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  end(): Promise<void>;
}

export interface PostgresEventBusOptions {
  readonly createClient: () => ListenClient;
  /**
   * The current data of what changed, read from the database. A notification is a pointer, not the
   * data: the payload of NOTIFY is limited to 8 KB and a run can be larger than that. Null when it no
   * longer exists.
   */
  readonly resolve: (workspaceId: string, type: RealtimeEventType, key: string) => Promise<unknown>;
  readonly channel?: string;
  /** First wait before reconnecting; it doubles up to `maxRetryMs`. */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

interface Notification {
  /** The process that published it, so it does not hear itself twice. */
  readonly o: string;
  readonly w: string;
  readonly t: RealtimeEventType;
  readonly k: string;
}

/**
 * An event bus shared by every API process that uses the same Postgres. Subscribers of this process
 * hear a change at once; the other processes learn about it through LISTEN/NOTIFY, read the current
 * data and hand it to their own subscribers. Needed as soon as two processes (two replicas, or a
 * local API next to the hosted one) work on the same database.
 */
export class PostgresEventBus implements EventBus {
  private readonly local = new InMemoryEventBus();
  private readonly instance = randomUUID();
  private readonly channel: string;
  private readonly chains = new Map<string, Promise<void>>();
  private client: ListenClient | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private retries = 0;

  constructor(private readonly options: PostgresEventBusOptions) {
    this.channel = options.channel ?? 'adk_realtime';
  }

  /** Starts listening. Resolves once connected; when the first attempt fails it keeps retrying. */
  async start(): Promise<void> {
    await this.connect();
  }

  publish<Data>(workspaceId: string, type: RealtimeEventType, data: Data, key?: string): void {
    this.local.publish(workspaceId, type, data);
    const client = this.client;
    if (!key || !client) return;
    const notification: Notification = { o: this.instance, w: workspaceId, t: type, k: key };
    void client
      .query('SELECT pg_notify($1, $2)', [this.channel, JSON.stringify(notification)])
      .catch((error: unknown) =>
        this.log('[EventBus] Could not notify the other processes:', error),
      );
  }

  subscribe(workspaceId: string, listener: RealtimeListener): () => void {
    return this.local.subscribe(workspaceId, listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private log(message: string, error?: unknown): void {
    (this.options.log ?? ((text, cause) => console.error(text, cause)))(message, error);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const client = this.options.createClient();
    let lost = false;
    const lose = (error?: unknown) => {
      if (lost) return;
      lost = true;
      if (this.client === client) this.client = null;
      if (error) this.log('[EventBus] Lost the connection to Postgres:', error);
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('notification', (message) => this.receive(message.payload));
    client.on('error', lose);
    client.on('end', () => lose());
    try {
      await client.connect();
      await client.query(`LISTEN ${this.channel}`);
      if (this.closed) {
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.retries = 0;
    } catch (error) {
      lose(error);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const first = this.options.retryMs ?? 1_000;
    const longest = this.options.maxRetryMs ?? 30_000;
    const wait = Math.min(longest, first * 2 ** this.retries);
    this.retries += 1;
    this.timer = setTimeout(() => void this.connect(), wait);
    this.timer.unref?.();
  }

  private receive(payload: string | undefined): void {
    let notification: Notification;
    try {
      notification = JSON.parse(payload ?? '') as Notification;
    } catch {
      return;
    }
    if (notification.o === this.instance) return;
    // One change after another of the same thing is delivered in order, so a slow read of an older
    // state can never overtake a newer one.
    const chainKey = `${notification.w}:${notification.t}:${notification.k}`;
    const next = (this.chains.get(chainKey) ?? Promise.resolve())
      .then(async () => {
        const data = await this.options.resolve(notification.w, notification.t, notification.k);
        if (data !== null) this.local.publish(notification.w, notification.t, data);
      })
      .catch((error: unknown) => this.log('[EventBus] Could not read a remote change:', error))
      .finally(() => {
        if (this.chains.get(chainKey) === next) this.chains.delete(chainKey);
      });
    this.chains.set(chainKey, next);
  }
}
