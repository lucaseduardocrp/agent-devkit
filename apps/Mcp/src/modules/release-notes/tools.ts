import { z } from 'zod';
import { segment, type AdkApi } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json, text } from '../../core/tool.js';
import { getAgent, getWorkflowBrief } from '../agents/tools.js';
import { searchKnowledge } from '../brain/tools.js';
import { id, knowledgeBlock, untrusted, UNTRUSTED_CONTENT_RULE } from '../shared.js';

interface ReleaseNoteDto {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly content: string;
  readonly agentId: string | null;
  readonly itemIds: readonly string[];
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface PbiItemDto {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: 'pbi' | 'card';
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly sourceData: Record<string, unknown>;
  readonly links: readonly { readonly providerId: string; readonly externalId: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the backend limit for one generation request.
const MAX_ITEMS = 300;
const DESCRIPTION_LIMIT = 1500;

const releaseNoteId = id('Release note id (from release_notes_list).');
const itemRefs = z
  .array(
    id(
      'Internal PBI/card UUID, Azure DevOps work item number (e.g. 50086), or provider:externalId (e.g. azure_devops:50086).',
    ),
  )
  .min(1)
  .max(MAX_ITEMS)
  .describe('Delivered work items (PBIs, tasks, bugs, cards). Find them with pbi_list.');
const title = z.string().trim().min(1).max(240).describe('Release note title.');
const version = z.string().trim().max(100).optional().describe('Version label, e.g. 1.4.0.');
const content = z.string().max(200000).describe('Release note body in Markdown.');

async function getItem(api: AdkApi, ref: string): Promise<PbiItemDto> {
  return (
    await api.request<{ item: PbiItemDto }>({ method: 'GET', path: `/pbi/items/${segment(ref)}` })
  ).item;
}

/** Loads items in small batches so a 300-item selection does not flood the API. */
async function getItems(api: AdkApi, refs: readonly string[]): Promise<PbiItemDto[]> {
  const unique = [...new Set(refs)];
  const items: PbiItemDto[] = [];
  for (let index = 0; index < unique.length; index += 10)
    items.push(
      ...(await Promise.all(unique.slice(index, index + 10).map((ref) => getItem(api, ref)))),
    );
  return items;
}

/** The API stores internal UUIDs; Azure numbers and provider:externalId refs are resolved first. */
async function resolveItemIds(api: AdkApi, refs: readonly string[]): Promise<string[]> {
  const resolved = refs.every((ref) => UUID.test(ref))
    ? refs
    : (await getItems(api, refs)).map((item) => item.id);
  return [...new Set(resolved)];
}

function plainText(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function itemType(item: PbiItemDto): string {
  const type = item.sourceData['adkCardType'] || item.sourceData['type'];
  return typeof type === 'string' && type ? type : item.kind === 'pbi' ? 'PBI' : 'Card';
}

function summary(note: ReleaseNoteDto) {
  return {
    id: note.id,
    title: note.title,
    version: note.version,
    agentId: note.agentId,
    itemCount: note.itemIds.length,
    updatedAt: note.updatedAt,
  };
}

export const releaseNotesModule: McpModule = {
  toolset: 'releasenotes',
  tools: [
    defineTool({
      name: 'release_notes_list',
      title: 'List release notes',
      description:
        'Lists the workspace release notes (newest first) without their bodies. Use release_notes_get for the Markdown.',
      toolset: 'releasenotes',
      access: 'read',
      routes: ['GET /release-notes'],
      input: {},
      run: async (_, { api }) => {
        const result = await api.request<{ releaseNotes: ReleaseNoteDto[] }>({
          method: 'GET',
          path: '/release-notes',
        });
        return json({ releaseNotes: result.releaseNotes.map(summary) });
      },
    }),
    defineTool({
      name: 'release_notes_get',
      title: 'Get release note',
      description: 'Gets a release note with its Markdown body and the IDs of the items it covers.',
      toolset: 'releasenotes',
      access: 'read',
      routes: ['GET /release-notes/:id'],
      input: { releaseNoteId },
      run: async ({ releaseNoteId: target }, { api }) =>
        json(await api.request({ method: 'GET', path: `/release-notes/${segment(target)}` })),
    }),
    defineTool({
      name: 'release_notes_create',
      title: 'Create release note',
      description:
        'Saves a release note written manually or drafted with release_notes_prepare. Show the draft to the user and confirm before saving. The creation is recorded in the release note history.',
      toolset: 'releasenotes',
      access: 'write',
      routes: ['POST /release-notes'],
      input: { title, version, content, itemIds: itemRefs.optional() },
      run: async ({ itemIds, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/release-notes',
            body: { ...body, ...(itemIds ? { itemIds: await resolveItemIds(api, itemIds) } : {}) },
          }),
        ),
    }),
    defineTool({
      name: 'release_notes_update',
      title: 'Update release note',
      description:
        'Edits the title, version or Markdown body of a release note. The change is recorded in its history.',
      toolset: 'releasenotes',
      access: 'write',
      routes: ['PATCH /release-notes/:id'],
      input: {
        releaseNoteId,
        title: title.optional(),
        version,
        content: content.optional(),
      },
      run: async ({ releaseNoteId: target, ...body }, { api }) =>
        json(
          await api.request({ method: 'PATCH', path: `/release-notes/${segment(target)}`, body }),
        ),
    }),
    defineTool({
      name: 'release_notes_delete',
      title: 'Delete release note',
      description:
        'Deletes a release note. The deletion and the deleted content stay in the audit history (audit_history with entityType release_note).',
      toolset: 'releasenotes',
      access: 'destructive',
      routes: ['DELETE /release-notes/:id'],
      input: { releaseNoteId },
      run: async ({ releaseNoteId: target }, { api }) => {
        await api.request({ method: 'DELETE', path: `/release-notes/${segment(target)}` });
        return json({ deleted: true, releaseNoteId: target });
      },
    }),
    defineTool({
      name: 'release_notes_generate',
      title: 'Generate release note',
      description:
        'Has the selected ADK agent write and save a release note from the delivered work items and the Brain.',
      toolset: 'releasenotes',
      access: 'write',
      execution: 'server',
      routes: ['POST /release-notes/generate'],
      input: {
        title,
        version,
        agentId: id('Agent that writes the release note (from agents_list).'),
        itemIds: itemRefs,
        instructions: z
          .string()
          .max(4000)
          .optional()
          .describe('Extra guidance, e.g. audience or what to highlight.'),
      },
      run: async ({ itemIds, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/release-notes/generate',
            body: { ...body, itemIds: await resolveItemIds(api, itemIds) },
          }),
        ),
    }),
    defineTool({
      name: 'release_notes_prepare',
      title: 'Draft release note (host model)',
      description:
        'Returns what you need to write a release note yourself: the selected work items (type, ID, state, parent, description), optional agent persona and related Brain sources. Then save it with release_notes_create.',
      toolset: 'releasenotes',
      access: 'read',
      execution: 'host',
      routes: [
        'GET /pbi/items/:id',
        'GET /agents/:id',
        'GET /agents/workflow',
        'GET /TestPlan/search',
      ],
      input: {
        title,
        version,
        itemIds: itemRefs,
        agentId: z.string().optional().describe('Agent persona to apply (from agents_list).'),
        instructions: z.string().max(4000).optional().describe('Extra guidance from the user.'),
        knowledgeLimit: z.number().int().min(0).max(30).default(10),
      },
      run: async (input, { api }) => {
        const items = await getItems(api, input.itemIds);
        const known = new Map(items.map((item) => [item.id, item]));
        const parentIds = [
          ...new Set(
            items.map((item) => item.parentId).filter((value): value is string => !!value),
          ),
        ].filter((parentId) => !known.has(parentId));
        const parents = new Map(
          (await getItems(api, parentIds)).map((item) => [item.id, item.title] as const),
        );
        for (const item of items) parents.set(item.id, item.title);
        const [agent, chunks, workflowBrief] = await Promise.all([
          input.agentId ? getAgent(api, input.agentId) : Promise.resolve(undefined),
          input.knowledgeLimit
            ? searchKnowledge(
                api,
                [input.title, ...items.map((item) => item.title)].join('\n').slice(0, 4000),
                input.knowledgeLimit,
              )
            : Promise.resolve([]),
          getWorkflowBrief(api),
        ]);
        const describe = (item: PbiItemDto) => {
          const description = plainText(item.description);
          return [
            `[${itemType(item)}]${item.links[0] ? ` #${item.links[0].externalId}` : ''} ${item.title} (${item.status})`,
            item.parentId && parents.has(item.parentId)
              ? `Parent: ${parents.get(item.parentId)}`
              : '',
            description
              ? `Description: ${description.slice(0, DESCRIPTION_LIMIT)}${description.length > DESCRIPTION_LIMIT ? '…' : ''}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
        };
        return json({
          title: input.title,
          version: input.version ?? null,
          itemIds: items.map((item) => item.id),
          instructions: input.instructions ?? null,
          items: items.map((item) => untrusted(`pbi:${item.id}`, describe(item))).join('\n\n'),
          agentInstructions: agent?.instructions ?? null,
          ...workflowBrief,
          knowledge: chunks.length ? knowledgeBlock(chunks) : null,
          rules: [
            'Write Markdown for end users: start with a level-1 heading and a short summary, then group the changes into sections such as New features, Improvements, Bug fixes and Known issues (omit empty sections).',
            'Describe the value of each change in plain language without internal jargon. Do not invent features that are not in the items.',
            'Write in the language of the user request unless the user asks otherwise.',
            'Show the draft to the user and confirm before saving.',
            UNTRUSTED_CONTENT_RULE,
            workflowBrief.rule,
          ],
          save: 'release_notes_create { title, version?, content, itemIds }',
        });
      },
    }),
    defineTool({
      name: 'release_notes_export_markdown',
      title: 'Export release note as Markdown',
      description:
        'Returns the release note as a Markdown file body. PDF and DOCX are binary downloads available in the web app (release note menu → Export PDF / Export DOCX).',
      toolset: 'releasenotes',
      access: 'read',
      routes: ['GET /release-notes/:id/export'],
      input: { releaseNoteId },
      run: async ({ releaseNoteId: target }, { api }) =>
        text(
          await api.request<string>({
            method: 'GET',
            path: `/release-notes/${segment(target)}/export`,
            query: { format: 'markdown' },
          }),
        ),
    }),
  ],
};
