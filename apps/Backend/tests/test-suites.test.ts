import { describe, expect, it } from 'vitest';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
  type TestSuite,
} from '../src/modules/testplans/application/test-suites.js';
import {
  PrismaTestSuiteStore,
  type PrismaTestSuiteClient,
} from '../src/modules/testplans/adapters/prisma-test-suites.js';

function suite(overrides: Partial<TestSuite> = {}): TestSuite {
  return {
    id: 'suite-1',
    workspaceId: 'ws-1',
    name: 'Regression',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

function service() {
  const store = new InMemoryTestSuiteStore();
  return { store, suites: new TestSuiteService(store) };
}

describe('TestSuiteService', () => {
  it('creates root and nested suites and lists them alphabetically', async () => {
    const { suites } = service();
    const root = await suites.create('ws-1', '  Regression  ');
    const child = await suites.create('ws-1', 'Checkout', root.id);

    expect(root.name).toBe('Regression');
    expect(root.parentId).toBeUndefined();
    expect(child.parentId).toBe(root.id);
    expect((await suites.list('ws-1')).map((item) => item.name)).toEqual([
      'Checkout',
      'Regression',
    ]);
  });

  it('isolates suites between workspaces', async () => {
    const { suites } = service();
    await suites.create('ws-1', 'Regression');
    expect(await suites.list('ws-2')).toHaveLength(0);
  });

  it('rejects a parent from another workspace', async () => {
    const { suites } = service();
    const foreign = await suites.create('ws-2', 'Foreign');
    await expect(suites.create('ws-1', 'Child', foreign.id)).rejects.toMatchObject({
      code: 'TEST_SUITE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('renames a suite and keeps the previous name when the new one is blank', async () => {
    const { suites } = service();
    const root = await suites.create('ws-1', 'Regression');
    expect((await suites.update(root.id, 'ws-1', { name: ' Smoke ' })).name).toBe('Smoke');
    expect((await suites.update(root.id, 'ws-1', { name: '   ' })).name).toBe('Smoke');
  });

  it('moves a suite to another parent and back to the root', async () => {
    const { suites } = service();
    const root = await suites.create('ws-1', 'Regression');
    const other = await suites.create('ws-1', 'Smoke');
    const child = await suites.create('ws-1', 'Checkout', root.id);

    expect((await suites.update(child.id, 'ws-1', { parentId: other.id })).parentId).toBe(other.id);
    expect((await suites.update(child.id, 'ws-1', { parentId: null })).parentId).toBeUndefined();
  });

  it('rejects a suite that becomes its own parent', async () => {
    const { suites } = service();
    const root = await suites.create('ws-1', 'Regression');
    await expect(suites.update(root.id, 'ws-1', { parentId: root.id })).rejects.toMatchObject({
      code: 'TEST_SUITE_CYCLE',
      statusCode: 400,
    });
  });

  it('rejects a cycle through an ancestor', async () => {
    const { suites } = service();
    const root = await suites.create('ws-1', 'Regression');
    const child = await suites.create('ws-1', 'Checkout', root.id);
    const grandChild = await suites.create('ws-1', 'Payment', child.id);

    await expect(suites.update(root.id, 'ws-1', { parentId: grandChild.id })).rejects.toMatchObject(
      { code: 'TEST_SUITE_CYCLE' },
    );
  });

  it('deletes an empty suite', async () => {
    const { store, suites } = service();
    const root = await suites.create('ws-1', 'Regression');
    await suites.delete(root.id, 'ws-1');
    expect(await store.find(root.id, 'ws-1')).toBeNull();
  });

  it('cascades delete to child suites', async () => {
    const { store, suites } = service();
    const root = await suites.create('ws-1', 'Regression');
    const child = await suites.create('ws-1', 'Checkout', root.id);

    await suites.delete(root.id, 'ws-1');

    expect(await store.find(root.id, 'ws-1')).toBeNull();
    expect(await store.find(child.id, 'ws-1')).toBeNull();
  });

  it('reports a missing suite on update and delete', async () => {
    const { suites } = service();
    await expect(suites.update('missing', 'ws-1', { name: 'x' })).rejects.toMatchObject({
      code: 'TEST_SUITE_NOT_FOUND',
    });
    await expect(suites.delete('missing', 'ws-1')).rejects.toMatchObject({
      code: 'TEST_SUITE_NOT_FOUND',
    });
  });
});

describe('InMemoryTestSuiteStore', () => {
  it('scopes find and delete by workspace and cascades to children', async () => {
    const store = new InMemoryTestSuiteStore();
    await store.save(suite());
    await store.save(suite({ id: 'child', parentId: 'suite-1' }));

    expect(await store.find('suite-1', 'ws-2')).toBeNull();
    expect(await store.delete('suite-1', 'ws-2')).toBe(false);
    expect(await store.delete('suite-1', 'ws-1')).toBe(true);
    expect(await store.find('child', 'ws-1')).toBeNull();
    expect(await store.delete('suite-1', 'ws-1')).toBe(false);
  });
});

describe('PrismaTestSuiteStore', () => {
  function client() {
    const calls: Record<string, unknown[]> = {};
    const record = {
      id: 'suite-1',
      workspaceId: 'ws-1',
      parentId: null as string | null,
      name: 'Regression',
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      updatedAt: new Date('2026-09-18T00:00:00.000Z'),
    };
    const track = (key: string, args: unknown) => {
      (calls[key] ??= []).push(args);
    };
    const prisma: PrismaTestSuiteClient = {
      testSuiteRecord: {
        upsert: (args) => {
          track('upsert', args);
          return Promise.resolve(record);
        },
        findMany: (args) => {
          track('findMany', args);
          return Promise.resolve([record]);
        },
        findFirst: (args) => {
          track('findFirst', args);
          return Promise.resolve(record);
        },
        deleteMany: (args) => {
          track('deleteMany', args);
          return Promise.resolve({ count: 1 });
        },
      },
    };
    return { calls, prisma };
  }

  it('maps records and scopes every query by workspace', async () => {
    const { calls, prisma } = client();
    const store = new PrismaTestSuiteStore(prisma);

    expect(await store.save(suite())).toMatchObject({
      id: 'suite-1',
      parentId: undefined,
      createdAt: '2026-09-18T00:00:00.000Z',
    });
    expect(await store.list('ws-1')).toHaveLength(1);
    expect(await store.find('suite-1', 'ws-1')).toMatchObject({ name: 'Regression' });
    expect(await store.delete('suite-1', 'ws-1')).toBe(true);
    expect(calls['findFirst']).toEqual([{ where: { id: 'suite-1', workspaceId: 'ws-1' } }]);
    expect(calls['deleteMany']).toEqual([{ where: { id: 'suite-1', workspaceId: 'ws-1' } }]);
  });

  it('persists a nested parent and reports a missing suite and a no-op delete', async () => {
    const { calls, prisma } = client();
    prisma.testSuiteRecord.findFirst = () => Promise.resolve(null);
    prisma.testSuiteRecord.deleteMany = () => Promise.resolve({ count: 0 });
    const store = new PrismaTestSuiteStore(prisma);

    await store.save(suite({ parentId: 'parent-1' }));
    expect(await store.find('suite-1', 'ws-1')).toBeNull();
    expect(await store.delete('suite-1', 'ws-1')).toBe(false);
    expect(calls['upsert']?.[0]).toMatchObject({ update: { parentId: 'parent-1' } });
  });
});
