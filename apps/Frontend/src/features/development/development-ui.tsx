import type { ReactNode } from 'react';
import { SplitLayout } from './SplitLayout.js';
import { Badge, type BadgeProps } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { ChangeStatus, SessionStatus } from './development-types.js';

type Tone = BadgeProps['variant'];
const CHANGE_TONES: Record<ChangeStatus, Tone> = {
  draft: 'outline',
  proposed: 'warning',
  approved: 'success',
  rejected: 'destructive',
  archived: 'outline',
};
const SESSION_TONES: Record<SessionStatus, Tone> = {
  queued: 'outline',
  running: 'default',
  waiting_review: 'warning',
  approved: 'success',
  failed: 'destructive',
  cancelled: 'outline',
};

export function ChangeBadge({ status }: { readonly status: ChangeStatus }) {
  const { messages } = useI18n();
  return <Badge variant={CHANGE_TONES[status]}>{messages.development.changeStatus[status]}</Badge>;
}

export function SessionBadge({ status }: { readonly status: SessionStatus }) {
  const { messages } = useI18n();
  return (
    <Badge variant={SESSION_TONES[status]}>{messages.development.sessionStatus[status]}</Badge>
  );
}

/** The two-pane layout of the screens: a list that scrolls on its own and the selected item. */
export function ListDetail({
  label,
  list,
  children,
}: {
  readonly label: string;
  readonly list: ReactNode;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <SplitLayout
      plain
      defaultWidth={300}
      label={t('common.resizeSidebar')}
      sideClassName="self-start lg:sticky lg:top-4 lg:max-h-[calc(100vh-11rem)]"
      side={
        <aside aria-label={label} className="min-w-0 flex-1 space-y-2 overflow-y-auto">
          {list}
        </aside>
      }
    >
      <div className="min-w-0 space-y-4">{children}</div>
    </SplitLayout>
  );
}

/** The bar over a list: search, the filters and, at the far end, the action that adds one. */
export function ListToolbar({
  search,
  onSearch,
  searchLabel,
  children,
  action,
}: {
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly searchLabel: string;
  /** The filters, shown next to the search. */
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder={searchLabel}
        aria-label={searchLabel}
        className="max-w-md flex-1"
      />
      {children}
      <div className="ml-auto flex items-center gap-2">{action}</div>
    </div>
  );
}

/** One framed list of rows. */
export function ListRows({ children }: { readonly children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
      {children}
    </div>
  );
}

/** A row of a list: it opens the item. */
export function ListRow({
  onSelect,
  children,
}: {
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="flex h-auto w-full items-center justify-start gap-3 rounded-none border-b border-[var(--border)] px-4 py-3 text-left font-normal last:border-b-0"
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}

export function Hint({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-muted)]">
      {children}
    </p>
  );
}

export function Panel({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4"
      aria-label={title}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <span className="text-xs text-[var(--text-muted)]">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="truncate text-[var(--text-secondary)]" title={label}>
        {label}
      </span>
      {children}
    </label>
  );
}

/** What every screen needs to act: the lock while a request runs and the wrapper that reloads. */
export interface SectionActions {
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly canDelete: boolean;
  readonly run: (action: () => Promise<unknown>) => Promise<void>;
}
