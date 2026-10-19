import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../shared/context.js';
import type { KnowledgeChunkRepository } from '../knowledge/application/knowledge-provider.js';
import type { SpecRepository } from '../spec/application/spec-service.js';
import type { SavedTestPlanStore } from '../testplans/application/saved-test-plans.js';
import { ApplicationError } from '../../shared/errors.js';

export type EntityType =
  | 'document'
  | 'specification'
  | 'template'
  | 'testplan'
  /** Derived from testplan events; never stored. */
  | 'testcase'
  | 'pbi'
  | 'issue'
  | 'release_note';
export type AuditAction = 'create' | 'update' | 'delete' | 'comment';
export interface AuditEvent {
  id: string;
  workspaceId: string;
  entityType: EntityType;
  entityId: string;
  action: AuditAction;
  actorId: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  requestId: string;
  operation: string;
  occurredAt: string;
  before: unknown;
  after: unknown;
}
export interface AuditQuery {
  workspaceId: string;
  entityType: EntityType;
  entityId?: string;
  offset: number;
  limit: number;
}
export interface AuditRepositories {
  knowledge: KnowledgeChunkRepository;
  specs: SpecRepository;
  tests: SavedTestPlanStore;
}
export interface AuditUnit extends AuditRepositories {
  append(events: AuditEvent[]): Promise<void>;
  deleteWorkspace?(id: string): Promise<void>;
}
export interface AuditPersistence {
  run<T>(workspaceId: string, work: (unit: AuditUnit) => Promise<T>): Promise<T>;
  list(query: AuditQuery): Promise<{ items: AuditEvent[]; total: number }>;
}
export const auditRequest = new AsyncLocalStorage<{
  context: () => RequestContext | undefined;
  operation: string;
}>();
type Snapshot = { type: EntityType; id: string; value: unknown };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function documentHistoryIds(
  events: readonly Pick<AuditEvent, 'entityId' | 'action' | 'before' | 'after'>[],
  entityId: string,
): string[] {
  const identity = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const page = value as { source?: unknown; pageId?: unknown };
    return typeof page.source === 'string' && typeof page.pageId === 'string'
      ? JSON.stringify([page.source, page.pageId])
      : undefined;
  };
  const edges = events
    .filter((event) => event.action === 'update')
    .map((event) => [identity(event.before), identity(event.after)] as const);
  const ids = new Set([entityId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [before, after] of edges) {
      if (!before || !after || (!ids.has(before) && !ids.has(after))) continue;
      for (const id of [before, after])
        if (!ids.has(id)) {
          ids.add(id);
          changed = true;
        }
    }
  }
  return [...ids];
}

function testCaseSnapshot(plan: unknown, caseId: string): Record<string, unknown> | null {
  const cases = plan && typeof plan === 'object' ? (plan as { plans?: unknown }).plans : undefined;
  if (!Array.isArray(cases)) return null;
  const index = cases.findIndex(
    (item: unknown) =>
      Boolean(item) &&
      typeof item === 'object' &&
      (item as { metadata?: { caseId?: unknown } }).metadata?.caseId === caseId,
  );
  if (index < 0) return null;
  // Metadata only holds the identifier and derived formatting. The position is left out so
  // removing an earlier case does not show as a change of every later one.
  const { metadata: _metadata, ...value } = cases[index] as Record<string, unknown>;
  return value;
}

/**
 * Derives the history of one test case from the events of its test plan, which store the
 * whole plan. Events that did not change the case are skipped. Expects newest first.
 */
export function testCaseHistory(planEvents: readonly AuditEvent[], caseId: string): AuditEvent[] {
  return planEvents.flatMap((event) => {
    const before = testCaseSnapshot(event.before, caseId);
    const after = testCaseSnapshot(event.after, caseId);
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    return [
      {
        ...event,
        entityType: 'testcase' as const,
        entityId: `${event.entityId}:${caseId}`,
        action: !before ? 'create' : !after ? 'delete' : 'update',
        before,
        after,
      },
    ];
  });
}

