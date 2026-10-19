import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Link types between backlog items, named from the point of view of the item that owns the link
 * (as in Azure DevOps "Add link"). Parent/child live in the item hierarchy (`parentId`); the other
 * types are stored once in a canonical direction and read back as their inverse from the target.
 */
export const pbiLinkTypes = [
  'parent',
  'child',
  'related',
  'predecessor',
  'successor',
  'duplicate',
  'duplicate_of',
  'tests',
  'tested_by',
] as const;
export type PbiLinkType = (typeof pbiLinkTypes)[number];
export type StoredLinkType = 'related' | 'successor' | 'duplicate' | 'tested_by';
export const inverseLinkType: Record<PbiLinkType, PbiLinkType> = {
  parent: 'child',
  child: 'parent',
  related: 'related',
  predecessor: 'successor',
  successor: 'predecessor',
  duplicate: 'duplicate_of',
  duplicate_of: 'duplicate',
  tests: 'tested_by',
  tested_by: 'tests',
};
const storedTypes = new Set<PbiLinkType>(['related', 'successor', 'duplicate', 'tested_by']);

export interface PbiRelation {
  id: string;
  workspaceId: string;
  sourceId: string;
  targetId: string;
  type: StoredLinkType;
  createdBy: string | null;
  createdAt: Date;
}
export type RelationKey = Pick<PbiRelation, 'sourceId' | 'targetId' | 'type'>;

/** Converts "from has link `type` to `to`" into its stored form. */
export function canonicalRelation(
  fromId: string,
  type: Exclude<PbiLinkType, 'parent' | 'child'>,
  toId: string,
): RelationKey {
  if (type === 'related') {
    const [sourceId, targetId] = [fromId, toId].sort();
    return { sourceId: sourceId!, targetId: targetId!, type };
  }
  return storedTypes.has(type)
    ? { sourceId: fromId, targetId: toId, type: type as StoredLinkType }
    : { sourceId: toId, targetId: fromId, type: inverseLinkType[type] as StoredLinkType };
}
/** The link type as seen from `itemId`, one of the two ends of the relation. */
export function relationTypeFor(relation: RelationKey, itemId: string): PbiLinkType {
  return relation.sourceId === itemId ? relation.type : inverseLinkType[relation.type];
}

export interface PbiRelationStore {
  /** Relations where the item is either end. */
  list(workspaceId: string, itemId: string): Promise<PbiRelation[]>;
  add(workspaceId: string, relation: RelationKey, createdBy: string | null): Promise<PbiRelation>;
  remove(workspaceId: string, relation: RelationKey): Promise<boolean>;
}

const sameKey = (a: RelationKey, b: RelationKey) =>
  a.sourceId === b.sourceId && a.targetId === b.targetId && a.type === b.type;

export class InMemoryPbiRelationStore implements PbiRelationStore {
  private readonly relations: PbiRelation[] = [];
  list(workspaceId: string, itemId: string): Promise<PbiRelation[]> {
    return Promise.resolve(
      this.relations.filter(
        (relation) =>
          relation.workspaceId === workspaceId &&
          (relation.sourceId === itemId || relation.targetId === itemId),
      ),
    );
  }
  add(workspaceId: string, relation: RelationKey, createdBy: string | null): Promise<PbiRelation> {
    const existing = this.relations.find(
      (entry) => entry.workspaceId === workspaceId && sameKey(entry, relation),
    );
    if (existing) return Promise.resolve(existing);
    const created: PbiRelation = {
      ...relation,
      id: crypto.randomUUID(),
      workspaceId,
      createdBy,
      createdAt: new Date(),
    };
    this.relations.push(created);
    return Promise.resolve(created);
  }
  remove(workspaceId: string, relation: RelationKey): Promise<boolean> {
    const index = this.relations.findIndex(
      (entry) => entry.workspaceId === workspaceId && sameKey(entry, relation),
    );
    if (index < 0) return Promise.resolve(false);
    this.relations.splice(index, 1);
    return Promise.resolve(true);
  }
}

export class PrismaPbiRelationStore implements PbiRelationStore {
  constructor(private readonly prisma: PrismaClient) {}
  async list(workspaceId: string, itemId: string): Promise<PbiRelation[]> {
    return (await this.prisma.pbiRelationRecord.findMany({
      where: { workspaceId, OR: [{ sourceId: itemId }, { targetId: itemId }] },
      orderBy: { createdAt: 'asc' },
    })) as PbiRelation[];
  }
  async add(
    workspaceId: string,
    relation: RelationKey,
    createdBy: string | null,
  ): Promise<PbiRelation> {
    return (await this.prisma.pbiRelationRecord.upsert({
      where: { sourceId_targetId_type: relation },
      create: { workspaceId, ...relation, createdBy },
      update: {},
    })) as PbiRelation;
  }
  async remove(workspaceId: string, relation: RelationKey): Promise<boolean> {
    return (
      (await this.prisma.pbiRelationRecord.deleteMany({ where: { workspaceId, ...relation } }))
        .count > 0
    );
  }
}
