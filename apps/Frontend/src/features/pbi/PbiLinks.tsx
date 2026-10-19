import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { useI18n } from '../../lib/i18n/index.js';
import {
  pbiLinkTypes,
  type PbiItem,
  type PbiLinkType,
  type PbiProviderId,
  type PbiRelation,
} from './pbi-types.js';

const copy = {
  'pt-BR': {
    links: 'Links',
    addLink: 'Adicionar link',
    existingItem: 'Item existente',
    newItem: 'Novo item',
    addingFrom: 'Você está adicionando um link a partir de:',
    linkType: 'Tipo de link',
    itemsToLink: 'Itens a vincular',
    search: 'Buscar itens por ID ou título',
    noResults: 'Nenhum item encontrado.',
    selected: 'selecionado(s)',
    removeSelection: 'Remover seleção',
    title: 'Título',
    cancel: 'Cancelar',
    save: 'Adicionar link',
    create: 'Criar e vincular',
    remove: 'Remover link',
    loading: 'Carregando links...',
    loadError: 'Não foi possível carregar os links.',
    retry: 'Tentar novamente',
    empty: 'Nenhum link neste item.',
    readOnlySource: 'Lido de {provider}',
    notImported: 'não importado',
    types: {
      parent: 'Pai',
      child: 'Filho',
      related: 'Relacionado',
      predecessor: 'Predecessor',
      successor: 'Sucessor',
      duplicate: 'Duplicado',
      duplicate_of: 'Duplicata de',
      tests: 'Testa',
      tested_by: 'Testado por',
    } satisfies Record<PbiLinkType, string>,
  },
  'en-US': {
    links: 'Links',
    addLink: 'Add link',
    existingItem: 'Existing item',
    newItem: 'New item',
    addingFrom: 'You are adding a link from:',
    linkType: 'Link type',
    itemsToLink: 'Items to link',
    search: 'Search items by ID or title',
    noResults: 'No items found.',
    selected: 'selected',
    removeSelection: 'Remove selection',
    title: 'Title',
    cancel: 'Cancel',
    save: 'Add link',
    create: 'Create and link',
    remove: 'Remove link',
    loading: 'Loading links...',
    loadError: 'Could not load links.',
    retry: 'Try again',
    empty: 'No links on this item.',
    readOnlySource: 'Read from {provider}',
    notImported: 'not imported',
    types: {
      parent: 'Parent',
      child: 'Child',
      related: 'Related',
      predecessor: 'Predecessor',
      successor: 'Successor',
      duplicate: 'Duplicate',
      duplicate_of: 'Duplicate of',
      tests: 'Tests',
      tested_by: 'Tested by',
    } satisfies Record<PbiLinkType, string>,
  },
} as const;
const providerNames: Record<string, string> = {
  azure_devops: 'Azure DevOps',
  trello: 'Trello',
  github_projects: 'GitHub Projects',
  jira: 'Jira',
};

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}
function shortId(item: Pick<PbiItem, 'id' | 'links'>): string {
  return item.links[0]?.externalId ?? item.id.slice(0, 8);
}

interface Props {
  apiClient: ApiClient;
  item: PbiItem;
  items: readonly PbiItem[];
  isReadOnly?: boolean;
  /** Opens another item in the editor. */
  onOpenItem: (id: string) => void;
  /** The hierarchy or items changed (parent/child links, new items); reload the board. */
  onChanged: () => Promise<void> | void;
}

type Mode = 'existing' | 'new' | null;

/**
 * Links of a backlog item, like Azure DevOps "Add link": link to one or more existing items or
 * create a new linked item. Parent/child links change the hierarchy; the others are N:N.
 */
