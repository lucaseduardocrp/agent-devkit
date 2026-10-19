import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase } from '../src/adapters/persistence/postgres-database.js';

describe('database adapters', () => {
  it('checks and closes PostgreSQL connections', async () => {
    const client = {
      $queryRawUnsafe: vi.fn().mockResolvedValue({}),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const database = new PostgresDatabase('unused-in-test', client);

    await database.check();
    await database.close();

    expect(client.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
    expect(client.$disconnect).toHaveBeenCalledOnce();
  });
});
