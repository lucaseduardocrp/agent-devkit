import crypto from 'node:crypto';
import { Router } from 'express';
import type { DynamicProviderFactory } from '../../modules/integrations/application/dynamic-provider-factory.js';
import {
  chunkPage,
  synchronizeKnowledge,
  type KnowledgeChunkRepository,
  type KnowledgePage,
} from '../../modules/knowledge/application/knowledge-provider.js';
import { requireOwnerId } from '../../modules/knowledge/application/ownership.js';
import { ApplicationError } from '../../shared/errors.js';
import type { RequestContext } from '../../shared/context.js';
import { translateContent } from '../../shared/i18n.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireModuleAccess } from './module-policy.js';

function requireBrainWritePermission(context: RequestContext): void {
  requireOwnerId(context);
  requireModuleAccess(context, [{ module: 'brain', operation: 'edit' }]);
}

const nativeSource = (source: string): boolean => source.startsWith('app://local?title=');
const sourceParam = (source: string, key: string): string | null => {
  try {
    return new URL(source).searchParams.get(key);
  } catch {
    return null;
  }
};
const wikiPath = (source: string): string | null => sourceParam(source, 'pagePath');
const wikiSegment = (title: string): string => {
  const segment = title.trim();
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    /[/?#\\]/.test(segment) ||
    [...segment].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new ApplicationError(
      'INVALID_WIKI_PATH',
      'O título não pode ser usado como página da Wiki.',
      400,
    );
  }
  return segment;
};
const normalizedWikiParentPath = (value: string): string => {
  const segments = value.trim().split('/').filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        /[?#\\]/.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32),
    )
  ) {
    throw new ApplicationError(
      'INVALID_WIKI_PATH',
      'O caminho de destino da Wiki é inválido.',
      400,
    );
  }
  return segments.length ? `/${segments.join('/')}` : '';
};
const nativeDocumentSource = (title: string, parentPageId?: string): string =>
  `app://local?title=${encodeURIComponent(title)}${parentPageId ? `&parentPageId=${encodeURIComponent(parentPageId)}` : ''}`;

