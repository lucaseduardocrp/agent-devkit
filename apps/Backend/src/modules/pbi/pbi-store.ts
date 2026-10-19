import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export type PbiKind = 'pbi' | 'card';
export interface PbiLink {
  id: string;
  providerId: string;
  externalId: string;
  externalUrl: string | null;
  boardId: string | null;
  syncedAt: Date;
}
export interface PbiItem {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: PbiKind;
  title: string;
  description: string;
  status: string;
  position: number;
  sourceData: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  links: PbiLink[];
}
export type PbiFields = Pick<PbiItem, 'kind' | 'title'> &
  Partial<Pick<PbiItem, 'parentId' | 'description' | 'status' | 'position' | 'sourceData'>>;
export type PbiChanges = Partial<Omit<PbiFields, 'kind'>>;
export interface PbiSearchOptions {
  externalId?: string;
  providerId?: string;
  iterationPath?: string;
  page: number;
  pageSize: number;
}
export interface PbiSearchResult {
  items: PbiItem[];
  total: number;
  page: number;
  pageSize: number;
}
export interface PbiStore {
  list(workspaceId: string): Promise<PbiItem[]>;
  search(workspaceId: string, options: PbiSearchOptions): Promise<PbiSearchResult>;
  get(workspaceId: string, id: string): Promise<PbiItem | null>;
  getMany(workspaceId: string, ids: readonly string[]): Promise<PbiItem[]>;
  listChildren(workspaceId: string, parentId: string): Promise<PbiItem[]>;
  create(workspaceId: string, fields: PbiFields): Promise<PbiItem>;
  update(
    workspaceId: string,
    id: string,
    fields: PbiChanges & { kind?: PbiKind },
  ): Promise<PbiItem | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  findByExternal(
    workspaceId: string,
    providerId: string,
    externalId: string,
  ): Promise<PbiItem | null>;
  link(workspaceId: string, id: string, fields: Omit<PbiLink, 'id' | 'syncedAt'>): Promise<PbiItem>;
}

export class InMemoryPbiStore implements PbiStore {
  private readonly items = new Map<string, PbiItem>();
  list(workspaceId: string): Promise<PbiItem[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter((item) => item.workspaceId === workspaceId)
        .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }
  async search(workspaceId: string, options: PbiSearchOptions): Promise<PbiSearchResult> {
    const matches = (await this.list(workspaceId)).filter(
      (item) =>
        (!options.externalId ||
          item.links.some(
            (link) =>
              link.externalId === options.externalId &&
              (!options.providerId || link.providerId === options.providerId),
          )) &&
        (!options.providerId ||
          options.externalId ||
          item.links.some((link) => link.providerId === options.providerId)) &&
        (!options.iterationPath ||
          (typeof item.sourceData.iterationPath === 'string' &&
            item.sourceData.iterationPath.includes(options.iterationPath))),
    );
    const offset = (options.page - 1) * options.pageSize;
    return {
      items: matches.slice(offset, offset + options.pageSize),
      total: matches.length,
      page: options.page,
      pageSize: options.pageSize,
    };
  }
  get(workspaceId: string, id: string): Promise<PbiItem | null> {
    const item = this.items.get(id);
    return Promise.resolve(item?.workspaceId === workspaceId ? item : null);
  }
  async getMany(workspaceId: string, ids: readonly string[]): Promise<PbiItem[]> {
    const wanted = new Set(ids);
    return (await this.list(workspaceId)).filter((item) => wanted.has(item.id));
  }
  async listChildren(workspaceId: string, parentId: string): Promise<PbiItem[]> {
    return (await this.list(workspaceId)).filter((item) => item.parentId === parentId);
  }
  create(workspaceId: string, fields: PbiFields): Promise<PbiItem> {
    const now = new Date();
    const item: PbiItem = {
      id: crypto.randomUUID(),
      workspaceId,
      parentId: fields.parentId ?? null,
      kind: fields.kind,
      title: fields.title,
      description: fields.description ?? '',
      status: fields.status ?? 'backlog',
      position: fields.position ?? now.getTime(),
      sourceData: fields.sourceData ?? {},
      createdAt: now,
      updatedAt: now,
      links: [],
    };
    this.items.set(item.id, item);
    return Promise.resolve(item);
  }
  async update(
    workspaceId: string,
    id: string,
    fields: PbiChanges & { kind?: PbiKind },
  ): Promise<PbiItem | null> {
    const old = await this.get(workspaceId, id);
    if (!old) return null;
    const item = { ...old, ...fields, updatedAt: new Date() };
    this.items.set(id, item);
    return item;
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    if (!(await this.get(workspaceId, id))) return false;
    for (const child of await this.list(workspaceId)) {
      if (child.parentId === id) await this.remove(workspaceId, child.id);
    }
    return this.items.delete(id);
  }
  async findByExternal(
    workspaceId: string,
    providerId: string,
    externalId: string,
  ): Promise<PbiItem | null> {
    return (
      (await this.list(workspaceId)).find((item) =>
        item.links.some((link) => link.providerId === providerId && link.externalId === externalId),
      ) ?? null
    );
  }
  async link(
    workspaceId: string,
    id: string,
    fields: Omit<PbiLink, 'id' | 'syncedAt'>,
  ): Promise<PbiItem> {
    const item = await this.get(workspaceId, id);
    if (!item) throw new Error('PBI item not found');
    const existing = item.links.find(
      (link) => link.providerId === fields.providerId && link.externalId === fields.externalId,
    );
    const link = { ...fields, id: existing?.id ?? crypto.randomUUID(), syncedAt: new Date() };
    const updated = {
      ...item,
      links: [...item.links.filter((current) => current.id !== link.id), link],
    };
    this.items.set(id, updated);
    return updated;
  }
}

