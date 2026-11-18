import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  E2eEnvironmentChanges,
  E2eEnvironmentStore,
  NewE2eEnvironment,
} from '../application/e2e-environments.js';
import type { E2eEnvironment } from '../domain/e2e-insight.js';

type Row = Omit<E2eEnvironment, 'variableNames'> & { variableNames: unknown };

function toEnvironment(row: Row): E2eEnvironment {
  return {
    ...row,
    variableNames: Array.isArray(row.variableNames)
      ? row.variableNames.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

export class PrismaE2eEnvironmentStore implements E2eEnvironmentStore {
  constructor(private readonly db: PrismaClient) {}

  async list(workspaceId: string): Promise<E2eEnvironment[]> {
    const rows = await this.db.e2eEnvironmentRecord.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toEnvironment);
  }

  async get(workspaceId: string, id: string): Promise<E2eEnvironment | null> {
    const row = await this.db.e2eEnvironmentRecord.findFirst({ where: { id, workspaceId } });
    return row ? toEnvironment(row) : null;
  }

  async create(input: NewE2eEnvironment): Promise<E2eEnvironment> {
    return toEnvironment(await this.db.e2eEnvironmentRecord.create({ data: input }));
  }

  async update(
    workspaceId: string,
    id: string,
    changes: E2eEnvironmentChanges,
  ): Promise<E2eEnvironment | null> {
    const result = await this.db.e2eEnvironmentRecord.updateMany({
      where: { id, workspaceId },
      data: changes,
    });
    return result.count ? this.get(workspaceId, id) : null;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db.e2eEnvironmentRecord.deleteMany({ where: { id, workspaceId } });
    return result.count > 0;
  }
}
