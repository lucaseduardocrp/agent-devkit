import { ApplicationError } from '../../shared/errors.js';
import {
  matchState,
  matchUser,
  selectField,
  type PushContext,
  type PushField,
  type StateCategory,
} from './push-contract.js';
import type { PbiLinkType } from './pbi-relations.js';
import { attachmentKindFromName, type Attachment } from '../shared/attachment.js';
import type { FieldDefinition, FieldValue } from '../field-mapping/field-mapping.js';

export interface RemotePbiItem {
  externalId: string;
  parentExternalId: string | null;
  kind: 'pbi' | 'card';
  title: string;
  description: string;
  status: string;
  position: number;
  externalUrl: string | null;
  boardId: string | null;
  sourceData: Record<string, unknown>;
  /** Files attached on the provider; they stay hosted there. */
  attachments?: Attachment[];
}
export interface PbiComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}
export interface PushItem {
  kind: 'pbi' | 'card';
  title: string;
  description: string;
  status: string;
  sourceData?: Record<string, unknown>;
}
export interface PushProviderOptions {
  boardId?: string;
  parentExternalId?: string;
  listId?: string;
  issueType?: string;
  externalId?: string;
  /** Values confirmed in the push contract, keyed by field. */
  fields?: Record<string, string>;
  customFields?: Record<string, FieldValue>;
  fieldDefinitions?: readonly FieldDefinition[];
}
export interface ExternalLink {
  type: PbiLinkType;
  externalId: string;
}
export interface PbiProvider {
  readonly id: string;
  pull(): Promise<RemotePbiItem[]>;
  pullChildren?(externalId: string): Promise<RemotePbiItem[]>;
  currentIteration?(): Promise<string | null>;
  comments?(externalId: string): Promise<PbiComment[]>;
  /** Fields that must be confirmed before pushing, with ADK values mapped to the provider. */
  pushContract(context: PushContext): Promise<PushField[]>;
  /** Fields available in the selected project, board and item type. */
  listFields?(scope?: string, itemType?: string): Promise<FieldDefinition[]>;
  push(item: PushItem, options: PushProviderOptions): Promise<RemotePbiItem>;
  /** Adds the given non-hierarchy links to an external item when they are missing. */
  syncLinks?(externalId: string, links: readonly ExternalLink[]): Promise<void>;
}
export interface PbiProviderConfig {
  id: string;
  settings: Record<string, unknown>;
  secret: string;
}
function setting(settings: Record<string, unknown>, key: string): string {
  const value = settings[key];
  return typeof value === 'string' ? value.trim() : '';
}
function configError(detail: string, status = 400): ApplicationError {
  return new ApplicationError('PBI_PROVIDER_CONFIG', detail, status, [], { detail });
}
function providerError(detail: string): ApplicationError {
  return new ApplicationError('PBI_PROVIDER_ERROR', detail, 502, [], { detail });
}
/** Extracts the readable message of a provider error body (JSON `message` or the raw text). */
function errorDetail(status: number, body: string): string {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      errorMessages?: unknown;
      errors?: unknown;
    };
    const jiraMessages = Array.isArray(parsed.errorMessages) ? parsed.errorMessages : [];
    const jiraErrors =
      parsed.errors && typeof parsed.errors === 'object' && !Array.isArray(parsed.errors)
        ? Object.entries(parsed.errors as Record<string, unknown>).map(
            ([field, value]) => `${field}: ${String(value)}`,
          )
        : [];
    const candidates = [
      typeof parsed.message === 'string' ? parsed.message : '',
      ...jiraMessages.map(String),
      ...jiraErrors,
    ].filter(Boolean);
    if (candidates.length) message = candidates.join(' · ');
  } catch {
    // Not JSON: keep the text body.
  }
  return `HTTP ${status}${message ? ` - ${message.slice(0, 300)}` : ''}`;
}
async function request<T>(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetcher(url, init);
  if (!response.ok) throw providerError(errorDetail(response.status, await response.text()));
  return response.json() as Promise<T>;
}
interface AzureRelation {
  rel: string;
  url: string;
  attributes?: { name?: string };
}
/** Files attached to an Azure DevOps work item, kept as links to Azure. */
function azureAttachments(relations: readonly AzureRelation[] | undefined): Attachment[] {
  return (relations ?? [])
    .filter((relation) => relation.rel === 'AttachedFile' && relation.url.startsWith('https://'))
    .map((relation) => {
      const name = relation.attributes?.name?.trim() || relation.url.split('/').pop() || 'file';
      const url = new URL(relation.url);
      url.searchParams.set('fileName', name);
      return {
        id: `provider:${relation.url}`,
        name,
        kind: attachmentKindFromName(name),
        scope: 'pbi',
        source: 'url',
        url: url.toString(),
      } satisfies Attachment;
    });
}
function basic(token: string): string {
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const azureCoreFields = new Set([
  'System.Id',
  'System.Title',
  'System.Description',
  'System.State',
  'System.WorkItemType',
  'System.AreaPath',
  'System.IterationPath',
  'System.Tags',
  'System.AssignedTo',
  'System.Parent',
]);
function azureFieldValues(fields: Record<string, unknown>): Record<string, FieldValue> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        !azureCoreFields.has(key) &&
        key !== 'Microsoft.VSTS.TCM.Steps' &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null),
    ),
  ) as Record<string, FieldValue>;
}

function fieldType(type: string): FieldDefinition['type'] {
  const value = type.toLowerCase();
  if (['integer', 'double', 'number', 'float'].includes(value)) return 'number';
  if (['boolean', 'checkbox'].includes(value)) return 'boolean';
  if (['datetime', 'date'].includes(value)) return 'date';
  if (['picklist', 'single_select', 'list', 'option'].includes(value)) return 'single_select';
  if (['multiselect', 'multi_select', 'array'].includes(value)) return 'multi_select';
  return 'text';
}
function jiraCustomValue(value: unknown): FieldValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) {
    const entries = value.map(jiraCustomValue);
    return entries.every((entry): entry is string => typeof entry === 'string')
      ? entries
      : undefined;
  }
  if (value && typeof value === 'object') {
    const option = value as { id?: unknown; value?: unknown; accountId?: unknown };
    const selected = option.id ?? option.accountId ?? option.value;
    if (typeof selected === 'string' || typeof selected === 'number') return String(selected);
  }
  return undefined;
}
function toPlainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toPlainText).join('');
  if (!value || typeof value !== 'object') return '';
  const node = value as { type?: string; text?: string; content?: unknown };
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'text') return node.text ?? '';
  const content = toPlainText(node.content);
  return ['paragraph', 'heading', 'listItem'].includes(node.type ?? '') ? `${content}\n` : content;
}
function assigneeSource(context: PushContext): string | undefined {
  const assignee = context.assignee;
  if (!assignee) return undefined;
  return assignee.email ? `${assignee.name} <${assignee.email}>` : assignee.name;
}
/** Picks the preferred type name present in the provider list (case insensitive). */
function preferType(names: readonly string[], ...wanted: unknown[]): string | null {
  for (const candidate of wanted) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const found = names.find((name) => name.toLowerCase() === candidate.trim().toLowerCase());
    if (found) return found;
  }
  return null;
}

/** Azure work item types that are not backlog items. */
const hiddenAzureTypes = new Set([
  'test case',
  'test plan',
  'test suite',
  'shared steps',
  'shared parameter',
  'code review request',
  'code review response',
  'feedback request',
  'feedback response',
]);
const azureCategories: Record<string, StateCategory> = {
  Proposed: 'proposed',
  InProgress: 'inProgress',
  Completed: 'done',
  Removed: 'removed',
};
/** Azure relation names for each ADK link type, seen from the item being pushed. */
export const azureLinkRelations: Record<PbiLinkType, string> = {
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  child: 'System.LinkTypes.Hierarchy-Forward',
  related: 'System.LinkTypes.Related',
  predecessor: 'System.LinkTypes.Dependency-Reverse',
  successor: 'System.LinkTypes.Dependency-Forward',
  duplicate: 'System.LinkTypes.Duplicate-Forward',
  duplicate_of: 'System.LinkTypes.Duplicate-Reverse',
  tests: 'Microsoft.VSTS.Common.TestedBy-Reverse',
  tested_by: 'Microsoft.VSTS.Common.TestedBy-Forward',
};
const azureLinkTypes = new Map(
  Object.entries(azureLinkRelations).map(([type, rel]) => [rel, type as PbiLinkType]),
);
const typedAzureLinks = new Set(
  [...azureLinkTypes.entries()]
    .filter(([, type]) => !['parent', 'child', 'related'].includes(type))
    .map(([rel]) => rel),
);

