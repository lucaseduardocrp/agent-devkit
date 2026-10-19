/* v8 ignore file -- persistence adapter contract is covered by the database integration suite. */
import type { TestSuite, TestSuiteStore } from '../application/test-suites.js';

interface RecordShape {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}
interface SuiteDelegate {
  upsert(args: unknown): Promise<RecordShape>;
  findMany(args: unknown): Promise<readonly RecordShape[]>;
  findFirst(args: unknown): Promise<RecordShape | null>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}
export interface PrismaTestSuiteClient {
  testSuiteRecord: SuiteDelegate;
}

export class PrismaTestSuiteStore implements TestSuiteStore {
  public constructor(private readonly client: PrismaTestSuiteClient) {}
  private map(record: RecordShape): TestSuite {
    return {
      ...record,
      parentId: record.parentId ?? undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
  public async save(suite: TestSuite): Promise<TestSuite> {
    return this.map(
      await this.client.testSuiteRecord.upsert({
        where: { id: suite.id },
        create: {
          ...suite,
          parentId: suite.parentId ?? null,
          createdAt: new Date(suite.createdAt),
          updatedAt: new Date(suite.updatedAt),
        },
        update: {
          name: suite.name,
          parentId: suite.parentId ?? null,
          updatedAt: new Date(suite.updatedAt),
        },
      }),
    );
  }
  public async list(workspaceId: string): Promise<readonly TestSuite[]> {
    return (
      await this.client.testSuiteRecord.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
      })
    ).map((record) => this.map(record));
  }
  public async find(id: string, workspaceId: string): Promise<TestSuite | null> {
    const value = await this.client.testSuiteRecord.findFirst({ where: { id, workspaceId } });
    return value ? this.map(value) : null;
  }
  public async delete(id: string, workspaceId: string): Promise<boolean> {
    return (await this.client.testSuiteRecord.deleteMany({ where: { id, workspaceId } })).count > 0;
  }
}
