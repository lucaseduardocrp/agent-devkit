import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useI18n } from '../../lib/i18n/index.js';
import { tablerIcons } from './tabler-icons.js';
import {
  WorkItemTypeBadge,
  isHexColor,
  defaultWorkItemTypes,
  workItemTypeColors,
  workItemTypePalette,
  type WorkItemType,
} from './work-item-types.js';

const copy = {
  'pt-BR': {
    title: 'Tipos de item',
    description:
      'Defina nome, cor e ícone de cada tipo. As cores valem para os cards do backlog e para as issues.',
    label: 'Nome',
    key: 'Chave',
    color: 'Cor',
    icon: 'Ícone',
    aliases: 'Apelidos (separados por vírgula)',
    add: 'Adicionar tipo',
    remove: 'Remover tipo',
    save: 'Salvar tipos',
    reset: 'Restaurar padrão',
    saved: 'Tipos salvos.',
    loadError: 'Não foi possível carregar os tipos.',
    saveError: 'Não foi possível salvar os tipos.',
    newType: 'Novo tipo',
    preview: 'Pré-visualização',
    customColor: 'Cor personalizada',
    chooseIcon: 'Escolher ícone',
    searchIcons: 'Pesquisar ícones',
    noIcons: 'Nenhum ícone encontrado.',
    close: 'Fechar',
    loading: 'Carregando tipos...',
  },
  'en-US': {
    title: 'Work item types',
    description:
      'Set the name, color and icon of each type. Colors apply to backlog cards and issues.',
    label: 'Name',
    key: 'Key',
    color: 'Color',
    icon: 'Icon',
    aliases: 'Aliases (comma separated)',
    add: 'Add type',
    remove: 'Remove type',
    save: 'Save types',
    reset: 'Restore defaults',
    saved: 'Types saved.',
    loadError: 'Could not load the types.',
    saveError: 'Could not save the types.',
    newType: 'New type',
    preview: 'Preview',
    customColor: 'Custom color',
    chooseIcon: 'Choose icon',
    searchIcons: 'Search icons',
    noIcons: 'No icons found.',
    close: 'Close',
    loading: 'Loading types...',
  },
} as const;

const slug = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

interface Props {
  readonly apiClient: ApiClient;
  readonly canEdit: boolean;
  readonly onSaved?: (types: readonly WorkItemType[]) => void;
}