type Row = Awaited<ReturnType<PrismaClient['pbiItemRecord']['findFirstOrThrow']>> & {
  links: Awaited<ReturnType<PrismaClient['pbiExternalLinkRecord']['findMany']>>;
};
function fromRow(row: Row): PbiItem {
  return {
    ...row,
    kind: row.kind as PbiKind,
    sourceData: row.sourceData as Record<string, unknown>,
    links: row.links.map(({ id, providerId, externalId, externalUrl, boardId, syncedAt }) => ({
      id,
      providerId,
      externalId,
      externalUrl,
      boardId,
      syncedAt,
    })),
  };
}
export class PrismaPbiStore implements PbiStore {
  constructor(private readonly prisma: PrismaClient) {}
  async search(workspaceId: string, options: PbiSearchOptions): Promise<PbiSearchResult> {
    const where: Prisma.PbiItemRecordWhereInput = {
      workspaceId,
      ...(options.externalId || options.providerId
        ? {
            links: {
              some: {
                ...(options.externalId ? { externalId: options.externalId } : {}),
                ...(options.providerId ? { providerId: options.providerId } : {}),
              },
            },
          }
        : {}),
      ...(options.iterationPath
        ? {
            sourceData: { path: ['iterationPath'], string_contains: options.iterationPath },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.pbiItemRecord.findMany({
        where,
        include: { links: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
      this.prisma.pbiItemRecord.count({ where }),
    ]);
    return { items: rows.map(fromRow), total, page: options.page, pageSize: options.pageSize };
  }
  async list(workspaceId: string): Promise<PbiItem[]> {
    const rows = await this.prisma.pbiItemRecord.findMany({
      where: { workspaceId },
      include: { links: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(fromRow);
  }
  async get(workspaceId: string, id: string): Promise<PbiItem | null> {
    const row = await this.prisma.pbiItemRecord.findFirst({
      where: { workspaceId, id },
      include: { links: true },
    });
    return row ? fromRow(row) : null;
  }
  async getMany(workspaceId: string, ids: readonly string[]): Promise<PbiItem[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.pbiItemRecord.findMany({
      where: { workspaceId, id: { in: [...ids] } },
      include: { links: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(fromRow);
  }
  async listChildren(workspaceId: string, parentId: string): Promise<PbiItem[]> {
    const rows = await this.prisma.pbiItemRecord.findMany({
      where: { workspaceId, parentId },
      include: { links: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(fromRow);
  }
  async create(workspaceId: string, fields: PbiFields): Promise<PbiItem> {
    const row = await this.prisma.pbiItemRecord.create({
      data: {
        workspaceId,
        parentId: fields.parentId ?? null,
        kind: fields.kind,
        title: fields.title,
        description: fields.description ?? '',
        status: fields.status ?? 'backlog',
        position: fields.position ?? Date.now(),
        sourceData: (fields.sourceData ?? {}) as Prisma.InputJsonValue,
      },
      include: { links: true },
    });
    return fromRow(row);
  }
  async update(
    workspaceId: string,
    id: string,
    fields: PbiChanges & { kind?: PbiKind },
  ): Promise<PbiItem | null> {
    if (!(await this.get(workspaceId, id))) return null;
    const row = await this.prisma.pbiItemRecord.update({
      where: { id },
      data: { ...fields, sourceData: fields.sourceData as Prisma.InputJsonValue | undefined },
      include: { links: true },
    });
    return fromRow(row);
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    return (await this.prisma.pbiItemRecord.deleteMany({ where: { workspaceId, id } })).count > 0;
  }
  async findByExternal(
    workspaceId: string,
    providerId: string,
    externalId: string,
  ): Promise<PbiItem | null> {
    const row = await this.prisma.pbiItemRecord.findFirst({
      where: { workspaceId, links: { some: { providerId, externalId } } },
      include: { links: true },
    });
    return row ? fromRow(row) : null;
  }
  async link(
    workspaceId: string,
    id: string,
    fields: Omit<PbiLink, 'id' | 'syncedAt'>,
  ): Promise<PbiItem> {
    await this.prisma.pbiExternalLinkRecord.upsert({
      where: {
        workspaceId_providerId_externalId: {
          workspaceId,
          providerId: fields.providerId,
          externalId: fields.externalId,
        },
      },
      create: { workspaceId, itemId: id, ...fields },
      update: { externalUrl: fields.externalUrl, boardId: fields.boardId, syncedAt: new Date() },
    });
    return (await this.get(workspaceId, id))!;
  }
}
