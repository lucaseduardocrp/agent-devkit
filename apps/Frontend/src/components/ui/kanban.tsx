import { cn } from '../../lib/utils.js';
import { Button } from './button.js';
import { Skeleton } from './skeleton.js';

/** Dashed slot that previews where a dragged card will land in the column under the pointer. */
export function KanbanDropPlaceholder({ title, label }: { title: string; label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      data-testid="kanban-drop-placeholder"
      className="rounded-md border-2 border-dashed border-[var(--border-accent)] bg-[var(--surface-2)]/40 p-2.5 text-xs text-[var(--text-accent)]"
    >
      <p className="mb-1 flex items-center gap-1.5 font-semibold">
        <i className="ti ti-arrow-down-circle" aria-hidden="true" />
        {label}
      </p>
      <p className="line-clamp-2 text-[var(--text-muted)]">{title}</p>
    </div>
  );
}

/** Replaces a card's content with a skeleton while its move is being saved. */
export function KanbanCardSaving({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      data-testid="kanban-card-saving"
      className="absolute inset-0 space-y-2 rounded-md bg-[var(--surface-2)] p-2.5"
    >
      <Skeleton className="h-3 w-1/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

/** Classes of a column: a valid drop target is highlighted, the rest keep the plain frame. */
export function kanbanColumnClass(isDropTarget: boolean): string {
  return cn(
    'flex w-72 shrink-0 flex-col rounded-lg border bg-[var(--surface-1)] transition-colors',
    isDropTarget
      ? 'border-[var(--border-accent)] bg-[var(--surface-2)] ring-1 ring-[var(--border-accent)]'
      : 'border-[var(--border)]',
  );
}

/** Classes that dim the card being dragged and block interaction while it is saving. */
export function kanbanCardStateClass(isDragging: boolean, isSaving: boolean): string {
  return cn(
    'relative transition-opacity',
    isDragging && 'opacity-40',
    isSaving && 'pointer-events-none',
  );
}

/** Marks a card whose move is still a draft, waiting to be sent. */
export function KanbanCardPending({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="kanban-card-pending"
      className="absolute right-1.5 top-1.5 text-xs text-[var(--text-accent)]"
    >
      <i className="ti ti-cloud-upload" aria-hidden="true" />
    </span>
  );
}

export interface KanbanDraftLabels {
  pending: string;
  saving: string;
  offline: string;
  error: string;
  saveNow: string;
  retry: string;
  discard: string;
}

/** Tells the user that card moves are a draft and lets them send or drop it. */
export function KanbanDraftBar({
  pending,
  saving,
  offline,
  error,
  labels,
  onSave,
  onDiscard,
}: {
  pending: number;
  saving: number;
  offline: boolean;
  error: string | null;
  labels: KanbanDraftLabels;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (pending === 0 && saving === 0) return null;
  const message = error
    ? `${labels.error}: ${error}`
    : offline
      ? labels.offline
      : saving > 0
        ? `${labels.saving} (${saving})`
        : `${pending} ${labels.pending}`;
  return (
    <div
      role="status"
      data-testid="kanban-draft-bar"
      className={cn(
        'mb-3 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm',
        error
          ? 'border-red-500/40 bg-red-500/10 text-red-300'
          : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)]',
      )}
    >
      <i
        className={cn(
          'ti',
          error
            ? 'ti-alert-triangle'
            : offline
              ? 'ti-wifi-off'
              : saving > 0
                ? 'ti-loader-2 animate-spin'
                : 'ti-cloud-upload',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">{message}</span>
      <Button type="button" size="sm" disabled={saving > 0} onClick={onSave}>
        {error ? labels.retry : labels.saveNow}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
        {labels.discard}
      </Button>
    </div>
  );
}