export async function auditWorkspaceDeletion(
  persistence: AuditPersistence,
  workspaceId: string,
  fallback: () => Promise<void>,
): Promise<void> {
  const request = auditRequest.getStore();
  const context = request?.context();
  await persistence.run(workspaceId, async (unit) => {
    const before = clone([
      ...(await snapshots(unit, 'knowledge', workspaceId)),
      ...(await snapshots(unit, 'specs', workspaceId)),
      ...(await snapshots(unit, 'tests', workspaceId)),
    ]);
    const deletionEvents = before.map((entity) => ({
      id: randomUUID(),
      workspaceId,
      entityType: entity.type,
      entityId: entity.id,
      action: 'delete' as const,
      actorId: context?.actorId ?? null,
      actorName: context?.actorName ?? null,
      actorEmail: context?.actorEmail ?? null,
      requestId: context?.requestId ?? 'system',
      operation: request?.operation ?? 'deleteWorkspace',
      occurredAt: new Date().toISOString(),
      before: entity.value,
      after: null,
    }));
    await unit.append(deletionEvents);
    if (unit.deleteWorkspace) await unit.deleteWorkspace(workspaceId);
    else {
      for (const snapshot of before) {
        if (snapshot.type === 'document') {
          const page = snapshot.value as { pageId: string; source: string };
          await unit.knowledge.deletePage(
            { id: page.pageId, source: page.source },
            { ownerId: workspaceId, requestId: context?.requestId ?? 'system' },
          );
        } else if (snapshot.type === 'specification')
          await unit.specs.deleteSpecification(snapshot.id, workspaceId);
        else if (snapshot.type === 'template')
          await unit.specs.deleteTemplate(snapshot.id, workspaceId);
        else await unit.tests.delete(snapshot.id, workspaceId);
      }
      await fallback();
    }
  });
}

