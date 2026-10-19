import { describe, expect, it, vi } from 'vitest';
import {
  createSavedTestPlan,
  InMemorySavedTestPlanStore,
} from '../src/modules/testplans/application/saved-test-plans.js';
import { PrismaSavedTestPlanStore } from '../src/modules/testplans/adapters/prisma-saved-test-plans.js';

describe('saved Test Plans', () => {
  it('creates defaults and isolates in-memory records by workspace', async () => {
    const store = new InMemorySavedTestPlanStore();
    const plan = createSavedTestPlan('w1', {}, [
      { title: 'Case', description: 'Do it', steps: [] },
    ]);
    await store.save(plan);
    expect(plan.title).toBe('Case');
    expect(createSavedTestPlan('w1', {}, []).title).toBe('Test Plan');
    expect(await store.find(plan.id, 'w1')).toEqual(plan);
    expect(await store.find(plan.id, 'w2')).toBeNull();
    expect(await store.list('w1', 0, 10)).toEqual([plan]);
    expect(await store.count('w1')).toBe(1);
    expect(await store.delete(plan.id, 'w2')).toBe(false);
    expect(await store.delete(plan.id, 'w1')).toBe(true);
    expect(await store.find(plan.id, 'w1')).toBeNull();
  });

  it('maps Prisma records for save, list, find, and delete', async () => {
    const record = {
      id: 'p1',
      workspaceId: 'w1',
      title: 'Plan',
      assignedTo: null,
      plans: [],
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    };
    const delegate = {
      upsert: vi.fn().mockResolvedValue(record),
      findMany: vi.fn().mockResolvedValue([record]),
      findFirst: vi.fn().mockResolvedValueOnce(record).mockResolvedValueOnce(null),
      count: vi.fn().mockResolvedValue(1),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const store = new PrismaSavedTestPlanStore({ savedTestPlanRecord: delegate });
    const domain = {
      ...record,
      assignedTo: undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
    expect(await store.save(domain)).toMatchObject({ id: 'p1' });
    expect(await store.list('w1', 0, 10)).toHaveLength(1);
    expect(await store.count('w1')).toBe(1);
    expect(await store.find('p1', 'w1')).not.toBeNull();
    expect(await store.find('missing', 'w1')).toBeNull();
    expect(await store.delete('p1', 'w1')).toBe(true);
    expect(delegate.deleteMany).toHaveBeenCalledWith({ where: { id: 'p1', workspaceId: 'w1' } });
  });
});
