import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { HistoryViewer } from '../audit/HistoryViewer.js';
import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { ResizableSidebar } from '../../components/layout/ResizableSidebar.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Skeleton, SkeletonRow } from '../../components/ui/skeleton.js';
import type {
  ApiClient,
  KnowledgeChunkDto,
  KnowledgeDocumentDto,
  KnowledgeRelationDto,
  KnowledgePushInput,
} from '../../lib/api-client.js';
import { MarkdownViewer } from './MarkdownViewer.js';
import { stripLeadingTitleHeading } from './markdown-parser.js';
import { BrainGraph } from './BrainGraph.js';
import { createBrainGraphState } from './brain-graph-model.js';
import { BrainPushModal } from './BrainPushModal.js';
import { CreateSpecFromDocument } from './CreateSpecFromDocument.js';
import { GenerateTestPlanFromSource } from '../testplans/GenerateTestPlanFromSource.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import { usePermissions } from '../workspaces/permissions.js';

export interface BrainViewProps {
  readonly apiClient?: ApiClient;
  readonly defaultOwnerId?: string;
  readonly initialDocuments?: readonly KnowledgeDocumentDto[];
  readonly isReadOnly?: boolean;
  readonly className?: string;
}

export interface OpenTabItem {
  readonly id: string;
  readonly title: string;
  readonly type: 'graph' | 'doc';
  readonly docId?: string;
}

interface BrainAssistantMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

