import { useId, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';

/**
 * A "?" icon that shows `children` while hovered or focused. Screen readers get the text as
 * the icon's description, so it is announced without opening anything.
 */
export function HelpTooltip({
  children,
  label,
  className,
}: {
  readonly children: ReactNode;
  /** Accessible name of the icon; defaults to "More information". */
  readonly label?: string;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label ?? t('common.moreInfo')}
        aria-describedby={id}
        className="inline-flex size-4 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bg-accent)]"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        // A click (or tap) only opens it: there is nothing to submit.
        onClick={() => setOpen(true)}
      >
        <i className="ti ti-help-circle text-sm" aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          // Opens to the right of the icon: labels sit on the left of forms and dialogs.
          'absolute -left-2 top-full z-30 mt-1.5 w-max max-w-72 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-normal leading-snug text-[var(--text-secondary)] shadow-lg',
          !open && 'sr-only',
        )}
      >
        {children}
      </span>
    </span>
  );
}

/** A form label with an optional help tooltip next to it. */
export function FieldLabel({
  htmlFor,
  children,
  hint,
  className,
}: {
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly hint?: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {children}
      </label>
      {hint && <HelpTooltip>{hint}</HelpTooltip>}
    </span>
  );
}
