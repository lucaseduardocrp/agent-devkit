/* v8 ignore file -- exercised by suite HTTP integration tests. */
import crypto from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';

export interface TestSuite {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TestSuiteStore {
  save(suite: TestSuite): Promise<TestSuite>;
  list(workspaceId: string): Promise<readonly TestSuite[]>;
  find(id: string, workspaceId: string): Promise<TestSuite | null>;
  delete(id: string, workspaceId: string): Promise<boolean>;
}

export class InMemoryTestSuiteStore implements TestSuiteStore {
  private readonly suites = new Map<string, TestSuite>();
  public save(suite: TestSuite): Promise<TestSuite> {
    this.suites.set(suite.id, suite);
    return Promise.resolve(suite);
  }
  public list(workspaceId: string): Promise<readonly TestSuite[]> {
    return Promise.resolve(
      [...this.suites.values()]
        .filter((suite) => suite.workspaceId === workspaceId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
  public find(id: string, workspaceId: string): Promise<TestSuite | null> {
    const suite = this.suites.get(id);
    return Promise.resolve(suite?.workspaceId === workspaceId ? suite : null);
  }
  public delete(id: string, workspaceId: string): Promise<boolean> {
    const suite = this.suites.get(id);
    if (suite?.workspaceId !== workspaceId) return Promise.resolve(false);
    for (const child of [...this.suites.values()].filter(
      (candidate) => candidate.workspaceId === workspaceId && candidate.parentId === id,
    )) {
      this.suites.delete(child.id);
    }
    return Promise.resolve(this.suites.delete(id));
  }
}

export class TestSuiteService {
  public constructor(private readonly store: TestSuiteStore) {}
  public list(workspaceId: string) {
    return this.store.list(workspaceId);
  }
  public async create(workspaceId: string, name: string, parentId?: string): Promise<TestSuite> {
    await this.assertParent(workspaceId, parentId);
    const now = new Date().toISOString();
    return this.store.save({
      id: crypto.randomUUID(),
      workspaceId,
      name: name.trim(),
      ...(parentId ? { parentId } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  public async update(
    id: string,
    workspaceId: string,
    input: { name?: string; parentId?: string | null },
  ): Promise<TestSuite> {
    const suite = await this.require(id, workspaceId);
    const parentId = input.parentId === undefined ? suite.parentId : (input.parentId ?? undefined);
    if (parentId === id)
      throw new ApplicationError(
        'TEST_SUITE_CYCLE',
        'Uma suíte não pode ser filha dela mesma.',
        400,
      );
    await this.assertParent(workspaceId, parentId);
    let ancestorId = parentId;
    while (ancestorId) {
      if (ancestorId === id)
        throw new ApplicationError(
          'TEST_SUITE_CYCLE',
          'A hierarquia de suítes não pode conter ciclos.',
          400,
        );
      ancestorId = (await this.store.find(ancestorId, workspaceId))?.parentId;
    }
    return this.store.save({
      ...suite,
      name: input.name?.trim() || suite.name,
      ...(parentId ? { parentId } : { parentId: undefined }),
      updatedAt: new Date().toISOString(),
    });
  }
  public async delete(id: string, workspaceId: string): Promise<void> {
    await this.require(id, workspaceId);
    await this.store.delete(id, workspaceId);
  }
  private async require(id: string, workspaceId: string): Promise<TestSuite> {
    const suite = await this.store.find(id, workspaceId);
    if (!suite)
      throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Suíte de testes não encontrada.', 404);
    return suite;
  }
  private async assertParent(workspaceId: string, parentId?: string): Promise<void> {
    if (parentId) await this.require(parentId, workspaceId);
  }
}