function orderedDocuments(
  docs: readonly KnowledgeDocumentDto[],
  collapsedIds: ReadonlySet<string>,
): { doc: KnowledgeDocumentDto; depth: number; hasChildren: boolean }[] {
  const byId = new Map(docs.map((doc) => [doc.pageId, doc]));
  const documentPath = (doc: KnowledgeDocumentDto): string | undefined => {
    const rawPath =
      doc.pagePath ??
      (() => {
        try {
          return new URL(doc.source).searchParams.get('pagePath') ?? undefined;
        } catch {
          return undefined;
        }
      })();
    if (!rawPath) return undefined;
    const normalized = `/${decodeURIComponent(rawPath)}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    return normalized;
  };
  const byPath = new Map(
    docs.flatMap((doc) => {
      const path = documentPath(doc);
      return path ? [[path, doc] as const] : [];
    }),
  );
  const parentOf = (doc: KnowledgeDocumentDto): KnowledgeDocumentDto | undefined => {
    const parentPageId =
      doc.parentPageId ??
      (() => {
        try {
          return new URL(doc.source).searchParams.get('parentPageId') ?? undefined;
        } catch {
          return undefined;
        }
      })();
    if (parentPageId) return byId.get(parentPageId);
    const path = documentPath(doc);
    if (!path) return undefined;
    const parentPath = path.slice(0, path.lastIndexOf('/'));
    return parentPath ? byPath.get(parentPath) : undefined;
  };
  const result: { doc: KnowledgeDocumentDto; depth: number; hasChildren: boolean }[] = [];
  const seen = new Set<string>();
  const hideBranch = (doc: KnowledgeDocumentDto): void => {
    /* v8 ignore next -- protects against malformed cyclic hierarchy data */
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    for (const child of docs.filter((candidate) => parentOf(candidate)?.id === doc.id))
      hideBranch(child);
  };
  const visit = (doc: KnowledgeDocumentDto, depth: number): void => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    const children = docs.filter((candidate) => parentOf(candidate)?.id === doc.id);
    result.push({ doc, depth, hasChildren: children.length > 0 });
    if (collapsedIds.has(doc.id)) {
      for (const child of children) hideBranch(child);
      return;
    }
    for (const child of children) visit(child, depth + 1);
  };
  for (const doc of docs) if (!parentOf(doc)) visit(doc, 0);
  for (const doc of docs) visit(doc, 0);
  return result;
}

export function BrainView({
  apiClient,
  defaultOwnerId = 'default-owner',
  initialDocuments,
  isReadOnly = false,
  className,
}: BrainViewProps) {
  const { t, formatDate } = useI18n();
  const { runActivity } = useActivityRunner();
  const permissions = usePermissions();
  // Deleting is a level above editing, so a read-only Brain never offers it. Specs and test
  // plans generated from a document live in their own modules and follow those permissions.
  const canDeleteDocuments = !isReadOnly && permissions.can('brain', 'delete');
  const canCreateSpecs = permissions.can('specs', 'edit');
  const canGenerateTestPlans = permissions.can('testplans', 'edit');
  const [tabs, setTabs] = useState<readonly OpenTabItem[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isFolderExpanded, setIsFolderExpanded] = useState(true);
  const [isAppFolderExpanded, setIsAppFolderExpanded] = useState(true);
  const [collapsedDocumentIds, setCollapsedDocumentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const [editingDoc, setEditingDoc] = useState<KnowledgeDocumentDto | 'new' | null>(null);
  const [newParentPageId, setNewParentPageId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editPreview, setEditPreview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [wikilinkQuery, setWikilinkQuery] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [wikilinkIndex, setWikilinkIndex] = useState(0);
  const [pendingRelationIds, setPendingRelationIds] = useState<readonly string[]>([]);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [assistantAgentId, setAssistantAgentId] = useState('');
  const [assistantMessage, setAssistantMessage] = useState('');
  const [assistantMessages, setAssistantMessages] = useState<readonly BrainAssistantMessage[]>([]);
  const [isAssistantWorking, setIsAssistantWorking] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [isResearchSidebarCollapsed, setIsResearchSidebarCollapsed] = useState(false);
  const [researchMessage, setResearchMessage] = useState('');
  const [researchMessages, setResearchMessages] = useState<readonly BrainAssistantMessage[]>([]);
  const [isResearching, setIsResearching] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  useEffect(() => {
    return undefined;
  }, []);

  useEffect(() => {
    if (!apiClient) return;
    let active = true;
    apiClient
      .getAgents()
      .then((items) => {
        if (active) setAgents(items);
      })
      .catch(() => {
        if (active) setAgents([]);
      });
    return () => {
      active = false;
    };
  }, [apiClient]);

  const [documentToDelete, setDocumentToDelete] = useState<KnowledgeDocumentDto | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const [isLinking, setIsLinking] = useState(false);

  // Only reachable from the link button, which needs a client, a target and no link in flight.
  const handleLinkDocument = async (client: ApiClient, document: KnowledgeDocumentDto) => {
    setIsLinking(true);
    try {
      setRelations(await client.createKnowledgeRelation(document.pageId, linkTarget));
      setLinkTarget('');
      setSyncFeedback({ type: 'success', message: 'Link adicionado ao documento.' });
    } catch (error) {
      setSyncFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Falha ao adicionar link.',
      });
    } finally {
      setIsLinking(false);
    }
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<readonly KnowledgeChunkDto[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [stats, setStats] = useState<{
    documentsCount: number;
    chunksCount: number;
    lastSync: string;
  } | null>(null);
  const [documents, setDocuments] = useState<readonly KnowledgeDocumentDto[]>(
    initialDocuments ?? [],
  );
  const [relations, setRelations] = useState<readonly KnowledgeRelationDto[]>([]);
  const connectionCount = createBrainGraphState(documents, relations).edges.length;
  const [isLoadingDocs, setIsLoadingDocs] = useState<boolean>(
    Boolean(apiClient && !initialDocuments),
  );
  const [isSyncing, setIsSyncing] = useState(false);
  const [pushingPageId, setPushingPageId] = useState<string | null>(null);
  const [pushDocument, setPushDocument] = useState<KnowledgeDocumentDto | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
    remoteUrl?: string;
  } | null>(null);

  useEffect(() => {
    let isMounted = true;
    if (!apiClient) return;

    setIsLoadingDocs(true);
    Promise.all([
      apiClient.getKnowledgeStats(defaultOwnerId),
      apiClient.getKnowledgeDocuments(defaultOwnerId),
    ])
      .then(([data, docs]) => {
        if (!isMounted) return;
        setStats({
          documentsCount: data.documentsCount,
          chunksCount: data.chunksCount,
          lastSync: t('brain.recent'),
        });
        setDocuments(docs);
      })
      .catch(() => {
        // Fallback to static stats if offline or unauthenticated
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingDocs(false);
        }
      });

    apiClient
      .getKnowledgeRelations()
      .then((relationList) => {
        if (isMounted) setRelations(relationList);
      })
      .catch(() => {
        // Correlations remain unavailable when using an older or offline backend.
      });

    return () => {
      isMounted = false;
    };
  }, [apiClient, defaultOwnerId, t]);

  const handleSync = async () => {
    if (!apiClient || isSyncing) return;

    setIsSyncing(true);
    setSyncFeedback(null);

    try {
      const res = await runActivity(
        { kind: 'sync', title: 'Sincronizando documentos', detail: 'Azure DevOps' },
        () => apiClient.syncKnowledge(),
      );
      const [updatedStats, updatedDocs, updatedRelations] = await Promise.all([
        apiClient.getKnowledgeStats(defaultOwnerId),
        apiClient.getKnowledgeDocuments(defaultOwnerId),
        apiClient.getKnowledgeRelations(),
      ]);
      setStats({
        documentsCount: updatedStats.documentsCount,
        chunksCount: updatedStats.chunksCount,
        lastSync: t('brain.justNow'),
      });
      const archivedIds = new Map(
        (res.archived ?? []).map((item) => [
          `${item.oldSource}:${item.pageId}`,
          `${item.newSource}:${item.pageId}`,
        ]),
      );
      setTabs((current) =>
        current.map((tab) => {
          const nextId = archivedIds.get(tab.id);
          return nextId ? { ...tab, id: nextId, docId: nextId } : tab;
        }),
      );
      setActiveTabId((current) => archivedIds.get(current ?? '') ?? current);
      setDocuments(updatedDocs);
      setRelations(updatedRelations);
      const archivedFeedback = res.archived?.length
        ? ` ${res.archived.length} ${t('brain.archivedDocuments')}`
        : '';
      setSyncFeedback({
        type: 'success',
        message: `${t('brain.syncSuccess')} ${res.chunksCount} ${t('brain.indexedChunks')}${archivedFeedback}`,
      });
    } catch (error) {
      setSyncFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : t('brain.syncFailure'),
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePush = async (
    doc: KnowledgeDocumentDto,
    client: ApiClient,
    input: KnowledgePushInput,
    providerName: string,
  ): Promise<{ success: boolean; error?: string }> => {
    setPushingPageId(doc.pageId);
    setSyncFeedback(null);
    try {
      const result = await runActivity(
        { kind: 'push', title: `Enviando “${doc.title}”`, detail: providerName },
        () => client.pushKnowledgeDocument(doc.pageId, input),
      );
      const [updatedDocs, updatedRelations] = await Promise.all([
        client.getKnowledgeDocuments(defaultOwnerId),
        client.getKnowledgeRelations(),
      ]);
      setDocuments(updatedDocs);
      setRelations(updatedRelations);
      const published = new Map((result.published ?? []).map((item) => [item.oldId, item.newId]));
      setTabs((prev) =>
        prev.map((tab) => {
          const newId = published.get(tab.id);
          const updated = updatedDocs.find((item) => item.id === newId);
          return newId
            ? {
                ...tab,
                id: newId,
                docId: newId,
                title: updated!.title,
              }
            : tab;
        }),
      );
      /* v8 ignore next -- publishing is only available while a document tab is active */
      setActiveTabId((prev) => published.get(prev ?? '') ?? prev);
      const updatedStats = await client.getKnowledgeStats(defaultOwnerId);
      setStats({
        documentsCount: updatedStats.documentsCount,
        chunksCount: updatedStats.chunksCount,
        lastSync: t('brain.justNow'),
      });
      setSyncFeedback({
        type: 'success',
        message: t('brain.pushSuccess'),
        remoteUrl: result.remoteUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('brain.pushFailure');
      setSyncFeedback({
        type: 'error',
        message,
      });
      return { success: false, error: message };
    } finally {
      setPushingPageId(null);
    }
    return { success: true };
  };

  const currentDocs = documents;

  const toggleDocumentExpansion = (documentId: string) => {
    setCollapsedDocumentIds((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  };

  const resolveChunkDocTitle = (chunk: { source: string; pageId: string }) => {
    const found = currentDocs.find(
      (d) => d.id === chunk.pageId || d.pageId === chunk.pageId || d.source === chunk.source,
    );
    return found?.title || chunk.pageId || chunk.source;
  };

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const executeSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        setSearchResults(null);
        setSearchError(null);
        setIsSearching(false);
        return;
      }

      if (!apiClient) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);
      setSearchError(null);

      try {
        const results = await apiClient.searchKnowledge(trimmed, defaultOwnerId);
        setSearchResults(results);
      } catch (error) {
        setSearchError(
          error instanceof Error ? error.message : 'Falha ao realizar busca de conhecimento.',
        );
        setSearchResults(null);
      } finally {
        setIsSearching(false);
      }
    },
    [apiClient, defaultOwnerId],
  );

  // Live auto-search as user types
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (!searchQuery.trim()) {
      setSearchResults(null);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    searchTimeoutRef.current = setTimeout(() => {
      void executeSearch(searchQuery);
    }, 150);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery, executeSearch]);

  const handleSearch = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    await executeSearch(searchQuery);
  };

  const handleClearSearch = () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    setSearchQuery('');
    setSearchResults(null);
    setSearchError(null);
  };

  const isAppDocument = (doc: KnowledgeDocumentDto): boolean =>
    Boolean(
      doc.isCustom ||
      doc.source.startsWith('app://') ||
      doc.source === 'app' ||
      doc.source === 'local',
    );

  const handleStartCreateDocument = () => {
    setNewParentPageId(null);
    setActiveTabId(null);
    setEditingDoc('new');
    setEditTitle('');
    setEditContent('');
    setEditPreview(false);
    setSaveError(null);
    setWikilinkQuery(null);
    setPendingRelationIds([]);
    clearAssistantContext();
  };

  const handleStartCreateSubpage = (parent: KnowledgeDocumentDto) => {
    handleStartCreateDocument();
    setNewParentPageId(parent.pageId);
  };

  const handleStartEdit = (doc: KnowledgeDocumentDto) => {
    setEditingDoc(doc);
    setEditTitle(doc.title);
    setEditContent(stripLeadingTitleHeading(doc.content ?? '', doc.title));
    setEditPreview(false);
    setSaveError(null);
    setWikilinkQuery(null);
    setPendingRelationIds([]);
    clearAssistantContext();
  };

  const handleCancelEdit = () => {
    setEditingDoc(null);
    setSaveError(null);
    setWikilinkQuery(null);
    setPendingRelationIds([]);
    setAssistantMessages([]);
    setAssistantMessage('');
    setAssistantError(null);
  };

  const clearAssistantContext = () => {
    setAssistantMessages([]);
    setAssistantMessage('');
    setAssistantError(null);
  };

  const askDocumentationAssistant = async () => {
    if (!apiClient || !assistantAgentId || !assistantMessage.trim() || isAssistantWorking) return;
    const userMessage: BrainAssistantMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: assistantMessage.trim(),
    };
    const history = [...assistantMessages, userMessage]
      .slice(-8)
      .map((item) => `${item.role === 'user' ? 'Usuário' : 'Assistente'}: ${item.content}`)
      .join('\n\n');
    setAssistantMessages((current) => [...current, userMessage]);
    setAssistantMessage('');
    setAssistantError(null);
    setIsAssistantWorking(true);
    try {
      const response = await runActivity(
        {
          kind: 'agent',
          title: 'Agente auxiliando a documentação',
          detail: editTitle || 'Novo documento',
        },
        () =>
          apiClient.executeAgent(assistantAgentId, {
            useKnowledge: true,
            prompt: `Você está ajudando a escrever documentação Markdown. Título: ${editTitle || 'Sem título'}.\n\nConteúdo atual:\n${editContent.slice(-8000)}\n\nConversa:\n${history}\n\nResponda em Markdown, com uma sugestão pronta para inserir quando for apropriado.`,
          }),
      );
      setAssistantMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'assistant', content: response.content },
      ]);
    } catch (error) {
      setAssistantError(
        error instanceof Error ? error.message : 'Não foi possível consultar o agente.',
      );
    } finally {
      setIsAssistantWorking(false);
    }
  };

  const insertAssistantResponse = (content: string) => {
    const editor = editorRef.current;
    const cursor = editor?.selectionStart ?? editContent.length;
    const separator = editContent && !editContent.endsWith('\n') ? '\n\n' : '';
    const next = `${editContent.slice(0, cursor)}${separator}${content}${editContent.slice(cursor)}`;
    setEditContent(next);
    requestAnimationFrame(() => editor?.focus());
  };

  const askBrain = async () => {
    if (!apiClient || !researchMessage.trim() || isResearching) return;
    const question = researchMessage.trim();
    const userMessage: BrainAssistantMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: question,
    };
    const history = researchMessages
      .slice(-8)
      .map((item) => `${item.role === 'user' ? 'Usuário' : 'Agente'}: ${item.content}`)
      .join('\n\n');
    setResearchMessages((current) => [...current, userMessage]);
    setResearchMessage('');
    setResearchError(null);
    setIsResearching(true);
    try {
      const result = await apiClient.queryBrain(question, history || undefined);
      setResearchMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'assistant', content: result.content },
      ]);
    } catch (error) {
      setResearchError(
        error instanceof Error ? error.message : 'Não foi possível consultar o Brain.',
      );
    } finally {
      setIsResearching(false);
    }
  };

  const clearResearchContext = () => {
    setResearchMessages([]);
    setResearchMessage('');
    setResearchError(null);
  };

  const wikilinkSuggestions = wikilinkQuery
    ? documents.filter(
        (document) =>
          document.pageId !== (editingDoc === 'new' ? undefined : editingDoc?.pageId) &&
          !pendingRelationIds.includes(document.pageId) &&
          document.title.toLocaleLowerCase().includes(wikilinkQuery.query.toLocaleLowerCase()),
      )
    : [];

  const handleEditorChange = (value: string, cursor: number) => {
    setEditContent(value);
    const beforeCursor = value.slice(0, cursor);
    const start = beforeCursor.lastIndexOf('[[');
    const lastClosed = beforeCursor.lastIndexOf(']]');
    const query = start > lastClosed ? beforeCursor.slice(start + 2) : '';
    if (start > lastClosed && !query.includes('\n') && !query.includes('[')) {
      setWikilinkQuery({ start, end: cursor, query });
      setWikilinkIndex(0);
    } else {
      setWikilinkQuery(null);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    handleWikilinkKeyDown(event);
  };

  const selectWikilink = (document: KnowledgeDocumentDto) => {
    const activeQuery = wikilinkQuery!;
    const inserted = `[[${document.title}]]`;
    const nextContent = `${editContent.slice(0, activeQuery.start)}${inserted}${editContent.slice(activeQuery.end)}`;
    const nextCursor = activeQuery.start + inserted.length;
    setEditContent(nextContent);
    setPendingRelationIds((current) => [...current, document.pageId]);
    setWikilinkQuery(null);
    const editor = editorRef.current!;
    requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handleWikilinkKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!wikilinkQuery) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setWikilinkQuery(null);
      return;
    }
    if (wikilinkSuggestions.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setWikilinkIndex(
        (current) =>
          (current + direction + wikilinkSuggestions.length) % wikilinkSuggestions.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectWikilink(wikilinkSuggestions[wikilinkIndex]!);
    }
  };

  const handleSaveDocument = async () => {
    if (!apiClient) return;
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      setSaveError(t('brain.titleRequired'));
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      let savedDocument: KnowledgeDocumentDto | null = null;
      if (editingDoc === 'new') {
        const createdDoc = newParentPageId
          ? await apiClient.createKnowledgeDocument(
              trimmedTitle,
              editContent,
              undefined,
              newParentPageId,
            )
          : await apiClient.createKnowledgeDocument(trimmedTitle, editContent);
        const newDoc = newParentPageId
          ? { ...createdDoc, parentPageId: newParentPageId }
          : createdDoc;
        savedDocument = newDoc;
        setDocuments((prev) => [...prev, newDoc]);
        openDocumentTab(newDoc);
        setSyncFeedback({
          type: 'success',
          message: t('brain.documentCreated', { title: newDoc.title }),
        });
      } else if (editingDoc) {
        const updatedDoc = await apiClient.updateKnowledgeDocument(
          editingDoc.pageId,
          trimmedTitle,
          editContent,
        );
        savedDocument = updatedDoc;
        setDocuments((prev) => prev.map((d) => (d.pageId === editingDoc.pageId ? updatedDoc : d)));
        setTabs((prev) =>
          prev.map((t) =>
            t.id === editingDoc.id ? { ...t, id: updatedDoc.id, title: updatedDoc.title } : t,
          ),
        );
        if (activeTabId === editingDoc.id) {
          setActiveTabId(updatedDoc.id);
        }
        setSyncFeedback({
          type: 'success',
          message: t('brain.documentUpdated', { title: updatedDoc.title }),
        });
      }

      if (savedDocument) {
        let updatedRelations = relations;
        for (const targetPageId of pendingRelationIds) {
          updatedRelations = await apiClient.createKnowledgeRelation(
            savedDocument.pageId,
            targetPageId,
          );
        }
        setRelations(updatedRelations);
        setPendingRelationIds([]);
      }

      const updatedStats = await apiClient.getKnowledgeStats(defaultOwnerId);
      setStats({
        documentsCount: updatedStats.documentsCount,
        chunksCount: updatedStats.chunksCount,
        lastSync: t('brain.justNow'),
      });
      setEditingDoc(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('brain.saveDocumentFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmDelete = async (targetDoc: KnowledgeDocumentDto) => {
    if (!apiClient) return;

    setIsDeleting(true);
    try {
      await apiClient.deleteKnowledgeDocument(targetDoc.pageId, targetDoc.source);

      closeTab(targetDoc.id);

      setDocuments((prev) =>
        prev.filter((d) => d.id !== targetDoc.id && d.pageId !== targetDoc.pageId),
      );

      const updatedStats = await apiClient.getKnowledgeStats(defaultOwnerId);
      setStats({
        documentsCount: updatedStats.documentsCount,
        chunksCount: updatedStats.chunksCount,
        lastSync: t('brain.justNow'),
      });

      setSyncFeedback({
        type: 'success',
        message: t('brain.documentDeleted', { title: targetDoc.title }),
      });
      setDocumentToDelete(null);
    } catch (error) {
      setSyncFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : t('brain.deleteDocumentFailed'),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Open Document in new tab (or switch to existing tab)
  const openDocumentTab = (doc: KnowledgeDocumentDto) => {
    setEditingDoc(null);
    setTabs((prev) => {
      if (prev.some((t) => t.id === doc.id)) {
        return prev;
      }
      return [...prev, { id: doc.id, title: doc.title, type: 'doc', docId: doc.id }];
    });
    setActiveTabId(doc.id);
  };

  // Open Graph in new tab (or switch to existing tab)
  const openGraphTab = () => {
    setEditingDoc(null);
    setTabs((prev) => {
      if (prev.some((t) => t.id === 'graph')) {
        return prev;
      }
      return [...prev, { id: 'graph', title: 'Graph view', type: 'graph' }];
    });
    setActiveTabId('graph');
  };

  // Open Welcome view (clears active tab)
  const openWelcomeTab = () => {
    setEditingDoc(null);
    setActiveTabId(null);
  };

  // Close tab
  const closeTab = (tabIdToClose: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== tabIdToClose));

    if (activeTabId === tabIdToClose) {
      const remaining = tabs.filter((t) => t.id !== tabIdToClose);
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1]!.id : null);
    }
  };

  // Toggle between active tab being Graph or Text note
  const toggleViewMode = () => {
    if (activeTabId === 'graph') {
      const lastDocTab = [...tabs].reverse().find((t) => t.type === 'doc');
      if (lastDocTab) {
        setActiveTabId(lastDocTab.id);
      } else {
        setActiveTabId(null);
      }
    } else {
      openGraphTab();
    }
  };

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeDoc: KnowledgeDocumentDto | undefined =
    activeTab?.type === 'doc' ? documents.find((d) => d.id === activeTab.id) : undefined;
  const handleOpenWikilink = (target: string) => {
    const normalizedTarget = target.trim().toLocaleLowerCase();
    const document = documents.find(
      (candidate) =>
        candidate.pageId.toLocaleLowerCase() === normalizedTarget ||
        candidate.title.trim().toLocaleLowerCase() === normalizedTarget,
    );
    if (document) openDocumentTab(document);
  };

  // Calculate text statistics
  const currentTitle = editingDoc
    ? editingDoc === 'new'
      ? t('brain.newDocument')
      : editTitle || editingDoc.title
    : activeTab?.type === 'graph'
      ? t('brain.graphView')
      : activeDoc
        ? activeDoc.title
        : t('brain.welcome');

  const fullTextContent = activeDoc
    ? activeDoc.content
      ? activeDoc.content
      : `# ${activeDoc.title}\n\n> ${t('brain.synchronizedDocument')} **${activeDoc.chunksCount} ${t('brain.indexedChunks')}** (${activeDoc.totalCharacters} ${t('brain.characters')}).\n\n${t('brain.synchronizeHint')}`
    : `# ${t('brain.welcome')}\n\n${t('brain.newVaultDescription')}\n\n${t('brain.vaultGuidance')}`;

  const wordCount = fullTextContent.trim().split(/\s+/).filter(Boolean).length;
  const charCount = fullTextContent.length;

  return (
    <div
      className={cn('flex h-full w-full overflow-hidden bg-[#181818] text-[#dcddde]', className)}
      data-testid="screen-brain"
    >
      {/* ========================================================================= */}
      {/* 1. LEFT SIDEBAR: MINIMALIST OBSIDIAN VAULT TREE                           */}
      {/* ========================================================================= */}
      <ResizableSidebar
        className="border-r border-[#262626] bg-[#1a1a1a] text-sm select-none"
        defaultWidth={260}
        minWidth={220}
        maxWidth="container"
        aria-label={t('brain.docSource')}
        data-testid="folder-sidebar"
      >
        {/* Minimalist Sidebar Header */}
        <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#262626] px-3 py-1.5 text-[#a0a0a0]">
          <div
            onClick={openWelcomeTab}
            className="flex min-w-0 shrink items-center gap-2 font-semibold text-[#f5f5f5] transition hover:text-white"
            data-testid="tab-brain-overview"
            title={t('brain.title')}
          >
            <i className="ti ti-folder text-base text-[#4a8fe8]" />
            <span>{t('brain.title')}</span>
          </div>

          <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5">
            {!isReadOnly && (
              <button
                type="button"
                onClick={handleStartCreateDocument}
                className="flex items-center gap-1 rounded bg-[#222226] px-2 py-1 text-xs font-medium text-[#c0c0c0] transition hover:bg-[#2c2c32] hover:text-white"
                title={t('brain.newDocument')}
                data-testid="btn-create-document"
              >
                <i className="ti ti-plus text-xs text-[#4a8fe8]" />
                <span>{t('brain.newDocument')}</span>
              </button>
            )}

            {!isReadOnly && (
              <button
                type="button"
                onClick={() => void handleSync()}
                disabled={isSyncing}
                className="flex items-center gap-1 rounded bg-[#252525] px-2 py-1 text-xs font-medium text-[#c0c0c0] transition hover:bg-[#303030] hover:text-white disabled:opacity-50"
                title={t('brain.syncDescription')}
                data-testid="btn-sync-knowledge"
              >
                <i className={cn('ti ti-refresh text-xs', isSyncing && 'animate-spin')} />
                <span>{isSyncing ? t('brain.syncing') : t('brain.sync')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Vault File Tree */}
        <div className="flex-1 overflow-y-auto px-2.5 py-3 space-y-3" data-testid="brain-tree">
          {isLoadingDocs ? (
            <div className="space-y-3 px-1 py-1" data-testid="docs-loading-skeleton">
              <div>
                <div className="flex items-center gap-2 rounded px-2 py-1.5 font-medium text-[#c5c5c5]">
                  <i className="ti ti-chevron-down text-xs text-[#808080]" />
                  <span className="truncate">{t('brain.applicationNotes')}</span>
                  <Skeleton className="ml-auto h-3 w-4 rounded-full" />
                </div>
                <div className="space-y-1.5 pl-6 pt-1">
                  <div className="flex items-center gap-2.5 py-1">
                    <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
                    <Skeleton className="h-2.5 w-28 rounded-full" />
                  </div>
                  <div className="flex items-center gap-2.5 py-1">
                    <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
                    <Skeleton className="h-2.5 w-20 rounded-full" />
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 rounded px-2 py-1.5 font-medium text-[#c5c5c5]">
                  <i className="ti ti-chevron-down text-xs text-[#808080]" />
                  <span className="truncate">{t('brain.azureWiki')}</span>
                  <Skeleton className="ml-auto h-3 w-4 rounded-full" />
                </div>
                <div className="space-y-1.5 pl-6 pt-1">
                  <div className="flex items-center gap-2.5 py-1">
                    <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
                    <Skeleton className="h-2.5 w-32 rounded-full" />
                  </div>
                  <div className="flex items-center gap-2.5 py-1">
                    <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
                    <Skeleton className="h-2.5 w-24 rounded-full" />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* 1. App Documents Section */}
              <div>
                <div
                  onClick={() => setIsAppFolderExpanded(!isAppFolderExpanded)}
                  title={t('brain.collapseDocument', { title: t('brain.applicationNotes') })}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 font-medium text-[#c5c5c5] transition hover:bg-[#242424] hover:text-white"
                  data-testid="folder-app-docs"
                >
                  <i
                    className={cn(
                      'ti ti-chevron-down text-xs text-[#808080] transition-transform',
                      !isAppFolderExpanded && '-rotate-90',
                    )}
                  />
                  <span className="truncate">{t('brain.applicationNotes')}</span>
                  <span className="ml-auto text-xs text-[#707070]">
                    {currentDocs.filter(isAppDocument).length}
                  </span>
                </div>

                {isAppFolderExpanded && (
                  <div className="space-y-0.5 pl-4 pt-1">
                    {currentDocs.filter(isAppDocument).length === 0 ? (
                      <div className="px-2 py-1 text-xs text-[#666666]">
                        {t('brain.noApplicationDocuments')}
                      </div>
                    ) : (
                      orderedDocuments(currentDocs.filter(isAppDocument), collapsedDocumentIds).map(
                        ({ doc, depth, hasChildren }) => {
                          const isSelected = activeTab?.id === doc.id;

                          return (
                            <div
                              key={`tree-${doc.id}`}
                              style={{ paddingLeft: `${10 + depth * 20}px` }}
                              onClick={() => openDocumentTab(doc)}
                              className={cn(
                                'flex cursor-pointer items-center justify-between rounded px-2.5 py-1.5 text-sm transition-colors hover:bg-[#242424] hover:text-[#f5f5f5]',
                                isSelected
                                  ? 'bg-[#262626] font-semibold text-[#4a8fe8]'
                                  : 'text-[#a5a5a5]',
                              )}
                              data-testid={`tree-item-${doc.id}`}
                            >
                              <div className="flex items-center min-w-0 flex-1">
                                {hasChildren ? (
                                  <button
                                    type="button"
                                    className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#808080] hover:bg-[#303030] hover:text-white"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      toggleDocumentExpansion(doc.id);
                                    }}
                                    aria-label={t(
                                      collapsedDocumentIds.has(doc.id)
                                        ? 'brain.expandDocument'
                                        : 'brain.collapseDocument',
                                      { title: doc.title },
                                    )}
                                    aria-expanded={!collapsedDocumentIds.has(doc.id)}
                                    data-testid={`tree-toggle-${doc.id}`}
                                  >
                                    <i
                                      className={cn(
                                        'ti ti-chevron-down text-xs transition-transform',
                                        collapsedDocumentIds.has(doc.id) && '-rotate-90',
                                      )}
                                      aria-hidden="true"
                                    />
                                  </button>
                                ) : (
                                  <span className="mr-1 h-4 w-4 shrink-0" aria-hidden="true" />
                                )}
                                <i className="ti ti-file-text text-sm text-[#707070]" />
                                <span className="ml-2 truncate">{doc.title}</span>
                              </div>
                              <span className="text-xs text-[#606060] shrink-0 ml-1">
                                {doc.chunksCount}
                              </span>
                            </div>
                          );
                        },
                      )
                    )}
                  </div>
                )}
              </div>

              {/* 2. External Wiki / Integrations Section */}
              <div>
                <div
                  onClick={() => setIsFolderExpanded(!isFolderExpanded)}
                  title={t('brain.toggleSection')}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 font-medium text-[#c5c5c5] transition hover:bg-[#242424] hover:text-white"
                  data-testid="folder-external-docs"
                >
                  <i
                    className={cn(
                      'ti ti-chevron-down text-xs text-[#808080] transition-transform',
                      !isFolderExpanded && '-rotate-90',
                    )}
                  />
                  <span className="truncate">{t('brain.azureWiki')}</span>
                  <span className="ml-auto text-xs text-[#707070]">
                    {currentDocs.filter((d) => !isAppDocument(d)).length}
                  </span>
                </div>

                {isFolderExpanded && (
                  <div className="space-y-0.5 pl-4 pt-1">
                    {currentDocs.filter((d) => !isAppDocument(d)).length === 0 ? (
                      <div className="px-2 py-1 text-xs text-[#666666]">
                        {t('brain.noDocuments')}
                      </div>
                    ) : (
                      orderedDocuments(
                        currentDocs.filter((d) => !isAppDocument(d)),
                        collapsedDocumentIds,
                      ).map(({ doc, depth, hasChildren }) => {
                        const isSelected = activeTab?.id === doc.id;

                        return (
                          <div
                            key={`tree-${doc.id}`}
                            style={{ paddingLeft: `${10 + depth * 20}px` }}
                            onClick={() => openDocumentTab(doc)}
                            className={cn(
                              'flex cursor-pointer items-center justify-between rounded px-2.5 py-1.5 text-sm transition-colors hover:bg-[#242424] hover:text-[#f5f5f5]',
                              isSelected
                                ? 'bg-[#262626] font-semibold text-[#4a8fe8]'
                                : 'text-[#a5a5a5]',
                            )}
                            data-testid={`tree-item-${doc.id}`}
                          >
                            <div className="flex items-center min-w-0 flex-1">
                              {hasChildren ? (
                                <button
                                  type="button"
                                  className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#808080] hover:bg-[#303030] hover:text-white"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleDocumentExpansion(doc.id);
                                  }}
                                  aria-label={t(
                                    collapsedDocumentIds.has(doc.id)
                                      ? 'brain.expandDocument'
                                      : 'brain.collapseDocument',
                                    { title: doc.title },
                                  )}
                                  aria-expanded={!collapsedDocumentIds.has(doc.id)}
                                  data-testid={`tree-toggle-${doc.id}`}
                                >
                                  <i
                                    className={cn(
                                      'ti ti-chevron-down text-xs transition-transform',
                                      collapsedDocumentIds.has(doc.id) && '-rotate-90',
                                    )}
                                    aria-hidden="true"
                                  />
                                </button>
                              ) : (
                                <span className="mr-1 h-4 w-4 shrink-0" aria-hidden="true" />
                              )}
                              <i className="ti ti-file-text text-sm text-[#707070]" />
                              <span className="ml-2 truncate">{doc.title}</span>
                            </div>
                            <span className="text-xs text-[#606060] shrink-0 ml-1">
                              {doc.chunksCount}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </ResizableSidebar>

      {/* ========================================================================= */}
      {/* 2. MAIN WORKSPACE: TABS BAR + NAV HEADER + CONTENT AREA                   */}
      {/* ========================================================================= */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#161616]">
        {/* ======================================================================= */}
        {/* TOP MULTI-TABS BAR (Supports N tabs open at the same time)              */}
        {/* ======================================================================= */}
        {tabs.length > 0 && (
          <div
            onWheel={(e) => {
              if (e.deltaY !== 0) {
                e.currentTarget.scrollLeft += e.deltaY;
              }
            }}
            className="thin-scrollbar flex h-10 shrink-0 items-stretch overflow-x-auto border-b border-[#262626] bg-[#1e1e1e]"
            data-testid="brain-tabs-bar"
          >
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className={cn(
                    'group relative flex min-w-[120px] max-w-[220px] shrink-0 cursor-pointer items-center gap-2 border-r border-[#262626] px-3.5 text-sm transition select-none',
                    isActive
                      ? 'border-t-2 border-t-[#4a8fe8] bg-[#161616] font-semibold text-white'
                      : 'bg-[#1e1e1e] text-[#8e8e8e] hover:bg-[#1a1a1a] hover:text-[#d0d0d0]',
                  )}
                  data-testid={tab.id === 'graph' ? 'tab-graph' : 'tab-active-doc'}
                >
                  <i
                    className={cn(
                      'ti text-sm',
                      tab.type === 'graph'
                        ? 'ti-network text-[#4a8fe8]'
                        : 'ti-file-text text-[#8e8e8e]',
                    )}
                  />
                  <span className="flex-1 truncate">{tab.title}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="rounded p-0.5 text-[#666666] hover:bg-[#2a2a2a] hover:text-white"
                    aria-label={t('common.close')}
                    data-testid={isActive ? 'close-tab' : `close-tab-${tab.id}`}
                  >
                    <i className="ti ti-x text-xs" />
                  </button>
                </div>
              );
            })}

            {/* Plus button to open new tab / toggle view */}
            <button
              type="button"
              onClick={toggleViewMode}
              className="flex items-center justify-center px-3 text-[#7d7d7d] hover:text-white"
              title={t('brain.graphStats', {
                notes: documents.length,
                connections: connectionCount,
              })}
              data-testid="btn-add-tab"
            >
              <i className="ti ti-plus text-sm" />
            </button>
          </div>
        )}

        {/* ======================================================================= */}
        {/* SUB-HEADER: TITLE & QUICK VIEW SWITCHER (Texto <-> Gráfico)            */}
        {/* ======================================================================= */}
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#262626]/60 bg-[#161616] px-4 text-sm text-[#8e8e8e]">
          {/* Navigation Back Button */}
          <button
            type="button"
            onClick={openWelcomeTab}
            className="flex items-center gap-1 text-xs text-[#808080] hover:text-white"
            title={t('brain.backWelcome')}
          >
            <i className="ti ti-arrow-left text-sm" />
            <span>{t('common.back')}</span>
          </button>

          {/* Center Document Title */}
          <div className="font-semibold text-[#f0f0f0]" data-testid="nav-title">
            {currentTitle}
          </div>

          {/* Right Action: Text / Graph View Switcher Button */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleViewMode}
              className="flex items-center gap-2 rounded-md bg-[#242424] px-3 py-1 text-xs font-semibold text-[#e0e0e0] transition hover:bg-[#2c2c2c] hover:text-white"
              title={
                activeTab?.type === 'graph'
                  ? t('brain.docContent')
                  : t('brain.graphStats', {
                      notes: documents.length,
                      connections: connectionCount,
                    })
              }
              data-testid="view-btn-graph"
            >
              <i
                className={cn(
                  'ti text-sm',
                  activeTab?.type === 'graph' ? 'ti-file-text' : 'ti-network text-[#4a8fe8]',
                )}
              />
              <span>
                {activeTab?.type === 'graph'
                  ? t('brain.docContent')
                  : t('brain.graphStats', {
                      notes: documents.length,
                      connections: connectionCount,
                    })}
              </span>
            </button>
            <button
              type="button"
              onClick={toggleViewMode}
              className="sr-only"
              data-testid="view-btn-toggle-top"
            >
              {t('brain.centerGraph')}
            </button>
            <button
              type="button"
              onClick={openWelcomeTab}
              className="sr-only"
              data-testid="view-btn-folder"
            >
              {t('brain.title')}
            </button>
          </div>
        </div>

        {/* Sync Feedback Alert */}
        {syncFeedback && (
          <div
            className={cn(
              'flex items-center gap-2 border-b px-4 py-2.5 text-sm',
              syncFeedback.type === 'success'
                ? 'border-[#2d4d35] bg-[#18281d] text-[#86efac]'
                : 'border-[#4d2d2d] bg-[#281818] text-[#fca5a5]',
            )}
            role="alert"
            data-testid="sync-feedback"
          >
            <i
              className={cn(
                'ti text-base',
                syncFeedback.type === 'success' ? 'ti-circle-check' : 'ti-alert-circle',
              )}
            />
            <span className="flex-1">{syncFeedback.message}</span>
            {syncFeedback.remoteUrl && (
              <a
                href={syncFeedback.remoteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {t('brain.openWiki')}
              </a>
            )}
            <button
              type="button"
              onClick={() => setSyncFeedback(null)}
              aria-label={t('brain.closeNotice')}
              className="hover:text-white"
            >
              <i className="ti ti-x text-sm" />
            </button>
          </div>
        )}

        {/* ======================================================================= */}
        {/* 3. CENTER VIEWPORT: GRAPH VIEW OR COMPLETE TEXT NOTE READER             */}
        {/* ======================================================================= */}
        <div className="relative flex-1 overflow-hidden">
          {activeTab?.type === 'graph' ? (
            <BrainGraph
              documents={documents}
              relations={relations}
              onOpenDocument={openDocumentTab}
              onOpenWelcome={openWelcomeTab}
            />
          ) : (
            /* ------------------------------------------------------------------- */
            /* TEXT / COMPLETE MARKDOWN DOCUMENT READER                            */
            /* ------------------------------------------------------------------- */
            <div
              className="flex h-full flex-col overflow-hidden bg-[#161616]"
              data-testid="folder-view"
            >
              <div className="flex-1 overflow-y-auto px-10 py-12">
                <article className="mx-auto max-w-[780px] space-y-6">
                  {/* Search input for knowledge base with floating dropdown */}
                  <div className="relative z-30">
                    <form
                      onSubmit={(e) => void handleSearch(e)}
                      className="relative flex items-center"
                    >
                      <Input
                        type="text"
                        placeholder={t('brain.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        aria-label={t('brain.searchKnowledge')}
                        className="border-[#2a2a2a] bg-[#1a1a1a] text-[#f5f5f5] placeholder:text-[#666666] focus-visible:border-[#4a8fe8]"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={handleClearSearch}
                          aria-label={t('common.clear')}
                          className="absolute right-3 text-[#7d7d7d] hover:text-white"
                        >
                          <i className="ti ti-x text-sm" />
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={isSearching}
                        className="sr-only"
                        aria-label={t('brain.executeSearch')}
                      >
                        {t('brain.executeSearch')}
                      </button>
                    </form>

                    {/* Search Loading & Error States */}
                    {isSearching && (
                      <div
                        className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-lg border border-[#2e2e2e] bg-[#1a1a1a] p-3 text-sm text-[#4a8fe8] shadow-2xl space-y-2"
                        data-testid="search-loading"
                      >
                        <div className="flex items-center gap-2">
                          <i className="ti ti-refresh animate-spin text-base" />
                          <span>{t('brain.syncing')}</span>
                        </div>
                        <SkeletonRow className="py-1" />
                        <SkeletonRow className="py-1" />
                      </div>
                    )}

                    {searchError && (
                      <div
                        className="absolute left-0 right-0 top-full mt-1.5 z-50 flex items-center rounded-lg border border-[#4d2d2d] bg-[#281818] p-3 text-sm text-[#fca5a5] shadow-2xl"
                        role="alert"
                      >
                        <i className="ti ti-alert-circle mr-2 text-base" />
                        <span>{searchError}</span>
                      </div>
                    )}

                    {/* Floating Search Results Dropdown */}
                    {searchResults !== null && !isSearching && (
                      <div
                        className="absolute left-0 right-0 top-full mt-1.5 z-50 max-h-[460px] overflow-y-auto space-y-2 rounded-lg border border-[#2e2e2e] bg-[#1a1a1a] p-3.5 shadow-2xl thin-scrollbar"
                        data-testid="search-results"
                      >
                        <div className="flex items-center justify-between pb-2 border-b border-[#262626] text-xs font-semibold uppercase tracking-wider text-[#a0a0a0]">
                          <span>{t('brain.searchResults', { count: searchResults.length })}</span>
                          <button
                            type="button"
                            onClick={handleClearSearch}
                            className="text-xs text-[#808080] hover:text-white capitalize"
                          >
                            {t('common.clear')}
                          </button>
                        </div>
                        {searchResults.length === 0 ? (
                          <div className="py-4 text-center text-sm text-[#7d7d7d]">
                            {t('brain.noSearchChunks')}
                          </div>
                        ) : (
                          searchResults.map((chunk) => {
                            const docTitle = resolveChunkDocTitle(chunk);
                            return (
                              <div
                                key={`${chunk.source}-${chunk.pageId}-${chunk.chunkIndex}`}
                                onClick={() => {
                                  const targetDoc = currentDocs.find(
                                    (d) =>
                                      d.id === chunk.pageId ||
                                      d.pageId === chunk.pageId ||
                                      d.source === chunk.source,
                                  );
                                  if (targetDoc) {
                                    openDocumentTab(targetDoc);
                                  } else {
                                    const fallbackDoc: KnowledgeDocumentDto = {
                                      id: chunk.pageId || chunk.source,
                                      pageId: chunk.pageId,
                                      source: chunk.source,
                                      title: docTitle,
                                      chunksCount: 1,
                                      totalCharacters: chunk.content.length,
                                      content: chunk.content,
                                      updatedAt: chunk.createdAt,
                                    };
                                    setDocuments((prev) => [...prev, fallbackDoc]);
                                    openDocumentTab(fallbackDoc);
                                  }
                                  handleClearSearch();
                                }}
                                className="group cursor-pointer rounded-lg border border-[#262626] bg-[#202020] p-3 text-sm transition hover:border-[#4a8fe8]/60 hover:bg-[#252525] min-w-0 max-w-full overflow-hidden"
                                data-testid={`search-result-item-${chunk.chunkIndex}`}
                              >
                                <div className="mb-1.5 flex items-center justify-between gap-3 min-w-0">
                                  <div className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
                                    <i className="ti ti-file-text text-sm text-[#4a8fe8] shrink-0" />
                                    <span
                                      className="truncate font-semibold text-sm text-[#4a8fe8] group-hover:underline"
                                      title={docTitle}
                                    >
                                      {docTitle}
                                    </span>
                                  </div>
                                  <span className="shrink-0 text-xs text-[#707070]">
                                    {formatDate(chunk.createdAt)}
                                  </span>
                                </div>
                                <p className="line-clamp-3 text-xs leading-relaxed text-[#c0c0c0] break-words [word-break:break-word] overflow-hidden">
                                  {chunk.content}
                                </p>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>

                  {/* EDITING / CREATING DOCUMENT FORM */}
                  {editingDoc ? (
                    <div
                      className="space-y-5 rounded-lg border border-[#28282c] bg-[#141416] p-6 shadow-xl"
                      data-testid="document-editor"
                    >
                      <div className="flex items-center justify-between border-b border-[#242428] pb-4">
                        <div className="flex items-center gap-2">
                          <span className="rounded border border-[#3b4b60] bg-[#1c2738] px-2.5 py-0.5 font-mono text-xs font-medium text-[#60a5fa]">
                            {editingDoc === 'new'
                              ? t('brain.newDocument')
                              : t('brain.editDocument')}
                          </span>
                          <span className="text-xs text-[#808080]">
                            {t('brain.markdownFormat')}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setEditPreview(!editPreview)}
                            className={cn(
                              'flex items-center gap-1.5 rounded border border-[#2a2a2e] px-3 py-1.5 text-xs font-medium transition',
                              editPreview
                                ? 'bg-[#2a2a2e] text-white'
                                : 'bg-[#1a1a1d] text-[#a0a0a0] hover:text-white',
                            )}
                            data-testid="btn-toggle-edit-preview"
                          >
                            <i className={cn('ti text-xs', editPreview ? 'ti-edit' : 'ti-eye')} />
                            <span>{editPreview ? t('common.edit') : t('brain.editPreview')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelEdit}
                            disabled={isSaving}
                            className="flex items-center gap-1.5 rounded border border-[#2a2a2e] bg-[#1a1a1d] px-3 py-1.5 text-xs font-medium text-[#a0a0a0] transition hover:bg-[#252528] hover:text-white disabled:opacity-50"
                            data-testid="btn-cancel-edit"
                          >
                            <span>{t('common.cancel')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSaveDocument()}
                            disabled={isSaving}
                            className="flex items-center gap-1.5 rounded bg-[#2563eb] px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#1d4ed8] disabled:opacity-50"
                            data-testid="btn-save-document"
                          >
                            <i
                              className={cn(
                                'ti text-xs',
                                isSaving ? 'ti-loader animate-spin' : 'ti-check',
                              )}
                            />
                            <span>{isSaving ? t('common.saving') : t('common.save')}</span>
                          </button>
                        </div>
                      </div>

                      {saveError && (
                        <div
                          className="rounded-md border border-red-900/50 bg-red-950/40 p-3 text-xs text-red-300"
                          data-testid="save-error-message"
                        >
                          {saveError}
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-[#a0a0a0]">
                          {t('brain.docTitle')}
                        </label>
                        <Input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          placeholder={t('brain.docTitlePlaceholder')}
                          className="border-[#2e2e32] bg-[#19191c] text-base font-semibold text-white placeholder-[#606060] focus-visible:border-[#4a8fe8]"
                          data-testid="input-document-title"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-[#a0a0a5]">
                          {t('brain.docContent')}
                        </label>
                        {editPreview ? (
                          <div
                            className="thin-scrollbar min-h-[360px] max-h-[500px] overflow-y-auto rounded-md border border-[#2e2e32] bg-[#19191c] p-4"
                            data-testid="editor-preview-container"
                          >
                            <MarkdownViewer
                              content={editContent || t('brain.emptyPreview')}
                              documentTitle={editTitle}
                              showModeToggle={false}
                              onWikilinkClick={handleOpenWikilink}
                            />
                          </div>
                        ) : (
                          <div className="relative">
                            <textarea
                              ref={editorRef}
                              value={editContent}
                              onChange={(event) =>
                                handleEditorChange(event.target.value, event.target.selectionStart)
                              }
                              onKeyDown={handleEditorKeyDown}
                              placeholder={t('brain.contentEditorPlaceholder')}
                              rows={16}
                              className="thin-scrollbar w-full resize-y rounded-md border border-[#2e2e32] bg-[#19191c] p-4 font-mono text-xs leading-relaxed text-[#e0e0e0] placeholder-[#606060] focus:border-[#4a8fe8] focus:outline-none"
                              data-testid="textarea-document-content"
                            />
                            {wikilinkQuery && (
                              <div
                                role="listbox"
                                aria-label={t('brain.wikilinkSuggestions')}
                                className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-[#34343a] bg-[#202024] p-1 shadow-2xl"
                              >
                                {wikilinkSuggestions.length === 0 ? (
                                  <p className="px-3 py-2 text-xs text-[#85858b]">
                                    {t('brain.noWikilinkSuggestions')}
                                  </p>
                                ) : (
                                  wikilinkSuggestions.map((document, index) => (
                                    <button
                                      type="button"
                                      role="option"
                                      aria-selected={index === wikilinkIndex}
                                      key={document.pageId}
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => selectWikilink(document)}
                                      className={cn(
                                        'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm',
                                        index === wikilinkIndex
                                          ? 'bg-[#2b4162] text-white'
                                          : 'text-[#d4d4d8] hover:bg-[#29292e]',
                                      )}
                                    >
                                      <i className="ti ti-link text-[#60a5fa]" aria-hidden="true" />
                                      <span>{document.title}</span>
                                    </button>
                                  ))
                                )}
                                <p className="border-t border-[#34343a] px-3 py-2 text-[11px] text-[#85858b]">
                                  {t('brain.wikilinkHint')}
                                </p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : activeDoc ? (
                    <div className="space-y-6" data-testid="active-document-view">
                      <div className="border-b border-[#262628] pb-4">
                        <div className="min-w-0 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="rounded border border-[#2b4162] bg-[#1a2638] px-2 py-0.5 font-mono text-xs font-medium text-[#4a8fe8]">
                              .md
                            </span>
                          </div>
                          <div className="flex items-start justify-between gap-4">
                            <h1 className="min-w-0 flex-1 max-w-full text-2xl font-bold tracking-tight text-[#f5f5f5] [overflow-wrap:anywhere] sm:text-3xl">
                              {activeDoc.title}
                            </h1>
                            <div
                              className="flex shrink-0 justify-end"
                              data-testid="document-actions"
                            >
                              <ActionsMenu key={activeDoc.id}>
                                {apiClient && (
                                  <HistoryViewer
                                    apiClient={apiClient}
                                    entityType="document"
                                    entityId={JSON.stringify([activeDoc.source, activeDoc.pageId])}
                                    entityTitle={activeDoc.title}
                                    workspaceId={defaultOwnerId}
                                  />
                                )}
                                {apiClient && canCreateSpecs && (
                                  <CreateSpecFromDocument
                                    key={activeDoc.id}
                                    apiClient={apiClient}
                                    document={activeDoc}
                                  />
                                )}
                                {apiClient && canGenerateTestPlans && (
                                  <GenerateTestPlanFromSource
                                    apiClient={apiClient}
                                    title={activeDoc.title}
                                    content={activeDoc.content ?? ''}
                                    sourceType="brain"
                                    sourceId={activeDoc.id}
                                  />
                                )}

                                {activeDoc.source.startsWith('app://local?title=') &&
                                  !isReadOnly &&
                                  apiClient && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="secondary"
                                      onClick={() => setPushDocument(activeDoc)}
                                      disabled={Boolean(pushingPageId)}
                                      aria-label={t('brain.push')}
                                      data-testid="btn-push-document"
                                    >
                                      <i className="ti ti-upload text-sm" aria-hidden="true" />
                                      {pushingPageId === activeDoc.pageId
                                        ? t('brain.pushing')
                                        : t('brain.push')}
                                    </Button>
                                  )}

                                {!isAppDocument(activeDoc) && !isReadOnly && apiClient && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                      handleStartCreateDocument();
                                      setEditTitle(activeDoc.title);
                                      setEditContent(
                                        stripLeadingTitleHeading(
                                          activeDoc.content ?? '',
                                          activeDoc.title,
                                        ),
                                      );
                                    }}
                                    data-testid="btn-copy-document"
                                  >
                                    <i className="ti ti-copy text-sm" aria-hidden="true" />
                                    {t('brain.copyToApplication')}
                                  </Button>
                                )}

                                {isAppDocument(activeDoc) && !isReadOnly && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => handleStartCreateSubpage(activeDoc)}
                                    data-testid="btn-create-subpage"
                                  >
                                    <i className="ti ti-file-plus text-sm" aria-hidden="true" />
                                    {t('brain.newSubpage')}
                                  </Button>
                                )}

                                {isAppDocument(activeDoc) && !isReadOnly && (
                                  <Button
                                    type="button"
                                    onClick={() => handleStartEdit(activeDoc)}
                                    className="inline-flex shrink-0 items-center gap-1.5 rounded border border-[#2a2a2a] bg-[#202020] px-3 py-1.5 text-xs font-medium text-[#c0c0c0] transition hover:bg-[#282828] hover:text-white"
                                    title={t('brain.editDocument')}
                                    data-testid="btn-edit-document"
                                  >
                                    <i className="ti ti-edit text-sm" />
                                    <span>{t('common.edit')}</span>
                                  </Button>
                                )}

                                {canDeleteDocuments && (
                                  <Button
                                    type="button"
                                    onClick={() => setDocumentToDelete(activeDoc)}
                                    className="inline-flex shrink-0 items-center gap-1.5 rounded border border-red-900/40 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-900/30 hover:text-red-300"
                                    title={t('brain.deleteDocument')}
                                    data-testid="btn-delete-document"
                                    data-destructive
                                  >
                                    <i className="ti ti-trash text-sm" />
                                    <span>
                                      {isAppDocument(activeDoc)
                                        ? t('common.delete')
                                        : t('brain.deleteOnlyFromApp')}
                                    </span>
                                  </Button>
                                )}
                              </ActionsMenu>
                            </div>
                          </div>
                        </div>
                        <details
                          key={activeDoc.id}
                          className="mt-4 rounded-lg border border-border bg-surface-1 p-3"
                        >
                          <summary className="cursor-pointer text-sm font-medium text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fill-accent)]">
                            {t('brain.manageLinks')}
                          </summary>
                          {apiClient && !isReadOnly && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Select
                                aria-label={t('brain.documentToLink')}
                                value={linkTarget}
                                onChange={(event) => setLinkTarget(event.target.value)}
                              >
                                <option value="">{t('brain.selectDocumentToLink')}</option>
                                {documents
                                  .filter((doc) => doc.pageId !== activeDoc.pageId)
                                  .map((doc) => (
                                    <option key={doc.id} value={doc.pageId}>
                                      {doc.title}
                                    </option>
                                  ))}
                              </Select>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={!linkTarget || isLinking}
                                isLoading={isLinking}
                                onClick={() => void handleLinkDocument(apiClient, activeDoc)}
                              >
                                {t('brain.addLink')}
                              </Button>
                            </div>
                          )}
                          <div
                            className="mt-3 flex max-h-60 flex-col gap-1 overflow-y-auto"
                            aria-label={t('brain.documentLinks')}
                          >
                            {documents
                              .filter((doc) =>
                                relations.some(
                                  (relation) =>
                                    (relation.sourcePageId === activeDoc.pageId &&
                                      relation.targetPageId === doc.pageId) ||
                                    (relation.targetPageId === activeDoc.pageId &&
                                      relation.sourcePageId === doc.pageId),
                                ),
                              )
                              .map((doc) => (
                                <Button
                                  key={doc.id}
                                  type="button"
                                  variant="link"
                                  className="h-auto min-h-8 justify-start whitespace-normal break-words text-left"
                                  onClick={() => openDocumentTab(doc)}
                                >
                                  {doc.title}
                                </Button>
                              ))}
                          </div>
                        </details>
                      </div>

                      {/* MARKDOWN VIEWER */}
                      <MarkdownViewer
                        content={fullTextContent}
                        documentTitle={activeDoc.title}
                        sourceUrl={
                          activeDoc.source.startsWith('http') ? activeDoc.source : undefined
                        }
                        showModeToggle={true}
                        onWikilinkClick={handleOpenWikilink}
                      />
                    </div>
                  ) : (
                    /* ROOT WELCOME NOTE */
                    <div className="space-y-6">
                      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#f5f5f5]">
                        {t('brain.welcome')}
                      </h1>

                      <div className="space-y-4 text-lg leading-relaxed text-[#c4c4c4]">
                        <p>{t('brain.newVaultDescription')}</p>
                        <p className="text-sm text-[#7d7d7d]">{t('brain.vaultGuidance')}</p>
                      </div>

                      {/* Stats & Sychronized Documents List */}
                      <div className="pt-6">
                        <div className="mb-4 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-[#707070]">
                          <span className="flex items-center gap-1.5">
                            {t('brain.synchronizedDocuments')}
                            {isLoadingDocs ? (
                              <Skeleton className="h-3 w-4 rounded-full" />
                            ) : (
                              `(${currentDocs.length})`
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={openGraphTab}
                            className="text-[#4a8fe8] hover:underline"
                          >
                            {t('brain.viewGraph')}
                          </button>
                        </div>

                        {/* Stats Cards */}
                        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-2">
                          <div
                            className="rounded-lg border border-[#262626] bg-[#1a1a1a] p-3"
                            data-testid="card-documentos"
                          >
                            <div className="text-xs text-[#707070]">{t('brain.documents')}</div>
                            <div className="text-xl font-bold text-white">
                              {isLoadingDocs ? (
                                <Skeleton className="mt-1 h-7 w-12 rounded-full" />
                              ) : stats ? (
                                stats.documentsCount
                              ) : (
                                34
                              )}
                            </div>
                          </div>
                          <div
                            className="rounded-lg border border-[#262626] bg-[#1a1a1a] p-3"
                            data-testid="card-sync"
                          >
                            <div className="text-xs text-[#707070]">{t('brain.sync')}</div>
                            <div className="text-sm font-semibold text-white">
                              {isLoadingDocs ? (
                                <Skeleton className="mt-1 h-5 w-20 rounded-full" />
                              ) : stats ? (
                                stats.lastSync
                              ) : (
                                t('brain.recent')
                              )}
                            </div>
                          </div>
                        </div>

                        {isLoadingDocs ? (
                          <div className="space-y-3 py-2" data-testid="sync-loading-skeleton">
                            <SkeletonRow />
                            <SkeletonRow />
                            <SkeletonRow />
                            <SkeletonRow />
                          </div>
                        ) : currentDocs.length === 0 ? (
                          <div
                            className="rounded-lg border border-dashed border-[#262626] p-8 text-center text-sm text-[#7d7d7d]"
                            data-testid="empty-documents"
                          >
                            {t('brain.noSynchronizedDocuments')}
                          </div>
                        ) : (
                          <div className="space-y-2" data-testid="documents-list">
                            {currentDocs.map((doc) => {
                              const metaText = `${doc.chunksCount} chunks · ${Math.max(1, Math.round(doc.totalCharacters / 1024))} KB`;
                              const isUrl = doc.source.startsWith('http');

                              return (
                                <div
                                  key={doc.id}
                                  onClick={() => openDocumentTab(doc)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      if (isUrl) {
                                        window.open(doc.source, '_blank', 'noopener,noreferrer');
                                      } else {
                                        openDocumentTab(doc);
                                      }
                                    }
                                  }}
                                  tabIndex={0}
                                  role="button"
                                  className="flex cursor-pointer items-center justify-between rounded-lg border border-[#262626] bg-[#1c1c1c] px-4 py-2.5 text-sm transition hover:bg-[#242424]"
                                  data-testid={`document-item-${doc.id}`}
                                >
                                  <div className="flex items-center gap-2.5">
                                    <i className="ti ti-file-text text-base text-[#4a8fe8]" />
                                    <span className="font-medium text-[#f0f0f0]">{doc.title}</span>
                                  </div>
                                  <div className="flex items-center gap-3 text-xs text-[#808080]">
                                    <span>{metaText}</span>
                                    {isUrl && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          window.open(doc.source, '_blank', 'noopener,noreferrer');
                                        }}
                                        title={t('brain.openSource')}
                                        className="hover:text-white"
                                      >
                                        <i className="ti ti-external-link text-sm" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              </div>

              {/* Status Bar at Bottom */}
              <div className="flex h-7 shrink-0 items-center justify-end border-t border-[#262626] bg-[#161616] px-4 text-xs text-[#707070]">
                <div className="flex items-center gap-4">
                  <span>{t('brain.backlinks', { count: 0 })}</span>
                  <span>
                    {wordCount} {t('brain.words')}
                  </span>
                  <span>
                    {charCount} {t('brain.characters')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {editingDoc ? (
        <ResizableSidebar
          aria-label={t('brain.assistantTitle')}
          data-testid="brain-agent-sidebar"
          defaultWidth={360}
          minWidth={280}
          maxWidth="container"
          resizeEdge="left"
          resizeLabel="Redimensionar assistente de documentação"
          className="overflow-hidden border-l border-[#262626] bg-[#1a1a1a]"
        >
          <section className="flex min-h-0 flex-1 flex-col p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-white">{t('brain.assistantTitle')}</h2>
                <p className="mt-1 text-xs text-[#a0a0a0]">{t('brain.assistantDescription')}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearAssistantContext}
                disabled={assistantMessages.length === 0 && !assistantMessage}
                aria-label={t('brain.clearAssistantContext')}
                title={t('common.clear')}
                className="shrink-0 text-[#a0a0a0] hover:text-white"
                leftIcon={<i className="ti ti-eraser" aria-hidden="true" />}
              >
                {t('common.clear')}
              </Button>
            </div>
            <Select
              aria-label={t('brain.selectDocumentationAgent')}
              className="mt-4"
              value={assistantAgentId}
              onChange={(event) => setAssistantAgentId(event.target.value)}
              disabled={!editingDoc || isAssistantWorking}
            >
              <option value="">{t('brain.selectDocumentationAgent')}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
            <div className="thin-scrollbar my-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {assistantMessages.length === 0 && (
                <p className="text-sm text-[#a0a0a0]">{t('brain.documentationAssistantHint')}</p>
              )}
              {assistantMessages.map((item) => (
                <article
                  key={item.id}
                  className={cn(
                    'rounded-lg border p-3 text-sm',
                    item.role === 'assistant'
                      ? 'border-blue-500/20 bg-blue-500/10'
                      : 'border-[#303034] bg-[#202024]',
                  )}
                >
                  <header className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#b0b0b0]">
                    <i
                      className={item.role === 'assistant' ? 'ti ti-sparkles' : 'ti ti-user'}
                      aria-hidden="true"
                    />
                    {item.role === 'assistant' ? t('brain.agent') : t('brain.you')}
                  </header>
                  {item.role === 'assistant' ? (
                    <>
                      <MarkdownViewer
                        content={item.content}
                        showModeToggle={false}
                        className="min-w-0 overflow-hidden [&_pre]:max-w-full"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => insertAssistantResponse(item.content)}
                        disabled={!editingDoc || isReadOnly}
                        className="mt-2 text-blue-300 hover:text-blue-200"
                        leftIcon={<i className="ti ti-file-import" aria-hidden="true" />}
                      >
                        {t('brain.insertAgentResponse')}
                      </Button>
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap text-[#e0e0e0]">{item.content}</p>
                  )}
                </article>
              ))}
              {isAssistantWorking && (
                <div className="flex items-center gap-2 text-sm text-[#a0a0a0]">
                  <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
                  {t('brain.agentWriting')}
                </div>
              )}
              {assistantError && (
                <p className="text-xs text-red-400" role="alert">
                  {assistantError}
                </p>
              )}
            </div>
            <Textarea
              aria-label={t('brain.documentationPrompt')}
              value={assistantMessage}
              onChange={(event) => setAssistantMessage(event.target.value)}
              placeholder={t('brain.documentationPrompt')}
              disabled={!editingDoc || isReadOnly || isAssistantWorking}
              rows={4}
            />
            <Button
              type="button"
              className="mt-2 w-full"
              isLoading={isAssistantWorking}
              disabled={
                !editingDoc ||
                isReadOnly ||
                !assistantAgentId ||
                !assistantMessage.trim() ||
                isAssistantWorking
              }
              onClick={() => void askDocumentationAssistant()}
              leftIcon={<i className="ti ti-send" aria-hidden="true" />}
            >
              {t('common.actions')}
            </Button>
          </section>
        </ResizableSidebar>
      ) : isResearchSidebarCollapsed ? (
        <aside
          className="flex w-12 shrink-0 flex-col items-center border-l border-[#262626] bg-[#1a1a1a] py-3"
          aria-label={t('brain.researchTitle')}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setIsResearchSidebarCollapsed(false)}
            aria-label={t('brain.openResearch')}
            title={t('brain.openResearch')}
          >
            <i className="ti ti-message-search text-lg" aria-hidden="true" />
          </Button>
        </aside>
      ) : (
        <ResizableSidebar
          aria-label={t('brain.researchTitle')}
          data-testid="brain-research-sidebar"
          defaultWidth={360}
          minWidth={280}
          maxWidth="container"
          resizeEdge="left"
          resizeLabel={t('common.resizeSidebar')}
          className="overflow-hidden border-l border-[#262626] bg-[#1a1a1a]"
        >
          <section className="flex min-h-0 flex-1 flex-col p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-white">{t('brain.researchTitle')}</h2>
                <p className="mt-1 text-xs text-[#a0a0a0]">{t('brain.researchDescription')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={clearResearchContext}
                  disabled={researchMessages.length === 0 && !researchMessage}
                  aria-label={t('brain.clearResearchContext')}
                  title={t('brain.clearResearchContext')}
                >
                  <i className="ti ti-eraser" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsResearchSidebarCollapsed(true)}
                  aria-label={t('brain.minimizeResearch')}
                  title={t('brain.minimizeResearch')}
                >
                  <i className="ti ti-layout-sidebar-right-collapse" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="thin-scrollbar my-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {researchMessages.length === 0 && (
                <div className="rounded-lg border border-[#303034] bg-[#202024] p-3 text-sm text-[#a0a0a0]">
                  {t('brain.researchHint')}
                </div>
              )}
              {researchMessages.map((item) => (
                <article
                  key={item.id}
                  className={cn(
                    'rounded-lg border p-3 text-sm',
                    item.role === 'assistant'
                      ? 'border-blue-500/20 bg-blue-500/10'
                      : 'border-[#303034] bg-[#202024]',
                  )}
                >
                  <header className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#b0b0b0]">
                    <i
                      className={item.role === 'assistant' ? 'ti ti-sparkles' : 'ti ti-user'}
                      aria-hidden="true"
                    />
                    {item.role === 'assistant' ? t('brain.brainAgent') : t('brain.you')}
                  </header>
                  {item.role === 'assistant' ? (
                    <MarkdownViewer
                      content={item.content}
                      showModeToggle={false}
                      className="min-w-0 overflow-hidden [&_pre]:max-w-full"
                    />
                  ) : (
                    <p className="whitespace-pre-wrap text-[#e0e0e0]">{item.content}</p>
                  )}
                </article>
              ))}
              {isResearching && (
                <div className="flex items-center gap-2 text-sm text-[#a0a0a0]">
                  <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
                  {t('brain.consultingBrain')}
                </div>
              )}
              {researchError && (
                <p className="text-xs text-red-400" role="alert">
                  {researchError}
                </p>
              )}
            </div>
            <Textarea
              aria-label={t('brain.researchPrompt')}
              value={researchMessage}
              onChange={(event) => setResearchMessage(event.target.value)}
              placeholder={t('brain.researchPrompt')}
              disabled={isResearching}
              rows={4}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void askBrain();
                }
              }}
            />
            <Button
              type="button"
              className="mt-2 w-full"
              isLoading={isResearching}
              disabled={!researchMessage.trim() || isResearching}
              onClick={() => void askBrain()}
              leftIcon={<i className="ti ti-send" aria-hidden="true" />}
            >
              {t('brain.ask')}
            </Button>
            <p className="mt-2 text-[11px] text-[#707070]">{t('brain.temporaryConversation')}</p>
          </section>
        </ResizableSidebar>
      )}

      {pushDocument && apiClient && (
        <BrainPushModal
          apiClient={apiClient}
          document={pushDocument}
          documents={documents}
          pushing={pushingPageId === pushDocument.pageId}
          onClose={() => setPushDocument(null)}
          onPush={(input, providerName) => handlePush(pushDocument, apiClient, input, providerName)}
        />
      )}

      {/* Confirmation Modal for Document Deletion */}
      {documentToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          data-testid="modal-confirm-delete"
        >
          <div className="w-full max-w-md space-y-4 rounded-xl border border-[#28282c] bg-[#1c1c1f] p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-red-400">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-950/50 border border-red-900/50">
                <i className="ti ti-trash text-lg" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">{t('brain.deleteDocument')}</h3>
                <p className="text-xs text-[#a0a0a0]">{t('brain.deleteConfirmation')}</p>
              </div>
            </div>

            <p className="text-sm text-[#c0c0c0] leading-relaxed">
              {t('brain.deleteDescription', { title: documentToDelete.title })}{' '}
              {!isAppDocument(documentToDelete) && t('brain.deleteExternalDescription')}
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDocumentToDelete(null)}
                disabled={isDeleting}
                className="rounded-md border border-[#2e2e32] bg-[#242428] px-4 py-2 text-xs font-medium text-[#c0c0c0] transition hover:bg-[#2c2c30] hover:text-white disabled:opacity-50"
                data-testid="btn-cancel-delete"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete(documentToDelete)}
                disabled={isDeleting}
                className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-50"
                data-testid="btn-confirm-delete"
              >
                <i
                  className={cn('ti text-xs', isDeleting ? 'ti-loader animate-spin' : 'ti-trash')}
                />
                <span>{isDeleting ? t('common.deleting') : t('brain.confirmDeletion')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
