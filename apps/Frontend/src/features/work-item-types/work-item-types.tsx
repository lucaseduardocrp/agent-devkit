import { useEffect, useState, type CSSProperties } from 'react';
import type { ApiClient } from '../../lib/api-client.js';

export const workItemTypeColors = [
  'red',
  'orange',
  'amber',
  'emerald',
  'cyan',
  'sky',
  'blue',
  'violet',
  'fuchsia',
  'pink',
  'slate',
] as const;
export type WorkItemTypeColor = (typeof workItemTypeColors)[number];

export interface WorkItemType {
  readonly key: string;
  readonly label: string;
  /** A color token ({@link WorkItemTypeColor}), or a `#rrggbb` value chosen in the color picker. */
  readonly color: string;
  /** Tabler icon name without the `ti-` prefix. */
  readonly icon: string;
  readonly aliases: readonly string[];
}

/** Tailwind needs complete class names, so each color lists its classes literally. */
export const workItemTypePalette: Record<
  WorkItemTypeColor,
  { badge: string; icon: string; bar: string; swatch: string }
> = {
  red: {
    badge: 'border-red-500/25 bg-red-500/10 text-red-300',
    icon: 'text-red-400',
    bar: 'border-l-red-500',
    swatch: 'bg-red-500',
  },
  orange: {
    badge: 'border-orange-500/25 bg-orange-500/10 text-orange-300',
    icon: 'text-orange-400',
    bar: 'border-l-orange-500',
    swatch: 'bg-orange-500',
  },
  amber: {
    badge: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
    icon: 'text-amber-400',
    bar: 'border-l-amber-500',
    swatch: 'bg-amber-500',
  },
  emerald: {
    badge: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
    icon: 'text-emerald-400',
    bar: 'border-l-emerald-500',
    swatch: 'bg-emerald-500',
  },
  cyan: {
    badge: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-300',
    icon: 'text-cyan-400',
    bar: 'border-l-cyan-500',
    swatch: 'bg-cyan-500',
  },
  sky: {
    badge: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
    icon: 'text-sky-400',
    bar: 'border-l-sky-500',
    swatch: 'bg-sky-500',
  },
  blue: {
    badge: 'border-blue-500/25 bg-blue-500/10 text-blue-300',
    icon: 'text-blue-400',
    bar: 'border-l-blue-500',
    swatch: 'bg-blue-500',
  },
  violet: {
    badge: 'border-violet-500/25 bg-violet-500/10 text-violet-300',
    icon: 'text-violet-400',
    bar: 'border-l-violet-500',
    swatch: 'bg-violet-500',
  },
  fuchsia: {
    badge: 'border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300',
    icon: 'text-fuchsia-400',
    bar: 'border-l-fuchsia-500',
    swatch: 'bg-fuchsia-500',
  },
  pink: {
    badge: 'border-pink-500/25 bg-pink-500/10 text-pink-300',
    icon: 'text-pink-400',
    bar: 'border-l-pink-500',
    swatch: 'bg-pink-500',
  },
  slate: {
    badge: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
    icon: 'text-[var(--text-secondary)]',
    bar: 'border-l-slate-500',
    swatch: 'bg-slate-500',
  },
};

export const isHexColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

export interface TypePalette {
  badge: string;
  icon: string;
  bar: string;
  swatch: string;
  /** Sets `--wit` for custom hex colors; undefined for palette tokens. */
  style?: CSSProperties;
}

/** Classes for a token color, or CSS-variable based classes for a custom hex color. */
export function resolveTypePalette(color: string | undefined): TypePalette {
  if (color && isHexColor(color))
    return {
      badge:
        'border-[color-mix(in_srgb,var(--wit)_30%,transparent)] bg-[color-mix(in_srgb,var(--wit)_12%,transparent)] text-[color-mix(in_srgb,var(--wit)_70%,white)]',
      icon: 'text-[var(--wit)]',
      bar: 'border-l-[var(--wit)]',
      swatch: 'bg-[var(--wit)]',
      style: { '--wit': color } as CSSProperties,
    };
  return workItemTypePalette[
    (color as WorkItemTypeColor) in workItemTypePalette ? (color as WorkItemTypeColor) : 'slate'
  ];
}

/** Mirrors the backend defaults, used until the workspace types load or when they fail to. */
export const defaultWorkItemTypes: readonly WorkItemType[] = [
  { key: 'bug', label: 'Bug', color: 'red', icon: 'bug', aliases: [] },
  { key: 'task', label: 'Task', color: 'sky', icon: 'checklist', aliases: ['tarefa'] },
  { key: 'sac', label: 'SAC', color: 'amber', icon: 'message-circle', aliases: [] },
  {
    key: 'pbi',
    label: 'Product Backlog Item',
    color: 'violet',
    icon: 'layout-kanban',
    aliases: ['product backlog item', 'user story'],
  },
  { key: 'epic', label: 'Epic', color: 'fuchsia', icon: 'flag', aliases: [] },
  { key: 'feature', label: 'Feature', color: 'cyan', icon: 'sparkles', aliases: [] },
  {
    key: 'plano-de-teste',
    label: 'Plano de teste',
    color: 'emerald',
    icon: 'clipboard-list',
    aliases: [],
  },
];

export const fallbackWorkItemType: WorkItemType = {
  key: '',
  label: '',
  color: 'slate',
  icon: 'file-description',
  aliases: [],
};

const normalize = (value: string) => value.trim().toLocaleLowerCase('pt-BR');

/** The configured type a raw type name (key, label or alias, any case) refers to. */
export function resolveWorkItemType(
  types: readonly WorkItemType[],
  raw: string,
): WorkItemType | undefined {
  const name = normalize(raw);
  if (!name) return undefined;
  return (
    types.find((type) => type.key === name || normalize(type.label) === name) ??
    types.find((type) => type.aliases.some((alias) => normalize(alias) === name)) ??
    // Provider types such as "Plano de Teste - Sprint 3" resolve by their longest key prefix.
    types.find((type) => name.startsWith(normalize(type.label)))
  );
}

/** Loads the workspace's configured types; defaults apply until then. */
export function useWorkItemTypes(
  apiClient: Pick<ApiClient, 'getWorkItemTypes'>,
  workspaceId: string | null,
  refreshToken?: number,
): readonly WorkItemType[] {
  const [types, setTypes] = useState<readonly WorkItemType[]>(defaultWorkItemTypes);
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void Promise.resolve()
      .then(() => apiClient.getWorkItemTypes())
      .then(
        (list) => {
          if (active) setTypes(list);
        },
        () => {
          // Keep the defaults: colors are a convenience, not a requirement.
        },
      );
    return () => {
      active = false;
    };
  }, [apiClient, workspaceId, refreshToken]);
  return types;
}

/** Colored type label with its icon. Renders nothing for an untyped item. */
export function WorkItemTypeBadge({
  name,
  types,
  fallbackIcon = 'file-description',
  className = '',
}: {
  name: string;
  types: readonly WorkItemType[];
  fallbackIcon?: string;
  className?: string;
}) {
  if (!name.trim()) return null;
  const type = resolveWorkItemType(types, name);
  const palette = resolveTypePalette(type?.color);
  return (
    <span
      style={palette.style}
      className={`inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 text-xs font-medium ${palette.badge} ${className}`}
      title={name}
    >
      <i
        className={`ti ti-${type?.icon ?? fallbackIcon} shrink-0 ${palette.icon}`}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate whitespace-nowrap">{type?.label ?? name}</span>
    </span>
  );
}
