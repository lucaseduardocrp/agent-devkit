import { z } from 'zod';
import { segment, type AdkApi } from '../../api/http-client.js';
import { definePrompt } from '../../core/prompt.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { chunksOrEmpty, id, knowledgeBlock, untrusted, UNTRUSTED_CONTENT_RULE } from '../shared.js';

export interface KnowledgeDocumentDto {
  readonly id: string;
  readonly pageId: string;
  readonly source: string;
  readonly title: string;
  readonly content?: string;
  readonly chunksCount: number;
  readonly totalCharacters: number;
  readonly updatedAt: string;
  readonly isCustom?: boolean;
  readonly parentPageId?: string;
  readonly pagePath?: string;
}

export async function listDocuments(api: AdkApi): Promise<readonly KnowledgeDocumentDto[]> {
  const result = await api.request<{ documents: KnowledgeDocumentDto[] }>({
    method: 'GET',
    path: '/knowledge/documents',
  });
  return result.documents;
}

export async function findDocument(
  api: AdkApi,
  pageId: string,
  source?: string,
): Promise<KnowledgeDocumentDto> {
  const document = (await listDocuments(api)).find(
    (item) => item.pageId === pageId && (!source || item.source === source),
  );
  if (!document) throw new Error(`Brain document ${pageId} was not found in the active workspace.`);
  return document;
}

export async function searchKnowledge(api: AdkApi, query: string, limit: number) {
  const chunks = chunksOrEmpty(
    await api.request({ method: 'GET', path: '/TestPlan/search', query: { prompt: query } }),
  );
  return chunks.slice(0, limit);
}

const pageId = id('Brain document pageId (from brain_list_documents).');

export const BRAIN_ANSWER_RULES = [
  'Answer exclusively with facts explicitly present in the sources below.',
  'Do not use general knowledge, assumptions or unsupported inferences.',
  'Cite the source of every claim using only the exact source identifiers provided.',
  'If the sources do not contain the answer, say so plainly (for example "Não encontrei essa informação no Brain.").',
  UNTRUSTED_CONTENT_RULE,
];

