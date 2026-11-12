/**
 * Live updates of a workspace. The bus carries what changed to every open stream of that
 * workspace; it is not a log. A client that (re)connects loads the current state and then applies
 * the events that follow, so nothing is stored or replayed here.
 */

export type RealtimeEventType = 'run' | 'development';

export interface RealtimeEvent<Data = unknown> {
  readonly type: RealtimeEventType;
  readonly workspaceId: string;
  readonly data: Data;
  readonly at: string;
}

export type RealtimeListener = (event: RealtimeEvent) => void;

export interface EventBus {
  /**
   * Hands the event to every current subscriber of the workspace. Never throws or blocks. `key`
   * identifies what changed (e.g. a run id), for buses that tell other processes about it.
   */
  publish<Data>(workspaceId: string, type: RealtimeEventType, data: Data, key?: string): void;
  /** Returns the function that stops the subscription. */
  subscribe(workspaceId: string, listener: RealtimeListener): () => void;
}

/**
 * Subscribers of one process. A deployment with several API replicas needs a bus that reaches the
 * other replicas too (e.g. Postgres LISTEN/NOTIFY); it only has to implement `EventBus`.
 */
export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<RealtimeListener>>();

  publish<Data>(workspaceId: string, type: RealtimeEventType, data: Data, _key?: string): void {
    const event: RealtimeEvent<Data> = { type, workspaceId, data, at: new Date().toISOString() };
    for (const listener of [...(this.listeners.get(workspaceId) ?? [])]) {
      // A broken subscriber (a closed socket) must not stop the others or the caller.
      try {
        listener(event);
      } catch (error) {
        console.error('[EventBus] Subscriber failed:', error);
      }
    }
  }

  subscribe(workspaceId: string, listener: RealtimeListener): () => void {
    const set = this.listeners.get(workspaceId) ?? new Set<RealtimeListener>();
    set.add(listener);
    this.listeners.set(workspaceId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(workspaceId);
    };
  }

  /** Open subscriptions of a workspace, for diagnostics and tests. */
  subscriberCount(workspaceId: string): number {
    return this.listeners.get(workspaceId)?.size ?? 0;
  }
}