export class MemoryAuditPersistence implements AuditPersistence {
  private events: AuditEvent[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  public constructor(private readonly repositories: AuditRepositories) {}
  public run<T>(_workspaceId: string, work: (unit: AuditUnit) => Promise<T>): Promise<T> {
    const result = this.pending.then(() =>
      work({
        ...this.repositories,
        append: (events) => {
          this.events.push(...clone(events));
          return Promise.resolve();
        },
      }),
    );
    this.pending = result.catch(() => undefined);
    return result;
  }
  public list(query: AuditQuery) {
    const scoped = this.events.filter(
      (e) => e.workspaceId === query.workspaceId && e.entityType === query.entityType,
    );
    const ids =
      query.entityId && query.entityType === 'document'
        ? documentHistoryIds(scoped, query.entityId)
        : [query.entityId];
    const matches = scoped.filter((e) => !query.entityId || ids.includes(e.entityId)).reverse();
    return Promise.resolve({
      items: clone(matches.slice(query.offset, query.offset + query.limit)),
      total: matches.length,
    });
  }
}

async function snapshots(
  unit: AuditUnit,
  family: 'knowledge' | 'specs' | 'tests',
  workspaceId: string,
): Promise<Snapshot[]> {
  if (family === 'specs')
    return [
      ...(await unit.specs.listTemplates(workspaceId)).map((value) => ({
        type: 'template' as const,
        id: value.id,
        value,
      })),
      ...(await unit.specs.listSpecifications(workspaceId)).map((value) => ({
        type: 'specification' as const,
        id: value.id,
        value,
      })),
    ];
  if (family === 'tests')
    return (await unit.tests.list(workspaceId, 0, await unit.tests.count(workspaceId))).map(
      (value) => ({ type: 'testplan', id: value.id, value }),
    );
  const context = { ownerId: workspaceId, requestId: 'audit-snapshot' };
  const chunks = await unit.knowledge.all(context);
  const relations = await unit.knowledge.listRelations(context);
  const pages = new Map<string, (typeof chunks)[number][]>();
  for (const chunk of chunks) {
    const key = JSON.stringify([chunk.source, chunk.pageId]);
    const group = pages.get(key) ?? [];
    group.push(chunk);
    pages.set(key, group);
  }
  return [...pages.values()].map((group) => {
    group.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const first = group[0]!;
    return {
      type: 'document',
      id: JSON.stringify([first.source, first.pageId]),
      value: {
        pageId: first.pageId,
        source: first.source,
        content: group.map((c) => c.content).join(''),
        relations: relations
          .filter((r) => r.sourcePageId === first.pageId || r.targetPageId === first.pageId)
          .map((r) => ({ sourcePageId: r.sourcePageId, targetPageId: r.targetPageId }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      },
    };
  });
}

export function auditedRepositories(
  raw: AuditRepositories,
  persistence: AuditPersistence,
): AuditRepositories {
  async function mutate<T>(
    family: 'knowledge' | 'specs' | 'tests',
    workspaceId: string,
    method: string,
    work: (unit: AuditUnit) => Promise<T>,
    explicitContext?: RequestContext,
    movedIds: ReadonlyMap<string, string> = new Map(),
  ): Promise<T> {
    const request = auditRequest.getStore();
    const context = explicitContext ?? request?.context();
    if (context?.ownerId && context.ownerId !== workspaceId)
      throw new ApplicationError('FORBIDDEN', 'Access denied.', 403);
    return persistence.run(workspaceId, async (unit) => {
      const originals = clone(await snapshots(unit, family, workspaceId));
      const before = originals.map((snapshot) => {
        const destination = movedIds.get(snapshot.id);
        return {
          ...snapshot,
          id:
            destination && !originals.some((other) => other.id === destination)
              ? destination
              : snapshot.id,
        };
      });
      const result = await work(unit);
      const after = clone(await snapshots(unit, family, workspaceId));
      const key = (s: Snapshot) => JSON.stringify([s.type, s.id]);
      const old = new Map(before.map((s) => [key(s), s]));
      const current = new Map(after.map((s) => [key(s), s]));
      const events: AuditEvent[] = [];
      for (const id of new Set([...old.keys(), ...current.keys()])) {
        const previous = old.get(id);
        const next = current.get(id);
        if (JSON.stringify(previous?.value) === JSON.stringify(next?.value)) continue;
        const entity = next ?? previous!;
        events.push({
          id: randomUUID(),
          workspaceId,
          entityType: entity.type,
          entityId: entity.id,
          action: !previous ? 'create' : !next ? 'delete' : 'update',
          actorId: context?.actorId ?? null,
          actorName: context?.actorName ?? null,
          actorEmail: context?.actorEmail ?? null,
          requestId: context?.requestId ?? 'system',
          operation: request?.operation ?? method,
          occurredAt: new Date().toISOString(),
          before: previous?.value ?? null,
          after: next?.value ?? null,
        });
      }
      await unit.append(events);
      return result;
    });
  }
  return {
    knowledge: {
      all: (c) => raw.knowledge.all(c),
      listRelations: (c) => raw.knowledge.listRelations(c),
      replacePage: (p, c, x) =>
        mutate('knowledge', x.ownerId!, 'replacePage', (u) => u.knowledge.replacePage(p, c, x), x),
      deletePage: (p, x) =>
        mutate('knowledge', x.ownerId!, 'deletePage', (u) => u.knowledge.deletePage(p, x), x),
      movePages: (m, x) =>
        mutate(
          'knowledge',
          x.ownerId!,
          'movePages',
          (u) => u.knowledge.movePages(m, x),
          x,
          new Map(
            m.map((move) => [
              JSON.stringify([move.previous.source, move.previous.id]),
              JSON.stringify([move.page.source, move.page.id]),
            ]),
          ),
        ),
      addRelation: (s, t, x) =>
        mutate('knowledge', x.ownerId!, 'addRelation', (u) => u.knowledge.addRelation(s, t, x), x),
      deleteRelation: (s, t, x) =>
        mutate(
          'knowledge',
          x.ownerId!,
          'deleteRelation',
          (u) => u.knowledge.deleteRelation(s, t, x),
          x,
        ),
    },
    specs: {
      listTemplates: (w) => raw.specs.listTemplates(w),
      findTemplate: (id, w) => raw.specs.findTemplate(id, w),
      listSpecifications: (w) => raw.specs.listSpecifications(w),
      findSpecification: (id, w) => raw.specs.findSpecification(id, w),
      saveTemplate: (v) =>
        mutate('specs', v.workspaceId, 'saveTemplate', (u) => u.specs.saveTemplate(v)),
      saveSpecification: (v) =>
        mutate('specs', v.workspaceId, 'saveSpecification', (u) => u.specs.saveSpecification(v)),
      deleteTemplate: (id, w) =>
        mutate('specs', w, 'deleteTemplate', (u) => u.specs.deleteTemplate(id, w)),
      deleteSpecification: (id, w) =>
        mutate('specs', w, 'deleteSpecification', (u) => u.specs.deleteSpecification(id, w)),
    },
    tests: {
      list: (w, o, l) => raw.tests.list(w, o, l),
      count: (w) => raw.tests.count(w),
      find: (id, w) => raw.tests.find(id, w),
      save: (v) => mutate('tests', v.workspaceId, 'saveTestPlan', (u) => u.tests.save(v)),
      delete: (id, w) => mutate('tests', w, 'deleteTestPlan', (u) => u.tests.delete(id, w)),
    },
  };
}