export function createKnowledgeRouter(
  knowledgeRepository: KnowledgeChunkRepository,
  dynamicProviderFactory: DynamicProviderFactory,
  resolveRequestContext: RequestContextResolver,
): Router {
  const router = Router();

  router.get('/knowledge/relations', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireOwnerId(context);
      response.json({ relations: await knowledgeRepository.listRelations(context) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/knowledge/relations', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireBrainWritePermission(context);
      const { sourcePageId, targetPageId } = request.body as Record<string, unknown>;
      if (typeof sourcePageId !== 'string' || typeof targetPageId !== 'string') {
        throw new ApplicationError(
          'INVALID_KNOWLEDGE_RELATION',
          'Os documentos da correlação são obrigatórios.',
          400,
        );
      }
      await knowledgeRepository.addRelation(sourcePageId, targetPageId, context);
      response.status(201).json({ relations: await knowledgeRepository.listRelations(context) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/knowledge/relations', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireBrainWritePermission(context);
      const sourcePageId =
        typeof request.query.sourcePageId === 'string' ? request.query.sourcePageId : '';
      const targetPageId =
        typeof request.query.targetPageId === 'string' ? request.query.targetPageId : '';
      await knowledgeRepository.deleteRelation(sourcePageId, targetPageId, context);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/knowledge/sync', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireBrainWritePermission(context);
      const ownerId = requireOwnerId(context);

      const provider = await dynamicProviderFactory.resolveKnowledgeProvider(ownerId);
      if (!provider) {
        throw new ApplicationError(
          'NO_ACTIVE_KNOWLEDGE_PROVIDER',
          'Nenhum provedor de documentação está ativo. Configure o Azure DevOps ou GitHub Projects na aba Connect.',
          400,
        );
      }

      const result = await synchronizeKnowledge(provider, knowledgeRepository, context);

      response.status(200).json({
        success: true,
        provider: provider.name,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/knowledge/push-providers', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const ownerId = requireOwnerId(context);
      response.json({ providers: await dynamicProviderFactory.listBrainPushProviders(ownerId) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/knowledge/push-destinations/:providerId', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const ownerId = requireOwnerId(context);
      const { providerId } = request.params;
      if (providerId === 'azure_devops_wiki') {
        const pages = new Map<string, { id: string; label: string }>();
        for (const chunk of await knowledgeRepository.all(context)) {
          const path = wikiPath(chunk.source);
          if (path) pages.set(path, { id: path, label: path });
        }
        response.json({
          destinations: [...pages.values()].sort((a, b) => a.label.localeCompare(b.label)),
        });
        return;
      }
      const provider = await dynamicProviderFactory.resolveBrainBoardPushProvider(
        ownerId,
        providerId,
      );
      if (!provider) {
        throw new ApplicationError(
          'PUSH_PROVIDER_NOT_CONFIGURED',
          'Integração de destino não configurada.',
          400,
        );
      }
      const items = await provider.pull();
      response.json({
        destinations: items
          .filter((item) => providerId !== 'trello' || item.sourceData.trelloType === 'list')
          .map((item) => ({ id: item.externalId, label: item.title }))
          .slice(0, 500),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/knowledge/documents/:pageId/push', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireBrainWritePermission(context);
      const ownerId = requireOwnerId(context);
      const pageId = request.params.pageId;
      if (pageId.length > 500) {
        throw new ApplicationError('DOCUMENT_NOT_FOUND', 'Documento não encontrado.', 404);
      }
      const all = await knowledgeRepository.all(context);
      const chunks = all
        .filter((chunk) => chunk.pageId === pageId && nativeSource(chunk.source))
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      if (chunks.length === 0) {
        throw new ApplicationError('DOCUMENT_NOT_FOUND', 'Documento nativo não encontrado.', 404);
      }
      if (!new URL(chunks[0]!.source).searchParams.get('title')?.trim()) {
        throw new ApplicationError('INVALID_DOCUMENT_TITLE', 'O documento não possui título.', 400);
      }
      const input = (request.body ?? {}) as Record<string, unknown>;
      if (input.providerId !== undefined) {
        const providerId = input.providerId;
        const title = sourceParam(chunks[0]!.source, 'title')!.trim();
        const content = chunks.map((chunk) => chunk.content).join('');
        const destination =
          input.destination && typeof input.destination === 'object'
            ? (input.destination as Record<string, unknown>)
            : {};
        const value = (key: string): string => {
          const field = destination[key];
          if (field === undefined || field === null) return '';
          if (typeof field !== 'string' || field.length > 500)
            throw new ApplicationError(
              'INVALID_PUSH_DESTINATION',
              'Destino de publicação inválido.',
              400,
            );
          return field.trim();
        };
        if (providerId === 'azure_devops_wiki') {
          const provider = await dynamicProviderFactory.resolveAzureDevOpsWikiProvider(
            ownerId,
            undefined,
            value('wikiIdentifier'),
          );
          if (!provider)
            throw new ApplicationError(
              'PUSH_PROVIDER_NOT_CONFIGURED',
              'Wiki do Azure DevOps não configurada.',
              400,
            );
          const parentPath = normalizedWikiParentPath(value('parentPath'));
          const page = await provider.pushPage({
            id: pageId,
            content,
            path: `${parentPath}/${wikiSegment(title)}`,
          });
          response.json({ success: true, remoteUrl: page.source, published: [] });
          return;
        }
        if (typeof providerId !== 'string')
          throw new ApplicationError(
            'INVALID_PUSH_PROVIDER',
            'Selecione uma integração válida.',
            400,
          );
        const provider = await dynamicProviderFactory.resolveBrainBoardPushProvider(
          ownerId,
          providerId,
        );
        if (!provider)
          throw new ApplicationError(
            'PUSH_PROVIDER_NOT_CONFIGURED',
            'Integração de destino não configurada.',
            400,
          );
        const listId = value('listId');
        const parentExternalId = value('parentExternalId');
        if (providerId === 'trello' && !listId)
          throw new ApplicationError(
            'INVALID_PUSH_DESTINATION',
            'Selecione uma lista do Trello.',
            400,
          );
        const pushed = await provider.push(
          { kind: 'card', title, description: content, status: 'backlog' },
          {
            ...(listId ? { listId } : {}),
            ...(parentExternalId ? { parentExternalId } : {}),
            ...(value('issueType') ? { issueType: value('issueType') } : {}),
            ...(value('externalId') ? { externalId: value('externalId') } : {}),
          },
        );
        response.json({ success: true, remoteUrl: pushed.externalUrl, published: [] });
        return;
      }
      const provider = await dynamicProviderFactory.resolveAzureDevOpsWikiProvider(ownerId);
      if (!provider) {
        throw new ApplicationError(
          'AZURE_WIKI_NOT_CONFIGURED',
          'Configure e ative a integração Azure DevOps com credenciais de escrita.',
          400,
        );
      }
      const grouped = new Map<string, typeof chunks>();
      for (const chunk of all.filter((item) => nativeSource(item.source))) {
        const group = grouped.get(chunk.pageId) ?? [];
        group.push(chunk);
        grouped.set(chunk.pageId, group);
      }
      let rootId = pageId;
      const ancestors = new Set<string>([rootId]);
      while (true) {
        const parentId = sourceParam(grouped.get(rootId)![0]!.source, 'parentPageId');
        if (!parentId || !grouped.has(parentId)) break;
        if (ancestors.has(parentId))
          throw new ApplicationError(
            'INVALID_DOCUMENT_HIERARCHY',
            'A hierarquia dos documentos contém um ciclo.',
            409,
          );
        ancestors.add(parentId);
        rootId = parentId;
      }
      const published: { oldId: string; newId: string; remoteUrl: string }[] = [];
      const pending: {
        previous: Readonly<Pick<KnowledgePage, 'id' | 'source'>>;
        page: KnowledgePage;
      }[] = [];
      const pushTree = async (id: string, parentPath = ''): Promise<void> => {
        const own = grouped.get(id)!.sort((a, b) => a.chunkIndex - b.chunkIndex);
        const title = sourceParam(own[0]!.source, 'title')?.trim();
        if (!title)
          throw new ApplicationError(
            'INVALID_DOCUMENT_TITLE',
            'O documento não possui título.',
            400,
          );
        const path = `${parentPath}/${wikiSegment(title)}`;
        const verifiedPage = await provider.pushPage({
          id,
          content: own.map((chunk) => chunk.content).join(''),
          path,
        });
        pending.push({
          previous: { id, source: own[0]!.source },
          page: verifiedPage,
        });
        published.push({
          oldId: `${own[0]!.source}:${id}`,
          newId: `${verifiedPage.source}:${verifiedPage.id}`,
          remoteUrl: verifiedPage.source,
        });
        for (const [childId, child] of grouped) {
          if (sourceParam(child[0]!.source, 'parentPageId') === id) await pushTree(childId, path);
        }
      };
      try {
        await pushTree(rootId);
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          'AZURE_WIKI_ERROR',
          'Falha na comunicação com a Wiki do Azure DevOps.',
          502,
          [{ stage: 'network' }],
        );
      }
      await knowledgeRepository.movePages(
        pending.map((item) => ({
          previous: item.previous,
          page: item.page,
          chunks: chunkPage(item.page),
        })),
        context,
      );
      response.status(200).json({
        success: true,
        remoteUrl: published.find((item) => item.oldId.endsWith(`:${pageId}`))!.remoteUrl,
        published,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/knowledge/stats', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const chunks = await knowledgeRepository.all(context);
      const uniquePages = new Set(chunks.map((chunk) => `${chunk.source}:${chunk.pageId}`));

      response.status(200).json({
        documentsCount: uniquePages.size,
        chunksCount: chunks.length,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/knowledge/documents', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const chunks = await knowledgeRepository.all(context);

      interface DocumentSummary {
        id: string;
        pageId: string;
        source: string;
        title: string;
        content: string;
        chunksCount: number;
        totalCharacters: number;
        updatedAt: string;
        isCustom: boolean;
        parentPageId?: string;
        pagePath?: string;
      }
      const docsMap = new Map<string, DocumentSummary>();
      const docChunksMap = new Map<string, { chunkIndex: number; content: string }[]>();

      for (const chunk of chunks) {
        const key = `${chunk.source}:${chunk.pageId}`;
        let doc = docsMap.get(key);
        let chunkList = docChunksMap.get(key);
        if (!chunkList) {
          chunkList = [];
          docChunksMap.set(key, chunkList);
        }
        chunkList.push({ chunkIndex: chunk.chunkIndex, content: chunk.content });

        if (!doc) {
          let title = chunk.pageId;
          const isCustom =
            chunk.source.startsWith('app://') ||
            chunk.source === 'app' ||
            (!chunk.source.startsWith('http://') && !chunk.source.startsWith('https://'));

          try {
            const url = new URL(chunk.source);
            const customTitle = url.searchParams.get('title');
            if (customTitle) {
              title = decodeURIComponent(customTitle);
            } else {
              const pagePath = url.searchParams.get('pagePath');
              if (pagePath) {
                const clean = decodeURIComponent(pagePath).replace(/^\/+/, '');
                title =
                  clean
                    .split('/')
                    .filter(Boolean)
                    .at(-1)
                    ?.replace(/-doc-[a-f\d-]{36}$/i, '') ?? chunk.pageId;
              } else {
                const parts = url.pathname.split('/').filter(Boolean);
                const lastPart = parts[parts.length - 1];
                title = lastPart ? decodeURIComponent(lastPart) : chunk.pageId;
              }
            }
          } catch {
            // non-url source fallback to chunk.pageId
          }

          doc = {
            id: key,
            pageId: chunk.pageId,
            source: chunk.source,
            title,
            content: '',
            chunksCount: 0,
            totalCharacters: 0,
            updatedAt: chunk.createdAt,
            isCustom,
            ...(sourceParam(chunk.source, 'parentPageId')
              ? { parentPageId: sourceParam(chunk.source, 'parentPageId')! }
              : {}),
            ...(wikiPath(chunk.source) ? { pagePath: wikiPath(chunk.source)! } : {}),
          };
          docsMap.set(key, doc);
        }

        doc.chunksCount += 1;
        doc.totalCharacters += chunk.content.length;
        doc.updatedAt = chunk.createdAt;
      }

      for (const [key, doc] of docsMap) {
        const list = docChunksMap.get(key)!;
        list.sort((a, b) => a.chunkIndex - b.chunkIndex);
        doc.content = list.map((c) => c.content).join('');
        const contentTitle = doc.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
        const isPublishedByadk =
          !doc.isCustom && /-doc-[a-f\d-]{36}$/i.test(wikiPath(doc.source) ?? '');
        if (contentTitle && ((doc.isCustom && doc.title === doc.pageId) || isPublishedByadk)) {
          doc.title = contentTitle;
        }
      }

      response.status(200).json({
        documents: Array.from(docsMap.values()),
      });
    } catch (error) {
      next(error);
    }
  });

  function normalizeDocumentContent(title: string, content: string): string {
    const cleanTitle = title.trim();
    const trimmed = content.trim();
    if (!trimmed) {
      return `# ${cleanTitle}`;
    }
    if (trimmed.startsWith('# ')) {
      return trimmed.replace(/^#\s+[^\r\n]+/, `# ${cleanTitle}`);
    }
    return `# ${cleanTitle}\n\n${trimmed}`;
  }

  router.post('/knowledge/documents', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireBrainWritePermission(context);

      const { title, content, parentPageId } = request.body as {
        title?: unknown;
        content?: unknown;
        parentPageId?: unknown;
      };
      if (!title || typeof title !== 'string' || !title.trim()) {
        throw new ApplicationError(
          'INVALID_DOCUMENT_TITLE',
          'O título do documento é obrigatório.',
          400,
        );
      }
      if (typeof content !== 'string') {
        throw new ApplicationError(
          'INVALID_DOCUMENT_CONTENT',
          'O conteúdo do documento deve ser uma string.',
          400,
        );
      }
      if (parentPageId !== undefined) {
        const parent = (await knowledgeRepository.all(context)).find(
          (chunk) => chunk.pageId === parentPageId && nativeSource(chunk.source),
        );
        if (typeof parentPageId !== 'string' || !parent)
          throw new ApplicationError(
            'PARENT_DOCUMENT_NOT_FOUND',
            'Documento pai não encontrado.',
            404,
          );
      }

      const cleanTitle = title.trim();
      const pageId = `doc-${crypto.randomUUID()}`;
      const source = nativeDocumentSource(cleanTitle, parentPageId);
      const now = new Date().toISOString();
      const finalContent = normalizeDocumentContent(cleanTitle, content);

      const page: KnowledgePage = {
        id: pageId,
        source,
        content: finalContent,
        updatedAt: now,
      };

      const chunks = chunkPage(page);
      await knowledgeRepository.replacePage(page, chunks, context);

      response.status(201).json({
        success: true,
        document: {
          id: `${source}:${pageId}`,
          pageId,
          source,
          title: cleanTitle,
          content: finalContent,
          chunksCount: chunks.length,
          totalCharacters: finalContent.length,
          updatedAt: now,
          isCustom: true,
          ...(parentPageId ? { parentPageId } : {}),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/knowledge/documents/:pageId', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireBrainWritePermission(context);

      const { pageId } = request.params;
      const { title, content } = request.body as {
        title?: unknown;
        content?: unknown;
      };

      if (!title || typeof title !== 'string' || !title.trim()) {
        throw new ApplicationError(
          'INVALID_DOCUMENT_TITLE',
          'O título do documento é obrigatório.',
          400,
        );
      }
      if (typeof content !== 'string') {
        throw new ApplicationError(
          'INVALID_DOCUMENT_CONTENT',
          'O conteúdo do documento deve ser uma string.',
          400,
        );
      }

      const allChunks = await knowledgeRepository.all(context);
      const docChunks = allChunks.filter((c) => c.pageId === pageId);

      if (docChunks.length === 0) {
        throw new ApplicationError('DOCUMENT_NOT_FOUND', 'Documento não encontrado.', 404);
      }

      const existingSource = docChunks[0]!.source;
      const isExternal =
        existingSource.startsWith('http://') || existingSource.startsWith('https://');

      if (isExternal) {
        throw new ApplicationError(
          'CANNOT_EDIT_EXTERNAL_DOCUMENT',
          'Documentos sincronizados de integrações externas não podem ser editados diretamente. A edição deve ser feita na plataforma de origem e sincronizada.',
          400,
        );
      }

      const cleanTitle = title.trim();
      const parentPageId = sourceParam(existingSource, 'parentPageId') ?? undefined;
      const targetSource = nativeDocumentSource(cleanTitle, parentPageId);
      const now = new Date().toISOString();
      const finalContent = normalizeDocumentContent(cleanTitle, content);

      const page: KnowledgePage = {
        id: pageId,
        source: targetSource,
        content: finalContent,
        updatedAt: now,
      };

      const chunks = chunkPage(page);
      await knowledgeRepository.movePages(
        [{ previous: { id: pageId, source: existingSource }, page, chunks }],
        context,
      );

      response.status(200).json({
        success: true,
        document: {
          id: `${targetSource}:${pageId}`,
          pageId,
          source: targetSource,
          title: cleanTitle,
          content: finalContent,
          chunksCount: chunks.length,
          totalCharacters: finalContent.length,
          updatedAt: now,
          isCustom: true,
          ...(parentPageId ? { parentPageId } : {}),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/knowledge/documents/:pageId', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireBrainWritePermission(context);

      const { pageId } = request.params;
      const sourceQuery = request.query['source'] as string | undefined;

      const allChunks = await knowledgeRepository.all(context);
      const matchingChunks = allChunks.filter(
        (c) => c.pageId === pageId && (!sourceQuery || c.source === sourceQuery),
      );

      if (matchingChunks.length === 0) {
        throw new ApplicationError('DOCUMENT_NOT_FOUND', 'Documento não encontrado.', 404);
      }

      const sourceToDelete = matchingChunks[0]!.source;
      if (allChunks.some((chunk) => sourceParam(chunk.source, 'parentPageId') === pageId))
        throw new ApplicationError(
          'DOCUMENT_HAS_SUBPAGES',
          'Exclua as subpáginas antes de excluir este documento.',
          409,
        );
      await knowledgeRepository.deletePage({ id: pageId, source: sourceToDelete }, context);

      response.status(200).json({
        success: true,
        message: translateContent('documentDeleted', context.locale),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
