import React from 'react';
import { cn } from '../../lib/utils.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Switch } from '../../components/ui/switch.js';
import { useI18n } from '../../lib/i18n/index.js';

export interface InspectorFrameProps {
  readonly titleId: string;
  /** Tabler icon class and the colours of the chip behind it. */
  readonly icon: string;
  readonly iconClassName: string;
  /** A small line over the title, such as the position of a step in the flow. */
  readonly kicker?: string;
  readonly title: string;
  readonly subtitle?: string;
  /** `lg` is for the forms that hold long text. */
  readonly size?: 'md' | 'lg';
  /** Accessible name of the remove button; without it the node cannot be removed from here. */
  readonly removeLabel?: string;
  readonly isReadOnly?: boolean;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}

/**
 * The shell shared by every node of the workflow canvas when it opens: the same surface, header
 * and spacing as the other dialogs of the app, so editing a node reads like editing anything else.
 */
export function InspectorFrame({
  titleId,
  icon,
  iconClassName,
  kicker,
  title,
  subtitle,
  size = 'md',
  removeLabel,
  isReadOnly = false,
  onRemove,
  onClose,
  children,
}: InspectorFrameProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      data-testid="workflow-inspector"
      className={cn(
        'flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl',
        size === 'lg' ? 'w-[min(96vw,720px)]' : 'w-[min(96vw,560px)]',
      )}
    >
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-4">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            iconClassName,
          )}
        >
          <i className={cn('ti text-xl', icon)} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {kicker && (
            <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              {kicker}
            </span>
          )}
          <h2 id={titleId} className="break-words text-lg font-semibold text-[var(--text-primary)]">
            {title}
          </h2>
          {subtitle && <p className="text-xs text-[var(--text-secondary)]">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onRemove && removeLabel && (
            <IconButton
              size="sm"
              icon={<i className="ti ti-trash" aria-hidden="true" />}
              label={removeLabel}
              disabled={isReadOnly}
              onClick={onRemove}
              className="text-[var(--text-danger)] hover:text-[var(--text-danger)]"
            />
          )}
          <IconButton
            size="sm"
            icon={<i className="ti ti-x text-lg" aria-hidden="true" />}
            label={t('common.close')}
            onClick={onClose}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6">{children}</div>
    </div>
  );
}

/** A labelled control. The label wraps the control, so the pair is announced and clicked together. */
export function InspectorField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
      {label}
      {children}
    </label>
  );
}

/** An on/off setting: the whole row toggles it, and the accent border says it is on. */
export function InspectorSwitchRow({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-[var(--surface-2)] px-3 py-2.5 transition-colors',
        checked ? 'border-[var(--fill-accent)]' : 'border-[var(--border)]',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
        {hint && <span className="text-xs text-[var(--text-muted)]">{hint}</span>}
      </span>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(change) => onChange(change.target.checked)}
        data-testid={testId}
      />
    </label>
  );
}

/** An amber note on a form, for something that needs attention. */
export function InspectorNotice({
  icon,
  testId,
  children,
}: {
  readonly icon: string;
  readonly testId?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p
      data-testid={testId}
      className="flex items-start gap-2 rounded-lg border border-[var(--bg-warning)] bg-[var(--bg-warning)] p-3 text-xs text-[var(--text-warning)]"
    >
      <i className={cn('ti mt-px shrink-0 text-sm', icon)} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
