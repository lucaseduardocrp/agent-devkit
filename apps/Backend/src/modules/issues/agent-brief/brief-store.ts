import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import type { IssueAgentBrief } from './brief-types.js';

export interface IssueBriefStore {
  get(workspaceId: string, issueId: string): Promise<IssueAgentBrief | null>;
  save(brief: IssueAgentBrief): Promise<IssueAgentBrief>;
}

export class InMemoryIssueBriefStore implements IssueBriefStore {
  private readonly briefs = new Map<string, IssueAgentBrief>();

  get(workspaceId: string, issueId: string): Promise<IssueAgentBrief | null> {
    const brief = this.briefs.get(issueId);
    return Promise.resolve(brief?.workspaceId === workspaceId ? structuredClone(brief) : null);
  }

  save(brief: IssueAgentBrief): Promise<IssueAgentBrief> {
    this.briefs.set(brief.issueId, structuredClone(brief));
    return Promise.resolve(structuredClone(brief));
  }
}

export class PrismaIssueBriefStore implements IssueBriefStore {
  constructor(private readonly db: PrismaClient) {}

  async get(workspaceId: string, issueId: string): Promise<IssueAgentBrief | null> {
    const row = await this.db.issueBriefRecord.findFirst({ where: { issueId, workspaceId } });
    return row ? (row.data as unknown as IssueAgentBrief) : null;
  }

  async save(brief: IssueAgentBrief): Promise<IssueAgentBrief> {
    const data = brief as unknown as Prisma.InputJsonValue;
    await this.db.issueBriefRecord.upsert({
      where: { issueId: brief.issueId },
      create: { issueId: brief.issueId, workspaceId: brief.workspaceId, data },
      update: { data },
    });
    return brief;
  }
}
