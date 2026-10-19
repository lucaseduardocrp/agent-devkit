import type { RuntimeConfig } from '../../shared/config.js';
import { PostgresDatabase } from './postgres-database.js';

type DatabaseConfig = Required<Pick<RuntimeConfig, 'databaseProvider' | 'databaseUrl'>>;

export function createDatabase(config: DatabaseConfig): PostgresDatabase {
  return new PostgresDatabase(config.databaseUrl);
}
