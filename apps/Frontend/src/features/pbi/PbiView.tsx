import {
  Fragment,
  createElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApiClient, AuditSnapshot } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Pagination, PagingSentinel, usePaging } from '../../components/ui/pagination.js';
import { Modal } from '../../components/ui/modal.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { useI18n } from '../../lib/i18n/index.js';
import { parseMarkdownBlocks, renderInlineContent } from '../brain/markdown-parser.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import type { PbiComment, PbiFields, PbiItem, PbiProvider, PbiProviderId } from './pbi-types.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import type { WorkspaceMember } from '../workspaces/workspace-types.js';
import { HistoryViewer } from '../audit/HistoryViewer.js';
import { usePermissions } from '../workspaces/permissions.js';
import { PbiPushDialog } from './PbiPushDialog.js';
import { PbiLinks } from './PbiLinks.js';
import { AttachmentPanel } from '../shared/AttachmentPanel.js';
import {
  discardDrafts,
  editorHtml,
  isSafeImageSource,
  saveWithDrafts,
  useInlineImages,
  useRichTextImageInput,
} from '../shared/media.js';

interface Props {
  apiClient: ApiClient;
  workspaceId: string | null;
  refreshToken?: number;
  onPbiChanged?: () => void;
  isReadOnly?: boolean;
  onOpenIssues?: () => void;
  onOpenTestPlans?: () => void;
}
type ItemForm = PbiFields & { id?: string };
const columnIds = [
  'order',
  'type',
  'title',
  'state',
  'assignee',
  'area',
  'iteration',
  'tags',
  'source',
  'actions',
] as const;
type ColumnId = (typeof columnIds)[number];
const defaultColumns: ColumnId[] = [...columnIds];
type ColumnWidths = Partial<Record<ColumnId, number>>;
const defaultColumnWidths: Record<ColumnId, number> = {
  order: 64,
  type: 224,
  title: 420,
  state: 112,
  assignee: 160,
  area: 144,
  iteration: 176,
  tags: 128,
  source: 176,
  actions: 56,
};
const minimumColumnWidth = 72;
function readColumns(workspaceId: string | null): ColumnId[] {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(`adk:pbi-columns:${workspaceId ?? 'default'}`) ?? 'null',
    );
    if (Array.isArray(saved) && saved.every((value: unknown) => typeof value === 'string')) {
      const selected = new Set<string>(saved);
      const valid = columnIds.filter(
        (id) => id === 'title' || id === 'actions' || selected.has(id),
      );
      return valid;
    }
  } catch {
    // Storage can be unavailable in private browsing.
  }
  return defaultColumns;
}
function readColumnWidths(workspaceId: string | null): Record<ColumnId, number> {
  const widths = { ...defaultColumnWidths };
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(`adk:pbi-column-widths:${workspaceId ?? 'default'}`) ?? 'null',
    );
    if (saved && typeof saved === 'object') {
      for (const id of columnIds) {
        const value = (saved as ColumnWidths)[id];
        if (typeof value === 'number' && Number.isFinite(value))
          widths[id] = Math.max(minimumColumnWidth, Math.min(900, value));
      }
    }
  } catch {
    // Storage can be unavailable in private browsing.
  }
  return widths;
}
const providerNames: Record<PbiProviderId, string> = {
  azure_devops: 'Azure DevOps',
  trello: 'Trello',
  github_projects: 'GitHub Projects',
  jira: 'Jira',
};
const sourceText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
/** Cheap HTML-to-text conversion used for search and row previews (no DOM parsing). */
function plainText(value: string): string {
  if (!value) return '';
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (!code.startsWith('#')) return namedEntities[code.toLowerCase()] ?? match;
      const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
/** Lowercases and removes accents so "introducao" also finds "Introdução". */
function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}
interface SavedFilter {
  id: string;
  name: string;
  query: string;
  source: string;
  status: string;
  iteration: string;
  assignee: string;
}
type FilterValues = Omit<SavedFilter, 'id' | 'name'>;
const savedFilterKeys = ['id', 'name', 'query', 'source', 'status', 'iteration', 'assignee'];
const savedFiltersKey = (workspaceId: string | null) =>
  `adk:pbi-saved-filters:${workspaceId ?? 'default'}`;
