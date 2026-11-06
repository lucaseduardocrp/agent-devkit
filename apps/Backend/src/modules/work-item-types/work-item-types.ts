import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';

/** Color tokens a type can use; the frontend maps each one to its palette. */
export const workItemTypeColors = [
  'red',
  'orange',
  'amber',
  'emerald',
  'cyan',
  'sky',
  'blue',
  'violet',
  'fuchsia',
  'pink',
  'slate',
] as const;
export type WorkItemTypeColor = (typeof workItemTypeColors)[number];

export interface WorkItemType {
  /** Stable lowercase key stored on issues and matched against the provider card type. */
  key: string;
  label: string;
  /** A color token, or a `#rrggbb` hex value picked by the user. */
  color: string;
  /** Tabler icon name without the `ti-` prefix. */
  icon: string;
  /** Other names (provider types, translations) that resolve to this type. */
  aliases: string[];
}

export const defaultWorkItemTypes: readonly WorkItemType[] = [
  { key: 'bug', label: 'Bug', color: 'red', icon: 'bug', aliases: [] },
  { key: 'task', label: 'Task', color: 'sky', icon: 'checklist', aliases: ['tarefa'] },
  { key: 'sac', label: 'SAC', color: 'amber', icon: 'message-circle', aliases: [] },
  {
    key: 'pbi',
    label: 'Product Backlog Item',
    color: 'violet',
    icon: 'layout-kanban',
    aliases: ['product backlog item', 'user story'],
  },
  { key: 'epic', label: 'Epic', color: 'fuchsia', icon: 'flag', aliases: [] },
  { key: 'feature', label: 'Feature', color: 'cyan', icon: 'sparkles', aliases: [] },
  {
    key: 'plano-de-teste',
    label: 'Plano de teste',
    color: 'emerald',
    icon: 'clipboard-list',
    aliases: [],
  },
];

export interface WorkItemTypeStore {
  /** Types configured for the workspace; the defaults until it saves its own. */
  get(workspaceId: string): Promise<WorkItemType[]>;
  save(workspaceId: string, types: WorkItemType[]): Promise<WorkItemType[]>;
}

const defaults = (): WorkItemType[] =>
  defaultWorkItemTypes.map((type) => ({ ...type, aliases: [...type.aliases] }));

export class InMemoryWorkItemTypeStore implements WorkItemTypeStore {
  private readonly types = new Map<string, WorkItemType[]>();
  get(workspaceId: string): Promise<WorkItemType[]> {
    return Promise.resolve(this.types.get(workspaceId) ?? defaults());
  }
  save(workspaceId: string, types: WorkItemType[]): Promise<WorkItemType[]> {
    this.types.set(workspaceId, types);
    return Promise.resolve(types);
  }
}

export class PrismaWorkItemTypeStore implements WorkItemTypeStore {
  constructor(private readonly db: PrismaClient) {}
  async get(workspaceId: string): Promise<WorkItemType[]> {
    const row = await this.db.workItemTypeSettingsRecord.findUnique({ where: { workspaceId } });
    return row ? (row.types as unknown as WorkItemType[]) : defaults();
  }
  async save(workspaceId: string, types: WorkItemType[]): Promise<WorkItemType[]> {
    const json = types as unknown as Prisma.InputJsonValue;
    const row = await this.db.workItemTypeSettingsRecord.upsert({
      where: { workspaceId },
      create: { workspaceId, types: json },
      update: { types: json },
    });
    return row.types as unknown as WorkItemType[];
  }
}
