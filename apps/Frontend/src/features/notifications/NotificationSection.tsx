import React from 'react';

/**
 * One part of a notification form, set apart from the one above by a divider. It may carry a small
 * muted title, a control opposite it (a view switch), both, or neither. The first section of a
 * group has no divider, so wrap the sections of a form in one element.
 */
export function NotificationSection({
  title,
  action,
  children,
}: {
  readonly title?: string;
  /** Sits opposite the title (a view switch, for example). */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4 border-t border-[var(--border)] pt-6 first:border-t-0 first:pt-0">
      {(title || action) && (
        <div className="flex min-h-7 items-center justify-between gap-3">
          {title ? (
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {title}
            </h3>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
