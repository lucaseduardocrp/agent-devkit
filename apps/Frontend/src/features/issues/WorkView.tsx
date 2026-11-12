import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useKanbanDraft } from '../../lib/use-kanban-draft.js';
import type { ApiClient } from '../../lib/api-client.js';
import { formatMessage, useI18n } from '../../lib/i18n/index.js';
import type { I18nDictionary } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Pagination, PagingSentinel, usePaging } from '../../components/ui/pagination.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Modal } from '../../components/ui/modal.js';
import { UnsavedChangesDialog } from '../../components/ui/unsaved-changes-dialog.js';
import { Skeleton, SkeletonCard, SkeletonText } from '../../components/ui/skeleton.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import type { PbiItem } from '../pbi/pbi-types.js';
import type { WorkspaceMember } from '../workspaces/workspace-types.js';
import { AgentBriefTab } from './AgentBriefTab.js';
import type { BriefReference } from './agent-brief-types.js';
import type { ReferenceFocus } from '../shared/reference-focus.js';
import { HistoryViewer } from '../audit/HistoryViewer.js';
import { usePermissions } from '../workspaces/permissions.js';
import {
  KanbanCardPending,
  KanbanCardSaving,
  KanbanDraftBar,
  KanbanDropPlaceholder,
  kanbanCardStateClass,
  kanbanColumnClass,
} from '../../components/ui/kanban.js';
import {
  WorkItemTypeBadge,
  resolveWorkItemType,
  useWorkItemTypes,
  resolveTypePalette,
} from '../work-item-types/work-item-types.js';
import { AttachmentPanel } from '../shared/AttachmentPanel.js';
import type { ImageAttachment } from '../shared/image-attachment-types.js';
import {
  ImageInputStatus,
  discardDrafts,
  isSafeImageSource,
  markdownImage,
  useInlineImages,
  useMarkdownImageInput,
  saveWithDrafts,
} from '../shared/media.js';
import type {
  AgentRun,
  DashboardSummary,
  InboxItem,
  Issue,
  IssueChanges,
  IssueComment,
  IssuePriority,
  IssueStatus,
  McpUsageSummary,
} from './issue-types.js';

type WorkTab = 'dashboard' | 'inbox' | 'issues';
type InboxTab = 'mine' | 'recent' | 'unread' | 'blocked' | 'all';

const statusOrder: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];
const priorityOrder: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];
const activeRunStatuses: AgentRun['status'][] = [
  'queued',
  'running',
  'waiting_review',
  'waiting_input',
];

function formatIssueDescription(value: string): string {
  if (typeof DOMParser === 'undefined') return value.replace(/<[^>]*>/g, ' ');
  const parser = new DOMParser();
  let parsed = parser.parseFromString(value, 'text/html');
  // Some imported work items contain HTML that was escaped before being stored.
  if (!/<\/?[a-z][^>]*>/i.test(value) && /<\/?[a-z][^>]*>/i.test(parsed.body.textContent))
    parsed = parser.parseFromString(parsed.body.textContent, 'text/html');
  for (const element of [...parsed.body.querySelectorAll<HTMLElement>('*')]) {
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'].includes(element.tagName)) {
      element.remove();
      continue;
    }
    if (
      !/^(A|B|BLOCKQUOTE|BR|CODE|DIV|EM|H[1-6]|HR|I|IMG|LI|OL|P|PRE|S|SPAN|STRONG|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|U|UL)$/.test(
        element.tagName,
      )
    ) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (
        element.tagName === 'A' &&
        attribute.name === 'href' &&
        /^(https?:|mailto:|tel:|\/|#|\.\.?\/)/i.test(attribute.value.trim())
      )
        continue;
      if (element.tagName === 'IMG' && ['alt', 'title'].includes(attribute.name)) continue;
      // Invalid image sources are removed below.
      if (
        element.tagName === 'IMG' &&
        attribute.name === 'src' &&
        isSafeImageSource(attribute.value)
      )
        continue;
      element.removeAttribute(attribute.name);
    }
  }
  return parsed.body.innerHTML;
}

interface IssueForm {
  title: string;
  description: string;
  attachments: readonly ImageAttachment[];
  status: IssueStatus;
  priority: IssuePriority;
  type: string;
  assigneeAgentId: string;
  assigneeUserId: string;
}

const emptyIssueForm: IssueForm = {
  title: '',
  description: '',
  attachments: [],
  status: 'todo',
  priority: 'medium',
  type: '',
  assigneeAgentId: '',
  assigneeUserId: '',
};

function isHtmlDescription(value: string): boolean {
  return /<\/?(?:a|b|blockquote|br|code|div|em|h[1-6]|hr|i|img|li|ol|p|pre|span|strong|table|td|th|tr|u|ul)\b[^>]*>/i.test(
    value.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'),
  );
}
function memberLabel(member: WorkspaceMember): string {
  return member.user?.name || member.user?.email || member.userId;
}

const sourceText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

interface IssueFilters {
  query: string;
  /** Empty means any status. */
  status: string;
  /** User id, 'none' for unassigned, or empty for anyone. */
  assignee: string;
  /** Agent id, 'none' for no agent, or empty for any agent. */
  agent: string;
  priority: string;
  iteration: string;
}
interface SavedIssueFilter extends IssueFilters {
  id: string;
  name: string;
}
const emptyFilters: IssueFilters = {
  query: '',
  status: '',
  assignee: '',
  agent: '',
  priority: '',
  iteration: '',
};
const filterKeys = Object.keys(emptyFilters) as (keyof IssueFilters)[];
const savedFiltersKey = (workspaceId: string | null) =>
  `adk:issue-saved-filters:${workspaceId ?? 'default'}`;
const issuesViewKey = (workspaceId: string | null) => `adk:issues-view:${workspaceId ?? 'default'}`;
function readIssuesView(workspaceId: string | null): 'list' | 'board' {
  try {
    return localStorage.getItem(issuesViewKey(workspaceId)) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}
function readSavedFilters(workspaceId: string | null): SavedIssueFilter[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(savedFiltersKey(workspaceId)) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (entry: unknown): entry is SavedIssueFilter =>
        !!entry &&
        typeof entry === 'object' &&
        ['id', 'name', ...filterKeys].every(
          (key) => typeof (entry as Record<string, unknown>)[key] === 'string',
        ),
    );
  } catch {
    // Storage can be unavailable in private browsing.
    return [];
  }
}

/** When an inbox item last changed: its newest run, or the issue itself when that is later. */
function lastActivity(item: InboxItem): string {
  const run = item.runs[0]?.createdAt;
  return run && run > item.issue.updatedAt ? run : item.issue.updatedAt;
}

function relativeDate(value: string, locale: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days === 0)
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(time);
  if (days < 7)
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(time);
}

function money(micros: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(
    micros / 1_000_000,
  );
}

const panel = 'rounded-lg border border-[var(--border)] bg-[var(--surface-1)]';

export interface WorkViewProps {
  apiClient: ApiClient;
  workspaceId: string | null;
  tab: WorkTab;
  currentUserId: string;
  isReadOnly?: boolean;
  canManageCosts?: boolean;
  newIssueRequest?: number;
  onNewIssueHandled?: () => void;
  onInboxCountChange?: (count: number) => void;
  onOpenIssues?: () => void;
  /** Goes to the module of a reference the agent reads first (Brain, PBIs, Specs...). */
  onOpenReference?: (reference: BriefReference) => void;
  /** An item another module sent the user to; opened once its data is there. */
  readonly focus?: ReferenceFocus | null;
  readonly onFocusHandled?: () => void;
}

