import { ApplicationError } from '../../shared/errors.js';
import type { IntegrationsService } from '../integrations/application/integrations-service.js';
import { createPbiProvider, type ExternalLink, type RemotePbiItem } from './providers.js';
import {
  fieldValues,
  missingFields,
  type PushAssignee,
  type PushContract,
} from './push-contract.js';
import {
  canonicalRelation,
  InMemoryPbiRelationStore,
  pbiLinkTypes,
  relationTypeFor,
  type PbiLinkType,
  type PbiRelationStore,
} from './pbi-relations.js';
import type { Cache } from '../../shared/cache.js';
import type { E2eArtifactStore } from '../e2e/application/artifact-store.js';
import { fileOwner, syncItemFilesSafely } from '../shared/attachment-files.js';
import type { PbiChanges, PbiFields, PbiItem, PbiSearchOptions, PbiStore } from './pbi-store.js';
import { pbiCacheScope } from './pbi-store.js';
import {
  InMemoryFieldMappingStore,
  mergeImportedFields,
  resolveFieldMapping,
  type FieldMappingStore,
  type FieldValue,
} from '../field-mapping/field-mapping.js';
import {
  diffChange,
  type EntityAuditLog,
  type EntityChange,
  type EntitySnapshot,
} from '../audit/entity-audit.js';

export type BoardProviderId = 'azure_devops' | 'trello' | 'github_projects' | 'jira';
const supported = new Set<BoardProviderId>(['azure_devops', 'trello', 'github_projects', 'jira']);
const auditedSourceKeys = [
  'type',
  'areaPath',
  'iterationPath',
  'tags',
  'adkPriority',
  'adkAgentId',
  'adkAssigneeUserId',
  'adkCardType',
] as const;
export function pbiSnapshot(item: PbiItem): EntitySnapshot {
  return {
    title: item.title,
    kind: item.kind,
    status: item.status,
    description: item.description,
    parentId: item.parentId,
    ...Object.fromEntries(
      auditedSourceKeys
        .filter((key) => item.sourceData[key] !== undefined && item.sourceData[key] !== '')
        .map((key) => [key, item.sourceData[key]]),
    ),
    customFields: item.sourceData.customFields ?? {},
    links: item.links.map((link) => `${link.providerId}:${link.externalId}`).sort(),
  };
}
const created = (item: PbiItem): EntityChange => ({
  entityType: 'pbi',
  entityId: item.id,
  action: 'create',
  before: null,
  after: pbiSnapshot(item),
});
const updated = (before: PbiItem, after: PbiItem): EntityChange | null =>
  diffChange('pbi', after.id, pbiSnapshot(before), pbiSnapshot(after));
/** What of a PBI or card can reference stored files. */
const itemFiles = (item: PbiItem | null) =>
  item && { description: item.description, attachments: item.attachments };
export interface PushOptions {
  providerId: BoardProviderId;
  boardId?: string;
  listId?: string;
  issueType?: string;
  /** Values for the provider push contract (see `pushContract`). */
  fields?: Record<string, string>;
  templateId?: string;
}
export interface PbiItemSummary {
  id: string;
  title: string;
  kind: PbiItem['kind'];
  status: string;
  type: string;
  links: { providerId: string; externalId: string; externalUrl: string | null }[];
}
export interface PbiRelationView {
  type: PbiLinkType;
  /** `adk` for links managed in ADK; a provider id for links read from that provider. */
  origin: string;
  item: PbiItemSummary | null;
  /** Provider id of a linked item that was not imported into ADK. */
  externalId?: string;
}
const sourceString = (value: unknown) => (typeof value === 'string' ? value : '');
function summary(item: PbiItem): PbiItemSummary {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    type:
      sourceString(item.sourceData.adkCardType) ||
      sourceString(item.sourceData.type) ||
      (item.kind === 'pbi' ? 'PBI' : 'Card'),
    links: item.links.map(({ providerId, externalId, externalUrl }) => ({
      providerId,
      externalId,
      externalUrl,
    })),
  };
}
/** Keys a provider may return after a push that ADK mirrors on the local item. */
const pushedSourceKeys = [
  'type',
  'iterationPath',
  'areaPath',
  'assignedTo',
  'projectItemId',
  'githubContentType',
];
function linkInvalid(detail: string, status = 400): ApplicationError {
  return new ApplicationError('PBI_LINK_INVALID', detail, status, [], { detail });
}
export class PbiService {
  constructor(
    private readonly store: PbiStore,
    private readonly integrations: IntegrationsService,
    private readonly fetcher: typeof fetch = fetch,
    private readonly audit?: EntityAuditLog,
    private readonly relationStore: PbiRelationStore = new InMemoryPbiRelationStore(),
    private readonly fieldMappings: FieldMappingStore = new InMemoryFieldMappingStore(),
    private readonly cache?: Cache,
    private readonly files?: E2eArtifactStore,
  ) {}
  /** Keeps exactly the stored files the saved item references; `after` is null on delete. */
  private syncFiles(workspaceId: string, before: PbiItem | null, after: PbiItem | null) {
    return syncItemFilesSafely(
      this.files,
      workspaceId,
      fileOwner('pbi', (after ?? before)!.id),
      itemFiles(before),
      itemFiles(after),
    );
  }
  private async record(workspaceId: string, changes: (EntityChange | null)[]): Promise<void> {
    const present = changes.filter((change): change is EntityChange => change !== null);
    if (this.audit && present.length) await this.audit.record(workspaceId, present);
  }

