import { PrismaPg } from '@prisma/adapter-pg';
import type { DatabaseConnection } from '../../application/persistence/database.js';
import { PrismaClient } from '../../generated/prisma/client.js';

export interface PrismaLifecycleClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
  $disconnect(): Promise<void>;
}

export class PostgresDatabase<
  TClient extends PrismaLifecycleClient = PrismaClient,
> implements DatabaseConnection {
  public readonly provider = 'postgres' as const;
  public readonly client: TClient;

  public constructor(connectionString: string, client?: TClient) {
    this.client =
      client ??
      (new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
      }) as unknown as TClient);
  }

  public async check(): Promise<void> {
    await this.client.$queryRawUnsafe('SELECT 1');
  }

  public async close(): Promise<void> {
    await this.client.$disconnect();
  }
}