function readSavedFilters(workspaceId: string | null): SavedFilter[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(savedFiltersKey(workspaceId)) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (entry: unknown): entry is SavedFilter =>
        !!entry &&
        typeof entry === 'object' &&
        savedFilterKeys.every((key) => typeof (entry as Record<string, unknown>)[key] === 'string'),
    );
  } catch {
    // Storage can be unavailable in private browsing.
    return [];
  }
}
function memberLabel(member: WorkspaceMember): string {
  return member.user?.name || member.user?.email || member.userId;
}
function displayType(item: PbiItem): string {
  return (
    sourceText(item.sourceData.adkCardType) ||
    sourceText(item.sourceData.type) ||
    (item.kind === 'pbi' ? 'PBI' : 'Card')
  );
}
function typeAppearance(item: PbiItem): {
  icon: string;
  colors: string;
  iconColor: string;
} {
  const type = displayType(item).trim().toLocaleLowerCase('pt-BR');
  if (type === 'bug')
    return {
      icon: 'ti-bug',
      colors: 'border-red-500/25 bg-red-500/10 text-red-300',
      iconColor: 'text-red-400',
    };
  if (type === 'task' || type === 'tarefa')
    return {
      icon: 'ti-checklist',
      colors: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
      iconColor: 'text-sky-400',
    };
  if (type === 'sac')
    return {
      icon: 'ti-message-circle',
      colors: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
      iconColor: 'text-amber-400',
    };
  if (type.startsWith('plano de'))
    return {
      icon: 'ti-clipboard-list',
      colors: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
      iconColor: 'text-emerald-400',
    };
  if (type === 'product backlog item' || type === 'pbi' || type === 'user story')
    return {
      icon: 'ti-layout-kanban',
      colors: 'border-violet-500/25 bg-violet-500/10 text-violet-300',
      iconColor: 'text-violet-400',
    };
  if (type === 'epic')
    return {
      icon: 'ti-flag',
      colors: 'border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300',
      iconColor: 'text-fuchsia-400',
    };
  if (type === 'feature')
    return {
      icon: 'ti-sparkles',
      colors: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-300',
      iconColor: 'text-cyan-400',
    };
  return {
    icon: item.kind === 'card' ? 'ti-file-description' : 'ti-folder',
    colors: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
    iconColor: 'text-[var(--text-secondary)]',
  };
}
const hiddenWorkItemTypes = new Set(['test case']);
function shouldHideItem(item: PbiItem): boolean {
  return (
    hiddenWorkItemTypes.has(sourceText(item.sourceData.type).trim().toLocaleLowerCase()) ||
    item.title.trim().toLocaleLowerCase() === 'excluir'
  );
}
const allowedHtmlTags = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'IMG',
  'I',
  'LI',
  'OL',
  'P',
  'PRE',
  'S',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'U',
  'UL',
]);
const allowedHtmlStyles = new Set([
  'background-color',
  'border',
  'border-collapse',
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-align',
  'text-decoration',
  'vertical-align',
  'white-space',
]);
function sanitizeHtml(value: string): string {
  if (typeof DOMParser === 'undefined') return value.replace(/<[^>]*>/g, ' ');
  const document = new DOMParser().parseFromString(value, 'text/html');
  for (const element of [...document.body.querySelectorAll<HTMLElement>('*')]) {
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'].includes(element.tagName)) {
      element.remove();
      continue;
    }
    if (!allowedHtmlTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (element.tagName === 'A' && attribute.name === 'href') {
        const href = attribute.value.trim();
        if (
          !/^(https?:|mailto:|tel:|\/|#|\.?\.?\/)/i.test(href) &&
          /^[a-z][a-z\d+.-]*:/i.test(href)
        )
          element.removeAttribute('href');
        continue;
      }
      if (element.tagName === 'IMG' && ['alt', 'title'].includes(attribute.name)) continue;
      // Invalid image sources are removed below.
      if (
        element.tagName === 'IMG' &&
        attribute.name === 'src' &&
        isSafeImageSource(attribute.value)
      )
        continue;
      if (attribute.name !== 'style') element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'IMG' && !element.hasAttribute('src')) {
      element.remove();
      continue;
    }
    const styles: string[] = [];
    for (let index = 0; index < element.style.length; index++) {
      const property = element.style.item(index);
      const propertyName = property.toLocaleLowerCase();
      const propertyValue = element.style.getPropertyValue(property).trim();
      if (
        allowedHtmlStyles.has(propertyName) &&
        !/(url\s*\(|expression\s*\(|javascript:|@import)/i.test(propertyValue)
      )
        styles.push(`${propertyName}: ${propertyValue}`);
    }
    if (styles.length) element.setAttribute('style', styles.join('; '));
    else element.removeAttribute('style');
  }
  return document.body.innerHTML;
}
function formatDescription(value: string): string {
  if (!value.trim() || /<\/?[a-z][^>]*>/i.test(value)) return sanitizeHtml(value);
  const decoded =
    typeof DOMParser === 'undefined'
      ? value
      : new DOMParser().parseFromString(value, 'text/html').body.textContent;
  const html = renderToStaticMarkup(
    <>
      {parseMarkdownBlocks(decoded).map((block, index) => {
        switch (block.type) {
          case 'heading': {
            return createElement(
              `h${block.level}`,
              { key: index },
              renderInlineContent(block.text),
            );
          }
          case 'paragraph':
            return <p key={index}>{renderInlineContent(block.text)}</p>;
          case 'blockquote':
            return <blockquote key={index}>{renderInlineContent(block.text)}</blockquote>;
          case 'code':
            return (
              <pre key={index}>
                <code>{block.code}</code>
              </pre>
            );
          case 'hr':
            return <hr key={index} />;
          case 'html':
            // Escaped HTML in plain-text descriptions stays literal text.
            return <p key={index}>{block.html}</p>;
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} style={{ marginLeft: item.indent }}>
                    {item.checked !== undefined ? `${item.checked ? '☑' : '☐'} ` : ''}
                    {renderInlineContent(item.text)}
                  </li>
                ))}
              </List>
            );
          }
          case 'table':
            return (
              <table key={index}>
                <thead>
                  <tr>
                    {block.headers.map((header, cellIndex) => (
                      <th key={cellIndex}>{renderInlineContent(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{renderInlineContent(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
        }
      })}
    </>,
  );
  return sanitizeHtml(html);
}
const emptyForm: ItemForm = {
  kind: 'pbi',
  title: '',
  description: '',
  status: 'backlog',
  parentId: null,
  attachments: [],
};
const copy = {
  'pt-BR': {
    subtitle: 'Backlog do workspace, cards e integrações',
    refresh: 'Atualizar',
    pullAll: 'Pull de todos',
    newPbi: 'Novo PBI',
    loadError: 'Não foi possível carregar os PBIs.',
    actionError: 'Não foi possível concluir a ação.',
    syncedItems: 'itens sincronizados',
    failedIntegrations: 'integração(ões) falharam',
    publishedTo: 'Publicado em',
    configureForPush: 'Configure uma integração para fazer push.',
    issueCreated: 'Issue criada a partir do PBI.',
    testsCreated: 'Casos de teste criados.',
    filter: 'Filtrar PBIs',
    filterPlaceholder: 'Filtrar por palavra-chave',
    allSources: 'Todas as origens',
    localSource: 'ADK (local)',
    allStates: 'Todos os estados',
    allIterations: 'Todas as iterações',
    area: 'Área',
    iteration: 'Iteração',
    tags: 'Tags',
    cards: 'cards',
    comments: 'Comentários',
    noComments: 'Nenhum comentário neste item.',
    loadingComments: 'Carregando comentários...',
    commentsError: 'Não foi possível carregar os comentários.',
    noCards: 'Nenhum card vinculado a este PBI.',
    syncingCards: 'Sincronizando cards...',
    cardsError: 'Não foi possível sincronizar os cards.',
    order: 'Ordem',
    type: 'Tipo',
    title: 'Título',
    state: 'Estado',
    source: 'Origem',
    actions: 'Ações',
    columns: 'Colunas',
    itemDetails: 'Detalhes do item',
    assignedAgent: 'Agente atribuído',
    unassigned: 'Não atribuído',
    priority: 'Prioridade',
    cardType: 'Tipo do card',
    noType: 'Sem tipo',
    description: 'Descrição',
    saveItem: 'Salvar item',
    agentError: 'Não foi possível carregar os agentes.',
    perPage: 'PBIs por página',
    expand: 'Expandir',
    collapse: 'Recolher',
    addCard: 'Adicionar card',
    push: 'Publicar',
    createIssue: 'Criar issue de',
    createTests: 'Criar testes de',
    noMatch: 'Nenhum item corresponde à busca.',
    empty: 'Nenhum PBI ainda. Crie um ou faça Pull das integrações.',
    integrations: 'Integrações',
    pullHint: 'Pull sincroniza todas as conexões ativas.',
    configureHint: 'Configure um provedor em Integrations para sincronizar.',
    editItem: 'Editar item',
    newCard: 'Novo card',
    parent: 'Item pai',
    selectParent: 'Selecione um item',
    publish: 'Publicar',
    deleteTitle: 'Excluir item?',
    deleteDescription: 'Excluir {title} e seus cards locais?',
    assignee: 'Responsável',
    allAssignees: 'Todos os responsáveis',
    noAssignee: 'Sem responsável',
    membersError: 'Não foi possível carregar os membros do workspace.',
    savedFilters: 'Filtros salvos',
    saveFilter: 'Salvar filtro',
    saveFilterTitle: 'Salvar filtros atuais',
    filterName: 'Nome do filtro',
    deleteSavedFilter: 'Excluir filtro salvo',
  },
  'en-US': {
    subtitle: 'Workspace backlog, cards and integrations',
    refresh: 'Refresh',
    pullAll: 'Pull all',
    newPbi: 'New PBI',
    loadError: 'Could not load PBIs.',
    actionError: 'Could not complete the action.',
    syncedItems: 'items synchronized',
    failedIntegrations: 'integration(s) failed',
    publishedTo: 'Published to',
    configureForPush: 'Configure an integration before pushing.',
    issueCreated: 'Issue created from PBI.',
    testsCreated: 'Test cases created.',
    filter: 'Filter PBIs',
    filterPlaceholder: 'Filter by keyword',
    allSources: 'All sources',
    localSource: 'ADK (local)',
    allStates: 'All states',
    allIterations: 'All iterations',
    area: 'Area',
    iteration: 'Iteration',
    tags: 'Tags',
    cards: 'cards',
    comments: 'Comments',
    noComments: 'No comments on this item.',
    loadingComments: 'Loading comments...',
    commentsError: 'Could not load comments.',
    noCards: 'No cards linked to this PBI.',
    syncingCards: 'Syncing cards...',
    cardsError: 'Could not sync cards.',
    order: 'Order',
    type: 'Type',
    title: 'Title',
    state: 'State',
    source: 'Source',
    actions: 'Actions',
    columns: 'Columns',
    itemDetails: 'Item details',
    assignedAgent: 'Assigned agent',
    unassigned: 'Unassigned',
    priority: 'Priority',
    cardType: 'Card type',
    noType: 'No type',
    description: 'Description',
    saveItem: 'Save item',
    agentError: 'Could not load agents.',
    perPage: 'PBIs per page',
    expand: 'Expand',
    collapse: 'Collapse',
    addCard: 'Add card',
    push: 'Publish',
    createIssue: 'Create issue from',
    createTests: 'Create tests from',
    noMatch: 'No items match the search.',
    empty: 'No PBIs yet. Create one or pull your integrations.',
    integrations: 'Integrations',
    pullHint: 'Pull synchronizes all active connections.',
    configureHint: 'Configure a provider in Integrations to synchronize.',
    editItem: 'Edit item',
    newCard: 'New card',
    parent: 'Parent item',
    selectParent: 'Select an item',
    publish: 'Publish',
    deleteTitle: 'Delete item?',
    deleteDescription: 'Delete {title} and its local cards?',
    assignee: 'Assignee',
    allAssignees: 'All assignees',
    noAssignee: 'No assignee',
    membersError: 'Could not load workspace members.',
    savedFilters: 'Saved filters',
    saveFilter: 'Save filter',
    saveFilterTitle: 'Save current filters',
    filterName: 'Filter name',
    deleteSavedFilter: 'Delete saved filter',
  },
} as const;

export function PbiView({
  apiClient,
  workspaceId,
  refreshToken,
  onPbiChanged,
  isReadOnly: readOnlyProp = false,
  onOpenIssues,
  onOpenTestPlans,
}: Props) {
  const { locale, t } = useI18n();
  const permissions = usePermissions();
  // Controls the member cannot use are not rendered at all.
  const isReadOnly = readOnlyProp || !permissions.can('pbis', 'edit');
  const canDelete = permissions.can('pbis', 'delete');
  const canCreateIssue = permissions.can('issues', 'edit');
  const canCreateTests = permissions.can('testplans', 'edit');
  const canViewAgents = permissions.can('agents');
  const { runActivity } = useActivityRunner();
  const c = copy[locale];
  const [items, setItems] = useState<PbiItem[]>([]);
  const [providers, setProviders] = useState<PbiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushingIds, setPushingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [iterationFilter, setIterationFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(() =>
    readSavedFilters(workspaceId),
  );
  const [filterNameDraft, setFilterNameDraft] = useState<string | null>(null);
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const iterationTouched = useRef(false);
  const expandedWorkspace = useRef<string | null>(null);
  const mounted = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(() => readColumns(workspaceId));
  const [columnWidths, setColumnWidths] = useState<Record<ColumnId, number>>(() =>
    readColumnWidths(workspaceId),
  );
  const columnWidthsRef = useRef(columnWidths);
  const activeResize = useRef<{ id: ColumnId; startX: number; startWidth: number } | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  columnWidthsRef.current = columnWidths;
  workspaceIdRef.current = workspaceId;
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [form, setForm] = useState<ItemForm | null>(null);
  const [syncingChildrenId, setSyncingChildrenId] = useState<string | null>(null);
  const [childrenError, setChildrenError] = useState<string | null>(null);
  const syncedChildren = useRef(new Set<string>());
  const [comments, setComments] = useState<PbiComment[]>([]);
  const [commentsForId, setCommentsForId] = useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentsRequest, setCommentsRequest] = useState(0);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [pushItem, setPushItem] = useState<PbiItem | null>(null);
  // Latest loaded items, read after a reload (e.g. to open an item created from a link).
  const itemsRef = useRef<PbiItem[]>(items);
  itemsRef.current = items;
  const [deleteItem, setDeleteItem] = useState<PbiItem | null>(null);
  const descriptionEditorRef = useRef<HTMLDivElement>(null);
  const formOpen = Boolean(form);
  useInlineImages(descriptionEditorRef, form?.description);
  const descriptionImages = useRichTextImageInput('pbi', descriptionEditorRef, (html) =>
    setForm((current) => ({ ...current!, description: sanitizeHtml(html) })),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setVisibleColumns(readColumns(workspaceId)), [workspaceId]);
  useEffect(() => setSavedFilters(readSavedFilters(workspaceId)), [workspaceId]);
  useEffect(() => {
    setMembers([]);
    setMembersError(null);
    if (!workspaceId) return;
    let active = true;
    void Promise.resolve()
      .then(() => apiClient.getWorkspaceMembers(workspaceId))
      .then(
        (list) => {
          if (active) setMembers(list);
        },
        () => {
          if (active) setMembersError(c.membersError);
        },
      );
    return () => {
      active = false;
    };
  }, [apiClient, workspaceId, c.membersError]);
  useEffect(() => setColumnWidths(readColumnWidths(workspaceId)), [workspaceId]);
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resize = activeResize.current;
      if (!resize) return;
      const width = Math.max(
        minimumColumnWidth,
        Math.min(900, resize.startWidth + event.clientX - resize.startX),
      );
      columnWidthsRef.current = { ...columnWidthsRef.current, [resize.id]: width };
      setColumnWidths(columnWidthsRef.current);
    };
    const onPointerUp = () => {
      if (!activeResize.current) return;
      activeResize.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem(
          `adk:pbi-column-widths:${workspaceIdRef.current ?? 'default'}`,
          JSON.stringify(columnWidthsRef.current),
        );
      } catch {
        // Storage can be unavailable in private browsing.
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);
  useEffect(() => {
    syncedChildren.current.clear();
  }, [workspaceId]);
  useEffect(() => {
    setChildrenError(null);
    if (!form?.id) syncedChildren.current.clear();
  }, [form?.id]);
  useEffect(() => {
    const itemId = form?.id;
    if (
      !itemId ||
      isReadOnly ||
      syncedChildren.current.has(itemId) ||
      !items.some(
        (item) =>
          item.id === itemId && item.links.some((link) => link.providerId === 'azure_devops'),
      )
    )
      return;
    syncedChildren.current.add(itemId);
    let active = true;
    setSyncingChildrenId(itemId);
    setChildrenError(null);
    void apiClient
      .syncPbiChildren(itemId)
      .then(
        (list) => {
          if (!active) return;
          setItems(list);
          setExpanded((current) => new Set(current).add(itemId));
        },
        (cause: unknown) => {
          syncedChildren.current.delete(itemId);
          if (active) setChildrenError(cause instanceof Error ? cause.message : c.cardsError);
        },
      )
      .finally(() => {
        if (active) setSyncingChildrenId(null);
      });
    return () => {
      active = false;
    };
  }, [apiClient, form?.id, isReadOnly, items, c.cardsError]);
  useEffect(() => {
    if (!formOpen || !canViewAgents) return;
    let active = true;
    void apiClient.getAgents().then(
      (list) => {
        if (active) {
          setAgents(list);
          setAgentError(null);
        }
      },
      () => {
        if (active) setAgentError(c.agentError);
      },
    );
    return () => {
      active = false;
    };
  }, [apiClient, formOpen, canViewAgents, c.agentError]);
  useEffect(() => {
    setComments([]);
    setCommentsForId(null);
    setCommentsError(null);
    const itemId = form?.id;
    if (!itemId) {
      setCommentsLoading(false);
      return;
    }
    let active = true;
    setCommentsLoading(true);
    void apiClient
      .getPbiComments(itemId)
      .then(
        (list) => {
          if (active) {
            setComments(list);
            setCommentsForId(itemId);
          }
        },
        (cause: unknown) => {
          if (active) setCommentsError(cause instanceof Error ? cause.message : c.commentsError);
        },
      )
      .finally(() => {
        if (active) setCommentsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, form?.id, commentsRequest, c.commentsError]);
  const showColumn = (id: ColumnId) => id === 'actions' || visibleColumns.includes(id);
  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Only optional columns reach here: the columns menu never offers title or actions.
  const toggleColumn = (id: ColumnId) => {
    const next = visibleColumns.includes(id)
      ? visibleColumns.filter((column) => column !== id)
      : columnIds.filter((column) => column === id || visibleColumns.includes(column));
    setVisibleColumns(next);
    try {
      localStorage.setItem(`adk:pbi-columns:${workspaceId ?? 'default'}`, JSON.stringify(next));
    } catch {
      /* Storage unavailable. */
    }
  };

  const load = useCallback(async () => {
    if (!workspaceId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [list, connected, currentIteration] = await Promise.all([
        apiClient.getPbiItems(),
        apiClient.getPbiProviders(),
        apiClient.getPbiCurrentIteration().catch(() => undefined),
      ]);
      itemsRef.current = list;
      setItems(list);
      setProviders(connected);
      if (!iterationTouched.current) {
        const path =
          currentIteration === undefined
            ? sourceText(
                list.find((item) => item.sourceData.currentIteration === true)?.sourceData
                  .iterationPath,
              )
            : currentIteration;
        if (path) setIterationFilter(path);
      }
      const parents = new Set(list.map((item) => item.parentId).filter((id): id is string => !!id));
      const firstLoadForWorkspace = expandedWorkspace.current !== workspaceId;
      expandedWorkspace.current = workspaceId;
      setExpanded((current) =>
        firstLoadForWorkspace
          ? new Set(parents)
          : new Set([...current].filter((id) => parents.has(id))),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c.loadError);
    } finally {
      setLoading(false);
    }
  }, [apiClient, workspaceId, c.loadError]);
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const visibleItems = useMemo(() => items.filter((item) => !shouldHideItem(item)), [items]);
  const itemById = useMemo(
    () => new Map(visibleItems.map((item) => [item.id, item])),
    [visibleItems],
  );
  const children = useMemo(() => {
    const map = new Map<string | null, PbiItem[]>();
    for (const item of visibleItems) {
      const siblings = map.get(item.parentId);
      if (siblings) siblings.push(item);
      else map.set(item.parentId, [item]);
    }
    for (const values of map.values())
      values.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    return map;
  }, [visibleItems]);
  // Descriptions are converted to text once per load, not on every keystroke or render.
  const descriptionText = useMemo(
    () => new Map(visibleItems.map((item) => [item.id, plainText(item.description)])),
    [visibleItems],
  );
  const searchIndex = useMemo(
    () =>
      new Map(
        visibleItems.map((item) => [
          item.id,
          normalizeSearch(
            [
              item.title,
              descriptionText.get(item.id)!,
              ...item.links.map((link) => link.externalId),
            ].join(' '),
          ),
        ]),
      ),
    [visibleItems, descriptionText],
  );
  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.userId, memberLabel(member)])),
    [members],
  );
  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => memberLabel(a).localeCompare(memberLabel(b), locale)),
    [members, locale],
  );
  const statuses = useMemo(
    () => [...new Set(visibleItems.map((item) => item.status).filter(Boolean))].sort(),
    [visibleItems],
  );
  const iterations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of visibleItems) {
      const iteration = sourceText(item.sourceData.iterationPath);
      if (iteration) counts.set(iteration, (counts.get(iteration) ?? 0) + 1);
    }
    return [...counts].sort(([left], [right]) => left.localeCompare(right));
  }, [visibleItems]);
  // Typing stays responsive: filtering 10k+ items runs with the deferred query.
  const deferredQuery = useDeferredValue(query);
  const currentFilters: FilterValues = {
    query,
    source: sourceFilter,
    status: statusFilter,
    iteration: iterationFilter,
    assignee: assigneeFilter,
  };
  const hasFilters = Object.values(currentFilters).some((value) => value.trim());
  const activeSavedFilter = savedFilters.find((saved) =>
    (Object.keys(currentFilters) as (keyof FilterValues)[]).every(
      (key) => saved[key] === currentFilters[key],
    ),
  );
  /**
   * Items shown under the current filters, or null when unfiltered. An item that matches
   * brings its whole subtree (all children) and its ancestors, so the hierarchy stays intact.
   */
  const shownIds = useMemo(() => {
    const terms = normalizeSearch(deferredQuery).split(/\s+/).filter(Boolean);
    if (!terms.length && !sourceFilter && !statusFilter && !iterationFilter && !assigneeFilter)
      return null;
    const selfMatches = (item: PbiItem): boolean => {
      const assignee = sourceText(item.sourceData.adkAssigneeUserId);
      const text = searchIndex.get(item.id)!;
      return (
        terms.every((term) => text.includes(term)) &&
        (!sourceFilter ||
          (sourceFilter === 'local'
            ? item.links.length === 0
            : item.links.some((link) => link.providerId === sourceFilter))) &&
        (!statusFilter || item.status === statusFilter) &&
        (!iterationFilter || sourceText(item.sourceData.iterationPath) === iterationFilter) &&
        (!assigneeFilter || (assigneeFilter === 'none' ? !assignee : assignee === assigneeFilter))
      );
    };
    const shown = new Set<string>();
    const subtrees = new Set<string>();
    for (const item of visibleItems) {
      if (subtrees.has(item.id) || !selfMatches(item)) continue;
      const stack = [item];
      while (stack.length) {
        const current = stack.pop()!;
        if (subtrees.has(current.id)) continue;
        subtrees.add(current.id);
        shown.add(current.id);
        stack.push(...(children.get(current.id) ?? []));
      }
      let parentId = item.parentId;
      while (parentId && !shown.has(parentId)) {
        shown.add(parentId);
        parentId = itemById.get(parentId)?.parentId ?? null;
      }
    }
    return shown;
  }, [
    deferredQuery,
    sourceFilter,
    statusFilter,
    iterationFilter,
    assigneeFilter,
    searchIndex,
    visibleItems,
    children,
    itemById,
  ]);
  const filteredRoots = useMemo(
    () => (children.get(null) ?? []).filter((item) => !shownIds || shownIds.has(item.id)),
    [children, shownIds],
  );
  // Root items are paged (or loaded while scrolling); their expanded subtrees come along.
  const paging = usePaging(filteredRoots.length, {
    storageKey: `adk:pbi-paging:${workspaceId ?? 'default'}`,
    resetKey: JSON.stringify([query, sourceFilter, statusFilter, iterationFilter, assigneeFilter]),
  });
  const visible = useMemo(() => {
    const rows: { item: PbiItem; depth: number }[] = [];
    const visit = (parentId: string, depth: number) => {
      for (const item of children.get(parentId) ?? []) {
        if (shownIds && !shownIds.has(item.id)) continue;
        rows.push({ item, depth });
        if (expanded.has(item.id)) visit(item.id, depth + 1);
      }
    };
    const pageRoots = filteredRoots.slice(paging.start, paging.end);
    for (const root of pageRoots) {
      rows.push({ item: root, depth: 0 });
      if (expanded.has(root.id)) visit(root.id, 1);
    }
    return rows;
  }, [children, paging.start, paging.end, expanded, filteredRoots, shownIds]);
  const visibleChildren = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const row of visible) {
      if (!row.item.parentId) continue;
      const siblings = map.get(row.item.parentId) ?? [];
      siblings.push(row);
      map.set(row.item.parentId, siblings);
    }
    return map;
  }, [visible]);
  const runAction = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c.actionError);
    } finally {
      setBusy(false);
    }
  };
  const pull = () => {
    setPulling(true);
    void runActivity({ kind: 'pull', title: c.pullAll }, async () => {
      const result = await apiClient.pullPbiBoards();
      onPbiChanged?.();
      const failed = result.results.filter((entry) => entry.error);
      if (failed.length)
        throw new Error(failed.map((entry) => `${entry.providerId}: ${entry.error}`).join(' · '));
      return result;
    })
      .then(
        (result) => {
          if (!mounted.current) return;
          setItems(result.items);
          const parents = new Set(
            result.items.map((item) => item.parentId).filter((id): id is string => !!id),
          );
          setExpanded((current) => new Set([...current, ...parents]));
          const imported = result.results.reduce((sum, entry) => sum + entry.imported, 0);
          setNotice(`${imported} ${c.syncedItems}.`);
          if (!onPbiChanged) void load();
        },
        () => {
          if (mounted.current && !onPbiChanged) void load();
        },
      )
      .finally(() => {
        if (mounted.current) setPulling(false);
      });
  };
  /** Closing the form without saving drops what was typed, pasted and attached. */
  const closeForm = (current: ItemForm) => {
    const editorValue = editorHtml(descriptionEditorRef.current!);
    discardDrafts({ ...current, description: editorValue });
    setForm(null);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const editorValue = editorHtml(descriptionEditorRef.current!);
      const { id, kind, sourceData, ...fields } = form!;
      const values = {
        ...fields,
        description: editorValue.trim() ? sanitizeHtml(editorValue) : '',
        sourceData: {
          adkPriority: sourceText(sourceData?.adkPriority) || '3',
          adkAgentId: sourceText(sourceData?.adkAgentId),
          adkAssigneeUserId: sourceText(sourceData?.adkAssigneeUserId),
          adkCardType: sourceText(sourceData?.adkCardType),
        },
      };
      // Pasted and attached files are drafts until this save uploads them.
      await saveWithDrafts(
        apiClient,
        'pbi',
        { description: values.description, attachments: values.attachments },
        (files) =>
          id
            ? apiClient.updatePbiItem(id, { ...values, ...files })
            : apiClient.createPbiItem({ ...values, ...files, kind }),
      );
      if (fields.parentId) setExpanded((current) => new Set(current).add(fields.parentId!));
      setForm(null);
      await load();
    });
  };
  const push = (
    item: PbiItem,
    provider: PbiProviderId,
    fields: Record<string, string>,
    templateId?: string,
  ) => {
    setPushItem(null);
    setPushingIds((current) => new Set(current).add(item.id));
    void runActivity({ kind: 'push', title: `${c.publish}: ${item.title}` }, () =>
      apiClient.pushPbiItem(item.id, {
        providerId: provider,
        fields,
        ...(templateId ? { templateId } : {}),
      }),
    )
      .then(
        (result) => {
          onPbiChanged?.();
          if (mounted.current) {
            setNotice(
              [`${c.publishedTo} ${providerNames[provider]}.`, ...result.warnings].join(' '),
            );
            if (!onPbiChanged) void load();
          }
        },
        () => {
          // The activity center keeps the error visible after navigating away.
        },
      )
      .finally(() => {
        if (mounted.current)
          setPushingIds((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          });
      });
  };
  /** The item with every field: the list only carries an excerpt of each description. */
  const fullItem = (item: PbiItem): Promise<PbiItem> =>
    item.partial ? apiClient.getPbiItem(item.id) : Promise.resolve(item);
  /** Calls `open` with the full item: at once when it is loaded, after fetching it otherwise. */
  const withFullItem = (item: PbiItem, open: (full: PbiItem) => void) => {
    if (!item.partial) {
      open(item);
      return;
    }
    void runAction(async () => {
      const full = await fullItem(item);
      if (mounted.current) open(full);
    });
  };
  const openPush = (item: PbiItem) => {
    const first = providers[0];
    if (!first) {
      setError(c.configureForPush);
      return;
    }
    withFullItem(item, setPushItem);
  };
  // The form opens with the full item only: saving a list item would overwrite its
  // description and provider fields with the excerpt.
  const editItem = (item: PbiItem) =>
    withFullItem(item, (full) =>
      setForm({
        id: full.id,
        kind: full.kind,
        title: full.title,
        description: full.description,
        status: full.status,
        parentId: full.parentId,
        position: full.position,
        sourceData: full.sourceData,
        attachments: full.attachments,
      }),
    );
  const openItem = (id: string) => {
    const target = itemsRef.current.find((entry) => entry.id === id);
    if (target) editItem(target);
  };
  const createIssue = (item: PbiItem) =>
    void runAction(async () => {
      await apiClient.createIssueFromPbi(item.id);
      setNotice(c.issueCreated);
      onOpenIssues?.();
    });
  const createTests = (listed: PbiItem) =>
    void runAction(async () => {
      const [item, { descendants }] = await Promise.all([
        fullItem(listed),
        apiClient.getPbiContext(listed.id),
      ]);
      const prompt = [
        item.title,
        item.description,
        ...descendants.map((child) => `${child.title}: ${child.description}`),
      ]
        .filter(Boolean)
        .join('\n\n');
      await apiClient.generateTestPlan(prompt, {
        title: item.title,
        sourceType: 'pbi',
        sourceId: item.id,
      });
      setNotice(c.testsCreated);
      onOpenTestPlans?.();
    });
  const persistSavedFilters = (next: SavedFilter[]) => {
    setSavedFilters(next);
    try {
      localStorage.setItem(savedFiltersKey(workspaceId), JSON.stringify(next));
    } catch {
      // Storage can be unavailable in private browsing.
    }
  };
  const applySavedFilter = (id: string) => {
    const saved = savedFilters.find((entry) => entry.id === id);
    if (!saved) return;
    iterationTouched.current = true;
    setQuery(saved.query);
    setSourceFilter(saved.source);
    setStatusFilter(saved.status);
    setIterationFilter(saved.iteration);
    setAssigneeFilter(saved.assignee);
  };
  const saveCurrentFilter = (event: FormEvent) => {
    event.preventDefault();
    const name = filterNameDraft?.trim();
    if (!name) return;
    const existing = savedFilters.find(
      (entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    const entry: SavedFilter = { id: existing?.id ?? crypto.randomUUID(), name, ...currentFilters };
    persistSavedFilters(
      [...savedFilters.filter((saved) => saved.id !== entry.id), entry].sort((a, b) =>
        a.name.localeCompare(b.name, locale),
      ),
    );
    setFilterNameDraft(null);
  };
  const { pbiCount, cardCount, sourceCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    let pbis = 0;
    for (const item of visibleItems) {
      if (item.kind === 'pbi') pbis++;
      for (const providerId of new Set(item.links.map((link) => link.providerId)))
        counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
    }
    return {
      pbiCount: pbis,
      cardCount: visibleItems.length - pbis,
      sourceCounts: Object.entries(providerNames).map(([id, name]) => ({
        id,
        name,
        count: counts.get(id) ?? 0,
      })),
    };
  }, [visibleItems]);
  const canBeParent = (candidate: PbiItem, childId?: string) => {
    if (!childId) return true;
    let current: PbiItem | undefined = candidate;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === childId) return false;
      visited.add(current.id);
      current = current.parentId ? itemById.get(current.parentId) : undefined;
    }
    return true;
  };
  const resolveAuditValue = (key: string, value: AuditSnapshot): string | undefined => {
    if (typeof value !== 'string') return undefined;
    if (key === 'adkAssigneeUserId')
      return value ? (memberNames.get(value) ?? value) : c.noAssignee;
    if (key === 'adkAgentId')
      return value ? (agents.find((agent) => agent.id === value)?.name ?? value) : c.unassigned;
    if (key === 'parentId') return itemById.get(value)?.title ?? value;
    if (key === 'description') return plainText(value);
    return undefined;
  };
  const tableMinimumWidth = Math.max(
    560,
    40 + columnIds.reduce((width, id) => width + (showColumn(id) ? columnWidths[id] : 0), 0),
  );
  const renderColumnGroup = () => (
    <colgroup>
      <col style={{ width: 40 }} />
      {columnIds.filter(showColumn).map((id) => (
        <col key={id} style={{ width: columnWidths[id] }} />
      ))}
    </colgroup>
  );
  const resizeHandle = (id: ColumnId) => (
    <button
      type="button"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={minimumColumnWidth}
      aria-valuemax={900}
      aria-valuenow={Math.round(columnWidths[id])}
      aria-label={`${c.columns}: ${c[id]}`}
      className="absolute right-0 top-0 z-20 h-full w-2 cursor-col-resize touch-none border-0 bg-transparent p-0 focus-visible:outline-none"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 20 : 8);
        const width = Math.max(
          minimumColumnWidth,
          Math.min(900, columnWidthsRef.current[id] + delta),
        );
        columnWidthsRef.current = { ...columnWidthsRef.current, [id]: width };
        setColumnWidths(columnWidthsRef.current);
        try {
          localStorage.setItem(
            `adk:pbi-column-widths:${workspaceId ?? 'default'}`,
            JSON.stringify(columnWidthsRef.current),
          );
        } catch {
          // Storage can be unavailable in private browsing.
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activeResize.current = {
          id,
          startX: event.clientX,
          startWidth: columnWidthsRef.current[id],
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
    />
  );

  return (
    <main className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 p-6 text-[var(--text-primary)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('nav.pbis')}</h1>
          <p className="text-sm text-[var(--text-muted)]">{c.subtitle}</p>
        </div>
        <ActionsMenu label={c.actions}>
          <Button
            variant="ghost"
            role="menuitem"
            className="flex w-full justify-start text-left"
            onClick={() => void load()}
            disabled={busy}
          >
            <i className="ti ti-refresh" aria-hidden="true" /> {c.refresh}
          </Button>
          {!isReadOnly && (
            <Button
              variant="ghost"
              role="menuitem"
              className="flex w-full justify-start text-left"
              onClick={pull}
              isLoading={pulling}
            >
              <i className="ti ti-cloud-download" aria-hidden="true" /> {c.pullAll}
            </Button>
          )}
          {!isReadOnly && (
            <Button
              variant="ghost"
              role="menuitem"
              className="flex w-full justify-start text-left"
              onClick={() => setForm({ ...emptyForm })}
            >
              <i className="ti ti-plus" aria-hidden="true" /> {c.newPbi}
            </Button>
          )}
          <Button
            variant="ghost"
            role="menuitemcheckbox"
            aria-checked={columnsOpen}
            className="flex w-full justify-start text-left"
            onClick={(event) => {
              event.stopPropagation();
              setColumnsOpen((open) => !open);
            }}
          >
            <i className="ti ti-columns-3" aria-hidden="true" /> {c.columns}
          </Button>
          {columnsOpen && (
            <div className="border-t border-border px-2 py-1">
              {columnIds
                .filter((id) => id !== 'title' && id !== 'actions')
                .map((id) => (
                  <Button
                    key={id}
                    variant="ghost"
                    role="checkbox"
                    aria-checked={showColumn(id)}
                    className="flex w-full justify-start gap-2 text-left"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleColumn(id);
                    }}
                  >
                    <i
                      className={`ti ${showColumn(id) ? 'ti-square-check text-[var(--text-accent)]' : 'ti-square'}`}
                      aria-hidden="true"
                    />
                    {c[id]}
                  </Button>
                ))}
            </div>
          )}
        </ActionsMenu>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
        >
          {error}{' '}
          <Button variant="ghost" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3 text-sm"
        >
          {notice}
        </div>
      )}
      {loading ? (
        <SkeletonCard />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <section className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Input
                aria-label={c.filter}
                placeholder={c.filterPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="max-w-md"
              />
              <Select
                aria-label={c.source}
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
                containerClassName="max-w-44"
              >
                <option value="">{c.allSources}</option>
                <option value="local">{c.localSource}</option>
                {Object.entries(providerNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={c.state}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                containerClassName="max-w-40"
              >
                <option value="">{c.allStates}</option>
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </Select>
              {iterations.length > 0 && (
                <Select
                  aria-label={c.iteration}
                  value={iterationFilter}
                  onChange={(event) => {
                    iterationTouched.current = true;
                    setIterationFilter(event.target.value);
                  }}
                  containerClassName="w-80 max-w-full flex-none"
                >
                  <option value="">{c.allIterations}</option>
                  {iterations.map(([iteration]) => (
                    <option key={iteration} value={iteration}>
                      {iteration}
                    </option>
                  ))}
                </Select>
              )}
              <Select
                aria-label={c.assignee}
                value={assigneeFilter}
                onChange={(event) => setAssigneeFilter(event.target.value)}
                containerClassName="max-w-48"
              >
                <option value="">{c.allAssignees}</option>
                <option value="none">{c.noAssignee}</option>
                {sortedMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {memberLabel(member)}
                  </option>
                ))}
              </Select>
              <div className="flex items-center gap-1">
                <Select
                  aria-label={c.savedFilters}
                  value={activeSavedFilter?.id ?? ''}
                  onChange={(event) => applySavedFilter(event.target.value)}
                  containerClassName="max-w-48"
                >
                  <option value="" disabled={savedFilters.length > 0}>
                    {c.savedFilters}
                  </option>
                  {savedFilters.map((saved) => (
                    <option key={saved.id} value={saved.id}>
                      {saved.name}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 gap-2 px-4"
                  title={c.saveFilter}
                  disabled={!hasFilters}
                  onClick={() => setFilterNameDraft(activeSavedFilter?.name ?? '')}
                >
                  <i className="ti ti-device-floppy text-lg" aria-hidden="true" />
                  {c.saveFilter}
                </Button>
                {activeSavedFilter && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    aria-label={`${c.deleteSavedFilter}: ${activeSavedFilter.name}`}
                    title={c.deleteSavedFilter}
                    onClick={() =>
                      persistSavedFilters(
                        savedFilters.filter((saved) => saved.id !== activeSavedFilter.id),
                      )
                    }
                  >
                    <i className="ti ti-trash" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <span className="text-xs text-[var(--text-muted)]">
                {pbiCount} {t('nav.pbis')} · {cardCount} {c.cards}
              </span>
            </div>
            {membersError && (
              <p role="alert" className="mb-3 text-xs text-red-300">
                {membersError}
              </p>
            )}
            <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
              <table
                role="treegrid"
                className="w-full table-fixed text-left text-sm [&_th:not(:last-child)]:border-r [&_th:not(:last-child)]:border-[var(--border)] [&_td:not(:last-child)]:border-r [&_td:not(:last-child)]:border-[var(--border)]"
                style={{ minWidth: tableMinimumWidth }}
              >
                {renderColumnGroup()}
                <thead className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                  <tr>
                    <th className="w-10 px-2 py-3" aria-label={c.expand} />
                    {showColumn('order') && (
                      <th className="relative px-3 py-3">
                        {c.order}
                        {resizeHandle('order')}
                      </th>
                    )}
                    {showColumn('type') && (
                      <th className="relative px-3 py-3">
                        {c.type}
                        {resizeHandle('type')}
                      </th>
                    )}
                    <th className="relative px-3 py-3">
                      {c.title}
                      {resizeHandle('title')}
                    </th>
                    {showColumn('state') && (
                      <th className="relative px-3 py-3">
                        {c.state}
                        {resizeHandle('state')}
                      </th>
                    )}
                    {showColumn('assignee') && (
                      <th className="relative px-3 py-3">
                        {c.assignee}
                        {resizeHandle('assignee')}
                      </th>
                    )}
                    {showColumn('area') && (
                      <th className="relative px-3 py-3">
                        {c.area}
                        {resizeHandle('area')}
                      </th>
                    )}
                    {showColumn('iteration') && (
                      <th className="relative px-3 py-3">
                        {c.iteration}
                        {resizeHandle('iteration')}
                      </th>
                    )}
                    {showColumn('tags') && (
                      <th className="relative px-3 py-3">
                        {c.tags}
                        {resizeHandle('tags')}
                      </th>
                    )}
                    {showColumn('source') && (
                      <th className="relative px-3 py-3">
                        {c.source}
                        {resizeHandle('source')}
                      </th>
                    )}
                    <th className="sticky right-0 z-10 bg-[var(--surface-1)] px-3 py-3 text-right">
                      {c.actions}
                      {resizeHandle('actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const renderRow = (
                      { item, depth }: { item: PbiItem; depth: number },
                      index: number,
                    ) => {
                      const canExpand = (children.get(item.id)?.length ?? 0) > 0;
                      const type = displayType(item);
                      const appearance = typeAppearance(item);
                      return (
                        <Fragment key={item.id}>
                          <tr
                            aria-level={depth + 1}
                            aria-expanded={canExpand ? expanded.has(item.id) : undefined}
                            tabIndex={canExpand ? 0 : undefined}
                            onClick={(event) => {
                              if (!canExpand || (event.target as HTMLElement).closest('button, a'))
                                return;
                              toggleExpanded(item.id);
                            }}
                            onKeyDown={(event) => {
                              if (!canExpand || event.target !== event.currentTarget) return;
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleExpanded(item.id);
                              }
                            }}
                            className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--fill-ghost-hover)] ${depth ? 'bg-[var(--surface-2)]' : ''} ${canExpand ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--border-accent)]' : ''}`}
                          >
                            <td
                              className="w-10 px-2 py-2"
                              style={{
                                paddingLeft: depth ? 8 + Math.min(depth, 12) * 12 : undefined,
                              }}
                            >
                              {canExpand && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 shrink-0"
                                  aria-label={`${expanded.has(item.id) ? c.collapse : c.expand} ${item.title}`}
                                  aria-expanded={expanded.has(item.id)}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleExpanded(item.id);
                                  }}
                                >
                                  <i
                                    className={`ti ti-chevron-${expanded.has(item.id) ? 'down' : 'right'}`}
                                    aria-hidden="true"
                                  />
                                </Button>
                              )}
                            </td>
                            {showColumn('order') && (
                              <td className="px-3 py-2 text-[var(--text-muted)]">
                                {depth ? '' : index + 1}
                              </td>
                            )}
                            {showColumn('type') && (
                              <td className="overflow-hidden px-3 py-2 text-xs">
                                <span
                                  className={`inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 font-medium ${appearance.colors}`}
                                  title={type}
                                >
                                  <i
                                    className={`ti ${appearance.icon} shrink-0 ${appearance.iconColor}`}
                                    aria-hidden="true"
                                  />
                                  <span className="min-w-0 truncate whitespace-nowrap">{type}</span>
                                </span>
                              </td>
                            )}
                            <td className="min-w-0 overflow-hidden px-3 py-2">
                              <div className="min-w-0 max-w-full overflow-hidden">
                                <div className="flex min-w-0 items-center gap-2">
                                  <Button
                                    variant="link"
                                    className="h-auto min-w-0 flex-1 justify-start overflow-hidden p-0 text-left font-medium text-[var(--text-primary)] no-underline hover:text-[var(--text-primary)]"
                                    title={item.title}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      editItem(item);
                                    }}
                                  >
                                    <span className="block min-w-0 truncate">{item.title}</span>
                                  </Button>
                                  {(children.get(item.id)?.length ?? 0) > 0 && (
                                    <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-1.5 text-xs text-[var(--text-muted)]">
                                      {children.get(item.id)?.length}
                                    </span>
                                  )}
                                </div>
                                {descriptionText.get(item.id) && (
                                  <div className="max-w-full truncate text-xs text-[var(--text-muted)]">
                                    {descriptionText.get(item.id)}
                                  </div>
                                )}
                              </div>
                            </td>
                            {showColumn('state') && (
                              <td className="overflow-hidden px-3 py-2">
                                <span
                                  className="inline-block max-w-full truncate whitespace-nowrap rounded-full bg-[var(--surface-2)] px-2 py-1 text-xs align-middle"
                                  title={item.status}
                                >
                                  {item.status}
                                </span>
                              </td>
                            )}
                            {showColumn('assignee') && (
                              <td className="overflow-hidden px-3 py-2 text-xs">
                                {(() => {
                                  const userId = sourceText(item.sourceData.adkAssigneeUserId);
                                  const name = userId ? (memberNames.get(userId) ?? userId) : '';
                                  return (
                                    <span className="block truncate" title={name}>
                                      {name}
                                    </span>
                                  );
                                })()}
                              </td>
                            )}
                            {showColumn('area') && (
                              <td className="overflow-hidden px-3 py-2 text-xs text-[var(--text-muted)]">
                                <span
                                  className="block truncate"
                                  title={sourceText(item.sourceData.areaPath)}
                                >
                                  {sourceText(item.sourceData.areaPath)}
                                </span>
                              </td>
                            )}
                            {showColumn('iteration') && (
                              <td className="overflow-hidden px-3 py-2 text-xs text-[var(--text-muted)]">
                                <span
                                  className="block truncate"
                                  title={sourceText(item.sourceData.iterationPath)}
                                >
                                  {sourceText(item.sourceData.iterationPath)}
                                </span>
                              </td>
                            )}
                            {showColumn('tags') && (
                              <td className="overflow-hidden px-3 py-2 text-xs text-[var(--text-muted)]">
                                <span
                                  className="block truncate"
                                  title={sourceText(item.sourceData.tags)}
                                >
                                  {sourceText(item.sourceData.tags)}
                                </span>
                              </td>
                            )}
                            {showColumn('source') && (
                              <td className="overflow-hidden px-3 py-2 text-xs">
                                <span className="block truncate">
                                  {item.links.length
                                    ? item.links.map((link) =>
                                        link.externalUrl ? (
                                          <a
                                            key={link.id}
                                            className="mr-1 text-[var(--text-accent)] hover:underline"
                                            href={link.externalUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            {providerNames[link.providerId] ?? link.providerId}
                                          </a>
                                        ) : (
                                          <span key={link.id} className="mr-1">
                                            {providerNames[link.providerId] ?? link.providerId}
                                          </span>
                                        ),
                                      )
                                    : 'ADK'}
                                </span>
                              </td>
                            )}
                            <td
                              className={`sticky right-0 z-10 px-2 py-1 text-right ${depth ? 'bg-[var(--surface-2)]' : 'bg-[var(--surface-1)]'}`}
                            >
                              {!isReadOnly && (
                                <ActionsMenu label={`${c.actions}: ${item.title}`} portal>
                                  <Button
                                    variant="ghost"
                                    role="menuitem"
                                    className="flex w-full justify-start text-left"
                                    onClick={() => editItem(item)}
                                  >
                                    <i className="ti ti-pencil" aria-hidden="true" />{' '}
                                    {t('common.edit')}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    role="menuitem"
                                    className="flex w-full justify-start text-left"
                                    onClick={() =>
                                      setForm({ ...emptyForm, kind: 'card', parentId: item.id })
                                    }
                                  >
                                    <i className="ti ti-square-rounded-plus" aria-hidden="true" />{' '}
                                    {c.addCard}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    role="menuitem"
                                    className="flex w-full justify-start text-left"
                                    onClick={() => openPush(item)}
                                  >
                                    <i className="ti ti-cloud-upload" aria-hidden="true" />{' '}
                                    {c.publish}
                                  </Button>
                                  {canCreateIssue && (
                                    <Button
                                      variant="ghost"
                                      role="menuitem"
                                      className="flex w-full justify-start text-left"
                                      onClick={() => createIssue(item)}
                                    >
                                      <i className="ti ti-circle-check" aria-hidden="true" />{' '}
                                      {c.createIssue}
                                    </Button>
                                  )}
                                  {canCreateTests && (
                                    <Button
                                      variant="ghost"
                                      role="menuitem"
                                      className="flex w-full justify-start text-left"
                                      onClick={() => createTests(item)}
                                    >
                                      <i className="ti ti-test-pipe" aria-hidden="true" />{' '}
                                      {c.createTests}
                                    </Button>
                                  )}
                                  {canDelete && (
                                    <Button
                                      variant="ghost"
                                      role="menuitem"
                                      className="flex w-full justify-start text-left text-red-400"
                                      onClick={() => setDeleteItem(item)}
                                    >
                                      <i className="ti ti-trash" aria-hidden="true" />{' '}
                                      {t('common.delete')}
                                    </Button>
                                  )}
                                </ActionsMenu>
                              )}
                            </td>
                          </tr>
                          {item.kind === 'pbi' &&
                            expanded.has(item.id) &&
                            !children.get(item.id)?.length && (
                              <tr>
                                <td
                                  colSpan={visibleColumns.length + 1}
                                  className="px-8 py-3 text-xs text-[var(--text-muted)]"
                                >
                                  {c.noCards}
                                </td>
                              </tr>
                            )}
                        </Fragment>
                      );
                    };
                    const renderPanel = (parent: PbiItem): ReactNode => {
                      const childRows = visibleChildren.get(parent.id) ?? [];
                      if (!expanded.has(parent.id) || !childRows.length) return null;
                      return childRows.map((row, index) => (
                        <Fragment key={row.item.id}>
                          {renderRow(row, index)}
                          {renderPanel(row.item)}
                        </Fragment>
                      ));
                    };
                    return visible
                      .filter(({ depth }) => depth === 0)
                      .map((row, index) => (
                        <Fragment key={row.item.id}>
                          {renderRow(row, index)}
                          {renderPanel(row.item)}
                        </Fragment>
                      ));
                  })()}
                  {visible.length === 0 && (
                    <tr>
                      <td
                        colSpan={visibleColumns.length + 1}
                        className="px-6 py-12 text-center text-[var(--text-muted)]"
                      >
                        {hasFilters ? c.noMatch : c.empty}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <PagingSentinel paging={paging} />
            <Pagination paging={paging} perPageLabel={c.perPage} className="mt-3" />
          </section>
          <aside className="h-fit rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <section>
              <h2 className="font-semibold">{c.integrations}</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">{c.pullHint}</p>
              <div className="mt-4 space-y-2">
                {sourceCounts.map((source) => (
                  <div key={source.id} className="flex justify-between text-sm">
                    <span>{source.name}</span>
                    <span className="text-[var(--text-muted)]">{source.count}</span>
                  </div>
                ))}
              </div>
              {!providers.length && (
                <p className="mt-4 text-xs text-[var(--text-muted)]">{c.configureHint}</p>
              )}
            </section>
          </aside>
        </div>
      )}

      <Modal
        open={Boolean(form)}
        onClose={form ? () => closeForm(form) : undefined}
        labelledBy="pbi-item-title"
      >
        {form && (
          <form
            onSubmit={save}
            className="flex h-[min(90vh,900px)] w-[min(96vw,1800px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-3 text-xs text-[var(--text-accent)]">
              <span>
                <i className="ti ti-file-description mr-2" aria-hidden="true" />
                {form.kind === 'pbi' ? 'PBI' : c.newCard} · {form.id?.slice(0, 8) ?? c.itemDetails}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('common.close')}
                onClick={() => closeForm(form)}
              >
                <i className="ti ti-x" aria-hidden="true" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-6 py-4">
              <h2 id="pbi-item-title" className="sr-only">
                {form.id ? c.editItem : form.kind === 'pbi' ? c.newPbi : c.newCard}
              </h2>
              <Input
                aria-label={c.title}
                required
                maxLength={240}
                disabled={isReadOnly}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder={c.title}
                className="min-w-[220px] flex-1 border-0 bg-transparent px-0 text-xl font-semibold shadow-none"
              />
              {form.id && (
                <HistoryViewer
                  apiClient={apiClient}
                  entityType="pbi"
                  workspaceId={workspaceId}
                  entityId={form.id}
                  entityTitle={form.title}
                  resolveValue={resolveAuditValue}
                />
              )}
              <Button type="button" variant="ghost" onClick={() => closeForm(form)}>
                {t('common.cancel')}
              </Button>
              {!isReadOnly && (
                <Button type="submit" isLoading={busy}>
                  <i className="ti ti-device-floppy" aria-hidden="true" />
                  {c.saveItem}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-6 py-3 text-xs">
              <span>
                {c.state}{' '}
                <strong className="ml-1 text-[var(--text-accent)]">
                  {form.status || 'backlog'}
                </strong>
              </span>
              {canViewAgents && (
                <span>
                  {c.assignedAgent}{' '}
                  <strong className="ml-1 text-[var(--text-accent)]">
                    {agents.find((agent) => agent.id === sourceText(form.sourceData?.adkAgentId))
                      ?.name ?? c.unassigned}
                  </strong>
                </span>
              )}
              <span>
                {c.assignee}{' '}
                <strong className="ml-1 text-[var(--text-accent)]">
                  {(() => {
                    const userId = sourceText(form.sourceData?.adkAssigneeUserId);
                    return userId ? (memberNames.get(userId) ?? userId) : c.noAssignee;
                  })()}
                </strong>
              </span>
              <span>
                {c.priority}{' '}
                <strong className="ml-1 text-[var(--text-accent)]">
                  {sourceText(form.sourceData?.adkPriority) || '3'}
                </strong>
              </span>
            </div>
            <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
              <div className="min-h-[300px] p-6 lg:border-r lg:border-[var(--border)]">
                <label
                  className="mb-3 block border-b border-[var(--border)] pb-3 text-sm font-semibold"
                  htmlFor="pbi-description"
                >
                  <i
                    className="ti ti-align-left mr-2 text-[var(--text-accent)]"
                    aria-hidden="true"
                  />
                  {c.description}
                </label>
                <div
                  id="pbi-description"
                  ref={descriptionEditorRef}
                  role="textbox"
                  aria-label={c.description}
                  aria-multiline="true"
                  contentEditable={!isReadOnly}
                  suppressContentEditableWarning
                  onBlur={(event) =>
                    setForm({ ...form, description: sanitizeHtml(editorHtml(event.currentTarget)) })
                  }
                  onPaste={isReadOnly ? undefined : descriptionImages.onPaste}
                  onDrop={isReadOnly ? undefined : descriptionImages.onDrop}
                  dangerouslySetInnerHTML={{ __html: formatDescription(form.description ?? '') }}
                  className="min-h-[220px] max-w-none overflow-x-auto overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm leading-6 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-accent)] lg:min-h-[360px] [&_a]:text-[var(--text-accent)] [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-strong)] [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-[var(--surface-1)] [&_code]:px-1 [&_code]:font-mono [&_h1]:my-4 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:my-4 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:my-3 [&_h3]:font-semibold [&_h4]:my-3 [&_h4]:font-semibold [&_h5]:my-2 [&_h5]:font-semibold [&_h6]:my-2 [&_h6]:font-semibold [&_hr]:my-4 [&_hr]:border-[var(--border)] [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--surface-1)] [&_pre]:p-3 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--border)] [&_td]:p-2 [&_th]:border [&_th]:border-[var(--border)] [&_th]:p-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6"
                />
                <div className="mt-6 border-t border-[var(--border)] pt-4">
                  <AttachmentPanel
                    apiClient={apiClient}
                    scope="pbi"
                    attachments={form.attachments ?? []}
                    disabled={isReadOnly}
                    onChange={(attachments) => setForm({ ...form, attachments })}
                    onInsertInline={descriptionImages.insertAttachment}
                  />
                </div>
                {form.id && (
                  <section
                    className="mt-6 border-t border-[var(--border)] pt-4"
                    aria-label={c.comments}
                  >
                    <h3 className="mb-3 text-sm font-semibold">{c.comments}</h3>
                    {commentsLoading || (!commentsError && commentsForId !== form.id) ? (
                      <p role="status" className="text-sm text-[var(--text-muted)]">
                        {c.loadingComments}
                      </p>
                    ) : commentsError ? (
                      <div role="alert" className="flex items-center gap-2 text-sm text-red-300">
                        <span>{commentsError}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setCommentsRequest((value) => value + 1)}
                        >
                          {t('common.retry')}
                        </Button>
                      </div>
                    ) : comments.length === 0 ? (
                      <p className="text-sm text-[var(--text-muted)]">{c.noComments}</p>
                    ) : (
                      <div className="space-y-3">
                        {comments.map((comment) => (
                          <article
                            key={comment.id}
                            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3"
                          >
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                              <strong className="text-[var(--text-primary)]">
                                {comment.author}
                              </strong>
                              <time dateTime={comment.createdAt}>
                                {new Date(comment.createdAt).toLocaleString(locale)}
                              </time>
                            </div>
                            <div
                              className="break-words text-sm leading-6 [&_a]:text-[var(--text-accent)] [&_a]:underline [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5"
                              dangerouslySetInnerHTML={{ __html: formatDescription(comment.body) }}
                            />
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                )}
              </div>
              <aside className="space-y-5 p-6">
                <label className="block text-xs font-semibold">
                  {c.state}
                  <Select
                    disabled={isReadOnly}
                    value={form.status ?? 'backlog'}
                    onChange={(event) => setForm({ ...form, status: event.target.value })}
                    containerClassName="mt-2"
                  >
                    {[
                      ...new Set([
                        'backlog',
                        'New',
                        'Active',
                        'Done',
                        'Removed',
                        form.status ?? '',
                      ]),
                    ]
                      .filter(Boolean)
                      .map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                  </Select>
                </label>
                {canViewAgents && (
                  <label className="block text-xs font-semibold">
                    {c.assignedAgent}
                    <Select
                      disabled={isReadOnly}
                      value={sourceText(form.sourceData?.adkAgentId)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          sourceData: { ...form.sourceData, adkAgentId: event.target.value },
                        })
                      }
                      containerClassName="mt-2"
                    >
                      <option value="">{c.unassigned}</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                {agentError && (
                  <p role="alert" className="text-xs text-red-300">
                    {agentError}
                  </p>
                )}
                <label className="block text-xs font-semibold">
                  {c.assignee}
                  <Select
                    disabled={isReadOnly}
                    value={sourceText(form.sourceData?.adkAssigneeUserId)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        sourceData: { ...form.sourceData, adkAssigneeUserId: event.target.value },
                      })
                    }
                    containerClassName="mt-2"
                  >
                    <option value="">{c.noAssignee}</option>
                    {sortedMembers.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {memberLabel(member)}
                      </option>
                    ))}
                    {(() => {
                      // Keep a former member selectable so saving does not silently unassign.
                      const userId = sourceText(form.sourceData?.adkAssigneeUserId);
                      return userId && !memberNames.has(userId) ? (
                        <option value={userId}>{userId}</option>
                      ) : null;
                    })()}
                  </Select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-semibold">
                    {c.priority}
                    <Select
                      disabled={isReadOnly}
                      value={sourceText(form.sourceData?.adkPriority) || '3'}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          sourceData: { ...form.sourceData, adkPriority: event.target.value },
                        })
                      }
                      containerClassName="mt-2"
                    >
                      {['1', '2', '3', '4'].map((priority) => (
                        <option key={priority} value={priority}>
                          {priority}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="block text-xs font-semibold">
                    {c.cardType}
                    <Select
                      disabled={isReadOnly}
                      value={
                        sourceText(form.sourceData?.adkCardType) ||
                        sourceText(form.sourceData?.type)
                      }
                      onChange={(event) =>
                        setForm({
                          ...form,
                          sourceData: { ...form.sourceData, adkCardType: event.target.value },
                        })
                      }
                      containerClassName="mt-2"
                    >
                      <option value="">{c.noType}</option>
                      {[
                        ...new Set([
                          'Task',
                          'Bug',
                          'Product Backlog Item',
                          'User Story',
                          'Feature',
                          sourceText(form.sourceData?.type),
                          sourceText(form.sourceData?.adkCardType),
                        ]),
                      ]
                        .filter(Boolean)
                        .map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                    </Select>
                  </label>
                </div>
                {form.kind === 'card' && (
                  <label className="block text-xs font-semibold">
                    {c.parent}
                    <Select
                      required
                      disabled={isReadOnly}
                      value={form.parentId ?? ''}
                      onChange={(event) =>
                        setForm({ ...form, parentId: event.target.value || null })
                      }
                      containerClassName="mt-2"
                    >
                      <option value="">{c.selectParent}</option>
                      {items
                        .filter((item) => canBeParent(item, form.id))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                    </Select>
                  </label>
                )}
                {form.id && (
                  <section className="border-t border-[var(--border)] pt-4" aria-label={c.cards}>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">{c.cards}</h3>
                      {!isReadOnly && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setForm({ ...emptyForm, kind: 'card', parentId: form.id })}
                        >
                          <i className="ti ti-square-rounded-plus" aria-hidden="true" />
                          {c.addCard}
                        </Button>
                      )}
                    </div>
                    <div className="space-y-1">
                      {(children.get(form.id) ?? []).map((child) => (
                        <Button
                          key={child.id}
                          type="button"
                          variant="ghost"
                          className="flex h-auto w-full min-w-0 justify-start gap-2 whitespace-normal text-left"
                          onClick={() => editItem(child)}
                        >
                          <i className="ti ti-file-description shrink-0" aria-hidden="true" />
                          <span className="min-w-0 break-words">{child.title}</span>
                        </Button>
                      ))}
                      {syncingChildrenId === form.id && (
                        <p role="status" className="text-xs text-[var(--text-muted)]">
                          {c.syncingCards}
                        </p>
                      )}
                      {childrenError &&
                        syncingChildrenId !== form.id &&
                        !children.get(form.id)?.length && (
                          <p role="alert" className="text-xs text-red-300">
                            {childrenError}
                          </p>
                        )}
                      {!children.get(form.id)?.length &&
                        syncingChildrenId !== form.id &&
                        !childrenError && (
                          <p className="text-xs text-[var(--text-muted)]">{c.noCards}</p>
                        )}
                    </div>
                  </section>
                )}
                {form.id &&
                  (() => {
                    const current = items.find((entry) => entry.id === form.id);
                    return current ? (
                      <PbiLinks
                        apiClient={apiClient}
                        item={current}
                        items={visibleItems}
                        isReadOnly={isReadOnly}
                        onOpenItem={openItem}
                        onChanged={load}
                      />
                    ) : null;
                  })()}
              </aside>
            </div>
          </form>
        )}
      </Modal>
      <PbiPushDialog
        apiClient={apiClient}
        item={pushItem}
        providers={providers}
        busy={pushItem ? pushingIds.has(pushItem.id) : false}
        onClose={() => setPushItem(null)}
        onSubmit={push}
      />
      <Modal
        open={filterNameDraft !== null}
        onClose={() => setFilterNameDraft(null)}
        labelledBy="pbi-save-filter-title"
      >
        {filterNameDraft !== null && (
          <form
            onSubmit={saveCurrentFilter}
            className="w-[min(90vw,420px)] space-y-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6"
          >
            <h2 id="pbi-save-filter-title" className="text-lg font-semibold">
              {c.saveFilterTitle}
            </h2>
            <label className="block text-sm">
              {c.filterName}
              <Input
                autoFocus
                required
                maxLength={80}
                value={filterNameDraft}
                onChange={(event) => setFilterNameDraft(event.target.value)}
                className="mt-2"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setFilterNameDraft(null)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!filterNameDraft.trim()}>
                {c.saveFilter}
              </Button>
            </div>
          </form>
        )}
      </Modal>
      {canDelete && deleteItem && (
        <ConfirmationDialog
          open
          title={c.deleteTitle}
          description={c.deleteDescription.replace('{title}', deleteItem.title)}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          destructive
          isLoading={busy}
          onCancel={() => setDeleteItem(null)}
          onConfirm={() => {
            void runAction(async () => {
              await apiClient.deletePbiItem(deleteItem.id);
              setDeleteItem(null);
              await load();
            });
          }}
        />
      )}
    </main>
  );
}