export function WorkView({
  apiClient,
  workspaceId,
  tab,
  currentUserId,
  isReadOnly = false,
  canManageCosts = false,
  newIssueRequest = 0,
  onNewIssueHandled,
  onInboxCountChange,
  onOpenIssues,
  onOpenReference,
  focus,
  onFocusHandled,
}: WorkViewProps) {
  const { locale, messages } = useI18n();
  const t = messages.issues;
  const workItemTypes = useWorkItemTypes(apiClient, workspaceId);
  const permissions = usePermissions();
  const canDelete = !isReadOnly && permissions.can('issues', 'delete');
  const [rawIssues, setIssues] = useState<readonly Issue[]>([]);
  const [inbox, setInbox] = useState<readonly InboxItem[]>([]);
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'details' | 'agent'>('details');
  const [selectedComments, setSelectedComments] = useState<readonly IssueComment[]>([]);
  const [selectedRuns, setSelectedRuns] = useState<readonly AgentRun[]>([]);
  const [workflowAnswerDraft, setWorkflowAnswerDraft] = useState('');
  const [selectedDetailsLoading, setSelectedDetailsLoading] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('0');
  const [rateDraft, setRateDraft] = useState({
    provider: '',
    model: '',
    inputUsdPerMillion: '',
    outputUsdPerMillion: '',
  });
  const [commentText, setCommentText] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailDraft, setDetailDraft] = useState<{
    title: string;
    description: string;
    attachments: readonly ImageAttachment[];
  }>({ title: '', description: '', attachments: [] });
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Omit<IssueFilters, 'query'>>(emptyFilters);
  const [savedFilters, setSavedFilters] = useState<SavedIssueFilter[]>(() =>
    readSavedFilters(workspaceId),
  );
  const [filterNameDraft, setFilterNameDraft] = useState<string | null>(null);
  const [pbiItems, setPbiItems] = useState<readonly PbiItem[]>([]);
  const canViewPbis = permissions.can('pbis');
  const [issuesView, setIssuesView] = useState<'list' | 'board'>(() => readIssuesView(workspaceId));
  // The choice is remembered per workspace in this browser.
  const chooseIssuesView = (view: 'list' | 'board') => {
    setIssuesView(view);
    try {
      localStorage.setItem(issuesViewKey(workspaceId), view);
    } catch {
      // Storage can be unavailable in private browsing.
    }
  };
  useEffect(() => {
    setIssuesView(readIssuesView(workspaceId));
  }, [workspaceId]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<IssueStatus | null>(null);
  const [inboxTab, setInboxTab] = useState<InboxTab>('mine');
  const [form, setForm] = useState<IssueForm>(emptyIssueForm);
  const formImages = useMarkdownImageInput('issue', (description) =>
    setForm((current) => ({ ...current, description })),
  );
  const detailImages = useMarkdownImageInput('issue', (description) =>
    setDetailDraft((current) => ({ ...current, description })),
  );
  const appendImage = (description: string, attachment: ImageAttachment) =>
    `${description.trimEnd()}${description.trim() ? '\n\n' : ''}${markdownImage(attachment)}\n`;

  const loadedFor = useRef<string | null>(null);
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!workspaceId) {
        setLoading(false);
        return;
      }
      // Later refreshes keep the screen as it is; only the first load shows skeletons.
      setLoading(loadedFor.current !== workspaceId);
      setError(null);
      try {
        const [issueList, inboxList, summary] = await Promise.all([
          apiClient.getIssues(signal),
          apiClient.getInbox(signal),
          apiClient.getDashboard(signal),
        ]);
        if (signal?.aborted) return;
        loadedFor.current = workspaceId;
        setIssues(issueList);
        setInbox(inboxList);
        setDashboard(summary);
        setAgents(summary.agents);
        setBudgetDraft(String((summary.costs?.monthlyBudgetMicros ?? 0) / 1_000_000));
      } catch (reason) {
        if (!signal?.aborted) setError(reason instanceof Error ? reason.message : t.loadError);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [apiClient, workspaceId, t.loadError],
  );

  // Moves made on the board are a draft: they are sent in one batch after a pause, kept in the
  // browser meanwhile, and sent again if the tab is hidden, closed or the connection drops.
  const kanbanDraft = useKanbanDraft({
    storageKey: workspaceId ? `adk:kanban-draft:issues:${workspaceId}` : null,
    save: async (id, to) => {
      const saved = await apiClient.updateIssue(id, { status: to as IssueStatus });
      setIssues((list) => list.map((issue) => (issue.id === saved.id ? saved : issue)));
    },
    onSaved: () => void reload(),
  });
  /** The server list with the draft applied; moved cards sit on top of their new column. */
  const issues = useMemo<readonly Issue[]>(() => {
    const moved = Object.keys(kanbanDraft.draft);
    if (!moved.length) return rawIssues;
    const byId = new Map(rawIssues.map((issue) => [issue.id, issue]));
    const head = moved.reverse().flatMap((id) => {
      const issue = byId.get(id);
      return issue ? [{ ...issue, status: kanbanDraft.draft[id]!.to as IssueStatus }] : [];
    });
    return [...head, ...rawIssues.filter((issue) => !(issue.id in kanbanDraft.draft))];
  }, [rawIssues, kanbanDraft.draft]);

  useEffect(() => {
    setMembers([]);
    if (!workspaceId) return;
    let active = true;
    void Promise.resolve()
      .then(() => apiClient.getWorkspaceMembers(workspaceId))
      .then(
        (list) => {
          if (active) setMembers(list);
        },
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [apiClient, workspaceId]);

  useEffect(() => setSavedFilters(readSavedFilters(workspaceId)), [workspaceId]);

  // The iteration path lives on the PBI an issue was created from.
  useEffect(() => {
    setPbiItems([]);
    if (!workspaceId || !canViewPbis || tab !== 'issues') return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => apiClient.getPbiItems(controller.signal))
      .then(
        (items) => {
          if (!controller.signal.aborted) setPbiItems(items);
        },
        () => undefined,
      );
    return () => controller.abort();
  }, [apiClient, workspaceId, canViewPbis, tab]);

  useEffect(() => {
    onInboxCountChange?.(inbox.filter((item) => !item.readAt && !item.archivedAt).length);
  }, [inbox, onInboxCountChange]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const timer = window.setInterval(() => {
      void reload();
      void apiClient
        .getIssue(selectedId)
        .then((detail) => {
          if (active) setSelectedComments(detail.comments);
        })
        .catch(() => undefined);
      if (apiClient.getAgentRuns)
        void apiClient
          .getAgentRuns(selectedId)
          .then((runs) => {
            if (active) setSelectedRuns(runs);
          })
          .catch(() => undefined);
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [apiClient, reload, selectedId]);

  useEffect(() => {
    if (newIssueRequest > 0) {
      setComposerOpen(true);
      onNewIssueHandled?.();
    }
  }, [newIssueRequest, onNewIssueHandled]);

  const selectedIssue = issues.find((issue) => issue.id === selectedId) ?? null;
  // Changes to the card's fields stay in this draft until the user saves: nothing is sent to the
  // server per interaction.
  const [sidebarDraft, setSidebarDraft] = useState<IssueChanges>({});
  const [confirmClose, setConfirmClose] = useState(false);
  /** The issue as it will be once saved: the stored one with the draft applied. */
  const issueView = { ...selectedIssue, ...sidebarDraft } as Issue;
  const detailsDirty =
    !!selectedIssue &&
    editingDetails &&
    (detailDraft.title !== selectedIssue.title ||
      detailDraft.description !== selectedIssue.description ||
      JSON.stringify(detailDraft.attachments) !== JSON.stringify(selectedIssue.attachments ?? []));
  const hasUnsaved = Object.keys(sidebarDraft).length > 0 || detailsDirty;
  const issueDescriptionRef = useRef<HTMLDivElement>(null);
  useInlineImages(issueDescriptionRef, selectedIssue?.description);
  const selectedInbox = inbox.find((item) => item.issue.id === selectedId);

  // Another module sent the user to an issue: open it as if it had been clicked in the list.
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focus || focus.kind !== 'issue' || handledFocus.current === focus.nonce) return;
    const issue = issues.find((candidate) => candidate.id === focus.ref);
    if (!issue) return;
    handledFocus.current = focus.nonce;
    void openIssue(issue);
    onFocusHandled?.();
  }, [focus, issues, onFocusHandled]); // eslint-disable-line react-hooks/exhaustive-deps

  const openIssue = async (issue: Issue) => {
    setDetailTab('details');
    setSelectedId(issue.id);
    setSelectedComments([]);
    setCommentText('');
    setCommentError(null);
    setSelectedRuns([]);
    setSelectedDetailsLoading(true);
    discardDrafts(detailDraft);
    setEditingDetails(false);
    setSidebarDraft({});
    setConfirmClose(false);
    setDetailDraft({
      title: issue.title,
      description: issue.description,
      attachments: issue.attachments ?? [],
    });
    setError(null);
    try {
      const [detail, runs] = await Promise.all([
        apiClient.getIssue(issue.id),
        apiClient.getAgentRuns ? apiClient.getAgentRuns(issue.id) : Promise.resolve([]),
      ]);
      setSelectedComments(detail.comments);
      setSelectedRuns(runs);
      if (!inbox.find((item) => item.issue.id === issue.id)?.readAt) {
        await apiClient.updateInboxItem(issue.id, { read: true });
        setInbox((items) =>
          items.map((item) =>
            item.issue.id === issue.id ? { ...item, readAt: new Date().toISOString() } : item,
          ),
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.loadError);
    } finally {
      setSelectedDetailsLoading(false);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.saveError);
    } finally {
      setBusy(false);
    }
  };

  /** Cancelling the composer drops what was typed, pasted and attached. */
  const closeComposer = () => {
    discardDrafts(form);
    setForm(emptyIssueForm);
    setComposerOpen(false);
  };
  const cancelDetailEdit = () => {
    discardDrafts(detailDraft);
    setEditingDetails(false);
  };

  const createIssue = async (event: FormEvent) => {
    event.preventDefault();
    await runAction(async () => {
      // Pasted and attached files are drafts until this save uploads them.
      const issue = await saveWithDrafts(
        apiClient,
        'issue',
        { description: form.description, attachments: form.attachments },
        (files) =>
          apiClient.createIssue({
            title: form.title.trim(),
            ...files,
            status: form.status,
            priority: form.priority,
            type: form.type,
            assigneeAgentId: form.assigneeAgentId || null,
            assigneeUserId: form.assigneeUserId || null,
          }),
      );
      setComposerOpen(false);
      setForm(emptyIssueForm);
      setDetailTab('details');
      setSelectedId(issue.id);
      setSelectedComments([]);
      onOpenIssues?.();
    });
  };

  /** Records a field change in the draft; going back to the stored value removes it. */
  const updateIssue = (changes: IssueChanges) => {
    setSidebarDraft((current) => {
      const next: Record<string, unknown> = { ...current, ...changes };
      for (const [key, value] of Object.entries(changes))
        if (((selectedIssue! as unknown as Record<string, unknown>)[key] ?? '') === (value ?? ''))
          delete next[key];
      return next;
    });
  };

  /** Sends every pending change of the open card (fields and details) in one request. */
  const saveIssue = async (): Promise<boolean> => {
    if (!selectedIssue || !hasUnsaved) return true;
    if (detailsDirty && !detailDraft.title.trim()) return false;
    setBusy(true);
    setError(null);
    try {
      if (detailsDirty)
        await saveWithDrafts(
          apiClient,
          'issue',
          { description: detailDraft.description, attachments: detailDraft.attachments },
          (files) =>
            apiClient.updateIssue(selectedIssue.id, {
              ...sidebarDraft,
              title: detailDraft.title.trim(),
              ...files,
            }),
        );
      else await apiClient.updateIssue(selectedIssue.id, sidebarDraft);
      setEditingDetails(false);
      setSidebarDraft({});
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.saveError);
      return false;
    } finally {
      setBusy(false);
    }
    return true;
  };

  const closeDetail = () => {
    cancelDetailEdit();
    setSidebarDraft({});
    setConfirmClose(false);
    setSelectedId(null);
  };
  /** Closing with unsaved changes asks what to do with them first. */
  const requestCloseDetail = () => {
    if (hasUnsaved) setConfirmClose(true);
    else closeDetail();
  };

  const agentOptions = agents.map((agent) => (
    <option key={agent.id} value={agent.id}>
      {agent.name}
    </option>
  ));
  const memberOptions = members.map((member) => (
    <option key={member.userId} value={member.userId}>
      {memberLabel(member)}
    </option>
  ));

  const changeInbox = (issueId: string, changes: { read?: boolean; archived?: boolean }) => {
    void runAction(async () => {
      await apiClient.updateInboxItem(issueId, changes);
    });
  };

  /** Iteration of each PBI item, inherited from the nearest ancestor that has one. */
  const pbiIterations = useMemo(() => {
    const byId = new Map(pbiItems.map((item) => [item.id, item]));
    const paths = new Map<string, string>();
    const resolve = (id: string, seen: Set<string>): string => {
      const cached = paths.get(id);
      if (cached !== undefined) return cached;
      const item = byId.get(id);
      if (!item || seen.has(id)) return '';
      seen.add(id);
      const own =
        sourceText(item.sourceData.iterationPath) ||
        (item.parentId ? resolve(item.parentId, seen) : '');
      paths.set(id, own);
      return own;
    };
    for (const item of pbiItems) resolve(item.id, new Set());
    return paths;
  }, [pbiItems]);
  const iterations = useMemo(() => {
    const values = new Set<string>();
    for (const issue of issues) {
      const iteration = issue.pbiItemId && pbiIterations.get(issue.pbiItemId);
      if (iteration) values.add(iteration);
    }
    return [...values].sort((a, b) => a.localeCompare(b, locale));
  }, [issues, pbiIterations, locale]);

  const currentFilters: IssueFilters = { query: search, ...filters };
  const hasFilters = filterKeys.some((key) => currentFilters[key].trim());
  const activeFilterCount = filterKeys.filter((key) => currentFilters[key].trim()).length;
  const activeSavedFilter = savedFilters.find((saved) =>
    filterKeys.every((key) => saved[key] === currentFilters[key]),
  );
  const setFilter = (key: keyof Omit<IssueFilters, 'query'>, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const persistSavedFilters = (next: SavedIssueFilter[]) => {
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
    setSearch(saved.query);
    setFilters({
      status: saved.status,
      assignee: saved.assignee,
      agent: saved.agent,
      priority: saved.priority,
      iteration: saved.iteration,
    });
  };
  const clearFilters = () => {
    setSearch('');
    setFilters(emptyFilters);
  };
  const saveCurrentFilter = (event: FormEvent) => {
    event.preventDefault();
    const name = filterNameDraft?.trim();
    if (!name) return;
    const existing = savedFilters.find(
      (entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    const entry: SavedIssueFilter = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      ...currentFilters,
    };
    persistSavedFilters(
      [...savedFilters.filter((saved) => saved.id !== entry.id), entry].sort((a, b) =>
        a.name.localeCompare(b.name, locale),
      ),
    );
    setFilterNameDraft(null);
  };

  const filteredIssues = useMemo(
    () =>
      issues.filter((issue) => {
        const matchesSearch = `${issue.number} ${issue.title} ${issue.description}`
          .toLocaleLowerCase(locale)
          .includes(search.toLocaleLowerCase(locale));
        const iteration = (issue.pbiItemId && pbiIterations.get(issue.pbiItemId)) || '';
        const matchesId = (filter: string, value: string | null) =>
          !filter || (filter === 'none' ? !value : value === filter);
        return (
          matchesSearch &&
          (!filters.status || issue.status === filters.status) &&
          (!filters.priority || issue.priority === filters.priority) &&
          matchesId(filters.assignee, issue.assigneeUserId) &&
          matchesId(filters.agent, issue.assigneeAgentId) &&
          (!filters.iteration || iteration === filters.iteration)
        );
      }),
    [issues, search, filters, pbiIterations, locale],
  );

  const filteredInbox = useMemo(
    () =>
      inbox
        .filter((item) => {
          if (item.archivedAt && inboxTab !== 'all') return false;
          if (inboxTab === 'unread') return !item.readAt;
          if (inboxTab === 'blocked') return item.issue.status === 'blocked';
          if (inboxTab === 'recent')
            return new Date(lastActivity(item)).getTime() >= Date.now() - 14 * 86400000;
          return true;
        })
        .filter((item) =>
          `${item.issue.number} ${item.issue.title}`
            .toLocaleLowerCase(locale)
            .includes(search.toLocaleLowerCase(locale)),
        ),
    [inbox, inboxTab, search, locale],
  );

  const issuesPaging = usePaging(filteredIssues.length, {
    storageKey: `adk:issues-paging:${workspaceId ?? 'default'}`,
    resetKey: JSON.stringify([search, filters]),
  });
  const inboxPaging = usePaging(filteredInbox.length, {
    storageKey: `adk:inbox-paging:${workspaceId ?? 'default'}`,
    resetKey: JSON.stringify([search, inboxTab]),
  });
  const listPaging = tab === 'issues' ? issuesPaging : inboxPaging;

  const issueRow = (issue: Issue, item?: InboxItem) => (
    <div
      key={issue.id}
      className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 last:border-b-0 hover:bg-[var(--fill-ghost-hover)]"
    >
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-w-0 flex-1 justify-start px-0 py-1 text-left font-normal"
        onClick={() => void openIssue(issue)}
        aria-label={`${issue.number} ${issue.title}`}
      >
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            issue.status === 'done'
              ? 'bg-emerald-500'
              : issue.status === 'blocked'
                ? 'bg-red-500'
                : issue.status === 'in_progress'
                  ? 'bg-blue-500'
                  : 'bg-neutral-500',
          )}
        />
        <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">#{issue.number}</span>
        {issue.type && <WorkItemTypeBadge name={issue.type} types={workItemTypes} />}
        <span
          className={cn(
            'truncate',
            item && !item.readAt && 'font-semibold text-[var(--text-primary)]',
          )}
        >
          {issue.title}
        </span>
      </Button>
      {item?.runs[0] && (
        <span
          className="hidden shrink-0 text-xs text-[var(--text-secondary)] sm:inline"
          data-testid={`inbox-runs-${issue.id}`}
        >
          {item.runs.length === 1
            ? t.runCountOne
            : formatMessage(t.runCountOther, { count: item.runs.length })}{' '}
          · {t.runStatus[item.runs[0].status]}
        </span>
      )}
      <span className="hidden rounded bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-secondary)] sm:inline">
        {t.statusNames[issue.status]}
      </span>
      <span className="hidden w-16 text-right text-xs text-[var(--text-muted)] md:inline">
        {relativeDate(item ? lastActivity(item) : issue.updatedAt, locale)}
      </span>
      {item && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => changeInbox(issue.id, { archived: !item.archivedAt })}
          disabled={busy}
          aria-label={item.archivedAt ? t.restore : t.archive}
          title={item.archivedAt ? t.restore : t.archive}
        >
          <i
            className={item.archivedAt ? 'ti ti-rotate-clockwise' : 'ti ti-archive'}
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );

  return (
    <div className="w-full space-y-5" data-testid={`work-${tab}`}>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          <span>{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void reload()}>
            {t.retry}
          </Button>
        </div>
      )}
      {loading && tab === 'dashboard' && !dashboard ? (
        <div className="grid gap-4 md:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : null}
      {tab === 'dashboard' && dashboard && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t.agents}
            </h3>
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => void reload()}
              aria-label={t.refresh}
            >
              <i className="ti ti-refresh" aria-hidden="true" />
              {t.refresh}
            </Button>
          </div>
          <section aria-label={t.agents}>
            {agents.length === 0 ? (
              <p className={cn(panel, 'p-5 text-sm text-[var(--text-muted)]')}>{t.noAgents}</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {agents.map((agent) => {
                  const active = issues.find(
                    (issue) => issue.assigneeAgentId === agent.id && issue.status === 'in_progress',
                  );
                  const agentCost = dashboard.costs?.byAgent?.[agent.id];
                  return (
                    <article
                      key={agent.id}
                      className="min-h-[180px] min-w-0 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-4"
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span
                          className={cn(
                            'h-2.5 w-2.5 rounded-full',
                            active ? 'bg-cyan-400' : 'bg-neutral-500',
                          )}
                        />
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs">
                          {agent.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0 truncate">{agent.name}</span>
                      </div>
                      <p className="mt-2 text-xs text-[var(--text-muted)]">
                        {active ? t.liveIssue : t.noAssignedIssue}
                      </p>
                      {active && (
                        <Button
                          type="button"
                          variant="ghost"
                          className="mt-2 h-auto min-w-0 w-full justify-start whitespace-normal break-words [overflow-wrap:anywhere] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left text-xs font-normal"
                          onClick={() => void openIssue(active)}
                        >
                          #{active.number} · {active.title}
                        </Button>
                      )}
                      <p className="mt-3 line-clamp-3 text-xs text-[var(--text-secondary)]">
                        {agent.description}
                      </p>
                      {agentCost && (
                        <p className="mt-2 text-xs text-[var(--text-muted)]">
                          {t.monthSpend}: {money(agentCost.spendMicros, locale)}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              [agents.length, t.agentsEnabled, 'ti-robot'],
              [dashboard.activeRuns ?? dashboard.inProgress, t.tasksInProgress, 'ti-progress'],
              [dashboard.open, t.openTasks, 'ti-circle-dotted'],
              [
                money(dashboard.costs?.monthSpendMicros ?? 0, locale),
                t.monthSpend,
                'ti-currency-dollar',
              ],
            ].map(([value, label, icon]) => (
              <div key={String(label)} className={cn(panel, 'p-5')}>
                <div className="flex justify-between">
                  <strong className="text-3xl font-semibold">{value}</strong>
                  <i className={`ti ${icon} text-[var(--text-muted)]`} aria-hidden="true" />
                </div>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">{label}</p>
                {label === t.monthSpend && (
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {t.totalTokens}:{' '}
                    {new Intl.NumberFormat(locale).format(dashboard.costs?.totalTokens ?? 0)}
                  </p>
                )}
              </div>
            ))}
          </div>
          {dashboard.costs && (
            <section className={cn(panel, 'space-y-4 p-5')} aria-label={t.costRates}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    {t.monthSpend}: {money(dashboard.costs.monthSpendMicros, locale)}
                  </h3>
                  <p className="text-xs text-[var(--text-muted)]">
                    {dashboard.costs.unpricedRuns} {t.unpricedRuns}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {t.tokenBreakdown}:{' '}
                    {new Intl.NumberFormat(locale).format(dashboard.costs.totalInputTokens ?? 0)} /{' '}
                    {new Intl.NumberFormat(locale).format(dashboard.costs.totalOutputTokens ?? 0)}
                  </p>
                </div>
                {canManageCosts && (
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runAction(async () => {
                        await apiClient.setMonthlyBudget(
                          Math.round(Number(budgetDraft) * 1_000_000),
                        );
                      });
                    }}
                  >
                    <label className="space-y-1 text-xs">
                      <span>{t.monthlyBudget}</span>
                      <Input
                        type="number"
                        min="0"
                        max="2147"
                        step="0.01"
                        value={budgetDraft}
                        onChange={(event) => setBudgetDraft(event.target.value)}
                      />
                    </label>
                    <Button type="submit" disabled={busy || !Number.isFinite(Number(budgetDraft))}>
                      {t.save}
                    </Button>
                  </form>
                )}
              </div>
              <h3 className="text-sm font-semibold">{t.costRates}</h3>
              <div className="flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
                {dashboard.costs.rates.map((rate) => (
                  <div
                    key={`${rate.provider}:${rate.model}`}
                    className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1"
                  >
                    <span>
                      {rate.provider} / {rate.model}: ${rate.inputUsdPerMillion} {t.inputRate}, $
                      {rate.outputUsdPerMillion} {t.outputRate}
                    </span>
                    {canManageCosts && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`${t.delete} ${rate.provider} ${rate.model}`}
                        onClick={() =>
                          void runAction(async () => {
                            await apiClient.deleteCostRate(rate.provider, rate.model);
                          })
                        }
                      >
                        ×
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {canManageCosts && (
                <form
                  className="grid gap-2 sm:grid-cols-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runAction(async () => {
                      await apiClient.setCostRate({
                        provider: rateDraft.provider.trim(),
                        model: rateDraft.model.trim(),
                        inputUsdPerMillion: Number(rateDraft.inputUsdPerMillion),
                        outputUsdPerMillion: Number(rateDraft.outputUsdPerMillion),
                      });
                      setRateDraft({
                        provider: '',
                        model: '',
                        inputUsdPerMillion: '',
                        outputUsdPerMillion: '',
                      });
                    });
                  }}
                >
                  <Input
                    required
                    placeholder={t.provider}
                    aria-label={t.provider}
                    value={rateDraft.provider}
                    onChange={(event) =>
                      setRateDraft({ ...rateDraft, provider: event.target.value })
                    }
                  />
                  <Input
                    required
                    placeholder={t.model}
                    aria-label={t.model}
                    value={rateDraft.model}
                    onChange={(event) => setRateDraft({ ...rateDraft, model: event.target.value })}
                  />
                  <Input
                    required
                    type="number"
                    min="0"
                    step="0.000001"
                    placeholder={t.inputRate}
                    aria-label={t.inputRate}
                    value={rateDraft.inputUsdPerMillion}
                    onChange={(event) =>
                      setRateDraft({ ...rateDraft, inputUsdPerMillion: event.target.value })
                    }
                  />
                  <Input
                    required
                    type="number"
                    min="0"
                    step="0.000001"
                    placeholder={t.outputRate}
                    aria-label={t.outputRate}
                    value={rateDraft.outputUsdPerMillion}
                    onChange={(event) =>
                      setRateDraft({ ...rateDraft, outputUsdPerMillion: event.target.value })
                    }
                  />
                  <Button type="submit" disabled={busy}>
                    {t.addRate}
                  </Button>
                </form>
              )}
            </section>
          )}
          {dashboard.costs?.mcpUsage && (
            <McpUsagePanel usage={dashboard.costs.mcpUsage} locale={locale} t={t} />
          )}
          {(dashboard.recentRuns?.length ?? 0) > 0 && (
            <section className={cn(panel, 'p-4')}>
              <h3 className="mb-2 text-sm font-semibold">{t.runs}</h3>
              <div className="space-y-2">
                {dashboard.recentRuns?.slice(0, 5).map((run) => (
                  <div key={run.id} className="flex justify-between gap-3 text-xs">
                    <span>
                      {agents.find((agent) => agent.id === run.agentId)?.name ??
                        run.agentId.slice(0, 8)}{' '}
                      · {t.runStatus[run.status]}
                    </span>
                    <span>{run.costMicros === null ? '—' : money(run.costMicros, locale)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="grid gap-3 lg:grid-cols-3">
            <Chart
              title={t.issuesByPriority}
              subtitle={t.last14Days}
              values={priorityOrder.map((key) => ({
                label: t.priorityNames[key],
                value: dashboard.byPriority[key],
                color: {
                  urgent: 'bg-red-500',
                  high: 'bg-orange-500',
                  medium: 'bg-yellow-500',
                  low: 'bg-neutral-500',
                }[key],
              }))}
            />
            <Chart
              title={t.issuesByStatus}
              subtitle={t.last14Days}
              values={statusOrder.map((key) => ({
                label: t.statusNames[key],
                value: dashboard.byStatus[key],
                color: {
                  backlog: 'bg-neutral-500',
                  todo: 'bg-blue-500',
                  in_progress: 'bg-violet-500',
                  in_review: 'bg-cyan-500',
                  blocked: 'bg-red-500',
                  done: 'bg-emerald-500',
                  cancelled: 'bg-neutral-700',
                }[key],
              }))}
            />
            <div className={cn(panel, 'p-4')}>
              <h3 className="text-sm font-semibold">{t.recentActivity}</h3>
              <p className="text-xs text-[var(--text-muted)]">{t.last14Days}</p>
              <div className="mt-4 space-y-3">
                {dashboard.recentActivity.length ? (
                  dashboard.recentActivity.slice(0, 5).map((issue) => (
                    <Button
                      key={issue.id}
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start text-left text-xs font-normal"
                      onClick={() => void openIssue(issue)}
                    >
                      <span className="truncate">
                        #{issue.number} {issue.title}
                      </span>
                      <span className="ml-auto shrink-0 text-[var(--text-muted)]">
                        {relativeDate(issue.updatedAt, locale)}
                      </span>
                    </Button>
                  ))
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">{t.noActivity}</p>
                )}
              </div>
            </div>
          </div>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t.recentIssues}
            </h3>
            <div className={panel}>
              {dashboard.recentIssues.length ? (
                dashboard.recentIssues.map((issue) => issueRow(issue))
              ) : (
                <p className="p-5 text-sm text-[var(--text-muted)]">{t.noIssues}</p>
              )}
            </div>
          </section>
        </>
      )}

      {(tab === 'issues' || tab === 'inbox') && (
        <>
          {tab === 'inbox' && (
            <div
              role="tablist"
              aria-label={t.inbox}
              className="flex flex-wrap gap-1 border-b border-[var(--border)]"
            >
              {(['mine', 'recent', 'unread', 'blocked', 'all'] as InboxTab[]).map((key) => (
                <Button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={inboxTab === key}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'rounded-none border-b-2',
                    inboxTab === key
                      ? 'border-[var(--fill-accent)] text-[var(--text-primary)]'
                      : 'border-transparent',
                  )}
                  onClick={() => setInboxTab(key)}
                >
                  {t[key]}
                  {key === 'unread' &&
                  inbox.filter((item) => !item.readAt && !item.archivedAt).length > 0 ? (
                    <span className="rounded-full bg-[var(--surface-2)] px-1.5 text-xs">
                      {inbox.filter((item) => !item.readAt && !item.archivedAt).length}
                    </span>
                  ) : null}
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t.search}
              aria-label={t.search}
              className="max-w-md flex-1"
            />
            {tab === 'issues' && (
              <>
                <Button
                  type="button"
                  variant={filtersOpen ? 'secondary' : 'outline'}
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  <i className="ti ti-filter" aria-hidden="true" />
                  {filtersOpen ? t.hideFilters : t.showFilters}
                  {activeFilterCount > 0 && (
                    <span className="rounded-full bg-[var(--fill-accent)] px-1.5 text-xs text-white">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
                <div className="flex gap-1" role="group" aria-label={t.issues}>
                  <Button
                    type="button"
                    variant={issuesView === 'list' ? 'secondary' : 'ghost'}
                    aria-pressed={issuesView === 'list'}
                    onClick={() => chooseIssuesView('list')}
                  >
                    <i className="ti ti-list" aria-hidden="true" />
                    {t.listView}
                  </Button>
                  <Button
                    type="button"
                    variant={issuesView === 'board' ? 'secondary' : 'ghost'}
                    aria-pressed={issuesView === 'board'}
                    onClick={() => chooseIssuesView('board')}
                  >
                    <i className="ti ti-layout-kanban" aria-hidden="true" />
                    {t.boardView}
                  </Button>
                </div>
              </>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void reload()}
                aria-label={t.refresh}
                title={t.refresh}
              >
                <i className="ti ti-refresh" aria-hidden="true" />
              </Button>
              {!isReadOnly && (
                <Button type="button" onClick={() => setComposerOpen(true)}>
                  <i className="ti ti-plus" aria-hidden="true" />
                  {t.newIssue}
                </Button>
              )}
            </div>
          </div>
          {tab === 'issues' && filtersOpen && (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={filters.status}
                onChange={(event) => setFilter('status', event.target.value)}
                aria-label={t.filterStatus}
                containerClassName="max-w-44"
              >
                <option value="">{t.anyStatus}</option>
                {statusOrder.map((key) => (
                  <option key={key} value={key}>
                    {t.statusNames[key]}
                  </option>
                ))}
              </Select>
              <Select
                value={filters.assignee}
                onChange={(event) => setFilter('assignee', event.target.value)}
                aria-label={t.assignee}
                containerClassName="w-72 max-w-full flex-none"
              >
                <option value="">{t.allAssignees}</option>
                <option value="none">{t.noAssignee}</option>
                {[...members]
                  .sort((a, b) => memberLabel(a).localeCompare(memberLabel(b), locale))
                  .map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {memberLabel(member)}
                    </option>
                  ))}
              </Select>
              <Select
                value={filters.agent}
                onChange={(event) => setFilter('agent', event.target.value)}
                aria-label={t.agent}
                containerClassName="w-80 max-w-full flex-none"
              >
                <option value="">{t.allAgents}</option>
                <option value="none">{t.noAgent}</option>
                {agentOptions}
              </Select>
              <Select
                value={filters.priority}
                onChange={(event) => setFilter('priority', event.target.value)}
                aria-label={t.priority}
                containerClassName="max-w-44"
              >
                <option value="">{t.allPriorities}</option>
                {priorityOrder.map((key) => (
                  <option key={key} value={key}>
                    {t.priorityNames[key]}
                  </option>
                ))}
              </Select>
              {(iterations.length > 0 || filters.iteration) && (
                <Select
                  value={filters.iteration}
                  onChange={(event) => setFilter('iteration', event.target.value)}
                  aria-label={t.iteration}
                  containerClassName="w-72 max-w-full flex-none"
                >
                  <option value="">{t.allIterations}</option>
                  {[...new Set([...iterations, filters.iteration].filter(Boolean))].map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </Select>
              )}
              <div className="flex items-center gap-1">
                <Select
                  aria-label={t.savedFilters}
                  value={activeSavedFilter?.id ?? ''}
                  onChange={(event) => applySavedFilter(event.target.value)}
                  containerClassName="max-w-48"
                >
                  <option value="" disabled={savedFilters.length > 0}>
                    {t.savedFilters}
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
                  title={t.saveFilter}
                  disabled={!hasFilters}
                  onClick={() => setFilterNameDraft(activeSavedFilter?.name ?? '')}
                >
                  <i className="ti ti-device-floppy text-lg" aria-hidden="true" />
                  {t.saveFilter}
                </Button>
                {activeSavedFilter && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    aria-label={`${t.deleteSavedFilter}: ${activeSavedFilter.name}`}
                    title={t.deleteSavedFilter}
                    onClick={() =>
                      persistSavedFilters(
                        savedFilters.filter((saved) => saved.id !== activeSavedFilter.id),
                      )
                    }
                  >
                    <i className="ti ti-trash" aria-hidden="true" />
                  </Button>
                )}
                {hasFilters && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    aria-label={t.clearFilters}
                    title={t.clearFilters}
                    onClick={clearFilters}
                  >
                    <i className="ti ti-filter-off" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <span className="text-xs text-[var(--text-muted)]">
                {filteredIssues.length}/{issues.length}
              </span>
            </div>
          )}
          {loading ? (
            <div className="grid gap-4 md:grid-cols-3">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : tab === 'issues' && issuesView === 'board' ? (
            <div>
              <KanbanDraftBar
                pending={Object.keys(kanbanDraft.draft).length - kanbanDraft.saving.size}
                saving={kanbanDraft.saving.size}
                offline={kanbanDraft.offline}
                error={kanbanDraft.error}
                labels={t.draftLabels}
                onSave={() => void kanbanDraft.flush()}
                onDiscard={kanbanDraft.discard}
              />
              <div className="flex items-start gap-3 overflow-x-auto pb-2" aria-label={t.boardView}>
                {statusOrder
                  .filter((status) => !filters.status || filters.status === status)
                  .map((status) => {
                    const columnIssues = filteredIssues.filter((issue) => issue.status === status);
                    const dragged = draggingId
                      ? issues.find((issue) => issue.id === draggingId)
                      : undefined;
                    const isTarget =
                      dragOverStatus === status && !!dragged && dragged.status !== status;
                    return (
                      <section
                        key={status}
                        aria-label={t.statusNames[status]}
                        className={kanbanColumnClass(isTarget)}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setDragOverStatus(status);
                        }}
                        onDragLeave={(event) => {
                          if (event.currentTarget.contains(event.relatedTarget as Node | null))
                            return;
                          setDragOverStatus((current) => (current === status ? null : current));
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          setDragOverStatus(null);
                          setDraggingId(null);
                          const id = event.dataTransfer.getData('text/plain');
                          const current = rawIssues.find((issue) => issue.id === id);
                          if (current && !isReadOnly) kanbanDraft.move(id, current.status, status);
                        }}
                      >
                        <header className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-xs font-semibold">
                          <h3 className="truncate" title={t.statusNames[status]}>
                            {t.statusNames[status]}
                          </h3>
                          <span className="rounded-full bg-[var(--surface-2)] px-1.5 text-[var(--text-muted)]">
                            {columnIssues.length}
                          </span>
                        </header>
                        <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">
                          {isTarget && (
                            <KanbanDropPlaceholder
                              title={`#${dragged.number} ${dragged.title}`}
                              label={`${t.moveTo} ${t.statusNames[status]}`}
                            />
                          )}
                          {columnIssues.map((issue) => {
                            const palette = resolveTypePalette(
                              resolveWorkItemType(workItemTypes, issue.type ?? '')?.color,
                            );
                            const assignee = issue.assigneeUserId
                              ? (members.find((member) => member.userId === issue.assigneeUserId) ??
                                null)
                              : null;
                            return (
                              <article
                                key={issue.id}
                                style={palette.style}
                                draggable={!isReadOnly}
                                onDragStart={(event) => {
                                  event.dataTransfer.setData('text/plain', issue.id);
                                  event.dataTransfer.effectAllowed = 'move';
                                  setDraggingId(issue.id);
                                }}
                                onDragEnd={() => {
                                  setDraggingId(null);
                                  setDragOverStatus(null);
                                }}
                                className={`rounded-md border border-l-4 border-[var(--border)] bg-[var(--surface-2)] p-2.5 ${palette.bar} ${isReadOnly ? '' : 'cursor-grab active:cursor-grabbing'} ${kanbanCardStateClass(draggingId === issue.id, kanbanDraft.saving.has(issue.id))}`}
                              >
                                {kanbanDraft.saving.has(issue.id) ? (
                                  <KanbanCardSaving label={t.savingMove} />
                                ) : (
                                  issue.id in kanbanDraft.draft && (
                                    <KanbanCardPending label={t.draftPendingCard} />
                                  )
                                )}
                                {issue.type && (
                                  <div className="mb-1.5">
                                    <WorkItemTypeBadge name={issue.type} types={workItemTypes} />
                                  </div>
                                )}
                                <Button
                                  type="button"
                                  variant="link"
                                  className="h-auto w-full min-w-0 justify-start whitespace-normal p-0 text-left text-sm font-medium text-[var(--text-primary)] no-underline [overflow-wrap:anywhere] hover:text-[var(--text-primary)]"
                                  onClick={() => void openIssue(issue)}
                                >
                                  <span className="font-mono text-xs text-[var(--text-muted)]">
                                    #{issue.number}
                                  </span>
                                  <span className="min-w-0 [overflow-wrap:anywhere]">
                                    {issue.title}
                                  </span>
                                </Button>
                                <p className="mt-1.5 truncate text-xs text-[var(--text-muted)]">
                                  {t.priorityNames[issue.priority]}
                                  {assignee && (
                                    <>
                                      {' · '}
                                      <i className="ti ti-user" aria-hidden="true" />{' '}
                                      {memberLabel(assignee)}
                                    </>
                                  )}
                                </p>
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className={panel}>
              {tab === 'issues'
                ? filteredIssues
                    .slice(issuesPaging.start, issuesPaging.end)
                    .map((issue) => issueRow(issue))
                : filteredInbox
                    .slice(inboxPaging.start, inboxPaging.end)
                    .map((item) => issueRow(item.issue, item))}
              {(tab === 'issues' ? filteredIssues.length : filteredInbox.length) === 0 &&
                !loading && (
                  <div className="p-8 text-center text-sm text-[var(--text-muted)]">
                    <p>{tab === 'inbox' ? t.inboxEmpty : t.noIssues}</p>
                    {!isReadOnly && tab === 'issues' && <p className="mt-1">{t.createFirst}</p>}
                  </div>
                )}
              <PagingSentinel paging={listPaging} />
            </div>
          )}
          {(tab === 'inbox' || issuesView === 'list') && listPaging.total > 0 && (
            <Pagination paging={listPaging} perPageLabel={t.perPage} />
          )}
          {tab === 'issues' &&
            issuesView === 'board' &&
            filteredIssues.length === 0 &&
            !loading && (
              <p className="text-center text-sm text-[var(--text-muted)]">{t.noIssues}</p>
            )}
        </>
      )}

      <Modal
        open={filterNameDraft !== null}
        onClose={() => setFilterNameDraft(null)}
        labelledBy="issue-save-filter-title"
      >
        {filterNameDraft !== null && (
          <form
            onSubmit={saveCurrentFilter}
            className="w-[min(90vw,420px)] space-y-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6"
          >
            <h2 id="issue-save-filter-title" className="text-lg font-semibold">
              {t.saveFilterTitle}
            </h2>
            <label className="block text-sm">
              {t.filterName}
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
                {t.cancel}
              </Button>
              <Button type="submit" disabled={!filterNameDraft.trim()}>
                {t.saveFilter}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={composerOpen && !isReadOnly}
        onClose={closeComposer}
        labelledBy="issue-composer-title"
      >
        <form
          onSubmit={(event) => void createIssue(event)}
          className="w-[min(560px,calc(100vw-2rem))] space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl"
        >
          <div className="flex items-center justify-between">
            <h2 id="issue-composer-title" className="text-lg font-semibold">
              {t.newIssue}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={closeComposer}
              aria-label={t.close}
            >
              <i className="ti ti-x" aria-hidden="true" />
            </Button>
          </div>
          <label className="block space-y-1 text-sm">
            <span>{t.title}</span>
            <Input
              autoFocus
              required
              maxLength={240}
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t.description}</span>
            <Textarea
              rows={5}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              onPaste={formImages.onPaste}
              onDrop={formImages.onDrop}
            />
            <ImageInputStatus state={formImages} />
          </label>
          <AttachmentPanel
            apiClient={apiClient}
            scope="issue"
            attachments={form.attachments}
            onChange={(attachments) => setForm({ ...form, attachments })}
            onInsertInline={(attachment) =>
              setForm({ ...form, description: appendImage(form.description, attachment) })
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span>{t.status}</span>
              <Select
                value={form.status}
                onChange={(event) =>
                  setForm({ ...form, status: event.target.value as IssueStatus })
                }
              >
                {statusOrder.map((key) => (
                  <option key={key} value={key}>
                    {t.statusNames[key]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span>{t.priority}</span>
              <Select
                value={form.priority}
                onChange={(event) =>
                  setForm({ ...form, priority: event.target.value as IssuePriority })
                }
              >
                {priorityOrder.map((key) => (
                  <option key={key} value={key}>
                    {t.priorityNames[key]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span>{t.type}</span>
              <Select
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value })}
              >
                <option value="">{t.noType}</option>
                {workItemTypes.map((type) => (
                  <option key={type.key} value={type.key}>
                    {type.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span>{t.agent}</span>
              <Select
                value={form.assigneeAgentId}
                onChange={(event) => setForm({ ...form, assigneeAgentId: event.target.value })}
              >
                <option value="">{t.noAgent}</option>
                {agentOptions}
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span>{t.assignee}</span>
              <Select
                value={form.assigneeUserId}
                onChange={(event) => setForm({ ...form, assigneeUserId: event.target.value })}
              >
                <option value="">{t.unassigned}</option>
                {memberOptions}
              </Select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={closeComposer}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={busy || !form.title.trim()} isLoading={busy}>
              {t.create}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(selectedId)}
        onClose={requestCloseDetail}
        labelledBy="issue-detail-title"
      >
        <div className="flex h-[min(90vh,900px)] w-[min(96vw,1800px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-6 py-3">
            <div className="min-w-0">
              <p className="text-xs text-[var(--text-accent)]">#{selectedIssue?.number}</p>
              <h2 id="issue-detail-title" className="mt-1 text-xl font-semibold">
                {selectedIssue?.title}
              </h2>
            </div>
            <div className="flex items-center gap-1">
              {selectedIssue && canDelete && (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  disabled={busy}
                  aria-label={t.delete}
                  title={t.delete}
                  className="bg-red-600 text-white hover:bg-red-500"
                  onClick={() => {
                    if (window.confirm(t.deleteConfirm))
                      void runAction(async () => {
                        await apiClient.deleteIssue(selectedIssue.id);
                        closeDetail();
                      });
                  }}
                >
                  <i className="ti ti-trash" aria-hidden="true" />
                </Button>
              )}
              {selectedIssue && (
                <HistoryViewer
                  apiClient={apiClient}
                  entityType="issue"
                  workspaceId={workspaceId}
                  entityId={selectedIssue.id}
                  entityTitle={`#${selectedIssue.number} ${selectedIssue.title}`}
                  resolveValue={(key, value) => {
                    if (typeof value !== 'string') return undefined;
                    if (key === 'assigneeUserId' || key === 'proofreaderUserId') {
                      const member = members.find((entry) => entry.userId === value);
                      return member ? memberLabel(member) : value;
                    }
                    if (key === 'assigneeAgentId')
                      return agents.find((agent) => agent.id === value)?.name ?? value;
                    if (key === 'status' && value in t.statusNames)
                      return t.statusNames[value as IssueStatus];
                    if (key === 'priority' && value in t.priorityNames)
                      return t.priorityNames[value as IssuePriority];
                    return undefined;
                  }}
                />
              )}
              {selectedIssue && !isReadOnly && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !hasUnsaved}
                  isLoading={busy}
                  onClick={() => void saveIssue()}
                >
                  {t.save}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={requestCloseDetail}
                aria-label={t.close}
              >
                <i className="ti ti-x" aria-hidden="true" />
              </Button>
            </div>
          </div>
          {!selectedIssue && (
            <div
              role="status"
              aria-label={t.loadingDetails}
              className="grid min-h-0 flex-1 gap-6 overflow-hidden p-6 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]"
            >
              <div className="space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-56 w-full rounded-md" />
                <SkeletonText lines={4} />
              </div>
              <div className="space-y-4">
                <Skeleton className="h-12 w-full rounded-md" />
                <Skeleton className="h-12 w-full rounded-md" />
                <Skeleton className="h-12 w-full rounded-md" />
              </div>
            </div>
          )}
          {selectedIssue && (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <div
                role="tablist"
                aria-label={selectedIssue.title}
                className="mb-5 flex gap-1 border-b border-[var(--border)]"
              >
                {(['details', 'agent'] as const).map((key) => (
                  <Button
                    key={key}
                    type="button"
                    role="tab"
                    variant="ghost"
                    aria-selected={detailTab === key}
                    className={cn(
                      'rounded-b-none border-b-2',
                      detailTab === key
                        ? 'border-[var(--border-accent)] text-[var(--text-primary)]'
                        : 'border-transparent text-[var(--text-muted)]',
                    )}
                    onClick={() => setDetailTab(key)}
                  >
                    {key === 'details' ? t.detailsTab : t.agentInfoTab}
                  </Button>
                ))}
              </div>
              {detailTab === 'agent' ? (
                <AgentBriefTab
                  apiClient={apiClient}
                  issueId={selectedIssue.id}
                  issueVersion={selectedIssue.updatedAt}
                  isReadOnly={isReadOnly}
                  issueAttachments={selectedIssue.attachments}
                  {...(onOpenReference ? { onOpenModule: onOpenReference } : {})}
                />
              ) : (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
                  <div className="min-w-0 space-y-5 lg:border-r lg:border-[var(--border)] lg:pr-6">
                    <div>
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">{t.description}</h3>
                        {!isReadOnly && !editingDetails && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setDetailDraft({
                                title: selectedIssue.title,
                                description: selectedIssue.description,
                                attachments: selectedIssue.attachments ?? [],
                              });
                              setEditingDetails(true);
                            }}
                          >
                            {t.edit}
                          </Button>
                        )}
                      </div>
                      {editingDetails ? (
                        <form
                          className="mt-2 space-y-3"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveIssue();
                          }}
                        >
                          <label className="block space-y-1 text-sm">
                            <span>{t.title}</span>
                            <Input
                              required
                              maxLength={240}
                              value={detailDraft.title}
                              onChange={(event) =>
                                setDetailDraft({ ...detailDraft, title: event.target.value })
                              }
                            />
                          </label>
                          <label className="block space-y-1 text-sm">
                            <span>{t.description}</span>
                            <Textarea
                              rows={5}
                              value={detailDraft.description}
                              onChange={(event) =>
                                setDetailDraft({ ...detailDraft, description: event.target.value })
                              }
                              onPaste={detailImages.onPaste}
                              onDrop={detailImages.onDrop}
                            />
                            <ImageInputStatus state={detailImages} />
                          </label>
                          <div className="flex gap-2">
                            <Button
                              type="submit"
                              size="sm"
                              disabled={busy || !detailDraft.title.trim()}
                            >
                              {t.save}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                cancelDetailEdit();
                                setDetailDraft({
                                  title: selectedIssue.title,
                                  description: selectedIssue.description,
                                  attachments: selectedIssue.attachments ?? [],
                                });
                              }}
                            >
                              {t.cancel}
                            </Button>
                          </div>
                        </form>
                      ) : selectedIssue.description &&
                        !isHtmlDescription(selectedIssue.description) ? (
                        <MarkdownViewer
                          content={selectedIssue.description}
                          showModeToggle={false}
                          className="mt-2 min-w-0 break-words text-sm"
                        />
                      ) : (
                        <div
                          ref={issueDescriptionRef}
                          className="mt-2 break-words text-sm leading-6 text-[var(--text-secondary)] [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded [&_a]:text-[var(--text-accent)] [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-strong)] [&_blockquote]:pl-4 [&_h1]:my-4 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:my-4 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:my-3 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--surface-2)] [&_pre]:p-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6"
                          dangerouslySetInnerHTML={{
                            __html: selectedIssue.description
                              ? formatIssueDescription(selectedIssue.description)
                              : '—',
                          }}
                        />
                      )}
                      <div className="mt-4">
                        <AttachmentPanel
                          apiClient={apiClient}
                          scope="issue"
                          attachments={
                            editingDetails
                              ? detailDraft.attachments
                              : (selectedIssue.attachments ?? [])
                          }
                          disabled={isReadOnly}
                          onChange={
                            editingDetails
                              ? (attachments) => setDetailDraft({ ...detailDraft, attachments })
                              : undefined
                          }
                          onInsertInline={(attachment) =>
                            setDetailDraft({
                              ...detailDraft,
                              description: appendImage(detailDraft.description, attachment),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="border-t border-[var(--border)] pt-4">
                      <h3 className="mb-3 text-sm font-semibold">{t.comments}</h3>
                      <div className="space-y-3">
                        {selectedDetailsLoading ? (
                          <div className="space-y-3" role="status" aria-label={t.loadingDetails}>
                            <div className="rounded-lg bg-[var(--surface-2)] p-3">
                              <Skeleton className="h-3 w-1/3 rounded-full" />
                              <Skeleton className="mt-3 h-3 w-full rounded-full" />
                              <Skeleton className="mt-2 h-3 w-2/3 rounded-full" />
                            </div>
                            <div className="rounded-lg bg-[var(--surface-2)] p-3">
                              <Skeleton className="h-3 w-1/4 rounded-full" />
                              <Skeleton className="mt-3 h-3 w-4/5 rounded-full" />
                            </div>
                          </div>
                        ) : (
                          selectedComments.map((comment) => (
                            <div
                              key={comment.id}
                              className="rounded-lg bg-[var(--surface-2)] p-3 text-sm"
                            >
                              <div className="mb-1 flex justify-between text-xs text-[var(--text-muted)]">
                                <span>
                                  {comment.authorId === currentUserId
                                    ? t.mine
                                    : (agents.find((agent) => agent.id === comment.authorId)
                                        ?.name ?? comment.authorId.slice(0, 8))}
                                </span>
                                <span>{relativeDate(comment.createdAt, locale)}</span>
                              </div>
                              <MarkdownViewer
                                content={comment.body}
                                showModeToggle={false}
                                className="min-w-0 break-words text-sm"
                              />
                            </div>
                          ))
                        )}
                      </div>
                      {!isReadOnly && (
                        <form
                          className="mt-3 flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (!commentText.trim()) return;
                            void (async () => {
                              setBusy(true);
                              setCommentError(null);
                              try {
                                const result = await apiClient.addIssueComment(
                                  selectedIssue.id,
                                  commentText.trim(),
                                );
                                setSelectedComments((current) => [...current, result.comment]);
                                setCommentText('');
                                const run = result.run;
                                if (run) setSelectedRuns((current) => [run, ...current]);
                                await reload();
                                if (result.automationError) setCommentError(result.automationError);
                              } catch (reason) {
                                setCommentError(
                                  reason instanceof Error ? reason.message : t.saveError,
                                );
                              } finally {
                                setBusy(false);
                              }
                            })();
                          }}
                        >
                          <Input
                            value={commentText}
                            onChange={(event) => setCommentText(event.target.value)}
                            placeholder={t.commentPlaceholder}
                            aria-label={t.commentPlaceholder}
                          />
                          <Button type="submit" disabled={busy || !commentText.trim()}>
                            {t.addComment}
                          </Button>
                        </form>
                      )}
                      {commentError && (
                        <p role="alert" className="mt-2 text-sm text-red-400">
                          {commentError}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
                      {selectedInbox && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              changeInbox(selectedIssue.id, { read: !selectedInbox.readAt })
                            }
                          >
                            {selectedInbox.readAt ? t.markUnread : t.markRead}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              changeInbox(selectedIssue.id, { archived: !selectedInbox.archivedAt })
                            }
                          >
                            {selectedInbox.archivedAt ? t.restore : t.archive}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <aside className="min-w-0 space-y-5">
                    <div className="grid gap-3">
                      <label className="space-y-1 text-sm">
                        <span>{t.status}</span>
                        <Select
                          disabled={isReadOnly || busy}
                          value={issueView.status}
                          onChange={(event) =>
                            updateIssue({ status: event.target.value as IssueStatus })
                          }
                        >
                          {statusOrder.map((key) => (
                            <option key={key} value={key}>
                              {t.statusNames[key]}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="space-y-1 text-sm">
                        <span>{t.priority}</span>
                        <Select
                          disabled={isReadOnly || busy}
                          value={issueView.priority}
                          onChange={(event) =>
                            updateIssue({ priority: event.target.value as IssuePriority })
                          }
                        >
                          {priorityOrder.map((key) => (
                            <option key={key} value={key}>
                              {t.priorityNames[key]}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="space-y-1 text-sm">
                        <span>{t.type}</span>
                        <Select
                          disabled={isReadOnly || busy}
                          value={issueView.type ?? ''}
                          onChange={(event) => updateIssue({ type: event.target.value })}
                        >
                          <option value="">{t.noType}</option>
                          {workItemTypes.map((type) => (
                            <option key={type.key} value={type.key}>
                              {type.label}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="space-y-1 text-sm">
                        <span>{t.agent}</span>
                        <Select
                          disabled={isReadOnly || busy}
                          value={issueView.assigneeAgentId ?? ''}
                          onChange={(event) =>
                            updateIssue({ assigneeAgentId: event.target.value || null })
                          }
                        >
                          <option value="">{t.noAgent}</option>
                          {agentOptions}
                        </Select>
                      </label>
                      <label className="space-y-1 text-sm">
                        <span>{t.assignee}</span>
                        <Select
                          disabled={isReadOnly || busy}
                          value={issueView.assigneeUserId ?? ''}
                          onChange={(event) =>
                            updateIssue({ assigneeUserId: event.target.value || null })
                          }
                        >
                          <option value="">{t.unassigned}</option>
                          {memberOptions}
                          {issueView.assigneeUserId &&
                            !members.some(
                              (member) => member.userId === issueView.assigneeUserId,
                            ) && (
                              <option value={issueView.assigneeUserId}>
                                {issueView.assigneeUserId}
                              </option>
                            )}
                        </Select>
                      </label>
                      <label className="space-y-1 text-sm">
                        <span>{t.proofreader}</span>
                        <Select
                          disabled={isReadOnly || busy}
                          value={issueView.proofreaderUserId ?? ''}
                          onChange={(event) =>
                            updateIssue({ proofreaderUserId: event.target.value || null })
                          }
                        >
                          <option value="">{t.noProofreader}</option>
                          {memberOptions}
                          {issueView.proofreaderUserId &&
                            !members.some(
                              (member) => member.userId === issueView.proofreaderUserId,
                            ) && (
                              <option value={issueView.proofreaderUserId}>
                                {issueView.proofreaderUserId}
                              </option>
                            )}
                        </Select>
                      </label>
                    </div>
                    <section aria-label={t.runs}>
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold">{t.runs}</h3>
                        {!isReadOnly &&
                          selectedIssue.assigneeAgentId &&
                          !selectedRuns.some((run) => activeRunStatuses.includes(run.status)) && (
                            <Button
                              type="button"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                void runAction(async () => {
                                  await apiClient.startIssueRun(selectedIssue.id);
                                  setSelectedRuns(await apiClient.getAgentRuns(selectedIssue.id));
                                })
                              }
                            >
                              {t.startRun}
                            </Button>
                          )}
                      </div>
                      {selectedDetailsLoading ? (
                        <div className="space-y-3" role="status" aria-label={t.loadingDetails}>
                          <div className="rounded-lg border border-[var(--border)] p-3">
                            <Skeleton className="h-4 w-2/3 rounded-full" />
                            <Skeleton className="mt-3 h-3 w-1/2 rounded-full" />
                          </div>
                          <div className="rounded-lg border border-[var(--border)] p-3">
                            <Skeleton className="h-4 w-3/4 rounded-full" />
                            <Skeleton className="mt-3 h-3 w-2/5 rounded-full" />
                          </div>
                        </div>
                      ) : selectedRuns.length === 0 ? (
                        <p className="text-sm text-[var(--text-muted)]">{t.noRuns}</p>
                      ) : (
                        <div className="space-y-3">
                          {selectedRuns.map((run) => (
                            <article
                              key={run.id}
                              className="rounded-lg border border-[var(--border)] p-3 text-sm"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <strong>
                                  #{run.attempt} · {t.runStatus[run.status]}
                                </strong>
                                <span className="text-xs text-[var(--text-muted)]">
                                  {relativeDate(run.createdAt, locale)} ·{' '}
                                  {run.costMicros === null ? '—' : money(run.costMicros, locale)}
                                </span>
                              </div>
                              {run.provider && (
                                <p className="mt-1 text-xs text-[var(--text-muted)]">
                                  {run.provider}
                                  {run.model ? ` / ${run.model}` : ''}
                                  {run.inputTokens !== null
                                    ? ` · ${formatMessage(t.tokenUsage, { input: run.inputTokens, output: String(run.outputTokens) })}`
                                    : ''}
                                </p>
                              )}
                              {run.mode === 'server' &&
                                run.workflowState &&
                                run.workflowState.steps.length > 0 && (
                                  <div className="mt-2 rounded-md bg-[var(--surface-2)] p-2 text-xs text-[var(--text-secondary)]">
                                    <p>
                                      {run.workflowState.currentStepIndex >=
                                      run.workflowState.steps.length
                                        ? t.approveFinal
                                        : `${t.stepProgress} ${run.workflowState.currentStepIndex + 1} ${t.of} ${run.workflowState.steps.length}`}
                                    </p>
                                    <ol className="mt-2 space-y-1">
                                      {run.workflowState.steps.map((step, index) => {
                                        const completed = run.workflowState?.results.some(
                                          (result) =>
                                            result.stepId === step.id &&
                                            (result.kind === undefined || result.kind === 'result'),
                                        );
                                        return (
                                          <li
                                            key={step.id}
                                            className={cn(
                                              'flex items-center gap-2',
                                              completed && 'text-emerald-400',
                                              index === run.workflowState?.currentStepIndex &&
                                                (run.status.startsWith('waiting_') ||
                                                  run.status === 'running') &&
                                                'text-amber-300',
                                            )}
                                          >
                                            <i
                                              className={cn(
                                                'ti',
                                                completed
                                                  ? 'ti-circle-check-filled'
                                                  : index === run.workflowState?.currentStepIndex &&
                                                      (run.status.startsWith('waiting_') ||
                                                        run.status === 'running')
                                                    ? 'ti-circle-dot'
                                                    : 'ti-circle',
                                              )}
                                              aria-hidden="true"
                                            />
                                            <span>{step.name}</span>
                                          </li>
                                        );
                                      })}
                                    </ol>
                                  </div>
                                )}
                              {run.output && (
                                <MarkdownViewer
                                  content={run.output}
                                  showModeToggle={false}
                                  className="mt-2 min-w-0 break-words text-sm"
                                />
                              )}
                              {!isReadOnly && run.status === 'waiting_review' && (
                                <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                                  <p className="mb-2 text-xs text-amber-200">
                                    {t.waitingForReview}
                                  </p>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      void runAction(async () => {
                                        await apiClient.continueAgentRun(run.id, {
                                          action: 'approve',
                                        });
                                        setSelectedRuns(
                                          await apiClient.getAgentRuns(selectedIssue.id),
                                        );
                                      })
                                    }
                                  >
                                    <i className="ti ti-check mr-2" aria-hidden="true" />
                                    {run.workflowState &&
                                    run.workflowState.currentStepIndex <
                                      run.workflowState.steps.length
                                      ? t.approveAndContinue
                                      : t.approveFinal}
                                  </Button>
                                  <div className="mt-3 border-t border-amber-500/20 pt-3">
                                    <label className="sr-only" htmlFor={`run-revision-${run.id}`}>
                                      {t.revisionPlaceholder}
                                    </label>
                                    <Textarea
                                      id={`run-revision-${run.id}`}
                                      value={workflowAnswerDraft}
                                      onChange={(event) =>
                                        setWorkflowAnswerDraft(event.target.value)
                                      }
                                      placeholder={t.revisionPlaceholder}
                                      rows={2}
                                      disabled={busy}
                                    />
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="mt-2"
                                      disabled={busy || !workflowAnswerDraft.trim()}
                                      onClick={() =>
                                        void runAction(async () => {
                                          await apiClient.continueAgentRun(run.id, {
                                            action: 'revise',
                                            answer: workflowAnswerDraft.trim(),
                                          });
                                          setWorkflowAnswerDraft('');
                                          setSelectedRuns(
                                            await apiClient.getAgentRuns(selectedIssue.id),
                                          );
                                        })
                                      }
                                    >
                                      <i className="ti ti-edit mr-2" aria-hidden="true" />
                                      {t.requestRevision}
                                    </Button>
                                  </div>
                                </div>
                              )}
                              {!isReadOnly && run.status === 'waiting_input' && (
                                <form
                                  className="mt-3 rounded-md border border-sky-500/30 bg-sky-500/10 p-3"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    if (!workflowAnswerDraft.trim()) return;
                                    void runAction(async () => {
                                      await apiClient.continueAgentRun(run.id, {
                                        action: 'answer',
                                        answer: workflowAnswerDraft.trim(),
                                      });
                                      setWorkflowAnswerDraft('');
                                      setSelectedRuns(
                                        await apiClient.getAgentRuns(selectedIssue.id),
                                      );
                                    });
                                  }}
                                >
                                  <p className="mb-2 text-xs text-sky-200">{t.waitingForAnswer}</p>
                                  <p className="mb-3 whitespace-pre-wrap text-sm">
                                    {run.workflowState?.question}
                                  </p>
                                  <label className="sr-only" htmlFor={`run-answer-${run.id}`}>
                                    {t.answerQuestion}
                                  </label>
                                  <Textarea
                                    id={`run-answer-${run.id}`}
                                    value={workflowAnswerDraft}
                                    onChange={(event) => setWorkflowAnswerDraft(event.target.value)}
                                    placeholder={t.answerPlaceholder}
                                    rows={3}
                                    disabled={busy}
                                  />
                                  <Button
                                    type="submit"
                                    size="sm"
                                    className="mt-2"
                                    disabled={busy || !workflowAnswerDraft.trim()}
                                  >
                                    <i className="ti ti-send mr-2" aria-hidden="true" />
                                    {t.submitAnswer}
                                  </Button>
                                </form>
                              )}
                              {run.error && <p className="mt-2 text-red-400">{run.error}</p>}
                              {!isReadOnly && activeRunStatuses.includes(run.status) && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="mt-2"
                                  disabled={busy}
                                  onClick={() =>
                                    void runAction(async () => {
                                      await apiClient.cancelAgentRun(run.id);
                                      setSelectedRuns(
                                        await apiClient.getAgentRuns(selectedIssue.id),
                                      );
                                    })
                                  }
                                >
                                  {t.cancelRun}
                                </Button>
                              )}
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  </aside>
                </div>
              )}
            </div>
          )}
        </div>
        <UnsavedChangesDialog
          open={confirmClose}
          isSaving={busy}
          labels={{
            title: t.unsavedTitle,
            description: t.unsavedBody,
            cancel: t.cancel,
            discard: t.discardChanges,
            save: t.saveChanges,
          }}
          onCancel={() => setConfirmClose(false)}
          onDiscard={closeDetail}
          onSave={() => void saveIssue().then((saved) => saved && closeDetail())}
        />
      </Modal>
    </div>
  );
}

/** Current-month tokens the MCP client's own model spent on ADK tool calls. */
function McpUsagePanel({
  usage,
  locale,
  t,
}: {
  usage: McpUsageSummary;
  locale: string;
  t: I18nDictionary['issues'];
}) {
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const tokens = (value: number) => `${usage.estimated ? '≈ ' : ''}${number(value)}`;
  return (
    <section className={cn(panel, 'space-y-4 p-5')} aria-labelledby="mcp-usage-title">
      <div>
        <h3 id="mcp-usage-title" className="text-sm font-semibold">
          {t.mcpUsage}
        </h3>
        <p className="text-xs text-[var(--text-muted)]">{t.mcpUsageHint}</p>
      </div>
      {usage.calls === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t.mcpEmpty}</p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            {[
              [t.mcpCalls, number(usage.calls)],
              [t.mcpTokens, tokens(usage.totalTokens)],
              [t.mcpSpend, money(usage.spendMicros, locale)],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3"
              >
                <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
                <dd className="mt-1 text-xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-[var(--text-muted)]">
            {t.tokenBreakdown}: {tokens(usage.inputTokens)} / {tokens(usage.outputTokens)}
          </p>
          {usage.unpricedCalls > 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              {usage.unpricedCalls} {t.mcpUnpriced}
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {t.mcpTopTools}
              </h4>
              <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
                {usage.byTool.map((item) => (
                  <li key={item.tool} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate font-mono">{item.tool}</span>
                    <span className="shrink-0">
                      {tokens(item.totalTokens)} · {number(item.calls)}×
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {t.mcpClients}
              </h4>
              <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
                {usage.byClient.map((item) => (
                  <li key={`${item.provider}:${item.model}`} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {item.provider} / {item.model}
                    </span>
                    <span className="shrink-0">
                      {tokens(item.totalTokens)} · {number(item.calls)}×
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Chart({
  title,
  subtitle,
  values,
}: {
  title: string;
  subtitle: string;
  values: { label: string; value: number; color: string }[];
}) {
  const max = Math.max(1, ...values.map((item) => item.value));
  return (
    <div className={cn(panel, 'p-4')}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
      <div className="mt-5 flex h-28 items-end gap-2 border-b border-[var(--border)] pb-1">
        {values.map((item) => (
          <div
            key={item.label}
            className="group flex h-full min-w-0 flex-1 items-end"
            title={`${item.label}: ${item.value}`}
          >
            <div
              className={cn('w-full rounded-t-sm', item.color)}
              style={{ height: `${item.value ? Math.max(8, (item.value / max) * 100) : 2}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
        {values.map((item) => (
          <span
            key={item.label}
            className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', item.color)} />
            {item.label} {item.value}
          </span>
        ))}
      </div>
    </div>
  );
}