export const brainModule: McpModule = {
  toolset: 'brain',
  tools: [
    defineTool({
      name: 'brain_list_documents',
      title: 'List Brain documents',
      description:
        'Lists Brain (knowledge base) documents: native pages and pages synced from Azure DevOps Wiki / GitHub. Returns summaries without content; use brain_get_document for the full text.',
      toolset: 'brain',
      access: 'read',
      routes: ['GET /knowledge/documents'],
      input: {
        query: z.string().trim().optional().describe('Case-insensitive filter on title or path.'),
        origin: z
          .enum(['all', 'native', 'external'])
          .default('all')
          .describe('native = created in ADK, external = synced from integrations.'),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      run: async (input, { api }) => {
        const needle = input.query?.toLocaleLowerCase();
        const matches = (await listDocuments(api)).filter(
          (doc) =>
            (input.origin === 'all' || (input.origin === 'native') === Boolean(doc.isCustom)) &&
            (!needle ||
              doc.title.toLocaleLowerCase().includes(needle) ||
              (doc.pagePath ?? '').toLocaleLowerCase().includes(needle)),
        );
        return json({
          total: matches.length,
          documents: matches
            .slice(input.offset, input.offset + input.limit)
            .map(({ content: _content, ...summary }) => summary),
        });
      },
    }),
    defineTool({
      name: 'brain_get_document',
      title: 'Read Brain document',
      description: 'Returns the full Markdown content of a Brain document.',
      toolset: 'brain',
      access: 'read',
      routes: ['GET /knowledge/documents'],
      input: {
        pageId,
        source: z
          .string()
          .optional()
          .describe('Disambiguates pages with the same id in different sources.'),
      },
      run: async (input, { api }) => {
        const { content = '', ...document } = await findDocument(api, input.pageId, input.source);
        return json({
          ...document,
          notice: UNTRUSTED_CONTENT_RULE,
          content: untrusted(document.title, content),
        });
      },
    }),
    defineTool({
      name: 'brain_create_document',
      title: 'Create Brain document',
      description:
        'Creates a native Brain page (Markdown). The title becomes the H1. Use parentPageId to create a sub-page. Use [[Title]] wikilinks to reference other pages.',
      toolset: 'brain',
      access: 'write',
      routes: ['POST /knowledge/documents'],
      input: {
        title: z.string().trim().min(1).max(300),
        content: z.string().max(1_000_000).describe('Markdown body.'),
        parentPageId: z.string().optional().describe('Parent native page for a sub-page.'),
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/knowledge/documents', body: input })),
    }),
    defineTool({
      name: 'brain_update_document',
      title: 'Update Brain document',
      description:
        'Replaces the title and content of a native Brain page. Synced (external) pages must be edited at their origin.',
      toolset: 'brain',
      access: 'write',
      routes: ['PUT /knowledge/documents/:pageId'],
      input: {
        pageId,
        title: z.string().trim().min(1).max(300),
        content: z.string().max(1_000_000),
      },
      run: async ({ pageId: target, ...body }, { api }) =>
        json(
          await api.request({
            method: 'PUT',
            path: `/knowledge/documents/${segment(target)}`,
            body,
          }),
        ),
    }),
    defineTool({
      name: 'brain_delete_document',
      title: 'Delete Brain document',
      description: 'Deletes a Brain document (sub-pages must be deleted first).',
      toolset: 'brain',
      access: 'destructive',
      routes: ['DELETE /knowledge/documents/:pageId'],
      input: { pageId, source: z.string().optional() },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/knowledge/documents/${segment(input.pageId)}`,
            query: { source: input.source },
          }),
        ),
    }),
    defineTool({
      name: 'brain_list_push_providers',
      title: 'List Brain push integrations',
      description: 'Lists configured destinations available for publishing a Brain document.',
      toolset: 'brain',
      access: 'read',
      routes: ['GET /knowledge/push-providers'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/knowledge/push-providers' })),
    }),
    defineTool({
      name: 'brain_list_push_destinations',
      title: 'List Brain destination folders or parents',
      description:
        'Lists Wiki pages, Trello lists, or project items available as a document destination.',
      toolset: 'brain',
      access: 'read',
      routes: ['GET /knowledge/push-destinations/:providerId'],
      input: { providerId: z.string().min(1) },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/knowledge/push-destinations/${segment(input.providerId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'brain_publish_document',
      openWorld: true,
      title: 'Publish Brain document',
      description:
        'Publishes a native Brain page to the selected integration and destination. Use brain_list_push_providers and brain_list_push_destinations first.',
      toolset: 'brain',
      access: 'write',
      routes: ['POST /knowledge/documents/:pageId/push'],
      input: {
        pageId,
        providerId: z.string().min(1),
        destination: z
          .object({
            parentPath: z.string().optional(),
            wikiIdentifier: z.string().optional(),
            listId: z.string().optional(),
            parentExternalId: z.string().optional(),
            issueType: z.string().optional(),
            externalId: z.string().optional(),
          })
          .optional(),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/knowledge/documents/${segment(input.pageId)}/push`,
            body: { providerId: input.providerId, destination: input.destination ?? {} },
          }),
        ),
    }),
    defineTool({
      name: 'brain_sync',
      openWorld: true,
      title: 'Sync Brain',
      description:
        'Synchronizes the Brain with the active knowledge integration (Azure DevOps Wiki / GitHub).',
      toolset: 'brain',
      access: 'write',
      routes: ['POST /knowledge/sync'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'POST', path: '/knowledge/sync' })),
    }),
    defineTool({
      name: 'brain_stats',
      title: 'Brain statistics',
      description: 'Returns the number of documents and indexed chunks in the Brain.',
      toolset: 'brain',
      access: 'read',
      routes: ['GET /knowledge/stats'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/knowledge/stats' })),
    }),
    defineTool({
      name: 'brain_list_relations',
      title: 'List document relations',
      description: 'Lists user-defined correlations between Brain documents (graph edges).',
      toolset: 'brain',
      access: 'read',
      routes: ['GET /knowledge/relations'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/knowledge/relations' })),
    }),
    defineTool({
      name: 'brain_add_relation',
      title: 'Relate documents',
      description: 'Creates a correlation between two Brain documents.',
      toolset: 'brain',
      access: 'write',
      routes: ['POST /knowledge/relations'],
      input: { sourcePageId: pageId, targetPageId: pageId },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/knowledge/relations', body: input })),
    }),
    defineTool({
      name: 'brain_remove_relation',
      title: 'Remove document relation',
      description: 'Removes a correlation between two Brain documents.',
      toolset: 'brain',
      access: 'destructive',
      routes: ['DELETE /knowledge/relations'],
      input: { sourcePageId: pageId, targetPageId: pageId },
      run: async (input, { api }) =>
        json(await api.request({ method: 'DELETE', path: '/knowledge/relations', query: input })),
    }),
    defineTool({
      name: 'brain_search',
      title: 'Search the Brain',
      description: 'Semantic/keyword search over Brain chunks. Returns the most relevant excerpts.',
      toolset: 'brain',
      access: 'read',
      routes: ['GET /TestPlan/search'],
      input: {
        query: z.string().trim().min(1).max(4000),
        limit: z.number().int().min(1).max(50).default(10),
      },
      run: async (input, { api }) => {
        const chunks = await searchKnowledge(api, input.query, input.limit);
        return json({
          notice: UNTRUSTED_CONTENT_RULE,
          results: chunks.map((chunk) => ({
            ...chunk,
            content: untrusted(chunk.source, chunk.content),
          })),
        });
      },
    }),
    defineTool({
      name: 'brain_ask',
      title: 'Ask the Brain (server model)',
      description:
        "Answers a question strictly from the Brain using the workspace's default agent.",
      toolset: 'brain',
      access: 'read',
      execution: 'server',
      routes: ['POST /agents/default/brain-query'],
      input: {
        question: z.string().trim().min(1).max(4000),
        history: z.string().trim().max(8000).optional().describe('Previous turns for context.'),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/agents/default/brain-query',
            body: { prompt: input.question, history: input.history },
          }),
        ),
    }),
    defineTool({
      name: 'brain_prepare_answer',
      title: 'Ask the Brain (host model)',
      description:
        'Retrieves the Brain sources for a question plus grounding rules, so you answer it yourself citing only those sources.',
      toolset: 'brain',
      access: 'read',
      execution: 'host',
      routes: ['GET /TestPlan/search'],
      input: {
        question: z.string().trim().min(1).max(4000),
        limit: z.number().int().min(1).max(30).default(10),
      },
      run: async (input, { api }) => {
        const chunks = await searchKnowledge(api, input.question, input.limit);
        return json({
          question: input.question,
          rules: BRAIN_ANSWER_RULES,
          sourcesFound: chunks.length,
          sources: chunks.length ? knowledgeBlock(chunks) : 'No Brain source matched the question.',
        });
      },
    }),
  ],
  prompts: [
    definePrompt({
      name: 'ask_brain',
      title: 'Ask the Brain',
      description: 'Answer a question using only the workspace Brain, with citations.',
      args: { question: z.string().describe('What you want to know.') },
      render: ({ question }) =>
        `Answer the question below using only the ADK Brain.\n1. Call brain_prepare_answer with the question (no API key needed).\n2. If few sources match, refine with brain_search or read pages with brain_get_document.\n3. Answer following the returned rules and cite each source.\n\nQuestion: ${question}`,
    }),
  ],
};