export function createPbiProvider(
  config: PbiProviderConfig,
  fetcher: typeof fetch = fetch,
): PbiProvider {
  const s = config.settings;
  const token = config.secret;
  if (!token) throw configError('Provider credential is missing.');
  if (config.id === 'azure_devops') {
    const organization = setting(s, 'organization');
    const project = setting(s, 'project');
    if (!organization || !project)
      throw configError('Azure organization and project are required.');
    const organizationBase = `https://dev.azure.com/${encodeURIComponent(organization)}`;
    const base = `${organizationBase}/${encodeURIComponent(project)}`;
    const headers = { authorization: basic(token), accept: 'application/json' };
    const workItemUrl = (id: string) =>
      `${organizationBase}/_apis/wit/workItems/${encodeURIComponent(id)}`;
    const currentIteration = async (): Promise<string | null> => {
      const response = await request<{ values?: { path?: string }[] }>(
        fetcher,
        `${base}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`,
        { headers },
      );
      return response.values?.[0]?.path ?? null;
    };
    interface ClassificationNode {
      name: string;
      attributes?: { startDate?: string; finishDate?: string };
      children?: ClassificationNode[];
    }
    const classification = async (group: 'iterations' | 'areas') => {
      const root = await request<ClassificationNode>(
        fetcher,
        `${base}/_apis/wit/classificationnodes/${group}?$depth=20&api-version=7.1`,
        { headers },
      );
      const nodes: { path: string; detail?: string }[] = [];
      const visit = (node: ClassificationNode, parent: string) => {
        const path = parent ? `${parent}\\${node.name}` : node.name;
        const start = node.attributes?.startDate?.slice(0, 10);
        const finish = node.attributes?.finishDate?.slice(0, 10);
        nodes.push({ path, ...(start && finish ? { detail: `${start} → ${finish}` } : {}) });
        for (const child of node.children ?? []) visit(child, path);
      };
      visit(root, '');
      return nodes;
    };
    const members = async () => {
      const teams = await request<{ value?: { id: string }[] }>(
        fetcher,
        `${organizationBase}/_apis/projects/${encodeURIComponent(project)}/teams?api-version=7.1`,
        { headers },
      );
      const users = new Map<string, { value: string; label: string; email: string }>();
      const pages = await Promise.all(
        (teams.value ?? []).map((team) =>
          request<{
            value?: { identity?: { displayName?: string; uniqueName?: string } }[];
          }>(
            fetcher,
            `${organizationBase}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(team.id)}/members?$top=1000&api-version=7.1`,
            { headers },
          ),
        ),
      );
      for (const page of pages)
        for (const member of page.value ?? []) {
          const email = member.identity?.uniqueName?.trim() ?? '';
          const label = member.identity?.displayName?.trim() || email;
          if (email && !users.has(email.toLowerCase()))
            users.set(email.toLowerCase(), { value: email, label, email });
        }
      return [...users.values()].sort((a, b) => a.label.localeCompare(b.label));
    };
    const workItemTypes = async () =>
      (
        await request<{
          value: {
            name: string;
            isDisabled?: boolean;
            states?: { name: string; category?: string }[];
          }[];
        }>(fetcher, `${base}/_apis/wit/workitemtypes?api-version=7.1`, { headers })
      ).value.filter((type) => !type.isDisabled && !hiddenAzureTypes.has(type.name.toLowerCase()));
    return {
      id: config.id,
      currentIteration,
      async listFields(_scope, itemType) {
        const selectedType = itemType || 'Test Case';
        const [type, catalog] = await Promise.all([
          // Azure only returns picklist values for this endpoint when they are expanded.
          request<{
            value?: {
              name: string;
              referenceName: string;
              alwaysRequired?: boolean;
              allowedValues?: string[];
            }[];
          }>(
            fetcher,
            `${base}/_apis/wit/workitemtypes/${encodeURIComponent(selectedType)}/fields?$expand=allowedValues&api-version=7.1`,
            { headers },
          ),
          request<{ value?: { referenceName: string; type?: string; readOnly?: boolean }[] }>(
            fetcher,
            `${organizationBase}/_apis/wit/fields?api-version=7.1`,
            { headers },
          ),
        ]);
        const details = new Map((catalog.value ?? []).map((field) => [field.referenceName, field]));
        return (type.value ?? [])
          .filter(
            (field) =>
              !azureCoreFields.has(field.referenceName) &&
              field.referenceName !== 'Microsoft.VSTS.TCM.Steps',
          )
          .map((field): FieldDefinition => ({
            id: field.referenceName,
            name: field.name,
            type: field.allowedValues?.length
              ? 'single_select'
              : fieldType(details.get(field.referenceName)?.type ?? 'string'),
            required: field.alwaysRequired ?? false,
            readOnly: details.get(field.referenceName)?.readOnly ?? false,
            ...(field.allowedValues?.length
              ? { options: field.allowedValues.map((name) => ({ id: name, name })) }
              : {}),
          }));
      },
      async comments(externalId) {
        const comments: PbiComment[] = [];
        const seenTokens = new Set<string>();
        let continuationToken: string | null = null;
        do {
          const params = new URLSearchParams({
            $top: '200',
            $expand: 'renderedText',
            order: 'asc',
            'api-version': '7.1-preview.4',
          });
          if (continuationToken) params.set('continuationToken', continuationToken);
          const page = await request<{
            comments: {
              commentId?: number;
              id?: number;
              text?: string;
              renderedText?: string;
              createdDate: string;
              createdBy?: { displayName?: string };
              isDeleted?: boolean;
            }[];
            continuationToken?: string | null;
          }>(
            fetcher,
            `${base}/_apis/wit/workItems/${encodeURIComponent(externalId)}/comments?${params}`,
            { headers },
          );
          for (const comment of page.comments) {
            if (comment.isDeleted) continue;
            comments.push({
              id: String(comment.commentId ?? comment.id),
              body: comment.renderedText ?? comment.text ?? '',
              author: comment.createdBy?.displayName ?? 'Azure DevOps',
              createdAt: comment.createdDate,
            });
          }
          const next = page.continuationToken ?? null;
          if (next && seenTokens.has(next)) throw providerError('Repeated comment page token.');
          if (next) seenTokens.add(next);
          continuationToken = next;
        } while (continuationToken);
        return comments;
      },
      async pull() {
        const results: RemotePbiItem[] = [];
        let currentIterationPath: string | undefined;
        try {
          currentIterationPath = (await currentIteration()) ?? undefined;
        } catch {
          // Iteration metadata is optional; keep syncing work items if unavailable.
        }
        const projectFilter =
          `[System.TeamProject] = '${project.replace(/'/g, "''")}' AND ` +
          `[System.WorkItemType] <> 'Test Case' AND [System.Title] <> 'EXCLUIR'`;
        const queryIds = (query: string, top?: number) =>
          request<{ workItems: { id: number }[] }>(
            fetcher,
            `${base}/_apis/wit/wiql?api-version=7.1${top ? `&$top=${top}` : ''}`,
            {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({ query }),
            },
          );
        const latest = await queryIds(
          `SELECT [System.Id] FROM WorkItems WHERE ${projectFilter} ORDER BY [System.Id] DESC`,
          1,
        );
        const maxId = latest.workItems[0]?.id ?? 0;
        const forwardParents = new Map<string, string>();
        const relatedIds = new Map<string, Set<string>>();
        const typedLinks = new Map<string, Map<string, ExternalLink>>();
        const addRelated = (sourceId: string, targetId: string) => {
          if (sourceId === targetId) return;
          if (!relatedIds.has(sourceId)) relatedIds.set(sourceId, new Set());
          relatedIds.get(sourceId)!.add(targetId);
        };
        const addTyped = (sourceId: string, rel: string, targetId: string) => {
          const type = azureLinkTypes.get(rel)!;
          if (!typedLinks.has(sourceId)) typedLinks.set(sourceId, new Map());
          typedLinks.get(sourceId)!.set(`${type}:${targetId}`, { type, externalId: targetId });
        };
        const ranges = maxId > 0 ? [{ after: 0, through: maxId }] : [];
        while (ranges.length) {
          const { after, through } = ranges.pop()!;
          let ids: number[];
          try {
            const wiql = await queryIds(
              `SELECT [System.Id] FROM WorkItems WHERE ${projectFilter} AND [System.Id] > ${after} AND [System.Id] <= ${through} ORDER BY [System.Id]`,
            );
            ids = wiql.workItems.map((item) => item.id);
          } catch (error) {
            if (
              !(error instanceof ApplicationError) ||
              !error.message.includes('VS402337') ||
              through - after <= 1
            )
              throw error;
            const middle = Math.floor((after + through) / 2);
            ranges.push({ after: middle, through }, { after, through: middle });
            continue;
          }
          // Azure may truncate a 20,000-item response without an error.
          if (ids.length >= 20000 && through - after > 1) {
            const middle = Math.floor((after + through) / 2);
            ranges.push({ after: middle, through }, { after, through: middle });
            continue;
          }
          for (let index = 0; index < ids.length; index += 200) {
            const chunk = ids.slice(index, index + 200);
            const data = await request<{
              value: {
                id: number;
                fields: Record<string, unknown>;
                relations?: AzureRelation[];
                url: string;
              }[];
            }>(fetcher, `${base}/_apis/wit/workitemsbatch?api-version=7.1`, {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({ ids: chunk, $expand: 'relations' }),
            });
            for (const row of data.value) {
              const fields = row.fields;
              for (const relation of row.relations ?? []) {
                if (relation.rel === 'System.LinkTypes.Hierarchy-Forward') {
                  const childId = relation.url.split('/').pop();
                  if (childId) forwardParents.set(childId, String(row.id));
                }
                if (relation.rel === 'System.LinkTypes.Related') {
                  const relatedId = relation.url.split('/').pop();
                  if (relatedId) {
                    addRelated(String(row.id), relatedId);
                    addRelated(relatedId, String(row.id));
                  }
                }
                const targetId = relation.url.split('/').pop();
                if (typedAzureLinks.has(relation.rel) && targetId)
                  addTyped(String(row.id), relation.rel, targetId);
              }
              const parent = row.relations?.find(
                (relation) => relation.rel === 'System.LinkTypes.Hierarchy-Reverse',
              );
              const parentField = fields['System.Parent'];
              const type = text(fields['System.WorkItemType']);
              const title = text(fields['System.Title']);
              if (
                type.trim().toLocaleLowerCase() === 'test case' ||
                title.trim().toLocaleLowerCase() === 'excluir'
              )
                continue;
              results.push({
                externalId: String(row.id),
                parentExternalId:
                  parent?.url.split('/').pop() ??
                  (typeof parentField === 'number' || typeof parentField === 'string'
                    ? String(parentField)
                    : null),
                kind: ['Task', 'Bug'].includes(type) ? 'card' : 'pbi',
                title,
                description: text(fields['System.Description']),
                status: text(fields['System.State']) || 'backlog',
                position: results.length,
                externalUrl: `${base}/_workitems/edit/${row.id}`,
                boardId: project,
                attachments: azureAttachments(row.relations),
                sourceData: {
                  customFields: { azure_devops: azureFieldValues(fields) },
                  type,
                  areaPath: fields['System.AreaPath'],
                  iterationPath: fields['System.IterationPath'],
                  ...(currentIterationPath &&
                  text(fields['System.IterationPath']) === currentIterationPath
                    ? { currentIteration: true }
                    : {}),
                  tags: fields['System.Tags'],
                  ...(text(
                    (fields['System.AssignedTo'] as { uniqueName?: string } | undefined)
                      ?.uniqueName,
                  )
                    ? {
                        assignedTo: (fields['System.AssignedTo'] as { uniqueName: string })
                          .uniqueName,
                      }
                    : {}),
                },
              });
            }
          }
        }
        if (results.some((item) => item.kind === 'pbi')) {
          // Pulled work items imply maxId > 0, so the whole id range is always queried.
          const linkRanges = [{ after: 0, through: maxId }];
          while (linkRanges.length) {
            const { after, through } = linkRanges.pop()!;
            let links: { source?: { id: number }; target?: { id: number }; rel?: string }[];
            try {
              const query =
                `SELECT [System.Id] FROM WorkItemLinks WHERE ` +
                `([Source].[System.TeamProject] = '${project.replace(/'/g, "''")}' ` +
                `AND [Source].[System.Id] > ${after} AND [Source].[System.Id] <= ${through}) ` +
                `AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' ` +
                `OR [System.Links.LinkType] = 'System.LinkTypes.Related') ` +
                `AND ([Target].[System.TeamProject] = '${project.replace(/'/g, "''")}') ` +
                `MODE (MustContain)`;
              const page = await request<{
                workItemRelations?: typeof links;
              }>(fetcher, `${base}/_apis/wit/wiql?api-version=7.1`, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ query }),
              });
              links = page.workItemRelations ?? [];
            } catch (error) {
              if (
                !(error instanceof ApplicationError) ||
                !error.message.includes('VS402337') ||
                through - after <= 1
              )
                throw error;
              const middle = Math.floor((after + through) / 2);
              linkRanges.push({ after: middle, through }, { after, through: middle });
              continue;
            }
            if (links.length >= 20000 && through - after > 1) {
              const middle = Math.floor((after + through) / 2);
              linkRanges.push({ after: middle, through }, { after, through: middle });
              continue;
            }
            for (const link of links) {
              if (!link.source?.id || !link.target?.id) continue;
              if (!link.rel || link.rel === 'System.LinkTypes.Hierarchy-Forward')
                forwardParents.set(String(link.target.id), String(link.source.id));
              if (link.rel === 'System.LinkTypes.Related') {
                addRelated(String(link.source.id), String(link.target.id));
                addRelated(String(link.target.id), String(link.source.id));
              }
            }
          }
        }
        for (const item of results) {
          if (!item.parentExternalId)
            item.parentExternalId = forwardParents.get(item.externalId) ?? null;
          item.sourceData.relatedExternalIds = [...(relatedIds.get(item.externalId) ?? [])];
          const typed = typedLinks.get(item.externalId);
          if (typed) item.sourceData.externalLinks = [...typed.values()];
        }
        return results;
      },
      async pullChildren(externalId) {
        const root = await request<{
          relations?: { rel: string; url: string }[];
        }>(
          fetcher,
          `${base}/_apis/wit/workitems/${encodeURIComponent(externalId)}?$expand=relations&api-version=7.1`,
          { headers },
        );
        const pending = (root.relations ?? [])
          .filter((relation) => relation.rel === 'System.LinkTypes.Hierarchy-Forward')
          .map((relation) => ({ id: relation.url.split('/').pop()!, parentId: externalId }));
        const seen = new Set([externalId]);
        const results: RemotePbiItem[] = [];
        while (pending.length) {
          const batch = pending.splice(0, 200).filter(({ id }) => {
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          if (!batch.length) continue;
          const data = await request<{
            value: {
              id: number;
              fields: Record<string, unknown>;
              relations?: AzureRelation[];
            }[];
          }>(fetcher, `${base}/_apis/wit/workitemsbatch?api-version=7.1`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              ids: batch.map(({ id }) => Number(id)),
              $expand: 'relations',
              errorPolicy: 'Omit',
            }),
          });
          const parentById = new Map(batch.map(({ id, parentId }) => [id, parentId]));
          for (const row of data.value) {
            const fields = row.fields;
            const type = text(fields['System.WorkItemType']);
            const title = text(fields['System.Title']);
            if (
              type.trim().toLocaleLowerCase() === 'test case' ||
              title.trim().toLocaleLowerCase() === 'excluir'
            )
              continue;
            results.push({
              externalId: String(row.id),
              parentExternalId: parentById.get(String(row.id)) ?? null,
              kind: 'card',
              title,
              description: text(fields['System.Description']),
              status: text(fields['System.State']) || 'backlog',
              position: results.length,
              externalUrl: `${base}/_workitems/edit/${row.id}`,
              boardId: project,
              attachments: azureAttachments(row.relations),
              sourceData: {
                customFields: { azure_devops: azureFieldValues(fields) },
                type,
                areaPath: fields['System.AreaPath'],
                iterationPath: fields['System.IterationPath'],
                tags: fields['System.Tags'],
                relatedExternalIds: (row.relations ?? [])
                  .filter((relation) => relation.rel === 'System.LinkTypes.Related')
                  .map((relation) => relation.url.split('/').pop()),
              },
            });
            for (const relation of row.relations ?? [])
              if (relation.rel === 'System.LinkTypes.Hierarchy-Forward') {
                const id = relation.url.split('/').pop();
                if (id && !seen.has(id)) pending.push({ id, parentId: String(row.id) });
              }
          }
        }
        return results;
      },
      async pushContract(context) {
        const [types, iterations, areas, users, current] = await Promise.all([
          workItemTypes(),
          classification('iterations'),
          classification('areas'),
          members(),
          currentIteration().catch(() => null),
        ]);
        const { item, values } = context;
        const typeNames = types.map((type) => type.name);
        const update = Boolean(context.externalId);
        const suggestedType = update
          ? preferType(typeNames, item.sourceData.type)
          : preferType(
              typeNames,
              item.sourceData.adkCardType,
              item.sourceData.type,
              ...(item.kind === 'pbi'
                ? ['Product Backlog Item', 'User Story', 'Requirement', 'Issue']
                : ['Task']),
            );
        const typeField = selectField({
          key: 'workItemType',
          label: 'Work item type',
          required: true,
          options: typeNames.map((name) => ({ value: name, label: name })),
          chosen: update ? undefined : values.workItemType,
          suggested: suggestedType,
          reloadOnChange: true,
          readOnly: update,
        });
        const states = (types.find((type) => type.name === typeField.value)?.states ?? []).map(
          (state) => ({ name: state.name, category: azureCategories[state.category ?? ''] }),
        );
        const iterationPath = text(item.sourceData.iterationPath);
        const areaPath = text(item.sourceData.areaPath);
        return [
          typeField,
          selectField({
            key: 'iterationPath',
            label: 'Iteration path',
            required: true,
            options: iterations.map((node) => ({
              value: node.path,
              label: node.path,
              detail: [node.detail, node.path === current ? 'current' : '']
                .filter(Boolean)
                .join(' · '),
            })),
            chosen: values.iterationPath,
            suggested: iterations.some((node) => node.path === iterationPath)
              ? iterationPath
              : null,
          }),
          selectField({
            key: 'areaPath',
            label: 'Area path',
            required: true,
            options: areas.map((node) => ({ value: node.path, label: node.path })),
            chosen: values.areaPath,
            suggested: areas.some((node) => node.path === areaPath)
              ? areaPath
              : (areas[0]?.path ?? null),
          }),
          selectField({
            key: 'assignee',
            label: 'Assigned to',
            required: Boolean(context.assignee),
            options: users.map((user) => ({
              value: user.value,
              label: user.label,
              detail: user.email,
            })),
            chosen: values.assignee,
            suggested: matchUser(context.assignee, users),
            source: assigneeSource(context),
          }),
          selectField({
            key: 'state',
            label: 'State',
            required: true,
            options: states.map((state) => ({ value: state.name, label: state.name })),
            chosen: values.state,
            suggested: matchState(item.status, states),
            source: item.status,
          }),
        ];
      },
      async push(item, options) {
        const fields = options.fields ?? {};
        const type =
          fields.workItemType ||
          options.issueType ||
          text(item.sourceData?.type) ||
          (item.kind === 'pbi' ? 'Product Backlog Item' : 'Task');
        const patch: { op: string; path: string; value: unknown }[] = [
          { op: 'add', path: '/fields/System.Title', value: item.title },
          { op: 'add', path: '/fields/System.Description', value: item.description },
        ];
        if (fields.iterationPath)
          patch.push({
            op: 'add',
            path: '/fields/System.IterationPath',
            value: fields.iterationPath,
          });
        if (fields.areaPath)
          patch.push({ op: 'add', path: '/fields/System.AreaPath', value: fields.areaPath });
        // An empty optional assignee leaves the provider value unchanged.
        if (fields.assignee)
          patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: fields.assignee });
        if (options.externalId && fields.state)
          patch.push({ op: 'add', path: '/fields/System.State', value: fields.state });
        for (const [id, value] of Object.entries(options.customFields ?? {}))
          patch.push({ op: 'add', path: `/fields/${id}`, value });
        if (options.parentExternalId && !options.externalId)
          patch.push({
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: workItemUrl(options.parentExternalId),
            },
          });
        let row = await request<{ id: number; fields?: Record<string, unknown> }>(
          fetcher,
          options.externalId
            ? `${base}/_apis/wit/workitems/${encodeURIComponent(options.externalId)}?api-version=7.1`
            : `${base}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`,
          {
            method: options.externalId ? 'PATCH' : 'POST',
            headers: { ...headers, 'content-type': 'application/json-patch+json' },
            body: JSON.stringify(patch),
          },
        );
        // New work items start in the initial state; move them afterwards when another was chosen.
        if (
          !options.externalId &&
          fields.state &&
          text(row.fields?.['System.State']) !== fields.state
        )
          row = await request<{ id: number; fields?: Record<string, unknown> }>(
            fetcher,
            `${base}/_apis/wit/workitems/${row.id}?api-version=7.1`,
            {
              method: 'PATCH',
              headers: { ...headers, 'content-type': 'application/json-patch+json' },
              body: JSON.stringify([
                { op: 'add', path: '/fields/System.State', value: fields.state },
              ]),
            },
          );
        return {
          externalId: String(row.id),
          parentExternalId: options.parentExternalId ?? null,
          kind: item.kind,
          title: item.title,
          description: item.description,
          status: text(row.fields?.['System.State']) || fields.state || item.status,
          position: 0,
          externalUrl: `${base}/_workitems/edit/${row.id}`,
          boardId: project,
          sourceData: {
            type,
            ...(fields.iterationPath ? { iterationPath: fields.iterationPath } : {}),
            ...(fields.areaPath ? { areaPath: fields.areaPath } : {}),
            ...(fields.assignee ? { assignedTo: fields.assignee } : {}),
          },
        };
      },
      async syncLinks(externalId, links) {
        if (!links.length) return;
        const current = await request<{ relations?: { rel: string; url: string }[] }>(
          fetcher,
          `${base}/_apis/wit/workitems/${encodeURIComponent(externalId)}?$expand=relations&api-version=7.1`,
          { headers },
        );
        const existing = new Set(
          (current.relations ?? []).map(
            (relation) => `${relation.rel}:${relation.url.split('/').pop()}`,
          ),
        );
        const patch = links
          .map((link) => ({ rel: azureLinkRelations[link.type], id: link.externalId }))
          .filter(({ rel, id }) => !existing.has(`${rel}:${id}`))
          .filter(
            (link, index, all) =>
              all.findIndex((other) => other.rel === link.rel && other.id === link.id) === index,
          )
          .map(({ rel, id }) => ({
            op: 'add',
            path: '/relations/-',
            value: { rel, url: workItemUrl(id) },
          }));
        if (!patch.length) return;
        await request(
          fetcher,
          `${base}/_apis/wit/workitems/${encodeURIComponent(externalId)}?api-version=7.1`,
          {
            method: 'PATCH',
            headers: { ...headers, 'content-type': 'application/json-patch+json' },
            body: JSON.stringify(patch),
          },
        );
      },
    };
  }
  if (config.id === 'trello') {
    const key = setting(s, 'apiKey');
    const boardId = setting(s, 'boardId');
    if (!key || !boardId) throw configError('Trello API key and board ID are required.');
    const auth = `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
    const base = 'https://api.trello.com/1';
    return {
      id: config.id,
      async listFields(scope) {
        const target = scope || boardId;
        const fields = await request<
          {
            id: string;
            name: string;
            type: string;
            options?: { id: string; value?: { text?: string } }[];
          }[]
        >(fetcher, `${base}/boards/${encodeURIComponent(target)}/customFields?${auth}`);
        return fields.map((field): FieldDefinition => ({
          id: field.id,
          name: field.name,
          type: fieldType(field.type),
          ...(field.type === 'list'
            ? {
                options: (field.options ?? []).map((option) => ({
                  id: option.id,
                  name: option.value?.text ?? option.id,
                })),
              }
            : {}),
        }));
      },
      async pull() {
        const lists = await request<{ id: string; name: string; pos: number; closed: boolean }[]>(
          fetcher,
          `${base}/boards/${encodeURIComponent(boardId)}/lists?filter=open&${auth}`,
        );
        const cards = await request<
          {
            id: string;
            idList: string;
            name: string;
            desc: string;
            pos: number;
            url: string;
            closed: boolean;
            customFieldItems?: {
              idCustomField: string;
              idValue?: string;
              value?: { text?: string; number?: string; date?: string; checked?: string };
            }[];
          }[]
        >(
          fetcher,
          `${base}/boards/${encodeURIComponent(boardId)}/cards?filter=open&customFieldItems=true&${auth}`,
        );
        return [
          ...lists.map((list): RemotePbiItem => ({
            externalId: list.id,
            parentExternalId: null,
            kind: 'pbi',
            title: list.name,
            description: '',
            status: 'backlog',
            position: list.pos,
            externalUrl: null,
            boardId,
            sourceData: { trelloType: 'list' },
          })),
          ...cards.map((card): RemotePbiItem => ({
            externalId: card.id,
            parentExternalId: card.idList,
            kind: 'card',
            title: card.name,
            description: card.desc,
            status: 'backlog',
            position: card.pos,
            externalUrl: card.url,
            boardId,
            sourceData: {
              trelloType: 'card',
              customFields: {
                trello: Object.fromEntries(
                  (card.customFieldItems ?? []).map((field) => [
                    field.idCustomField,
                    field.idValue ??
                      field.value?.text ??
                      field.value?.date ??
                      (field.value?.number === undefined
                        ? undefined
                        : Number(field.value.number)) ??
                      (field.value?.checked === undefined
                        ? undefined
                        : field.value.checked === 'true') ??
                      null,
                  ]),
                ),
              },
            },
          })),
        ];
      },
      async pushContract(context) {
        const boards = await request<{ id: string; name: string }[]>(
          fetcher,
          `${base}/members/me/boards?filter=open&fields=name&${auth}`,
        );
        const boardField = selectField({
          key: 'board',
          label: 'Board',
          required: true,
          options: boards.map((board) => ({ value: board.id, label: board.name })),
          chosen: context.values.board,
          suggested: boards.some((board) => board.id === boardId) ? boardId : null,
          reloadOnChange: true,
        });
        if (context.item.kind === 'pbi' || !boardField.value) return [boardField];
        const selected = encodeURIComponent(boardField.value);
        const [lists, users] = await Promise.all([
          request<{ id: string; name: string }[]>(
            fetcher,
            `${base}/boards/${selected}/lists?filter=open&${auth}`,
          ),
          request<{ id: string; fullName?: string; username: string }[]>(
            fetcher,
            `${base}/boards/${selected}/members?fields=fullName,username&${auth}`,
          ),
        ]);
        const people = users.map((user) => ({
          value: user.id,
          label: user.fullName || user.username,
          login: user.username,
        }));
        return [
          boardField,
          selectField({
            key: 'list',
            label: 'List',
            required: true,
            options: lists.map((list) => ({ value: list.id, label: list.name })),
            chosen: context.values.list,
            suggested: lists.some((list) => list.id === context.parentExternalId)
              ? context.parentExternalId!
              : (lists.find((list) => list.name === matchState(context.item.status, lists))?.id ??
                null),
            source: context.item.status,
          }),
          selectField({
            key: 'member',
            label: 'Member',
            required: Boolean(context.assignee),
            options: people.map((user) => ({
              value: user.value,
              label: user.label,
              detail: `@${user.login}`,
            })),
            chosen: context.values.member,
            suggested: matchUser(context.assignee, people),
            source: assigneeSource(context),
          }),
        ];
      },
      async push(item, options) {
        const fields = options.fields ?? {};
        const targetBoard = fields.board || options.boardId || boardId;
        if (item.kind === 'pbi') {
          if (Object.keys(options.customFields ?? {}).length)
            throw configError('Trello custom fields can only be set on cards, not lists.');
          const list = await request<{ id: string }>(
            fetcher,
            options.externalId
              ? `${base}/lists/${encodeURIComponent(options.externalId)}?${auth}`
              : `${base}/lists?${auth}`,
            {
              method: options.externalId ? 'PUT' : 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: item.title, idBoard: targetBoard }),
            },
          );
          return {
            externalId: list.id,
            parentExternalId: null,
            kind: 'pbi',
            title: item.title,
            description: item.description,
            status: item.status,
            position: 0,
            externalUrl: null,
            boardId: targetBoard,
            sourceData: { trelloType: 'list' },
          };
        }
        const listId = fields.list || options.listId || options.parentExternalId;
        if (!listId) throw configError('Select a Trello list or push the parent PBI first.');
        const card = await request<{ id: string; url: string }>(
          fetcher,
          options.externalId
            ? `${base}/cards/${encodeURIComponent(options.externalId)}?${auth}`
            : `${base}/cards?${auth}`,
          {
            method: options.externalId ? 'PUT' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: item.title,
              desc: item.description,
              idList: listId,
              ...(fields.member ? { idMembers: [fields.member] } : {}),
            }),
          },
        );
        for (const [id, value] of Object.entries(options.customFields ?? {})) {
          const definition = options.fieldDefinitions?.find((field) => field.id === id);
          const body =
            definition?.type === 'single_select'
              ? { idValue: value }
              : {
                  value: {
                    [definition?.type === 'number'
                      ? 'number'
                      : definition?.type === 'boolean'
                        ? 'checked'
                        : definition?.type === 'date'
                          ? 'date'
                          : 'text']: String(value),
                  },
                };
          await request(
            fetcher,
            `${base}/cards/${encodeURIComponent(card.id)}/customField/${encodeURIComponent(id)}/item?${auth}`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
          );
        }
        return {
          externalId: card.id,
          parentExternalId: listId,
          kind: 'card',
          title: item.title,
          description: item.description,
          status: item.status,
          position: 0,
          externalUrl: card.url,
          boardId: targetBoard,
          sourceData: { trelloType: 'card' },
        };
      },
    };
  }
  if (config.id === 'jira') {
    const baseUrl = setting(s, 'baseUrl').replace(/\/$/, '');
    const projectKey = setting(s, 'projectKey');
    const email = setting(s, 'email');
    if (
      !baseUrl.startsWith('https://') ||
      !new URL(baseUrl).hostname.endsWith('.atlassian.net') ||
      !projectKey ||
      !email
    )
      throw configError('Jira Cloud URL, email and project key are required.');
    const headers = {
      authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    const jiraCategories: Record<string, StateCategory> = {
      new: 'proposed',
      indeterminate: 'inProgress',
      done: 'done',
    };
    /** Moves the issue to the chosen status through the workflow transition that reaches it. */
    const transition = async (issueKey: string, status: string | undefined) => {
      if (!status) return;
      const current = await request<{ fields?: { status?: { name?: string } } }>(
        fetcher,
        `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`,
        { headers },
      );
      if (current.fields?.status?.name === status) return;
      const { transitions } = await request<{
        transitions: { id: string; to?: { name?: string } }[];
      }>(fetcher, `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        headers,
      });
      const next = transitions.find((entry) => entry.to?.name === status);
      if (!next)
        throw providerError(`Jira has no workflow transition to "${status}" for this issue.`);
      const response = await fetcher(
        `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
        { method: 'POST', headers, body: JSON.stringify({ transition: { id: next.id } }) },
      );
      if (!response.ok) throw providerError(errorDetail(response.status, await response.text()));
    };
    return {
      id: config.id,
      async listFields() {
        const fields = await request<
          {
            id: string;
            name: string;
            custom?: boolean;
            schema?: { type?: string; items?: string };
          }[]
        >(fetcher, `${baseUrl}/rest/api/3/field`, { headers });
        return fields
          .filter((field) => field.custom)
          .map((field): FieldDefinition => ({
            id: field.id,
            name: field.name,
            type:
              field.schema?.type === 'array'
                ? 'multi_select'
                : fieldType(field.schema?.type ?? 'string'),
          }));
      },
      async pull() {
        const result: RemotePbiItem[] = [];
        let nextPageToken: string | undefined;
        do {
          const page = await request<{
            issues: { id: string; key: string; fields: Record<string, unknown> }[];
            nextPageToken?: string;
          }>(fetcher, `${baseUrl}/rest/api/3/search/jql`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              jql: `project = "${projectKey.replace(/"/g, '')}" ORDER BY created ASC`,
              maxResults: 100,
              nextPageToken,
              fields: ['*all'],
            }),
          });
          for (const issue of page.issues) {
            const fields = issue.fields;
            const parent = fields['parent'] as { id?: string } | undefined;
            const type = fields['issuetype'] as { name?: string } | undefined;
            const state = fields['status'] as { name?: string } | undefined;
            result.push({
              externalId: issue.id,
              parentExternalId: parent?.id ?? null,
              kind: parent ? 'card' : 'pbi',
              title: text(fields['summary']),
              description: toPlainText(fields['description']),
              status: state?.name ?? 'backlog',
              position: result.length,
              externalUrl: `${baseUrl}/browse/${issue.key}`,
              boardId: projectKey,
              sourceData: {
                key: issue.key,
                type: type?.name,
                customFields: {
                  jira: Object.fromEntries(
                    Object.entries(fields)
                      .filter(([id]) => id.startsWith('customfield_'))
                      .map(([id, value]) => [id, jiraCustomValue(value)] as const)
                      .filter((entry) => entry[1] !== undefined),
                  ),
                },
              },
            });
          }
          nextPageToken = page.nextPageToken;
        } while (nextPageToken);
        return result;
      },
      async pushContract(context) {
        const project = encodeURIComponent(projectKey);
        const [meta, statuses, users] = await Promise.all([
          request<{
            issueTypes?: { name: string; subtask?: boolean }[];
            values?: { name: string; subtask?: boolean }[];
          }>(fetcher, `${baseUrl}/rest/api/3/issue/createmeta/${project}/issuetypes`, {
            headers,
          }),
          request<
            {
              name: string;
              statuses: { name: string; statusCategory?: { key?: string } }[];
            }[]
          >(fetcher, `${baseUrl}/rest/api/3/project/${project}/statuses`, { headers }),
          request<{ accountId: string; displayName: string; emailAddress?: string }[]>(
            fetcher,
            `${baseUrl}/rest/api/3/user/assignable/search?project=${project}&maxResults=1000`,
            { headers },
          ),
        ]);
        const { item, values } = context;
        const types = (meta.issueTypes ?? meta.values ?? []).map((type) => type.name);
        const update = Boolean(context.externalId);
        const typeField = selectField({
          key: 'issueType',
          label: 'Issue type',
          required: true,
          options: types.map((name) => ({ value: name, label: name })),
          chosen: update ? undefined : values.issueType,
          suggested: update
            ? preferType(types, item.sourceData.type)
            : preferType(
                types,
                item.sourceData.adkCardType,
                item.sourceData.type,
                ...(item.kind === 'pbi' ? ['Story', 'Epic'] : ['Task', 'Subtask']),
              ),
          reloadOnChange: true,
          readOnly: update,
        });
        const states = (
          statuses.find((entry) => entry.name === typeField.value)?.statuses ?? []
        ).map((state) => ({
          name: state.name,
          category: jiraCategories[state.statusCategory?.key ?? ''],
        }));
        const people = users.map((user) => ({
          value: user.accountId,
          label: user.displayName,
          ...(user.emailAddress ? { email: user.emailAddress } : {}),
        }));
        return [
          typeField,
          selectField({
            key: 'assignee',
            label: 'Assignee',
            required: Boolean(context.assignee),
            options: people.map((user) => ({
              value: user.value,
              label: user.label,
              ...(user.email ? { detail: user.email } : {}),
            })),
            chosen: values.assignee,
            suggested: matchUser(context.assignee, people),
            source: assigneeSource(context),
          }),
          selectField({
            key: 'status',
            label: 'Status',
            required: true,
            options: states.map((state) => ({ value: state.name, label: state.name })),
            chosen: values.status,
            suggested: matchState(item.status, states),
            source: item.status,
          }),
        ];
      },
      async push(item, options) {
        const fields = options.fields ?? {};
        const mapped = Object.fromEntries(
          Object.entries(options.customFields ?? {}).map(([id, value]) => {
            const type = options.fieldDefinitions?.find((field) => field.id === id)?.type;
            return [
              id,
              type === 'single_select'
                ? { id: value }
                : type === 'multi_select' && Array.isArray(value)
                  ? (value as string[]).map((entry) => ({ id: entry }))
                  : value,
            ];
          }),
        );
        const issueType =
          fields.issueType || options.issueType || (item.kind === 'pbi' ? 'Epic' : 'Task');
        const description = {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: item.description || item.title }],
            },
          ],
        };
        const assignee = fields.assignee ? { assignee: { accountId: fields.assignee } } : {};
        let result: { id: string; key: string };
        if (options.externalId) {
          const update = await fetcher(
            `${baseUrl}/rest/api/3/issue/${encodeURIComponent(options.externalId)}`,
            {
              method: 'PUT',
              headers,
              body: JSON.stringify({
                fields: { summary: item.title, description, ...assignee, ...mapped },
              }),
            },
          );
          if (!update.ok) throw providerError(errorDetail(update.status, await update.text()));
          result = await request<{ id: string; key: string }>(
            fetcher,
            `${baseUrl}/rest/api/3/issue/${encodeURIComponent(options.externalId)}?fields=key`,
            { headers },
          );
        } else {
          result = await request<{ id: string; key: string }>(
            fetcher,
            `${baseUrl}/rest/api/3/issue`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                fields: {
                  project: { key: projectKey },
                  summary: item.title,
                  issuetype: { name: issueType },
                  description,
                  ...assignee,
                  ...mapped,
                  ...(options.parentExternalId ? { parent: { id: options.parentExternalId } } : {}),
                },
              }),
            },
          );
        }
        await transition(result.key, fields.status);
        return {
          externalId: result.id,
          parentExternalId: options.parentExternalId ?? null,
          kind: item.kind,
          title: item.title,
          description: item.description,
          status: fields.status || item.status,
          position: 0,
          externalUrl: `${baseUrl}/browse/${result.key}`,
          boardId: projectKey,
          sourceData: { key: result.key, type: issueType },
        };
      },
    };
  }
  if (config.id === 'github_projects') {
    const owner = setting(s, 'owner');
    const number = Number(setting(s, 'projectNumber'));
    if (!owner || !Number.isInteger(number) || number < 1)
      throw configError('GitHub owner and project number are required.');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    };
    const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      const result = await request<{
        data?: T;
        errors?: { message: string; type?: string }[];
      }>(fetcher, 'https://api.github.com/graphql', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
      // Owner lookups query both `user` and `organization`; the one that does not exist is NOT_FOUND.
      const errors = (result.errors ?? []).filter((error) => error.type !== 'NOT_FOUND');
      if (errors.length || !result.data)
        throw providerError(
          errors[0]?.message ?? result.errors?.[0]?.message ?? 'GitHub GraphQL failed.',
        );
      return result.data;
    };
    const projectQuery = `query($owner:String!,$number:Int!,$after:String){ user(login:$owner){ projectV2(number:$number){ id items(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{...ProjectItemFields} } } } organization(login:$owner){ projectV2(number:$number){ id items(first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{...ProjectItemFields} } } } } fragment ProjectItemFields on ProjectV2Item { id statusField:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}} iterationField:fieldValueByName(name:"Iteration"){... on ProjectV2ItemFieldIterationValue{title}} fieldValues(first:100){nodes{... on ProjectV2ItemFieldValueCommon{field{... on ProjectV2FieldCommon{id}}} ... on ProjectV2ItemFieldTextValue{text} ... on ProjectV2ItemFieldNumberValue{number} ... on ProjectV2ItemFieldDateValue{date} ... on ProjectV2ItemFieldSingleSelectValue{optionId} ... on ProjectV2ItemFieldMultiSelectValue{options{id}} ... on ProjectV2ItemFieldIterationValue{iterationId}}} content{__typename ... on Issue{id title body url parent{ id } subIssues(first:100){pageInfo{hasNextPage endCursor} nodes{id title body url}}} ... on DraftIssue{id title body} ... on PullRequest{id title body url}} }`;
    type GSubIssue = { id: string; title: string; body?: string; url?: string };
    type GSubIssues = {
      nodes: GSubIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
    type GItem = {
      id: string;
      fieldValues?: {
        nodes: {
          field?: { id?: string };
          text?: string;
          number?: number;
          date?: string;
          optionId?: string;
          options?: { id: string }[];
          iterationId?: string;
        }[];
      };
      statusField?: { name?: string } | null;
      iterationField?: { title?: string } | null;
      content: {
        __typename?: string;
        id: string;
        title: string;
        body?: string;
        url?: string;
        parent?: { id: string };
        subIssues?: GSubIssues;
      } | null;
    };
    type GProject = {
      id: string;
      items: { nodes: GItem[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    };
    const getProject = async (after?: string) => {
      const data = await graphql<{
        user?: { projectV2?: GProject } | null;
        organization?: { projectV2?: GProject } | null;
      }>(projectQuery, { owner, number, after });
      const project = data.user?.projectV2 ?? data.organization?.projectV2;
      if (!project) throw configError('GitHub project was not found.', 404);
      return project;
    };
    type GProjectSummary = {
      id: string;
      number: number;
      title: string;
      field?: { id?: string; options?: { id: string; name: string }[] } | null;
    };
    const projectsQuery = `query($owner:String!){ user(login:$owner){ projectsV2(first:50){ nodes{...ProjectSummary} } } organization(login:$owner){ projectsV2(first:50){ nodes{...ProjectSummary} } } } fragment ProjectSummary on ProjectV2 { id number title field(name:"Status"){ ... on ProjectV2SingleSelectField { id options{ id name } } } }`;
    const listProjects = async () => {
      const data = await graphql<{
        user?: { projectsV2?: { nodes: GProjectSummary[] } } | null;
        organization?: { projectsV2?: { nodes: GProjectSummary[] } } | null;
      }>(projectsQuery, { owner });
      return [
        ...(data.user?.projectsV2?.nodes ?? []),
        ...(data.organization?.projectsV2?.nodes ?? []),
      ];
    };
    const repositoryPath = (value: string | undefined) => {
      const path = (value || setting(s, 'repo')).trim().replace(/^\/+|\/+$/g, '');
      if (!path) return null;
      const [repoOwner, name] = path.includes('/') ? path.split('/', 2) : [owner, path];
      return repoOwner && name ? { owner: repoOwner, name } : null;
    };
    const configuredRepository = setting(s, 'repo')
      ? setting(s, 'repo').includes('/')
        ? setting(s, 'repo')
        : `${owner}/${setting(s, 'repo')}`
      : null;
    return {
      id: config.id,
      async listFields(scope) {
        const targetNumber = scope ? Number(scope) : number;
        if (!Number.isInteger(targetNumber) || targetNumber < 1)
          throw configError('GitHub project number is invalid.');
        const data = await graphql<{
          user?: {
            projectV2?: {
              fields: {
                nodes: {
                  id: string;
                  name: string;
                  dataType: string;
                  options?: { id: string; name: string }[];
                  multiSelectOptions?: { id: string; name: string }[];
                  configuration?: { iterations?: { id: string; title: string }[] };
                }[];
              };
            };
          } | null;
          organization?: {
            projectV2?: {
              fields: {
                nodes: {
                  id: string;
                  name: string;
                  dataType: string;
                  options?: { id: string; name: string }[];
                  multiSelectOptions?: { id: string; name: string }[];
                  configuration?: { iterations?: { id: string; title: string }[] };
                }[];
              };
            };
          } | null;
        }>(
          `
            query ($owner: String!, $number: Int!) {
              user(login: $owner) {
                projectV2(number: $number) {
                  fields(first: 100) {
                    nodes {
                      ...ProjectField
                    }
                  }
                }
              }
              organization(login: $owner) {
                projectV2(number: $number) {
                  fields(first: 100) {
                    nodes {
                      ...ProjectField
                    }
                  }
                }
              }
            }
            fragment ProjectField on ProjectV2FieldConfiguration {
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                options {
                  id
                  name
                }
              }
              ... on ProjectV2MultiSelectField {
                multiSelectOptions {
                  id
                  name
                }
              }
              ... on ProjectV2IterationField {
                configuration {
                  iterations {
                    id
                    title
                  }
                }
              }
            }
          `,
          { owner, number: targetNumber },
        );
        const fields =
          data.user?.projectV2?.fields.nodes ?? data.organization?.projectV2?.fields.nodes ?? [];
        return fields
          .filter((field) => field.id && field.name)
          .map((field): FieldDefinition => ({
            id: field.id,
            name: field.name,
            type:
              field.dataType === 'ITERATION'
                ? 'iteration'
                : field.dataType === 'SINGLE_SELECT'
                  ? 'single_select'
                  : fieldType(field.dataType),
            ...(field.options ? { options: field.options } : {}),
            ...(field.multiSelectOptions ? { options: field.multiSelectOptions } : {}),
            ...(field.configuration?.iterations
              ? {
                  options: field.configuration.iterations.map((item) => ({
                    id: item.id,
                    name: item.title,
                  })),
                }
              : {}),
          }));
      },
      async pull() {
        const byId = new Map<string, RemotePbiItem>();
        let after: string | undefined;
        do {
          const project = await getProject(after);
          for (const node of project.items.nodes) {
            const content = node.content;
            if (!content) continue;
            byId.set(content.id, {
              externalId: content.id,
              parentExternalId: content.parent?.id ?? null,
              kind: content.parent ? 'card' : 'pbi',
              title: content.title,
              description: content.body ?? '',
              status: node.statusField?.name ?? 'backlog',
              position: byId.size,
              externalUrl: content.url ?? null,
              boardId: project.id,
              sourceData: {
                projectItemId: node.id,
                githubContentType: content.__typename,
                iterationPath: node.iterationField?.title,
                customFields: {
                  github_projects: Object.fromEntries(
                    (node.fieldValues?.nodes ?? [])
                      .filter((field) => field.field?.id)
                      .map((field) => [
                        field.field!.id!,
                        field.text ??
                          field.number ??
                          field.date ??
                          field.optionId ??
                          field.options?.map((option) => option.id) ??
                          field.iterationId ??
                          null,
                      ]),
                  ),
                },
              },
            });
            let subIssues = content.subIssues;
            while (subIssues) {
              for (const child of subIssues.nodes) {
                if (!byId.has(child.id))
                  byId.set(child.id, {
                    externalId: child.id,
                    parentExternalId: content.id,
                    kind: 'card',
                    title: child.title,
                    description: child.body ?? '',
                    status: 'backlog',
                    position: byId.size,
                    externalUrl: child.url ?? null,
                    boardId: project.id,
                    sourceData: {},
                  });
              }
              if (!subIssues.pageInfo.hasNextPage || !subIssues.pageInfo.endCursor) break;
              const data = await graphql<{ node: { subIssues: GSubIssues } | null }>(
                `
                  query ($id: ID!, $after: String!) {
                    node(id: $id) {
                      ... on Issue {
                        subIssues(first: 100, after: $after) {
                          pageInfo {
                            hasNextPage
                            endCursor
                          }
                          nodes {
                            id
                            title
                            body
                            url
                          }
                        }
                      }
                    }
                  }
                `,
                { id: content.id, after: subIssues.pageInfo.endCursor },
              );
              subIssues = data.node?.subIssues;
            }
          }
          after = project.items.pageInfo.hasNextPage
            ? (project.items.pageInfo.endCursor ?? undefined)
            : undefined;
        } while (after);
        return [...byId.values()];
      },
      async pushContract(context) {
        const { item, values } = context;
        const update = Boolean(context.externalId);
        const [projects, repositories] = await Promise.all([
          listProjects(),
          graphql<{
            repositoryOwner?: { repositories?: { nodes: { nameWithOwner: string }[] } } | null;
          }>(
            `
              query ($owner: String!) {
                repositoryOwner(login: $owner) {
                  repositories(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
                    nodes {
                      nameWithOwner
                    }
                  }
                }
              }
            `,
            { owner },
          ),
        ]);
        const repositoryField = selectField({
          key: 'repository',
          label: 'Repository (owner/name)',
          required: !update,
          options: (repositories.repositoryOwner?.repositories?.nodes ?? []).map((repo) => ({
            value: repo.nameWithOwner,
            label: repo.nameWithOwner,
          })),
          chosen: update ? undefined : values.repository,
          suggested: update ? null : configuredRepository,
          reloadOnChange: true,
          allowCustom: true,
          readOnly: update,
        });
        const projectField = selectField({
          key: 'project',
          label: 'Project',
          required: true,
          options: projects.map((project) => ({
            value: String(project.number),
            label: project.title,
            detail: `#${project.number}`,
          })),
          chosen: values.project,
          suggested: projects.some((project) => project.number === number) ? String(number) : null,
          reloadOnChange: true,
        });
        const statusOptions =
          projects.find((project) => String(project.number) === projectField.value)?.field
            ?.options ?? [];
        const fields = [repositoryField, projectField];
        if (statusOptions.length)
          fields.push(
            selectField({
              key: 'status',
              label: 'Status',
              required: true,
              options: statusOptions.map((option) => ({ value: option.id, label: option.name })),
              chosen: values.status,
              suggested:
                statusOptions.find(
                  (option) =>
                    option.name ===
                    matchState(
                      item.status,
                      statusOptions.map((entry) => ({ name: entry.name })),
                    ),
                )?.id ?? null,
              source: item.status,
            }),
          );
        const repo = repositoryPath(repositoryField.value || undefined);
        if (repo) {
          const users = await graphql<{
            repository: {
              assignableUsers: {
                nodes: { id: string; login: string; name?: string | null; email?: string | null }[];
              };
            } | null;
          }>(
            `
              query ($owner: String!, $name: String!) {
                repository(owner: $owner, name: $name) {
                  assignableUsers(first: 100) {
                    nodes {
                      id
                      login
                      name
                      email
                    }
                  }
                }
              }
            `,
            { owner: repo.owner, name: repo.name },
          );
          const people = (users.repository?.assignableUsers.nodes ?? []).map((user) => ({
            value: user.id,
            label: user.name || user.login,
            login: user.login,
            ...(user.email ? { email: user.email } : {}),
          }));
          fields.push(
            selectField({
              key: 'assignee',
              label: 'Assignee',
              required: Boolean(context.assignee),
              options: people.map((user) => ({
                value: user.value,
                label: user.label,
                detail: `@${user.login}`,
              })),
              chosen: values.assignee,
              suggested: matchUser(context.assignee, people),
              source: assigneeSource(context),
            }),
          );
        }
        return fields;
      },
      async push(item, options) {
        const fields = options.fields ?? {};
        const projectNumber = Number(fields.project) || number;
        const assigneeIds = fields.assignee ? [fields.assignee] : undefined;
        const project = (await listProjects()).find((entry) => entry.number === projectNumber);
        if (!project) throw configError('GitHub project was not found.', 404);
        const setStatus = async (projectItemId: string) => {
          if (!fields.status || !project.field?.id) return;
          await graphql(
            `
              mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
                updateProjectV2ItemFieldValue(
                  input: {
                    projectId: $project
                    itemId: $item
                    fieldId: $field
                    value: { singleSelectOptionId: $option }
                  }
                ) {
                  projectV2Item {
                    id
                  }
                }
              }
            `,
            {
              project: project.id,
              item: projectItemId,
              field: project.field.id,
              option: fields.status,
            },
          );
        };
        const setCustomFields = async (projectItemId: string) => {
          for (const [id, value] of Object.entries(options.customFields ?? {})) {
            const type = options.fieldDefinitions?.find((field) => field.id === id)?.type;
            if (!type || type === 'boolean')
              throw configError(`Unsupported GitHub Project field: ${id}`);
            const fieldValue =
              type === 'number'
                ? { number: value }
                : type === 'date'
                  ? { date: value }
                  : type === 'single_select'
                    ? { singleSelectOptionId: value }
                    : type === 'multi_select'
                      ? { multiSelectOptionIds: value }
                      : type === 'iteration'
                        ? { iterationId: value }
                        : { text: value };
            await graphql(
              `
                mutation ($input: UpdateProjectV2ItemFieldValueInput!) {
                  updateProjectV2ItemFieldValue(input: $input) {
                    projectV2Item {
                      id
                    }
                  }
                }
              `,
              {
                input: {
                  projectId: project.id,
                  itemId: projectItemId,
                  fieldId: id,
                  value: fieldValue,
                },
              },
            );
          }
        };
        const statusName =
          project.field?.options?.find((option) => option.id === fields.status)?.name ??
          item.status;
        if (options.externalId) {
          const isDraft = item.sourceData?.githubContentType === 'DraftIssue';
          let projectItemId = text(item.sourceData?.projectItemId);
          if (!projectItemId && (Object.keys(options.customFields ?? {}).length || fields.status)) {
            if (isDraft)
              throw configError(
                'The draft issue has no GitHub Project item. Pull the project before mapping its fields.',
              );
            const added = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
              `
                mutation ($projectId: ID!, $contentId: ID!) {
                  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
                    item {
                      id
                    }
                  }
                }
              `,
              { projectId: project.id, contentId: options.externalId },
            );
            projectItemId = added.addProjectV2ItemById.item.id;
          }
          let updatedUrl: string | null = null;
          if (isDraft)
            await graphql(
              `
                mutation ($input: UpdateProjectV2DraftIssueInput!) {
                  updateProjectV2DraftIssue(input: $input) {
                    draftIssue {
                      id
                    }
                  }
                }
              `,
              {
                input: {
                  draftIssueId: options.externalId,
                  title: item.title,
                  body: item.description,
                  ...(assigneeIds ? { assigneeIds } : {}),
                },
              },
            );
          else {
            const updated = await graphql<{ updateIssue: { issue: { id: string; url: string } } }>(
              `
                mutation ($input: UpdateIssueInput!) {
                  updateIssue(input: $input) {
                    issue {
                      id
                      url
                    }
                  }
                }
              `,
              {
                input: {
                  id: options.externalId,
                  title: item.title,
                  body: item.description,
                  ...(assigneeIds ? { assigneeIds } : {}),
                },
              },
            );
            updatedUrl = updated.updateIssue.issue.url;
          }
          if (projectItemId) await setStatus(projectItemId);
          if (projectItemId) await setCustomFields(projectItemId);
          return {
            externalId: options.externalId,
            parentExternalId: options.parentExternalId ?? null,
            kind: item.kind,
            title: item.title,
            description: item.description,
            status: projectItemId ? statusName : item.status,
            position: 0,
            externalUrl: updatedUrl,
            boardId: options.boardId ?? project.id,
            sourceData: { projectItemId, githubContentType: isDraft ? 'DraftIssue' : 'Issue' },
          };
        }
        const repo = repositoryPath(fields.repository);
        if (!repo) throw configError('Configure a repository for GitHub Projects push.');
        const repoData = await graphql<{ repository: { id: string } | null }>(
          `
            query ($owner: String!, $repo: String!) {
              repository(owner: $owner, name: $repo) {
                id
              }
            }
          `,
          { owner: repo.owner, repo: repo.name },
        );
        if (!repoData.repository) throw configError('GitHub repository was not found.', 404);
        const created = await graphql<{ createIssue: { issue: { id: string; url: string } } }>(
          `
            mutation ($input: CreateIssueInput!) {
              createIssue(input: $input) {
                issue {
                  id
                  url
                }
              }
            }
          `,
          {
            input: {
              repositoryId: repoData.repository.id,
              title: item.title,
              body: item.description,
              ...(assigneeIds ? { assigneeIds } : {}),
            },
          },
        );
        const issue = created.createIssue.issue;
        if (options.parentExternalId)
          await graphql(
            `
              mutation ($parent: ID!, $child: ID!) {
                addSubIssue(input: { issueId: $parent, subIssueId: $child }) {
                  issue {
                    id
                  }
                }
              }
            `,
            { parent: options.parentExternalId, child: issue.id },
          );
        const added = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
          `
            mutation ($projectId: ID!, $contentId: ID!) {
              addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
                item {
                  id
                }
              }
            }
          `,
          { projectId: project.id, contentId: issue.id },
        );
        await setStatus(added.addProjectV2ItemById.item.id);
        await setCustomFields(added.addProjectV2ItemById.item.id);
        return {
          externalId: issue.id,
          parentExternalId: options.parentExternalId ?? null,
          kind: item.kind,
          title: item.title,
          description: item.description,
          status: statusName,
          position: 0,
          externalUrl: issue.url,
          boardId: project.id,
          sourceData: { projectItemId: added.addProjectV2ItemById.item.id },
        };
      },
    };
  }
  throw new ApplicationError(
    'PBI_PROVIDER_UNSUPPORTED',
    `Unsupported board provider: ${config.id}`,
    400,
  );
}
