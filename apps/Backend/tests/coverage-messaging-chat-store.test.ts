import { describe, expect, it } from 'vitest';
import {
  InMemoryMessagingChatStore,
  PrismaMessagingChatStore,
  type PrismaMessagingChatsClient,
} from '../src/modules/messaging/application/messaging-chat-store.js';

const base = {
  workspaceId: 'w1',
  provider: 'telegram' as const,
  chatId: 'c1',
  userId: 'u1',
  displayName: 'Ann',
  linkedBy: 'm1',
};

describe('InMemoryMessagingChatStore', () => {
  it('links, lists, finds, updates and removes chats per workspace', async () => {
    const store = new InMemoryMessagingChatStore();
    const chat = await store.link(base);
    expect(chat.notifications).toBe(true);
    expect(chat.agentId).toBeNull();

    const again = await store.link({ ...base, linkedBy: 'm2' });
    expect(again.id).toBe(chat.id);
    expect(again.linkedBy).toBe('m2');
    await store.link({ ...base, workspaceId: 'w2' });

    expect(await store.list('w1', 'telegram')).toHaveLength(1);
    expect((await store.find('w1', 'telegram', 'c1'))?.id).toBe(chat.id);
    expect(await store.find('w1', 'telegram', 'nope')).toBeNull();

    expect(await store.update('other', chat.id, { agentId: 'a' })).toBeNull();
    expect(await store.update('w1', 'missing', { agentId: 'a' })).toBeNull();
    const updated = await store.update('w1', chat.id, { agentId: 'a', notifications: false });
    expect(updated).toMatchObject({ agentId: 'a', notifications: false });

    expect(await store.remove('other', chat.id)).toBe(false);
    expect(await store.remove('w1', chat.id)).toBe(true);
    expect(await store.remove('w1', chat.id)).toBe(false);
  });
});

describe('PrismaMessagingChatStore', () => {
  const now = new Date();
  const row = {
    ...base,
    id: 'r1',
    agentId: null,
    notifications: true,
    createdAt: now,
    updatedAt: now,
  };

  function makeClient(overrides: Partial<PrismaMessagingChatsClient['messagingChatRecord']> = {}) {
    const calls: unknown[] = [];
    const client: PrismaMessagingChatsClient = {
      messagingChatRecord: {
        findMany: (a) => (calls.push(['findMany', a]), Promise.resolve([row])),
        findFirst: (a) => (calls.push(['findFirst', a]), Promise.resolve(row)),
        upsert: (a) => (calls.push(['upsert', a]), Promise.resolve(row)),
        updateMany: (a) => (calls.push(['updateMany', a]), Promise.resolve({ count: 1 })),
        deleteMany: (a) => (calls.push(['deleteMany', a]), Promise.resolve({ count: 1 })),
        ...overrides,
      },
    };
    return { client, calls };
  }

  it('maps rows for list, find and link', async () => {
    const { client, calls } = makeClient();
    const store = new PrismaMessagingChatStore(client);
    expect(await store.list('w1', 'telegram')).toEqual([row]);
    expect(await store.find('w1', 'telegram', 'c1')).toEqual(row);
    expect(await store.link(base)).toEqual(row);
    expect(calls).toContainEqual([
      'upsert',
      expect.objectContaining({
        update: { userId: 'u1', displayName: 'Ann', linkedBy: 'm1' },
      }),
    ]);
  });

  it('returns null from find when no row exists', async () => {
    const { client } = makeClient({ findFirst: () => Promise.resolve(null) });
    expect(await new PrismaMessagingChatStore(client).find('w1', 'telegram', 'x')).toBeNull();
  });

  it('updates and handles missing rows', async () => {
    const store = new PrismaMessagingChatStore(makeClient().client);
    expect(await store.update('w1', 'r1', { agentId: 'a' })).toEqual(row);

    const none = new PrismaMessagingChatStore(
      makeClient({ updateMany: () => Promise.resolve({ count: 0 }) }).client,
    );
    expect(await none.update('w1', 'r1', {})).toBeNull();

    const vanished = new PrismaMessagingChatStore(
      makeClient({ findFirst: () => Promise.resolve(null) }).client,
    );
    expect(await vanished.update('w1', 'r1', {})).toBeNull();
  });

  it('reports whether remove deleted anything', async () => {
    expect(await new PrismaMessagingChatStore(makeClient().client).remove('w1', 'r1')).toBe(true);
    const none = new PrismaMessagingChatStore(
      makeClient({ deleteMany: () => Promise.resolve({ count: 0 }) }).client,
    );
    expect(await none.remove('w1', 'r1')).toBe(false);
  });
});
