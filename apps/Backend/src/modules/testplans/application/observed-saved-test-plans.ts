import type { SavedTestPlan, SavedTestPlanStore } from './saved-test-plans.js';

/** Reacts to changes of saved Test Plans made through the store. */
export interface SavedTestPlanObserver {
  saved(plan: SavedTestPlan): Promise<void>;
  deleted(workspaceId: string, planId: string): Promise<void>;
}

/**
 * A Test Plan store that tells its observers about every save and delete, so modules that keep
 * a copy of a test case (E2E tests linked to it) stay consistent whichever screen made the change.
 * An observer that fails is logged and never fails the change itself.
 */
export class ObservedSavedTestPlanStore implements SavedTestPlanStore {
  private readonly observers: SavedTestPlanObserver[] = [];

  constructor(private readonly inner: SavedTestPlanStore) {}

  observe(observer: SavedTestPlanObserver): void {
    this.observers.push(observer);
  }

  async save(plan: SavedTestPlan): Promise<SavedTestPlan> {
    const saved = await this.inner.save(plan);
    await this.notify((observer) => observer.saved(saved));
    return saved;
  }

  list(workspaceId: string, offset: number, limit: number): Promise<readonly SavedTestPlan[]> {
    return this.inner.list(workspaceId, offset, limit);
  }

  count(workspaceId: string): Promise<number> {
    return this.inner.count(workspaceId);
  }

  find(id: string, workspaceId: string): Promise<SavedTestPlan | null> {
    return this.inner.find(id, workspaceId);
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    const deleted = await this.inner.delete(id, workspaceId);
    if (deleted) await this.notify((observer) => observer.deleted(workspaceId, id));
    return deleted;
  }

  private async notify(call: (observer: SavedTestPlanObserver) => Promise<void>): Promise<void> {
    for (const observer of this.observers)
      await call(observer).catch((error: unknown) =>
        console.error('[SavedTestPlans] Observer failed:', error),
      );
  }
}
