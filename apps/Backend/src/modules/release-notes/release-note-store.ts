import type { PrismaClient } from '../../generated/prisma/client.js';

export interface ReleaseNote {
  id: string;
  workspaceId: string;
  title: string;
  version: string;
  content: string;
  agentId: string | null;
  itemIds: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export type ReleaseNoteFields = Pick<ReleaseNote, 'title'> &
  Partial<Pick<ReleaseNote, 'version' | 'content' | 'agentId' | 'itemIds' | 'createdBy'>>;
export type ReleaseNoteChanges = Partial<
  Pick<ReleaseNote, 'title' | 'version' | 'content' | 'itemIds'>
>;

export interface ReleaseNoteStore {
  list(workspaceId: string): Promise<ReleaseNote[]>;
  get(workspaceId: string, id: string): Promise<ReleaseNote | null>;
  create(workspaceId: string, fields: ReleaseNoteFields): Promise<ReleaseNote>;
  update(workspaceId: string, id: string, changes: ReleaseNoteChanges): Promise<ReleaseNote | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

const newest = (a: ReleaseNote, b: ReleaseNote) => b.updatedAt.getTime() - a.updatedAt.getTime();

export class InMemoryReleaseNoteStore implements ReleaseNoteStore {
  private readonly notes = new Map<string, ReleaseNote>();
  list(workspaceId: string): Promise<ReleaseNote[]> {
    return Promise.resolve(
      [...this.notes.values()].filter((note) => note.workspaceId === workspaceId).sort(newest),
    );
  }
  get(workspaceId: string, id: string): Promise<ReleaseNote | null> {
    const note = this.notes.get(id);
    return Promise.resolve(note?.workspaceId === workspaceId ? note : null);
  }
  create(workspaceId: string, fields: ReleaseNoteFields): Promise<ReleaseNote> {
    const now = new Date();
    const note: ReleaseNote = {
      id: crypto.randomUUID(),
      workspaceId,
      title: fields.title,
      version: fields.version ?? '',
      content: fields.content ?? '',
      agentId: fields.agentId ?? null,
      itemIds: fields.itemIds ?? [],
      createdBy: fields.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.notes.set(note.id, note);
    return Promise.resolve(note);
  }
  async update(
    workspaceId: string,
    id: string,
    changes: ReleaseNoteChanges,
  ): Promise<ReleaseNote | null> {
    const note = await this.get(workspaceId, id);
    if (!note) return null;
    const updated = { ...note, ...changes, updatedAt: new Date() };
    this.notes.set(id, updated);
    return updated;
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    return Boolean(await this.get(workspaceId, id)) && this.notes.delete(id);
  }
}

type Row = Awaited<ReturnType<PrismaClient['releaseNoteRecord']['findFirstOrThrow']>>;
function fromRow(row: Row): ReleaseNote {
  return {
    ...row,
    itemIds: Array.isArray(row.itemIds)
      ? row.itemIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export class PrismaReleaseNoteStore implements ReleaseNoteStore {
  constructor(private readonly prisma: PrismaClient) {}
  async list(workspaceId: string): Promise<ReleaseNote[]> {
    const rows = await this.prisma.releaseNoteRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(fromRow);
  }
  async get(workspaceId: string, id: string): Promise<ReleaseNote | null> {
    const row = await this.prisma.releaseNoteRecord.findFirst({ where: { workspaceId, id } });
    return row ? fromRow(row) : null;
  }
  async create(workspaceId: string, fields: ReleaseNoteFields): Promise<ReleaseNote> {
    const row = await this.prisma.releaseNoteRecord.create({
      data: {
        workspaceId,
        title: fields.title,
        version: fields.version ?? '',
        content: fields.content ?? '',
        agentId: fields.agentId ?? null,
        itemIds: fields.itemIds ?? [],
        createdBy: fields.createdBy ?? null,
      },
    });
    return fromRow(row);
  }
  async update(
    workspaceId: string,
    id: string,
    changes: ReleaseNoteChanges,
  ): Promise<ReleaseNote | null> {
    const result = await this.prisma.releaseNoteRecord.updateMany({
      where: { workspaceId, id },
      data: changes,
    });
    return result.count ? this.get(workspaceId, id) : null;
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    return (
      (await this.prisma.releaseNoteRecord.deleteMany({ where: { workspaceId, id } })).count > 0
    );
  }
}