  list(workspaceId: string) {
    return this.store.list(workspaceId);
  }
  /** The list of every item as JSON, from the cache while no item changed. */
  summariesJson(workspaceId: string): Promise<string> {
    const load = async () => JSON.stringify({ items: await this.store.summaries(workspaceId) });
    return this.cache
      ? this.cache.text(pbiCacheScope(workspaceId), 'summaries', 60 * 60, load)
      : load();
  }
  search(workspaceId: string, options: PbiSearchOptions) {
    return this.store.search(workspaceId, options);
  }
  async currentIteration(workspaceId: string): Promise<string | null> {
    const load = async () => {
      const providers = await this.availableProviders(workspaceId);
      if (!providers.some((entry) => entry.providerId === 'azure_devops')) return null;
      return (
        (await (await this.provider(workspaceId, 'azure_devops')).currentIteration?.()) ?? null
      );
    };
    // A call to the provider on every page load; sprints change every few weeks.
    return this.cache
      ? this.cache.json(`pbi-iteration:${workspaceId}`, 'current', 10 * 60, load)
      : load();
  }
  async get(workspaceId: string, id: string): Promise<PbiItem> {
    const external = /^(azure_devops|trello|github_projects|jira):(.+)$/.exec(id);
    const item = external
      ? await this.store.findByExternal(workspaceId, external[1]!, external[2]!)
      : /^\d+$/.test(id)
        ? await this.store.findByExternal(workspaceId, 'azure_devops', id)
        : await this.store.get(workspaceId, id);
    if (!item) throw new ApplicationError('PBI_NOT_FOUND', 'PBI item not found.', 404);
    return item;
  }
  async comments(workspaceId: string, id: string) {
    const item = await this.get(workspaceId, id);
    const link = item.links.find((entry) => entry.providerId === 'azure_devops');
    if (!link) return [];
    const provider = await this.provider(workspaceId, 'azure_devops');
    return (await provider.comments?.(link.externalId)) ?? [];
  }
  async create(workspaceId: string, fields: PbiFields): Promise<PbiItem> {
    await this.validateParent(workspaceId, fields.kind, fields.parentId ?? null);
    const item = await this.store.create(workspaceId, fields);
    await this.syncFiles(workspaceId, null, item);
    await this.record(workspaceId, [created(item)]);
    return item;
  }
  async update(workspaceId: string, id: string, fields: PbiChanges): Promise<PbiItem> {
    const current = await this.get(workspaceId, id);
    if (fields.parentId !== undefined) {
      if (fields.parentId === current.id)
        throw new ApplicationError('PBI_HIERARCHY', 'An item cannot parent itself.', 400);
      await this.validateParent(workspaceId, current.kind, fields.parentId);
      let ancestorId = fields.parentId;
      while (ancestorId) {
        if (ancestorId === current.id)
          throw new ApplicationError('PBI_HIERARCHY', 'The hierarchy cannot contain a cycle.', 400);
        ancestorId = (await this.get(workspaceId, ancestorId)).parentId;
      }
    }
    const item = (await this.store.update(workspaceId, current.id, {
      ...fields,
      ...(fields.sourceData ? { sourceData: { ...current.sourceData, ...fields.sourceData } } : {}),
    }))!;
    await this.syncFiles(workspaceId, current, item);
    await this.record(workspaceId, [updated(current, item)]);
    return item;
  }
  async remove(workspaceId: string, id: string): Promise<void> {
    const item = await this.get(workspaceId, id);
    // Children are removed with their parent, and so are their files.
    const removed = [item];
    if (this.audit || this.files) {
      const children = new Map<string, PbiItem[]>();
      for (const entry of await this.store.list(workspaceId))
        if (entry.parentId)
          children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry]);
      for (let index = 0; index < removed.length; index++)
        removed.push(...(children.get(removed[index]!.id) ?? []));
    }
    await this.store.remove(workspaceId, item.id);
    for (const entry of removed) await this.syncFiles(workspaceId, entry, null);
    await this.record(
      workspaceId,
      removed.map((entry) => ({
        entityType: 'pbi',
        entityId: entry.id,
        action: 'delete',
        before: pbiSnapshot(entry),
        after: null,
      })),
    );
  }
  private async validateParent(
    workspaceId: string,
    kind: 'pbi' | 'card',
    parentId: string | null,
  ): Promise<void> {
    if (kind === 'pbi' && parentId)
      throw new ApplicationError('PBI_HIERARCHY', 'PBIs cannot have a parent.', 400);
    if (kind === 'card' && !parentId)
      throw new ApplicationError('PBI_HIERARCHY', 'Cards require a parent PBI.', 400);
    if (kind === 'card' && parentId) {
      const parent = await this.get(workspaceId, parentId);
      if (parent.kind !== 'pbi' && parent.kind !== 'card')
        throw new ApplicationError('PBI_HIERARCHY', 'Cards must belong to a PBI or card.', 400);
    }
  }
  async availableProviders(workspaceId: string) {
    const configs = await this.integrations.listIntegrations(workspaceId);
    const available = configs.filter(
      (config) =>
        config.isEnabled &&
        config.hasSecret &&
        (supported.has(config.providerId as BoardProviderId) ||
          config.providerId === 'azure_devops_wiki'),
    );
    const preferred = [...available].sort(
      (a, b) =>
        Number(a.providerId === 'azure_devops_wiki') - Number(b.providerId === 'azure_devops_wiki'),
    );
    const unique = new Map<string, { providerId: string; settings: Record<string, unknown> }>();
    for (const config of preferred) {
      const providerId =
        config.providerId === 'azure_devops_wiki' ? 'azure_devops' : config.providerId;
      if (!unique.has(providerId))
        unique.set(providerId, { providerId, settings: config.settings });
    }
    return [...unique.values()];
  }
  private async provider(workspaceId: string, providerId: BoardProviderId) {
    const configs = await this.integrations.listIntegrations(workspaceId);
    const config =
      configs.find(
        (entry) => entry.isEnabled && entry.hasSecret && entry.providerId === providerId,
      ) ??
      (providerId === 'azure_devops'
        ? configs.find(
            (entry) =>
              entry.isEnabled && entry.hasSecret && entry.providerId === 'azure_devops_wiki',
          )
        : undefined);
    if (!config)
      throw new ApplicationError(
        'PBI_PROVIDER_CONFIG',
        `Configure ${providerId} in Integrations first.`,
        400,
      );
    const secret = await this.integrations.getDecryptedSecret(
      workspaceId,
      config.category,
      config.providerId,
    );
    return createPbiProvider(
      { id: providerId, settings: config.settings, secret: secret ?? '' },
      this.fetcher,
    );
  }
  private async importItem(
    workspaceId: string,
    providerId: string,
    remote: RemotePbiItem,
    parentId: string | null,
    existing: PbiItem | null,
    changes: (EntityChange | null)[],
  ): Promise<PbiItem> {
    const kind = parentId ? 'card' : remote.kind;
    // Provider files are replaced on every import; files added in the ADK are kept.
    const attachments = remote.attachments && [
      ...(existing?.attachments ?? []).filter((file) => !file.id.startsWith('provider:')),
      ...remote.attachments,
    ];
    const item = existing
      ? (await this.store.update(workspaceId, existing.id, {
          title: remote.title,
          kind,
          description: remote.description,
          status: remote.status,
          parentId,
          position: remote.position,
          ...(attachments ? { attachments } : {}),
          sourceData: mergeImportedFields(
            existing.sourceData,
            {
              ...remote.sourceData,
              ...Object.fromEntries(
                Object.entries(existing.sourceData).filter(([key]) => key.startsWith('adk')),
              ),
            },
            providerId,
          ),
        }))!
      : await this.store.create(workspaceId, {
          kind,
          title: remote.title,
          description: remote.description,
          status: remote.status,
          parentId,
          position: remote.position,
          ...(attachments ? { attachments } : {}),
          sourceData: remote.sourceData,
        });
    const linked = await this.store.link(workspaceId, item.id, {
      providerId,
      externalId: remote.externalId,
      externalUrl: remote.externalUrl,
      boardId: remote.boardId,
    });
    // The imported description replaces the one edited in the ADK, with its images.
    await this.syncFiles(workspaceId, existing, linked);
    changes.push(existing ? updated(existing, linked) : created(linked));
    return linked;
  }
  private async importHierarchy(
    workspaceId: string,
    providerId: string,
    remote: RemotePbiItem[],
  ): Promise<number> {
    const existing = new Map<string, PbiItem>();
    for (const item of await this.store.list(workspaceId))
      for (const link of item.links)
        if (link.providerId === providerId) existing.set(link.externalId, item);
    const remoteIds = new Set(remote.map((item) => item.externalId));
    const children = new Map<string, RemotePbiItem[]>();
    const pending: RemotePbiItem[] = [];
    for (const item of remote) {
      if (item.parentExternalId && remoteIds.has(item.parentExternalId))
        children.set(item.parentExternalId, [...(children.get(item.parentExternalId) ?? []), item]);
      else pending.push(item);
    }
    pending.sort(
      (a, b) =>
        Number(b.sourceData.currentIteration === true) -
        Number(a.sourceData.currentIteration === true),
    );
    const importedIds = new Map<string, string>();
    const changes: (EntityChange | null)[] = [];
    let imported = 0;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(16, pending.length) }, async () => {
        while (!failure) {
          const item = pending.shift();
          if (!item) return;
          try {
            const parentId = item.parentExternalId
              ? (importedIds.get(item.parentExternalId) ??
                existing.get(item.parentExternalId)?.id ??
                null)
              : null;
            const saved = await this.importItem(
              workspaceId,
              providerId,
              item,
              parentId,
              existing.get(item.externalId) ?? null,
              changes,
            );
            importedIds.set(item.externalId, saved.id);
            imported++;
            pending.unshift(...(children.get(item.externalId) ?? []));
          } catch (error) {
            failure = error;
          }
        }
      }),
    );
    await this.record(workspaceId, changes);
    if (failure) throw failure instanceof Error ? failure : new Error('PBI import failed.');
    if (imported !== remote.length)
      throw new ApplicationError('PBI_HIERARCHY', 'Provider returned a cyclic hierarchy.', 502);
    return imported;
  }
  pull(workspaceId: string): Promise<{
    results: { providerId: string; imported: number; error?: string }[];
    items: PbiItem[];
  }>;
  pull(
    workspaceId: string,
    includeItems: false,
    providerId?: BoardProviderId,
  ): Promise<{ results: { providerId: string; imported: number; error?: string }[] }>;
  pull(
    workspaceId: string,
    includeItems: true,
    providerId?: BoardProviderId,
  ): Promise<{
    results: { providerId: string; imported: number; error?: string }[];
    items: PbiItem[];
  }>;
  async pull(workspaceId: string, includeItems = true, providerId?: BoardProviderId) {
    const configured = await this.availableProviders(workspaceId);
    const unique = [
      ...new Set(
        configured
          .map((item) => item.providerId)
          .filter((configuredId) => !providerId || configuredId === providerId),
      ),
    ] as BoardProviderId[];
    if (providerId && !unique.includes(providerId))
      throw new ApplicationError(
        'PBI_PROVIDER_CONFIG',
        `Configure ${providerId} in Integrations first.`,
        400,
      );
    const results = [] as { providerId: string; imported: number; error?: string }[];
    for (const providerId of unique) {
      try {
        const remote = await (await this.provider(workspaceId, providerId)).pull();
        const imported = await this.importHierarchy(workspaceId, providerId, remote);
        results.push({ providerId, imported });
      } catch (error) {
        results.push({
          providerId,
          imported: 0,
          error: error instanceof Error ? error.message : 'Pull failed.',
        });
      }
    }
    return includeItems ? { results, items: await this.store.list(workspaceId) } : { results };
  }
  async syncChildren(workspaceId: string, id: string): Promise<PbiItem[]> {
    const item = await this.get(workspaceId, id);
    const link = item.links.find((entry) => entry.providerId === 'azure_devops');
    if (!link) return this.store.list(workspaceId);
    const provider = await this.provider(workspaceId, 'azure_devops');
    const children = (await provider.pullChildren?.(link.externalId)) ?? [];
    await this.importHierarchy(workspaceId, 'azure_devops', children);
    return this.store.list(workspaceId);
  }
  private async parentExternalId(
    workspaceId: string,
    item: PbiItem,
    providerId: BoardProviderId,
  ): Promise<string | undefined> {
    if (!item.parentId) return undefined;
    const parent = await this.get(workspaceId, item.parentId);
    return parent.links.find((link) => link.providerId === providerId)?.externalId;
  }
  /**
   * Describes what must be confirmed to push the item: destination fields and ADK values
   * (assignee, state) mapped to the provider. `values` are the choices made so far.
   */
  async pushContract(
    workspaceId: string,
    id: string,
    providerId: BoardProviderId,
    values: Record<string, string> = {},
    assignee: PushAssignee | null = null,
  ): Promise<PushContract> {
    const item = await this.get(workspaceId, id);
    const existing = item.links.find((link) => link.providerId === providerId);
    const provider = await this.provider(workspaceId, providerId);
    const fields = await provider.pushContract({
      item,
      values,
      assignee,
      externalId: existing?.externalId,
      parentExternalId: await this.parentExternalId(workspaceId, item, providerId),
    });
    return { providerId, update: Boolean(existing), fields };
  }
  async fieldCatalog(
    workspaceId: string,
    providerId: BoardProviderId,
    scope?: string,
    itemType?: string,
  ) {
    const provider = await this.provider(workspaceId, providerId);
    if (!provider.listFields)
      throw new ApplicationError(
        'FIELD_MAPPING_UNSUPPORTED',
        'Provider does not expose field definitions.',
        400,
      );
    return provider.listFields(scope, itemType);
  }
  async previewFields(
    workspaceId: string,
    id: string,
    providerId: BoardProviderId,
    templateId: string,
    scope = '',
    itemType = '',
  ) {
    const item = await this.get(workspaceId, id);
    const template = await this.fieldMappings.get(workspaceId, templateId);
    if (
      !template ||
      template.entityType !== 'pbi' ||
      template.providerId !== providerId ||
      (template.scope && template.scope !== scope) ||
      (template.itemType && template.itemType !== itemType)
    )
      throw new ApplicationError(
        'FIELD_MAPPING_INVALID',
        'Template does not match this destination.',
        400,
      );
    const definitions = await this.fieldCatalog(workspaceId, providerId, scope, itemType);
    return { definitions, values: resolveFieldMapping(item, template, definitions) };
  }
  async push(
    workspaceId: string,
    id: string,
    options: PushOptions,
    assignee: PushAssignee | null = null,
  ): Promise<{ item: PbiItem; warnings: string[] }> {
    const item = await this.get(workspaceId, id);
    const existing = item.links.find((link) => link.providerId === options.providerId);
    const provider = await this.provider(workspaceId, options.providerId);
    const parentExternalId = await this.parentExternalId(workspaceId, item, options.providerId);
    // Older clients send the destination as top-level options; map them onto contract fields.
    const values: Record<string, string> = {
      ...(options.boardId ? { board: options.boardId } : {}),
      ...(options.listId ? { list: options.listId } : {}),
      ...(options.issueType
        ? { [options.providerId === 'jira' ? 'issueType' : 'workItemType']: options.issueType }
        : {}),
      ...options.fields,
    };
    const contract = await provider.pushContract({
      item,
      values,
      assignee,
      externalId: existing?.externalId,
      parentExternalId,
    });
    const missing = missingFields(contract);
    if (missing.length)
      throw new ApplicationError(
        'PBI_PUSH_FIELDS',
        `Missing push fields: ${missing.join(', ')}`,
        400,
        missing.map((field) => ({ field })),
        { fields: missing.join(', ') },
      );
    const fields = fieldValues(contract);
    let customFields: Record<string, FieldValue> = {};
    let fieldDefinitions;
    if (options.templateId) {
      const configured = (await this.availableProviders(workspaceId)).find(
        (entry) => entry.providerId === options.providerId,
      );
      const setting = configured?.settings ?? {};
      const scope =
        fields.board ??
        fields.project ??
        (typeof setting.project === 'string' ? setting.project : undefined) ??
        (typeof setting.projectKey === 'string' ? setting.projectKey : undefined) ??
        (typeof setting.boardId === 'string' ? setting.boardId : undefined) ??
        (typeof setting.projectNumber === 'string' ? setting.projectNumber : undefined) ??
        existing?.boardId ??
        '';
      const preview = await this.previewFields(
        workspaceId,
        item.id,
        options.providerId,
        options.templateId,
        scope,
        fields.workItemType ?? fields.issueType ?? '',
      );
      customFields = preview.values;
      fieldDefinitions = preview.definitions;
    }
    if (item.parentId && !parentExternalId && !fields.list && !options.listId && !existing)
      throw new ApplicationError(
        'PBI_PARENT_NOT_LINKED',
        'Push the parent PBI first or select a destination list.',
        400,
      );
    const remote = await provider.push(item, {
      boardId: options.boardId,
      listId: options.listId,
      issueType: options.issueType,
      fields,
      customFields,
      fieldDefinitions,
      parentExternalId,
      externalId: existing?.externalId,
    });
    await this.store.link(workspaceId, item.id, {
      providerId: options.providerId,
      externalId: remote.externalId,
      externalUrl: remote.externalUrl ?? existing?.externalUrl ?? null,
      boardId: remote.boardId ?? existing?.boardId ?? null,
    });
    const mirrored = Object.fromEntries(
      pushedSourceKeys
        .filter((key) => remote.sourceData[key] !== undefined)
        .map((key) => [key, remote.sourceData[key]]),
    );
    const saved = (await this.store.update(workspaceId, item.id, {
      status: remote.status,
      sourceData: mergeImportedFields(
        item.sourceData,
        {
          ...mirrored,
          ...(Object.keys(customFields).length
            ? { customFields: { [options.providerId]: customFields } }
            : {}),
        },
        options.providerId,
      ),
    }))!;
    await this.record(workspaceId, [updated(item, saved)]);
    const warnings: string[] = [];
    if (provider.syncLinks) {
      const links = await this.providerLinks(workspaceId, saved.id, options.providerId);
      try {
        await provider.syncLinks(remote.externalId, links);
      } catch (error) {
        warnings.push(
          `Links were not published: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { item: saved, warnings };
  }
  /** ADK links whose other item already exists on the provider, as provider links. */
  private async providerLinks(
    workspaceId: string,
    id: string,
    providerId: string,
  ): Promise<ExternalLink[]> {
    const relations = await this.relationStore.list(workspaceId, id);
    const others = await this.store.getMany(
      workspaceId,
      relations.map((relation) =>
        relation.sourceId === id ? relation.targetId : relation.sourceId,
      ),
    );
    const externalIds = new Map(
      others.map((other) => [
        other.id,
        other.links.find((link) => link.providerId === providerId)?.externalId,
      ]),
    );
    return relations.flatMap((relation) => {
      const otherId = relation.sourceId === id ? relation.targetId : relation.sourceId;
      const externalId = externalIds.get(otherId);
      return externalId ? [{ type: relationTypeFor(relation, id), externalId }] : [];
    });
  }

  /** Every link of the item: hierarchy, links managed in ADK and links read from Azure. */
  async relations(workspaceId: string, id: string): Promise<PbiRelationView[]> {
    const item = await this.get(workspaceId, id);
    const views: PbiRelationView[] = [];
    if (item.parentId) {
      const parent = await this.store.get(workspaceId, item.parentId);
      if (parent) views.push({ type: 'parent', origin: 'adk', item: summary(parent) });
    }
    for (const child of await this.store.listChildren(workspaceId, item.id))
      views.push({ type: 'child', origin: 'adk', item: summary(child) });
    const stored = await this.relationStore.list(workspaceId, item.id);
    const others = new Map(
      (
        await this.store.getMany(
          workspaceId,
          stored.map((relation) =>
            relation.sourceId === item.id ? relation.targetId : relation.sourceId,
          ),
        )
      ).map((other) => [other.id, other]),
    );
    for (const relation of stored) {
      const other = others.get(
        relation.sourceId === item.id ? relation.targetId : relation.sourceId,
      );
      if (other)
        views.push({
          type: relationTypeFor(relation, item.id),
          origin: 'adk',
          item: summary(other),
        });
    }
    const remote: ExternalLink[] = [
      ...(Array.isArray(item.sourceData.relatedExternalIds)
        ? item.sourceData.relatedExternalIds
            .filter((externalId): externalId is string => typeof externalId === 'string')
            .map((externalId) => ({ type: 'related' as const, externalId }))
        : []),
      ...(Array.isArray(item.sourceData.externalLinks)
        ? (item.sourceData.externalLinks as unknown[]).filter(
            (link): link is ExternalLink =>
              !!link &&
              typeof link === 'object' &&
              typeof (link as ExternalLink).externalId === 'string' &&
              pbiLinkTypes.includes((link as ExternalLink).type),
          )
        : []),
    ];
    for (const link of remote) {
      const other = await this.store.findByExternal(workspaceId, 'azure_devops', link.externalId);
      if (views.some((view) => view.type === link.type && view.item && view.item.id === other?.id))
        continue;
      views.push({
        type: link.type,
        origin: 'azure_devops',
        item: other ? summary(other) : null,
        ...(other ? {} : { externalId: link.externalId }),
      });
    }
    return views;
  }
  private relationLabels(views: readonly PbiRelationView[]): string[] {
    return views
      .filter((view) => view.origin === 'adk' && view.item)
      .map((view) => `${view.type}: ${view.item!.title}`)
      .sort();
  }
  /** Moves an item under a new parent (or to the root), keeping the hierarchy acyclic. */
  private async setParent(workspaceId: string, item: PbiItem, parentId: string | null) {
    let ancestorId = parentId;
    while (ancestorId) {
      if (ancestorId === item.id) throw linkInvalid('The hierarchy cannot contain a cycle.');
      ancestorId = (await this.get(workspaceId, ancestorId)).parentId;
    }
    const saved = (await this.store.update(workspaceId, item.id, {
      parentId,
      kind: parentId ? 'card' : 'pbi',
    }))!;
    await this.record(workspaceId, [updated(item, saved)]);
  }
  async addRelations(
    workspaceId: string,
    id: string,
    type: PbiLinkType,
    targetIds: readonly string[],
    actorId: string | null = null,
  ): Promise<PbiRelationView[]> {
    const item = await this.get(workspaceId, id);
    const targets: PbiItem[] = [];
    for (const targetId of new Set(targetIds)) {
      const target = await this.get(workspaceId, targetId);
      if (target.id === item.id) throw linkInvalid('An item cannot be linked to itself.');
      if (!targets.some((entry) => entry.id === target.id)) targets.push(target);
    }
    if (!targets.length) throw linkInvalid('Choose at least one item to link.');
    const before = this.relationLabels(await this.relations(workspaceId, item.id));
    if (type === 'parent') {
      if (targets.length !== 1) throw linkInvalid('An item can have only one parent.');
      await this.setParent(workspaceId, item, targets[0]!.id);
    } else if (type === 'child') {
      for (const target of targets) await this.setParent(workspaceId, target, item.id);
    } else {
      for (const target of targets)
        await this.relationStore.add(
          workspaceId,
          canonicalRelation(item.id, type, target.id),
          actorId,
        );
    }
    const views = await this.relations(workspaceId, item.id);
    await this.record(workspaceId, [
      diffChange(
        'pbi',
        item.id,
        { title: item.title, relations: before },
        { title: item.title, relations: this.relationLabels(views) },
      ),
    ]);
    return views;
  }
  async removeRelation(
    workspaceId: string,
    id: string,
    type: PbiLinkType,
    targetId: string,
  ): Promise<PbiRelationView[]> {
    const item = await this.get(workspaceId, id);
    const target = await this.get(workspaceId, targetId);
    const before = this.relationLabels(await this.relations(workspaceId, item.id));
    let removed = false;
    if (type === 'parent' && item.parentId === target.id) {
      await this.setParent(workspaceId, item, null);
      removed = true;
    } else if (type === 'child' && target.parentId === item.id) {
      await this.setParent(workspaceId, target, null);
      removed = true;
    } else if (type !== 'parent' && type !== 'child') {
      removed = await this.relationStore.remove(
        workspaceId,
        canonicalRelation(item.id, type, target.id),
      );
    }
    if (!removed) throw linkInvalid('Link not found.', 404);
    const views = await this.relations(workspaceId, item.id);
    await this.record(workspaceId, [
      diffChange(
        'pbi',
        item.id,
        { title: item.title, relations: before },
        { title: item.title, relations: this.relationLabels(views) },
      ),
    ]);
    return views;
  }
}
