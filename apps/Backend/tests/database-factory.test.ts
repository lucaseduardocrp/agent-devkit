import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/adapters/persistence/database-factory.js';

describe('database factory', () => {
  it('creates the PostgreSQL adapter', async () => {
    const database = createDatabase({
      databaseProvider: 'postgres',
      databaseUrl: 'postgresql://localhost:5432/adk',
    });
    expect(database.provider).toBe('postgres');
    await database.close();
  });
});
