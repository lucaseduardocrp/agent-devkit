import crypto from 'node:crypto';
import type { TestPlan } from '../domain/test-plan.js';

/** Where a Test Plan came from; `test_management` marks one imported from a platform. */
export type SavedTestPlanSource = 'manual' | 'brain' | 'spec' | 'pbi' | 'test_management';

export interface SavedTestPlan {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly assignedTo?: string;
  readonly suiteId?: string;
  readonly sourceType?: SavedTestPlanSource;
  readonly sourceId?: string;
  readonly plans: readonly TestPlan[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavedTestPlanStore {
  save(plan: SavedTestPlan): Promise<SavedTestPlan>;
  list(workspaceId: string, offset: number, limit: number): Promise<readonly SavedTestPlan[]>;
  count(workspaceId: string): Promise<number>;
  find(id: string, workspaceId: string): Promise<SavedTestPlan | null>;
  delete(id: string, workspaceId: string): Promise<boolean>;
}

export class InMemorySavedTestPlanStore implements SavedTestPlanStore {
  private readonly records = new Map<string, SavedTestPlan>();
  public save(plan: SavedTestPlan): Promise<SavedTestPlan> {
    this.records.set(plan.id, plan);
    return Promise.resolve(plan);
  }
  public list(
    workspaceId: string,
    offset: number,
    limit: number,
  ): Promise<readonly SavedTestPlan[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((plan) => plan.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(offset, offset + limit),
    );
  }
  public count(workspaceId: string): Promise<number> {
    return Promise.resolve(
      [...this.records.values()].filter((plan) => plan.workspaceId === workspaceId).length,
    );
  }
  public find(id: string, workspaceId: string): Promise<SavedTestPlan | null> {
    const plan = this.records.get(id);
    return Promise.resolve(plan?.workspaceId === workspaceId ? plan : null);
  }
  public delete(id: string, workspaceId: string): Promise<boolean> {
    const plan = this.records.get(id);
    if (plan?.workspaceId === workspaceId) {
      return Promise.resolve(this.records.delete(id));
    }
    return Promise.resolve(false);
  }
}

/** Every Test Plan of a workspace, read page by page. */
export async function listAllSavedTestPlans(
  store: SavedTestPlanStore,
  workspaceId: string,
): Promise<SavedTestPlan[]> {
  const plans: SavedTestPlan[] = [];
  const count = await store.count(workspaceId);
  for (let offset = 0; offset < count; offset += 100)
    plans.push(...(await store.list(workspaceId, offset, 100)));
  return plans;
}

/**
 * Edited cases sent by clients carry only their own fields: the metadata stored with each
 * case (remote ids, custom fields...) is kept for the cases that already existed.
 */
export function keepCaseMetadata(
  previous: readonly TestPlan[],
  incoming: readonly TestPlan[],
): TestPlan[] {
  const byId = new Map(
    previous.flatMap((testCase) => {
      const id = testCase.metadata?.['caseId'];
      return typeof id === 'string' && id ? [[id, testCase.metadata]] : [];
    }),
  );
  return incoming.map((testCase) => {
    const id = testCase.metadata?.['caseId'];
    const stored = typeof id === 'string' ? byId.get(id) : undefined;
    return stored ? { ...testCase, metadata: { ...stored, ...testCase.metadata } } : testCase;
  });
}

export function createSavedTestPlan(
  workspaceId: string,
  input: {
    title?: string;
    assignedTo?: string;
    suiteId?: string | null;
    sourceType?: SavedTestPlanSource;
    sourceId?: string;
  },
  plans: readonly TestPlan[],
): SavedTestPlan {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    workspaceId,
    title: input.title ?? plans[0]?.title ?? 'Test Plan',
    assignedTo: input.assignedTo,
    suiteId: input.suiteId ?? undefined,
    sourceType: input.sourceType ?? 'manual',
    sourceId: input.sourceId,
    plans: withCaseIds(plans),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Gives every test case a stable `metadata.caseId`, kept across edits, so the history of a
 * single case can be followed. Missing or duplicated IDs get a new one.
 */
export function withCaseIds(plans: readonly TestPlan[]): readonly TestPlan[] {
  const seen = new Set<string>();
  return plans.map((plan) => {
    const current = plan.metadata?.['caseId'];
    if (typeof current === 'string' && current && !seen.has(current)) {
      seen.add(current);
      return plan;
    }
    const caseId = crypto.randomUUID();
    seen.add(caseId);
    return { ...plan, metadata: { ...plan.metadata, caseId } };
  });
}