export function PbiLinks({ apiClient, item, items, isReadOnly, onOpenItem, onChanged }: Props) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [relations, setRelations] = useState<PbiRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [type, setType] = useState<PbiLinkType>('related');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void apiClient
      .getPbiRelations(item.id)
      .then(
        (list) => {
          if (active) setRelations(list);
        },
        (cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : c.loadError);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, item.id, request, c.loadError]);
  useEffect(() => {
    setMode(null);
    setMenuOpen(false);
  }, [item.id]);

  const byId = useMemo(() => new Map(items.map((entry) => [entry.id, entry])), [items]);
  const linkedIds = useMemo(
    () =>
      new Set(
        relations
          .filter((relation) => relation.type === type && relation.item)
          .map((relation) => relation.item!.id),
      ),
    [relations, type],
  );
  const results = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const matches: PbiItem[] = [];
    for (const entry of items) {
      if (entry.id === item.id || linkedIds.has(entry.id)) continue;
      const text = normalize(
        [entry.title, entry.id, ...entry.links.map((link) => link.externalId)].join(' '),
      );
      if (terms.every((term) => text.includes(term))) matches.push(entry);
      if (matches.length >= 20) break;
    }
    return matches;
  }, [items, item.id, linkedIds, query]);

  const open = (next: Exclude<Mode, null>) => {
    setMenuOpen(false);
    setMode(next);
    setType(next === 'new' ? 'child' : 'related');
    setQuery('');
    setSelected([]);
    setTitle('');
    setActionError(null);
  };
  const run = async (task: () => Promise<void>) => {
    setSaving(true);
    setActionError(null);
    try {
      await task();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : c.loadError);
    } finally {
      setSaving(false);
    }
  };
  const addExisting = (event: FormEvent) => {
    event.preventDefault();
    if (!selected.length) return;
    void run(async () => {
      setRelations(await apiClient.addPbiRelations(item.id, type, selected));
      setMode(null);
      if (type === 'parent' || type === 'child') await onChanged();
    });
  };
  const addNew = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return;
    void run(async () => {
      const created = await apiClient.createPbiItem(
        type === 'child'
          ? { kind: 'card', title: name, parentId: item.id }
          : { kind: 'pbi', title: name },
      );
      if (type !== 'child')
        setRelations(await apiClient.addPbiRelations(item.id, type, [created.id]));
      setMode(null);
      await onChanged();
      onOpenItem(created.id);
    });
  };
  const remove = (relation: PbiRelation) =>
    void run(async () => {
      setRelations(await apiClient.removePbiRelation(item.id, relation.type, relation.item!.id));
      if (relation.type === 'parent' || relation.type === 'child') await onChanged();
    });

  const groups = pbiLinkTypes
    .map((linkType) => ({
      type: linkType,
      entries: relations.filter((relation) => relation.type === linkType),
    }))
    .filter((group) => group.entries.length);

  return (
    <section className="border-t border-[var(--border)] pt-4" aria-label={c.links}>
      <div className="relative mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{c.links}</h3>
        {!isReadOnly && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <i className="ti ti-link-plus" aria-hidden="true" />
            {c.addLink}
            <i className="ti ti-chevron-down" aria-hidden="true" />
          </Button>
        )}
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-48 rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-lg"
          >
            <Button
              type="button"
              variant="ghost"
              role="menuitem"
              className="flex w-full justify-start gap-2 text-left"
              onClick={() => open('existing')}
            >
              <i className="ti ti-link" aria-hidden="true" />
              {c.existingItem}
            </Button>
            <Button
              type="button"
              variant="ghost"
              role="menuitem"
              className="flex w-full justify-start gap-2 text-left"
              onClick={() => open('new')}
            >
              <i className="ti ti-pencil" aria-hidden="true" />
              {c.newItem}
            </Button>
          </div>
        )}
      </div>
      {mode && (
        <form
          onSubmit={mode === 'existing' ? addExisting : addNew}
          aria-label={mode === 'existing' ? c.existingItem : c.newItem}
          className="mb-4 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm"
        >
          <div>
            <p className="text-xs text-[var(--text-muted)]">{c.addingFrom}</p>
            <p className="mt-1 break-words font-medium">
              <span className="mr-2 text-[var(--text-muted)]">{shortId(item)}</span>
              {item.title}
            </p>
          </div>
          <label className="block text-xs font-semibold">
            {c.linkType}
            <Select
              value={type}
              onChange={(event) => setType(event.target.value as PbiLinkType)}
              containerClassName="mt-1"
            >
              {pbiLinkTypes.map((linkType) => (
                <option key={linkType} value={linkType}>
                  {c.types[linkType]}
                </option>
              ))}
            </Select>
          </label>
          {mode === 'existing' ? (
            <div>
              <label className="block text-xs font-semibold">
                {c.itemsToLink}
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={c.search}
                  aria-label={c.search}
                  className="mt-1"
                />
              </label>
              {selected.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1" aria-label={c.selected}>
                  {selected.map((id) => (
                    <span
                      key={id}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-1)] px-2 py-0.5 text-xs"
                    >
                      <span className="truncate">{byId.get(id)?.title ?? id}</span>
                      <button
                        type="button"
                        className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        aria-label={`${c.removeSelection}: ${byId.get(id)?.title ?? id}`}
                        onClick={() =>
                          setSelected((current) => current.filter((value) => value !== id))
                        }
                      >
                        <i className="ti ti-x" aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {query.trim() && (
                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto" role="listbox">
                  {results.length === 0 && (
                    <li className="text-xs text-[var(--text-muted)]">{c.noResults}</li>
                  )}
                  {results.map((entry) => {
                    const checked = selected.includes(entry.id);
                    return (
                      <li key={entry.id} role="option" aria-selected={checked}>
                        <button
                          type="button"
                          className={`flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-[var(--fill-ghost-hover)] ${checked ? 'text-[var(--text-accent)]' : ''}`}
                          onClick={() =>
                            setSelected((current) =>
                              checked
                                ? current.filter((value) => value !== entry.id)
                                : type === 'parent'
                                  ? [entry.id]
                                  : [...current, entry.id],
                            )
                          }
                        >
                          <i
                            className={`ti ${checked ? 'ti-square-check' : 'ti-square'} mt-0.5`}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 break-words">
                            <span className="mr-2 text-xs text-[var(--text-muted)]">
                              {shortId(entry)}
                            </span>
                            {entry.title}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <label className="block text-xs font-semibold">
              {c.title}
              <Input
                value={title}
                required
                maxLength={240}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1"
              />
            </label>
          )}
          {actionError && (
            <p role="alert" className="text-xs text-red-300">
              {actionError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode(null)}>
              {c.cancel}
            </Button>
            <Button
              type="submit"
              size="sm"
              isLoading={saving}
              disabled={mode === 'existing' ? !selected.length : !title.trim()}
            >
              {mode === 'existing' ? c.save : c.create}
            </Button>
          </div>
        </form>
      )}
      {loading ? (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          {c.loading}
        </p>
      ) : error ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-red-300">
          <span>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRequest((value) => value + 1)}
          >
            {c.retry}
          </Button>
        </div>
      ) : groups.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{c.empty}</p>
      ) : (
        <div className="space-y-3">
          {!mode && actionError && (
            <p role="alert" className="text-xs text-red-300">
              {actionError}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.type}>
              <h4 className="mb-1 text-xs font-semibold text-[var(--text-muted)]">
                {c.types[group.type]} ({group.entries.length})
              </h4>
              <ul className="space-y-1">
                {group.entries.map((relation) => (
                  <li
                    key={`${relation.origin}:${relation.item?.id ?? relation.externalId}`}
                    className="flex items-start gap-1"
                  >
                    {relation.item ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="flex h-auto min-w-0 flex-1 justify-start gap-2 whitespace-normal text-left"
                        onClick={() => onOpenItem(relation.item!.id)}
                      >
                        <i className="ti ti-link shrink-0" aria-hidden="true" />
                        <span className="min-w-0 break-words">
                          <span className="mr-2 text-xs text-[var(--text-muted)]">
                            {relation.item.links[0]?.externalId ?? relation.item.type}
                          </span>
                          {relation.item.title}
                        </span>
                      </Button>
                    ) : (
                      <p className="flex-1 px-3 py-1 text-xs text-[var(--text-muted)]">
                        #{relation.externalId} · {c.notImported}
                      </p>
                    )}
                    {relation.origin !== 'adk' ? (
                      <span
                        className="shrink-0 px-2 py-1 text-[10px] text-[var(--text-muted)]"
                        title={c.readOnlySource.replace(
                          '{provider}',
                          providerNames[relation.origin as PbiProviderId] ?? relation.origin,
                        )}
                      >
                        {providerNames[relation.origin as PbiProviderId] ?? relation.origin}
                      </span>
                    ) : (
                      !isReadOnly && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          aria-label={`${c.remove}: ${relation.item!.title}`}
                          title={c.remove}
                          disabled={saving}
                          onClick={() => remove(relation)}
                        >
                          <i className="ti ti-unlink" aria-hidden="true" />
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
