import type { SavedTestPlan, SavedTestPlanStore } from '../application/saved-test-plans.js';

interface RecordShape {
  id: string;
  workspaceId: string;
  title: string;
  assignedTo: string | null;
  suiteId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  plans: unknown;
  createdAt: Date;
  updatedAt: Date;
}
interface Delegate {
  upsert(args: unknown): Promise<RecordShape>;
  findMany(args: unknown): Promise<readonly RecordShape[]>;
  findFirst(args: unknown): Promise<RecordShape | null>;
  count(args: unknown): Promise<number>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}
export interface PrismaSavedTestPlanClient {
  savedTestPlanRecord: Delegate;
}

export class PrismaSavedTestPlanStore implements SavedTestPlanStore {
  public constructor(private readonly client: PrismaSavedTestPlanClient) {}
  private map(record: RecordShape): SavedTestPlan {
    return {
      ...record,
      assignedTo: record.assignedTo ?? undefined,
      suiteId: record.suiteId ?? undefined,
      sourceType: (record.sourceType as SavedTestPlan['sourceType']) ?? undefined,
      sourceId: record.sourceId ?? undefined,
      plans: record.plans as SavedTestPlan['plans'],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
  public async save(plan: SavedTestPlan): Promise<SavedTestPlan> {
    return this.map(
      await this.client.savedTestPlanRecord.upsert({
        where: { id: plan.id },
        create: {
          ...plan,
          createdAt: new Date(plan.createdAt),
          updatedAt: new Date(plan.updatedAt),
        },
        update: {
          title: plan.title,
          assignedTo: plan.assignedTo ?? null,
          suiteId: plan.suiteId ?? null,
          sourceType: plan.sourceType ?? null,
          sourceId: plan.sourceId ?? null,
          plans: plan.plans,
          updatedAt: new Date(plan.updatedAt),
        },
      }),
    );
  }
  public async list(
    workspaceId: string,
    offset: number,
    limit: number,
  ): Promise<readonly SavedTestPlan[]> {
    const records = await this.client.savedTestPlanRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit,
    });
    return records.map((record) => this.map(record));
  }
  public count(workspaceId: string): Promise<number> {
    return this.client.savedTestPlanRecord.count({ where: { workspaceId } });
  }
  public async find(id: string, workspaceId: string): Promise<SavedTestPlan | null> {
    const record = await this.client.savedTestPlanRecord.findFirst({ where: { id, workspaceId } });
    return record ? this.map(record) : null;
  }
  public async delete(id: string, workspaceId: string): Promise<boolean> {
    const result = await this.client.savedTestPlanRecord.deleteMany({
      where: { id, workspaceId },
    });
    return result.count > 0;
  }
}