export function WorkItemTypesPanel({ apiClient, canEdit, onSaved }: Props) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [types, setTypes] = useState<WorkItemType[]>([]);
  const [aliasDrafts, setAliasDrafts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [iconPickerIndex, setIconPickerIndex] = useState<number | null>(null);
  const [iconSearch, setIconSearch] = useState('');
  const filteredIcons = useMemo(() => {
    const query = iconSearch.trim().toLowerCase();
    return query ? tablerIcons.filter((icon) => icon.includes(query)) : tablerIcons;
  }, [iconSearch]);

  const load = (list: readonly WorkItemType[]) => {
    setTypes(list.map((type) => ({ ...type })));
    setAliasDrafts(list.map((type) => type.aliases.join(', ')));
  };
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => apiClient.getWorkItemTypes())
      .then(
        (list) => {
          if (active) load(list);
        },
        () => {
          if (active) setError(c.loadError);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, c.loadError]);

  const change = (index: number, patch: Partial<WorkItemType>) => {
    setNotice(null);
    setTypes((current) => current.map((type, i) => (i === index ? { ...type, ...patch } : type)));
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = types.map((type, index) => ({
        ...type,
        key: type.key || slug(type.label),
        aliases: aliasDrafts[index]!.split(',')
          .map((alias) => alias.trim())
          .filter(Boolean),
      }));
      const saved = await apiClient.saveWorkItemTypes(payload);
      load(saved);
      setNotice(c.saved);
      onSaved?.(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c.saveError);
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div
        className="space-y-4"
        role="status"
        aria-label={c.loading}
        data-testid="work-item-types-loading"
      >
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Skeleton className="h-12 w-full rounded-md" />
              <Skeleton className="h-12 w-full rounded-md" />
              <Skeleton className="h-12 w-full rounded-md" />
            </div>
            <Skeleton className="h-12 w-full rounded-md" />
            <div className="flex items-center gap-2">
              {Array.from({ length: 11 }).map((_, dot) => (
                <Skeleton key={dot} className="h-6 w-6" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  return (
    <div className="space-y-4" data-testid="work-item-types-panel">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{c.title}</h2>
        <p className="text-xs text-muted">{c.description}</p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-[var(--text-accent)]">
          {notice}
        </p>
      )}
      <ul className="space-y-3">
        {types.map((type, index) => (
          <li
            key={index}
            className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3"
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr]">
              <label className="block text-xs font-semibold">
                {c.label}
                <Input
                  className="mt-1"
                  value={type.label}
                  maxLength={60}
                  disabled={!canEdit}
                  onChange={(event) => change(index, { label: event.target.value })}
                />
              </label>
              <label className="block text-xs font-semibold">
                {c.key}
                <Input
                  className="mt-1"
                  value={type.key}
                  maxLength={40}
                  disabled={!canEdit}
                  onChange={(event) => change(index, { key: slug(event.target.value) })}
                />
              </label>
              <div className="block text-xs font-semibold">
                {c.icon}
                <Button
                  type="button"
                  variant="outline"
                  className="mt-1 flex w-full justify-start"
                  disabled={!canEdit}
                  aria-label={`${c.icon}: ${type.icon}`}
                  onClick={() => {
                    setIconSearch('');
                    setIconPickerIndex(index);
                  }}
                >
                  <i className={`ti ti-${type.icon}`} aria-hidden="true" />
                  <span className="truncate">{type.icon}</span>
                </Button>
              </div>
            </div>
            <label className="block text-xs font-semibold">
              {c.aliases}
              <Input
                className="mt-1"
                // aliasDrafts and types change together, so the draft always exists.
                /* v8 ignore next */
                value={aliasDrafts[index] ?? ''}
                disabled={!canEdit}
                onChange={(event) =>
                  setAliasDrafts((current) =>
                    current.map((draft, i) => (i === index ? event.target.value : draft)),
                  )
                }
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <div role="radiogroup" aria-label={c.color} className="flex flex-wrap gap-1.5">
                {workItemTypeColors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={type.color === color}
                    aria-label={color}
                    title={color}
                    disabled={!canEdit}
                    onClick={() => change(index, { color })}
                    className={`h-6 w-6 rounded-full border-2 ${workItemTypePalette[color].swatch} ${type.color === color ? 'border-white' : 'border-transparent opacity-70 hover:opacity-100'}`}
                  />
                ))}
                <label
                  className={`relative h-6 w-6 overflow-hidden rounded-full border-2 ${isHexColor(type.color) ? 'border-white' : 'border-[var(--border-strong)]'}`}
                  title={c.customColor}
                  style={
                    isHexColor(type.color)
                      ? { backgroundColor: type.color }
                      : {
                          background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                        }
                  }
                >
                  <input
                    type="color"
                    aria-label={c.customColor}
                    disabled={!canEdit}
                    value={isHexColor(type.color) ? type.color : '#6366f1'}
                    onChange={(event) => change(index, { color: event.target.value })}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              </div>
              <span className="text-xs text-[var(--text-muted)]">{c.preview}</span>
              <WorkItemTypeBadge name={type.label || type.key} types={[type]} />
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  aria-label={`${c.remove}: ${type.label}`}
                  onClick={() => {
                    setNotice(null);
                    setTypes((current) => current.filter((_, i) => i !== index));
                    setAliasDrafts((current) => current.filter((_, i) => i !== index));
                  }}
                >
                  <i className="ti ti-trash" aria-hidden="true" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setNotice(null);
              setTypes((current) => [
                ...current,
                {
                  key: '',
                  label: c.newType,
                  color: 'slate',
                  icon: 'file-description',
                  aliases: [],
                },
              ]);
              setAliasDrafts((current) => [...current, '']);
            }}
          >
            <i className="ti ti-plus" aria-hidden="true" /> {c.add}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setNotice(null);
              load(defaultWorkItemTypes);
            }}
          >
            {c.reset}
          </Button>
          <Button type="button" isLoading={saving} onClick={() => void save()}>
            <i className="ti ti-device-floppy" aria-hidden="true" /> {c.save}
          </Button>
        </div>
      )}
      <Modal
        open={iconPickerIndex !== null}
        onClose={() => setIconPickerIndex(null)}
        labelledBy="work-item-icon-title"
      >
        <div className="flex h-[min(80vh,640px)] w-[min(94vw,560px)] flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-5">
          <div className="flex items-center justify-between">
            <h2 id="work-item-icon-title" className="text-sm font-semibold">
              {c.chooseIcon}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={c.close}
              onClick={() => setIconPickerIndex(null)}
            >
              <i className="ti ti-x" aria-hidden="true" />
            </Button>
          </div>
          <Input
            autoFocus
            aria-label={c.searchIcons}
            placeholder={c.searchIcons}
            leftIcon={<i className="ti ti-search" aria-hidden="true" />}
            value={iconSearch}
            onChange={(event) => setIconSearch(event.target.value)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {filteredIcons.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-muted)]">{c.noIcons}</p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
                {filteredIcons.map((icon) => (
                  <Button
                    key={icon}
                    type="button"
                    variant="ghost"
                    aria-label={icon}
                    title={icon}
                    className={`flex h-auto flex-col gap-1 px-1 py-2 text-[10px] ${
                      iconPickerIndex !== null && types[iconPickerIndex]?.icon === icon
                        ? 'bg-[var(--fill-ghost-hover)] ring-2 ring-[var(--border-accent)]'
                        : ''
                    }`}
                    onClick={() => {
                      // The picker is only open while an index is chosen.
                      /* v8 ignore next */
                      if (iconPickerIndex !== null) change(iconPickerIndex, { icon });
                      setIconPickerIndex(null);
                    }}
                  >
                    <i className={`ti ti-${icon} text-xl`} aria-hidden="true" />
                    <span className="w-full truncate">{icon}</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
