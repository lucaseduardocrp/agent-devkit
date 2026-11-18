import type { EventBus } from '../realtime/event-bus.js';
import type { ChangeBody, DevChange, DevSession, SessionBody } from './development.js';
import type { DevelopmentStore } from './development-store.js';

/**
 * What a Development stream sends: which change or session moved, not its content. A session can
 * hold a whole diff, so the client reads the current one by id; a removed item answers 404 there.
 */
export interface DevelopmentEventPayload {
  readonly kind: 'change' | 'session';
  readonly id: string;
  readonly deleted?: boolean;
}

/** The bus key of an item, which is all the other API processes need to tell their own streams. */
export const developmentEventKey = (kind: DevelopmentEventPayload['kind'], id: string): string =>
  `${kind}:${id}`;

/** The payload for a bus key; null for a key that is not one of ours. */
export function developmentEventFromKey(key: string): DevelopmentEventPayload | null {
  const [kind, ...rest] = key.split(':');
  const id = rest.join(':');
  return (kind === 'change' || kind === 'session') && id ? { kind, id } : null;
}

/**
 * A store that tells the workspace whenever a change or a session is written, so every open
 * Development screen follows the work of the agents as it happens.
 */
export class EventingDevelopmentStore implements DevelopmentStore {
  constructor(
    private readonly inner: DevelopmentStore,
    private readonly bus: EventBus,
  ) {}

  private announce<Item extends { id: string; workspaceId: string }>(
    kind: DevelopmentEventPayload['kind'],
    item: Item | null,
  ): Item | null {
    if (item)
      this.bus.publish<DevelopmentEventPayload>(
        item.workspaceId,
        'development',
        { kind, id: item.id },
        developmentEventKey(kind, item.id),
      );
    return item;
  }

  private async announceRemoval(
    kind: DevelopmentEventPayload['kind'],
    workspaceId: string,
    id: string,
    removed: Promise<boolean>,
  ): Promise<boolean> {
    const done = await removed;
    if (done)
      this.bus.publish<DevelopmentEventPayload>(
        workspaceId,
        'development',
        { kind, id, deleted: true },
        developmentEventKey(kind, id),
      );
    return done;
  }

  listChanges: DevelopmentStore['listChanges'] = (workspaceId) =>
    this.inner.listChanges(workspaceId);
  getChange: DevelopmentStore['getChange'] = (workspaceId, id) =>
    this.inner.getChange(workspaceId, id);
  listSessions: DevelopmentStore['listSessions'] = (workspaceId) =>
    this.inner.listSessions(workspaceId);
  getSession: DevelopmentStore['getSession'] = (workspaceId, id) =>
    this.inner.getSession(workspaceId, id);

  createChange = async (workspaceId: string, body: ChangeBody): Promise<DevChange> =>
    this.announce('change', await this.inner.createChange(workspaceId, body))!;
  updateChange = async (workspaceId: string, id: string, body: ChangeBody) =>
    this.announce('change', await this.inner.updateChange(workspaceId, id, body));
  removeChange = (workspaceId: string, id: string) =>
    this.announceRemoval('change', workspaceId, id, this.inner.removeChange(workspaceId, id));
  createSession = async (workspaceId: string, body: SessionBody): Promise<DevSession> =>
    this.announce('session', await this.inner.createSession(workspaceId, body))!;
  updateSession = async (workspaceId: string, id: string, body: SessionBody) =>
    this.announce('session', await this.inner.updateSession(workspaceId, id, body));
  removeSession = (workspaceId: string, id: string) =>
    this.announceRemoval('session', workspaceId, id, this.inner.removeSession(workspaceId, id));
}
