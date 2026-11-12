import { randomUUID } from 'node:crypto';

export type MessagingProvider = 'telegram';

/** A chat paired with a workspace's bot: the allowlist of who may talk to its agents. */
export interface MessagingChat {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: MessagingProvider;
  readonly chatId: string;
  readonly userId: string;
  readonly displayName: string;
  /** The member who generated the pairing code; agent runs from the chat act as them. */
  readonly linkedBy: string;
  readonly agentId: string | null;
  readonly notifications: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewMessagingChat {
  readonly workspaceId: string;
  readonly provider: MessagingProvider;
  readonly chatId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly linkedBy: string;
}

export type MessagingChatPatch = Partial<Pick<MessagingChat, 'agentId' | 'notifications'>>;

export interface MessagingChatStore {
  list(workspaceId: string, provider: MessagingProvider): Promise<MessagingChat[]>;
  find(
    workspaceId: string,
    provider: MessagingProvider,
    chatId: string,
  ): Promise<MessagingChat | null>;
  /** Pairs the chat again when it already is (a new code replaces who linked it). */
  link(chat: NewMessagingChat): Promise<MessagingChat>;
  update(workspaceId: string, id: string, patch: MessagingChatPatch): Promise<MessagingChat | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export class InMemoryMessagingChatStore implements MessagingChatStore {
  private readonly chats = new Map<string, MessagingChat>();

  list(workspaceId: string, provider: MessagingProvider) {
    return Promise.resolve(
      [...this.chats.values()].filter(
        (chat) => chat.workspaceId === workspaceId && chat.provider === provider,
      ),
    );
  }

  find(workspaceId: string, provider: MessagingProvider, chatId: string) {
    return Promise.resolve(
      [...this.chats.values()].find(
        (chat) =>
          chat.workspaceId === workspaceId && chat.provider === provider && chat.chatId === chatId,
      ) ?? null,
    );
  }

  async link(input: NewMessagingChat) {
    const existing = await this.find(input.workspaceId, input.provider, input.chatId);
    const now = new Date();
    const chat: MessagingChat = existing
      ? { ...existing, ...input, updatedAt: now }
      : {
          ...input,
          id: randomUUID(),
          agentId: null,
          notifications: true,
          createdAt: now,
          updatedAt: now,
        };
    this.chats.set(chat.id, chat);
    return chat;
  }

  update(workspaceId: string, id: string, patch: MessagingChatPatch) {
    const chat = this.chats.get(id);
    if (chat?.workspaceId !== workspaceId) return Promise.resolve(null);
    const next = { ...chat, ...patch, updatedAt: new Date() };
    this.chats.set(id, next);
    return Promise.resolve(next);
  }

  remove(workspaceId: string, id: string) {
    if (this.chats.get(id)?.workspaceId !== workspaceId) return Promise.resolve(false);
    return Promise.resolve(this.chats.delete(id));
  }
}

interface ChatRow {
  id: string;
  workspaceId: string;
  provider: string;
  chatId: string;
  userId: string;
  displayName: string;
  linkedBy: string;
  agentId: string | null;
  notifications: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The Prisma delegate the store needs, so tests can pass a fake. */
export interface PrismaMessagingChatsClient {
  readonly messagingChatRecord: {
    findMany(args: { where: { workspaceId: string; provider: string } }): Promise<ChatRow[]>;
    findFirst(args: {
      where: { workspaceId: string; provider?: string; chatId?: string; id?: string };
    }): Promise<ChatRow | null>;
    upsert(args: {
      where: {
        workspaceId_provider_chatId: { workspaceId: string; provider: string; chatId: string };
      };
      create: NewMessagingChat;
      update: Pick<NewMessagingChat, 'userId' | 'displayName' | 'linkedBy'>;
    }): Promise<ChatRow>;
    updateMany(args: {
      where: { id: string; workspaceId: string };
      data: MessagingChatPatch;
    }): Promise<{ count: number }>;
    deleteMany(args: { where: { id: string; workspaceId: string } }): Promise<{ count: number }>;
  };
}

export class PrismaMessagingChatStore implements MessagingChatStore {
  constructor(private readonly client: PrismaMessagingChatsClient) {}

  async list(workspaceId: string, provider: MessagingProvider) {
    const rows = await this.client.messagingChatRecord.findMany({
      where: { workspaceId, provider },
    });
    return rows.map(toChat);
  }

  async find(workspaceId: string, provider: MessagingProvider, chatId: string) {
    const row = await this.client.messagingChatRecord.findFirst({
      where: { workspaceId, provider, chatId },
    });
    return row ? toChat(row) : null;
  }

  async link(input: NewMessagingChat) {
    const row = await this.client.messagingChatRecord.upsert({
      where: {
        workspaceId_provider_chatId: {
          workspaceId: input.workspaceId,
          provider: input.provider,
          chatId: input.chatId,
        },
      },
      create: input,
      update: { userId: input.userId, displayName: input.displayName, linkedBy: input.linkedBy },
    });
    return toChat(row);
  }

  async update(workspaceId: string, id: string, patch: MessagingChatPatch) {
    const { count } = await this.client.messagingChatRecord.updateMany({
      where: { id, workspaceId },
      data: patch,
    });
    if (!count) return null;
    const row = await this.client.messagingChatRecord.findFirst({ where: { id, workspaceId } });
    return row ? toChat(row) : null;
  }

  async remove(workspaceId: string, id: string) {
    const { count } = await this.client.messagingChatRecord.deleteMany({
      where: { id, workspaceId },
    });
    return count > 0;
  }
}

function toChat(row: ChatRow): MessagingChat {
  return { ...row, provider: row.provider as MessagingProvider };
}
