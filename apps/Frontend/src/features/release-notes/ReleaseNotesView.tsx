import { useCallback, useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ApiClient, AuditSnapshot } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { useI18n } from '../../lib/i18n/index.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import { HistoryViewer } from '../audit/HistoryViewer.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import type { PbiItem } from '../pbi/pbi-types.js';
import { usePermissions } from '../workspaces/permissions.js';
import type { ReleaseNote, ReleaseNoteExportFormat } from './release-note-types.js';

interface Props {
  apiClient: ApiClient;
  workspaceId: string | null;
  isReadOnly?: boolean;
}
type Mode = 'view' | 'edit' | 'generate';
interface Draft {
  id?: string;
  title: string;
  version: string;
  content: string;
}

// Matches the backend limit for one generation request.
const maxSelectedItems = 300;
// Rendering thousands of checkboxes is slow; users narrow the list with filters instead.
const visibleItemLimit = 200;

const copy = {
  'pt-BR': {
    subtitle: 'Notas de versão escritas manualmente ou por um agente a partir dos itens entregues',
    newNote: 'Nova release note',
    generate: 'Gerar com agente',
    empty: 'Nenhuma release note ainda.',
    selectHint: 'Selecione uma release note ou crie uma nova.',
    loadError: 'Não foi possível carregar as release notes.',
    actionError: 'Não foi possível concluir a ação.',
    actions: 'Ações da release note',
    exportMarkdown: 'Exportar Markdown',
    exportPdf: 'Exportar PDF',
    exportDocx: 'Exportar DOCX',
    edit: 'Editar',
    delete: 'Excluir',
    deleteTitle: 'Excluir release note?',
    deleteDescription: 'Excluir “{title}”? A exclusão fica registrada no histórico.',
    title: 'Título',
    version: 'Versão',
    versionPlaceholder: 'Ex.: 1.4.0',
    content: 'Conteúdo (Markdown)',
    preview: 'Pré-visualização',
    save: 'Salvar',
    cancel: 'Cancelar',
    agent: 'Agente',
    selectAgent: 'Selecione um agente',
    noAgents: 'Crie um agente em Agents para gerar release notes.',
    instructions: 'Instruções adicionais (opcional)',
    instructionsPlaceholder: 'Ex.: público externo, destacar melhorias de desempenho',
    items: 'Itens da release',
    searchItems: 'Buscar por título ou ID',
    allTypes: 'Todos os tipos',
    allStates: 'Todos os estados',
    allIterations: 'Todas as iterações',
    type: 'Tipo',
    state: 'Estado',
    iteration: 'Iteração',
    selected: 'selecionado(s)',
    selectVisible: 'Selecionar visíveis',
    clearSelection: 'Limpar seleção',
    showingFirst: 'Exibindo os primeiros {count} itens. Refine os filtros para ver os demais.',
    limitReached: 'Limite de {count} itens por release note.',
    noItems: 'Nenhum item corresponde aos filtros.',
    loadingItems: 'Carregando itens...',
    itemsError: 'Não foi possível carregar os itens.',
    generating: 'Gerando release note',
    submitGenerate: 'Gerar release note',
    basedOn: 'Baseada em {count} item(ns)',
    updated: 'Atualizada em',
  },
  'en-US': {
    subtitle: 'Release notes written manually or by an agent from delivered work items',
    newNote: 'New release note',
    generate: 'Generate with agent',
    empty: 'No release notes yet.',
    selectHint: 'Select a release note or create a new one.',
    loadError: 'Could not load release notes.',
    actionError: 'Could not complete the action.',
    actions: 'Release note actions',
    exportMarkdown: 'Export Markdown',
    exportPdf: 'Export PDF',
    exportDocx: 'Export DOCX',
    edit: 'Edit',
    delete: 'Delete',
    deleteTitle: 'Delete release note?',
    deleteDescription: 'Delete “{title}”? The deletion is recorded in the history.',
    title: 'Title',
    version: 'Version',
    versionPlaceholder: 'e.g. 1.4.0',
    content: 'Content (Markdown)',
    preview: 'Preview',
    save: 'Save',
    cancel: 'Cancel',
    agent: 'Agent',
    selectAgent: 'Select an agent',
    noAgents: 'Create an agent in Agents to generate release notes.',
    instructions: 'Additional instructions (optional)',
    instructionsPlaceholder: 'e.g. external audience, highlight performance improvements',
    items: 'Release items',
    searchItems: 'Search by title or ID',
    allTypes: 'All types',
    allStates: 'All states',
    allIterations: 'All iterations',
    type: 'Type',
    state: 'State',
    iteration: 'Iteration',
    selected: 'selected',
    selectVisible: 'Select visible',
    clearSelection: 'Clear selection',
    showingFirst: 'Showing the first {count} items. Refine the filters to see the rest.',
    limitReached: 'Limit of {count} items per release note.',
    noItems: 'No items match the filters.',
    loadingItems: 'Loading items...',
    itemsError: 'Could not load items.',
    generating: 'Generating release note',
    submitGenerate: 'Generate release note',
    basedOn: 'Based on {count} item(s)',
    updated: 'Updated',
  },
} as const;

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function itemType(item: PbiItem): string {
  return (
    text(item.sourceData.adkCardType) ||
    text(item.sourceData.type) ||
    (item.kind === 'pbi' ? 'PBI' : 'Card')
  );
}
function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}
function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ReleaseNotesView({ apiClient, workspaceId, isReadOnly = false }: Props) {
  const { locale, formatDate, t } = useI18n();
  const { runActivity } = useActivityRunner();
  const permissions = usePermissions();
  const canDelete = !isReadOnly && permissions.can('releaseNotes', 'delete');
  // Generation is built from selected PBIs, so it needs access to read them.
  const canGenerate = !isReadOnly && permissions.can('pbis');
  const c = copy[locale];
  const [notes, setNotes] = useState<ReleaseNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState<Draft>({ title: '', version: '', content: '' });
  const [deleteNote, setDeleteNote] = useState<ReleaseNote | null>(null);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [agentId, setAgentId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [items, setItems] = useState<PbiItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [itemQuery, setItemQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [iterationFilter, setIterationFilter] = useState('');
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const deferredItemQuery = useDeferredValue(itemQuery);
  const selected = notes.find((note) => note.id === selectedId) ?? null;

  const load = useCallback(async () => {
    if (!workspaceId) {
      setNotes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await apiClient.getReleaseNotes();
      setNotes(list);
      setSelectedId((current) =>
        current && list.some((note) => note.id === current) ? current : (list[0]?.id ?? null),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c.loadError);
    } finally {
      setLoading(false);
    }
  }, [apiClient, workspaceId, c.loadError]);
  useEffect(() => {
    void load();
  }, [load]);

  // Agents and work items are only needed by the generator, so they load on demand.
  useEffect(() => {
    if (mode !== 'generate' || items) return;
    let active = true;
    setItemsError(null);
    void Promise.all([
      apiClient.getPbiItems(),
      apiClient.getAgents(),
      apiClient.getPbiCurrentIteration().catch(() => null),
    ]).then(
      ([list, agentList, currentIteration]) => {
        if (!active) return;
        setItems(list);
        setAgents(agentList);
        setAgentId((current) => current || (agentList[0]?.id ?? ''));
        if (currentIteration) setIterationFilter(currentIteration);
      },
      (cause: unknown) => {
        if (active) setItemsError(cause instanceof Error ? cause.message : c.itemsError);
      },
    );
    return () => {
      active = false;
    };
  }, [apiClient, mode, items, c.itemsError]);

  const itemOptions = useMemo(() => {
    const types = new Set<string>();
    const states = new Set<string>();
    const iterations = new Set<string>();
    for (const item of items ?? []) {
      types.add(itemType(item));
      if (item.status) states.add(item.status);
      const iteration = text(item.sourceData.iterationPath);
      if (iteration) iterations.add(iteration);
    }
    const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b, locale));
    return { types: sorted(types), states: sorted(states), iterations: sorted(iterations) };
  }, [items, locale]);
  const searchIndex = useMemo(
    () =>
      new Map(
        (items ?? []).map((item) => [
          item.id,
          normalize([item.title, ...item.links.map((link) => link.externalId)].join(' ')),
        ]),
      ),
    [items],
  );
  const filteredItems = useMemo(() => {
    const terms = normalize(deferredItemQuery).split(/\s+/).filter(Boolean);
    return (items ?? []).filter(
      (item) =>
        terms.every((term) => searchIndex.get(item.id)?.includes(term)) &&
        (!typeFilter || itemType(item) === typeFilter) &&
        (!stateFilter || item.status === stateFilter) &&
        (!iterationFilter || text(item.sourceData.iterationPath) === iterationFilter),
    );
  }, [items, searchIndex, deferredItemQuery, typeFilter, stateFilter, iterationFilter]);
  const itemById = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);

  const runAction = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c.actionError);
    } finally {
      setBusy(false);
    }
  };
  const startManual = () => {
    setDraft({ title: '', version: '', content: '' });
    setMode('edit');
  };
  const startEdit = (note: ReleaseNote) => {
    setSelectedId(note.id);
    setDraft({ id: note.id, title: note.title, version: note.version, content: note.content });
    setMode('edit');
  };
  const startGenerate = () => {
    setDraft({ title: '', version: '', content: '' });
    setSelectedItems(new Set());
    setInstructions('');
    setMode('generate');
  };
  const saveDraft = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const fields = {
        title: draft.title.trim(),
        version: draft.version.trim(),
        content: draft.content,
      };
      const saved = draft.id
        ? await apiClient.updateReleaseNote(draft.id, fields)
        : await apiClient.createReleaseNote(fields);
      setSelectedId(saved.id);
      setMode('view');
      await load();
    });
  };
  const generate = (event: FormEvent) => {
    event.preventDefault();
    if (!agentId || !selectedItems.size) return;
    const fields = {
      title: draft.title.trim(),
      version: draft.version.trim() || undefined,
      agentId,
      itemIds: [...selectedItems],
      instructions: instructions.trim() || undefined,
    };
    void runAction(async () => {
      const note = await runActivity(
        { kind: 'agent', title: `${c.generating}: ${fields.title}` },
        () => apiClient.generateReleaseNote(fields),
      );
      setSelectedId(note.id);
      setMode('view');
      await load();
    });
  };
  const exportNote = (note: ReleaseNote, format: ReleaseNoteExportFormat) =>
    void runAction(async () => {
      const extension = format === 'markdown' ? 'md' : format;
      const { blob, fileName } = await runActivity(
        { kind: 'download', title: `${note.title}.${extension}` },
        () => apiClient.exportReleaseNote(note.id, format),
      );
      download(blob, fileName ?? `${note.title}.${extension}`);
    });
  const toggleItem = (id: string) =>
    setSelectedItems((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < maxSelectedItems) next.add(id);
      return next;
    });
  const resolveAuditValue = (key: string, value: AuditSnapshot): string | undefined => {
    // agentId never reaches resolvers: HistoryViewer hides it from snapshots.
    if (key === 'itemIds' && Array.isArray(value))
      return value
        .map((id) => (typeof id === 'string' ? (itemById.get(id)?.title ?? id) : ''))
        .filter(Boolean)
        .join('\n');
    return undefined;
  };

  const exportButtons = (note: ReleaseNote) =>
    (
      [
        ['markdown', 'ti-markdown', c.exportMarkdown],
        ['pdf', 'ti-file-type-pdf', c.exportPdf],
        ['docx', 'ti-file-type-docx', c.exportDocx],
      ] as const
    ).map(([format, icon, label]) => (
      <Button
        key={format}
        variant="ghost"
        role="menuitem"
        className="flex w-full justify-start text-left"
        disabled={busy}
        onClick={() => exportNote(note, format)}
      >
        <i className={`ti ${icon}`} aria-hidden="true" /> {label}
      </Button>
    ));

  return (
    <main className="flex w-full flex-col gap-5 p-6 text-[var(--text-primary)] 2xl:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('nav.releaseNotes')}</h1>
          <p className="text-sm text-[var(--text-muted)]">{c.subtitle}</p>
        </div>
        {!isReadOnly && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={startManual}>
              <i className="ti ti-plus" aria-hidden="true" /> {c.newNote}
            </Button>
            {canGenerate && (
              <Button onClick={startGenerate}>
                <i className="ti ti-sparkles" aria-hidden="true" /> {c.generate}
              </Button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
        >
          {error}
        </div>
      )}
      {loading ? (
        <SkeletonCard />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)]">
          {/* The list scrolls on its own so long histories never push the editor down. */}
          <aside
            className="space-y-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto lg:pr-1"
            aria-label={t('nav.releaseNotes')}
          >
            {notes.length === 0 && (
              <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-muted)]">
                {c.empty}
              </p>
            )}
            {notes.map((note) => (
              <article
                key={note.id}
                className={`flex items-start gap-2 rounded-lg border p-3 ${note.id === selectedId && mode === 'view' ? 'border-[var(--border-accent)] bg-[var(--fill-ghost-selected)]' : 'border-[var(--border)] bg-[var(--surface-1)]'}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setSelectedId(note.id);
                    setMode('view');
                  }}
                >
                  <span className="block truncate font-medium">{note.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    {note.version && (
                      <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5">
                        {note.version}
                      </span>
                    )}
                    <span>
                      {c.updated} {formatDate(note.updatedAt, { dateStyle: 'short' })}
                    </span>
                  </span>
                </button>
                <ActionsMenu label={`${c.actions}: ${note.title}`} portal>
                  <HistoryViewer
                    apiClient={apiClient}
                    entityType="release_note"
                    workspaceId={workspaceId}
                    entityId={note.id}
                    entityTitle={note.title}
                    resolveValue={resolveAuditValue}
                  />
                  {exportButtons(note)}
                  {!isReadOnly && (
                    <Button
                      variant="ghost"
                      role="menuitem"
                      className="flex w-full justify-start text-left"
                      onClick={() => startEdit(note)}
                    >
                      <i className="ti ti-pencil" aria-hidden="true" /> {c.edit}
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="ghost"
                      role="menuitem"
                      className="flex w-full justify-start text-left text-red-400"
                      onClick={() => setDeleteNote(note)}
                    >
                      <i className="ti ti-trash" aria-hidden="true" /> {c.delete}
                    </Button>
                  )}
                </ActionsMenu>
              </article>
            ))}
          </aside>

          <section className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6">
            {mode === 'edit' && (
              <form onSubmit={saveDraft} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
                  <label className="block space-y-1 text-sm">
                    <span>{c.title}</span>
                    <Input
                      required
                      maxLength={240}
                      value={draft.title}
                      onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span>{c.version}</span>
                    <Input
                      maxLength={100}
                      placeholder={c.versionPlaceholder}
                      value={draft.version}
                      onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                    />
                  </label>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <label className="block space-y-1 text-sm">
                    <span>{c.content}</span>
                    <Textarea
                      className="h-[calc(100vh-22rem)] min-h-[360px] resize-none font-mono text-sm"
                      value={draft.content}
                      onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                    />
                  </label>
                  <div className="min-w-0 space-y-1 text-sm">
                    <span>{c.preview}</span>
                    <div className="h-[calc(100vh-22rem)] min-h-[360px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-4">
                      <MarkdownViewer content={draft.content} showModeToggle={false} />
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setMode('view')}>
                    {c.cancel}
                  </Button>
                  <Button type="submit" isLoading={busy} disabled={!draft.title.trim()}>
                    {c.save}
                  </Button>
                </div>
              </form>
            )}

            {mode === 'generate' && (
              <form onSubmit={generate} className="space-y-4">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_200px_minmax(0,1fr)]">
                  <label className="block space-y-1 text-sm">
                    <span>{c.title}</span>
                    <Input
                      required
                      maxLength={240}
                      value={draft.title}
                      onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span>{c.version}</span>
                    <Input
                      maxLength={100}
                      placeholder={c.versionPlaceholder}
                      value={draft.version}
                      onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span>{c.agent}</span>
                    <Select
                      required
                      value={agentId}
                      onChange={(event) => setAgentId(event.target.value)}
                    >
                      <option value="">{c.selectAgent}</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                {items && !agents.length && (
                  <p className="text-xs text-[var(--text-muted)]">{c.noAgents}</p>
                )}
                <label className="block space-y-1 text-sm">
                  <span>{c.instructions}</span>
                  <Textarea
                    rows={2}
                    maxLength={4000}
                    placeholder={c.instructionsPlaceholder}
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                  />
                </label>
                <fieldset className="space-y-3">
                  <legend className="mb-2 flex w-full flex-wrap items-center justify-between gap-2 text-sm font-semibold">
                    <span>{c.items}</span>
                    <span className="text-xs font-normal text-[var(--text-muted)]">
                      {selectedItems.size} {c.selected}
                    </span>
                  </legend>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={c.searchItems}
                      placeholder={c.searchItems}
                      value={itemQuery}
                      onChange={(event) => setItemQuery(event.target.value)}
                      className="max-w-sm"
                    />
                    <Select
                      aria-label={c.type}
                      value={typeFilter}
                      onChange={(event) => setTypeFilter(event.target.value)}
                      containerClassName="max-w-48"
                    >
                      <option value="">{c.allTypes}</option>
                      {itemOptions.types.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={c.state}
                      value={stateFilter}
                      onChange={(event) => setStateFilter(event.target.value)}
                      containerClassName="max-w-44"
                    >
                      <option value="">{c.allStates}</option>
                      {itemOptions.states.map((state) => (
                        <option key={state} value={state}>
                          {state}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={c.iteration}
                      value={iterationFilter}
                      onChange={(event) => setIterationFilter(event.target.value)}
                      containerClassName="w-72 max-w-full flex-none"
                    >
                      <option value="">{c.allIterations}</option>
                      {itemOptions.iterations.map((iteration) => (
                        <option key={iteration} value={iteration}>
                          {iteration}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!filteredItems.length}
                      onClick={() =>
                        setSelectedItems((current) => {
                          const next = new Set(current);
                          for (const item of filteredItems.slice(0, visibleItemLimit)) {
                            if (next.size >= maxSelectedItems) break;
                            next.add(item.id);
                          }
                          return next;
                        })
                      }
                    >
                      {c.selectVisible}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={!selectedItems.size}
                      onClick={() => setSelectedItems(new Set())}
                    >
                      {c.clearSelection}
                    </Button>
                  </div>
                  {selectedItems.size >= maxSelectedItems && (
                    <p role="status" className="text-xs text-amber-300">
                      {c.limitReached.replace('{count}', String(maxSelectedItems))}
                    </p>
                  )}
                  {itemsError ? (
                    <p role="alert" className="text-sm text-red-300">
                      {itemsError}
                    </p>
                  ) : !items ? (
                    <p role="status" className="text-sm text-[var(--text-muted)]">
                      {c.loadingItems}
                    </p>
                  ) : (
                    <div className="h-[calc(100vh-34rem)] min-h-[280px] overflow-y-auto rounded-md border border-[var(--border)]">
                      {filteredItems.length === 0 && (
                        <p className="p-4 text-sm text-[var(--text-muted)]">{c.noItems}</p>
                      )}
                      {filteredItems.slice(0, visibleItemLimit).map((item) => (
                        <label
                          key={item.id}
                          className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--fill-ghost-hover)]"
                        >
                          <input
                            type="checkbox"
                            checked={selectedItems.has(item.id)}
                            onChange={() => toggleItem(item.id)}
                          />
                          <span className="w-36 shrink-0 truncate rounded border border-[var(--border)] px-2 py-0.5 text-xs">
                            {itemType(item)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {item.links[0]?.externalId ? `#${item.links[0].externalId} ` : ''}
                            {item.title}
                          </span>
                          <span className="shrink-0 text-xs text-[var(--text-muted)]">
                            {item.status}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {filteredItems.length > visibleItemLimit && (
                    <p className="text-xs text-[var(--text-muted)]">
                      {c.showingFirst.replace('{count}', String(visibleItemLimit))}
                    </p>
                  )}
                </fieldset>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setMode('view')}>
                    {c.cancel}
                  </Button>
                  <Button
                    type="submit"
                    isLoading={busy}
                    disabled={!draft.title.trim() || !agentId || !selectedItems.size}
                  >
                    <i className="ti ti-sparkles" aria-hidden="true" /> {c.submitGenerate}
                  </Button>
                </div>
              </form>
            )}

            {mode === 'view' &&
              (selected ? (
                <article>
                  <header className="mb-4 border-b border-[var(--border)] pb-4">
                    <h2 className="text-2xl font-semibold">{selected.title}</h2>
                    <p className="mt-1 flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
                      {selected.version && (
                        <span>
                          {c.version} {selected.version}
                        </span>
                      )}
                      <span>
                        {c.updated}{' '}
                        {formatDate(selected.updatedAt, { dateStyle: 'short', timeStyle: 'short' })}
                      </span>
                      {selected.itemIds.length > 0 && (
                        <span>{c.basedOn.replace('{count}', String(selected.itemIds.length))}</span>
                      )}
                    </p>
                  </header>
                  <MarkdownViewer content={selected.content} showModeToggle={false} />
                </article>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">{c.selectHint}</p>
              ))}
          </section>
        </div>
      )}
      {deleteNote && (
        <ConfirmationDialog
          open
          title={c.deleteTitle}
          description={c.deleteDescription.replace('{title}', deleteNote.title)}
          confirmLabel={c.delete}
          cancelLabel={c.cancel}
          destructive
          isLoading={busy}
          onCancel={() => setDeleteNote(null)}
          onConfirm={() => {
            const id = deleteNote.id;
            void runAction(async () => {
              await apiClient.deleteReleaseNote(id);
              setDeleteNote(null);
              if (selectedId === id) setSelectedId(null);
              await load();
            });
          }}
        />
      )}
    </main>
  );
}
