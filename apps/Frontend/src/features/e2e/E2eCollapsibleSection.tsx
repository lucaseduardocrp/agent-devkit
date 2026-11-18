import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';

/**
 * A titled panel of the test detail whose body can be collapsed. It starts expanded; the body stays
 * mounted while collapsed so drafts and loaded screenshots survive a toggle.
 */
export function E2eCollapsibleSection({
  title,
  icon,
  testId,
  children,
}: {
  readonly title: string;
  /** Tabler icon class, e.g. `ti-scale`. */
  readonly icon: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = `${testId}-body`;

  return (
    <section
      className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
      data-testid={testId}
    >
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        <Button
          variant="ghost"
          className={cn(
            'h-auto w-full justify-between gap-2 rounded-b-none rounded-t-lg px-4 py-2 text-sm font-semibold',
            open && 'border-b border-[var(--border)]',
          )}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="flex items-center gap-2">
            <i className={cn('ti text-[var(--text-accent)]', icon)} aria-hidden="true" />
            {title}
          </span>
          <i
            className={cn('ti ti-chevron-down transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </Button>
      </h3>
      <div id={bodyId} data-testid={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
