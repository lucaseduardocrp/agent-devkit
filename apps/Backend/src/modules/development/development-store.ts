import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { ChangeBody, DevChange, DevSession, SessionBody } from './development.js';

export interface DevelopmentStore {
  listChanges(workspaceId: string): Promise<DevChange[]>;
  getChange(workspaceId: string, id: string): Promise<DevChange | null>;
  createChange(workspaceId: string, body: ChangeBody): Promise<DevChange>;
  updateChange(workspaceId: string, id: string, body: ChangeBody): Promise<DevChange | null>;
  removeChange(workspaceId: string, id: string): Promise<boolean>;
  listSessions(workspaceId: string): Promise<DevSession[]>;
  getSession(workspaceId: string, id: string): Promise<DevSession | null>;
  createSession(workspaceId: string, body: SessionBody): Promise<DevSession>;
  updateSession(workspaceId: string, id: string, body: SessionBody): Promise<DevSession | null>;
  removeSession(workspaceId: string, id: string): Promise<boolean>;
}

interface Stored {
  id: string;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One workspace-scoped collection kept in memory; newest first, like the database store. */
class MemoryCollection<Body extends object> {
  private readonly items = new Map<string, Body & Stored>();
  list(workspaceId: string): Promise<(Body & Stored)[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter((item) => item.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    );
  }
  get(workspaceId: string, id: string): Promise<(Body & Stored) | null> {
    const item = this.items.get(id);
    return Promise.resolve(item?.workspaceId === workspaceId ? item : null);
  }
  create(workspaceId: string, body: Body): Promise<Body & Stored> {
    const now = new Date();
    const item = { ...body, id: crypto.randomUUID(), workspaceId, createdAt: now, updatedAt: now };
    this.items.set(item.id, item);
    return Promise.resolve(item);
  }
  async update(workspaceId: string, id: string, body: Body): Promise<(Body & Stored) | null> {
    const item = await this.get(workspaceId, id);
    if (!item) return null;
    const updated = { ...item, ...body, updatedAt: new Date() };
    this.items.set(id, updated);
    return updated;
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    return Boolean(await this.get(workspaceId, id)) && this.items.delete(id);
  }
}

export class InMemoryDevelopmentStore implements DevelopmentStore {
  private readonly changes = new MemoryCollection<ChangeBody>();
  private readonly sessions = new MemoryCollection<SessionBody>();
  listChanges = (workspaceId: string) => this.changes.list(workspaceId);
  getChange = (workspaceId: string, id: string) => this.changes.get(workspaceId, id);
  createChange = (workspaceId: string, body: ChangeBody) => this.changes.create(workspaceId, body);
  updateChange = (workspaceId: string, id: string, body: ChangeBody) =>
    this.changes.update(workspaceId, id, body);
  removeChange = (workspaceId: string, id: string) => this.changes.remove(workspaceId, id);
  listSessions = (workspaceId: string) => this.sessions.list(workspaceId);
  getSession = (workspaceId: string, id: string) => this.sessions.get(workspaceId, id);
  createSession = (workspaceId: string, body: SessionBody) =>
    this.sessions.create(workspaceId, body);
  updateSession = (workspaceId: string, id: string, body: SessionBody) =>
    this.sessions.update(workspaceId, id, body);
  removeSession = (workspaceId: string, id: string) => this.sessions.remove(workspaceId, id);
}

type ChangeRow = Awaited<ReturnType<PrismaClient['developmentChangeRecord']['findFirstOrThrow']>>;
type SessionRow = Awaited<ReturnType<PrismaClient['developmentSessionRecord']['findFirstOrThrow']>>;

const json = (value: object) => value as unknown as Prisma.InputJsonValue;

// The columns repeat what lists and filters need; `data` holds the whole body.
function changeFromRow(row: ChangeRow): DevChange {
  return {
    ...(row.data as unknown as ChangeBody),
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    title: row.title,
    status: row.status as DevChange['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function sessionFromRow(row: SessionRow): DevSession {
  return {
    ...(row.data as unknown as SessionBody),
    // Sessions saved before links existed have neither.
    pbiItemId: (row.data as Partial<SessionBody>).pbiItemId ?? null,
    issueId: (row.data as Partial<SessionBody>).issueId ?? null,
    id: row.id,
    workspaceId: row.workspaceId,
    changeId: row.changeId,
    title: row.title,
    status: row.status as DevSession['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
const changeColumns = (body: ChangeBody) => ({
  slug: body.slug,
  title: body.title,
  status: body.status,
  data: json(body),
});
const sessionColumns = (body: SessionBody) => ({
  changeId: body.changeId,
  title: body.title,
  status: body.status,
  data: json(body),
});

export class PrismaDevelopmentStore implements DevelopmentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listChanges(workspaceId: string): Promise<DevChange[]> {
    const rows = await this.prisma.developmentChangeRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(changeFromRow);
  }
  async getChange(workspaceId: string, id: string): Promise<DevChange | null> {
    const row = await this.prisma.developmentChangeRecord.findFirst({ where: { workspaceId, id } });
    return row ? changeFromRow(row) : null;
  }
  async createChange(workspaceId: string, body: ChangeBody): Promise<DevChange> {
    return changeFromRow(
      await this.prisma.developmentChangeRecord.create({
        data: { workspaceId, ...changeColumns(body) },
      }),
    );
  }
  async updateChange(workspaceId: string, id: string, body: ChangeBody): Promise<DevChange | null> {
    const result = await this.prisma.developmentChangeRecord.updateMany({
      where: { workspaceId, id },
      data: changeColumns(body),
    });
    return result.count ? this.getChange(workspaceId, id) : null;
  }
  async removeChange(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.prisma.developmentChangeRecord.deleteMany({
      where: { workspaceId, id },
    });
    return result.count > 0;
  }

  async listSessions(workspaceId: string): Promise<DevSession[]> {
    const rows = await this.prisma.developmentSessionRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(sessionFromRow);
  }
  async getSession(workspaceId: string, id: string): Promise<DevSession | null> {
    const row = await this.prisma.developmentSessionRecord.findFirst({
      where: { workspaceId, id },
    });
    return row ? sessionFromRow(row) : null;
  }
  async createSession(workspaceId: string, body: SessionBody): Promise<DevSession> {
    return sessionFromRow(
      await this.prisma.developmentSessionRecord.create({
        data: { workspaceId, ...sessionColumns(body) },
      }),
    );
  }
  async updateSession(
    workspaceId: string,
    id: string,
    body: SessionBody,
  ): Promise<DevSession | null> {
    const result = await this.prisma.developmentSessionRecord.updateMany({
      where: { workspaceId, id },
      data: sessionColumns(body),
    });
    return result.count ? this.getSession(workspaceId, id) : null;
  }
  async removeSession(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.prisma.developmentSessionRecord.deleteMany({
      where: { workspaceId, id },
    });
    return result.count > 0;
  }
}
