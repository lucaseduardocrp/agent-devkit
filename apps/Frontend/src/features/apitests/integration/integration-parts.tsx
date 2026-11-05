import React, { useEffect, useId, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Modal } from '../../../components/ui/modal.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import type { HttpMethod, RequestKind } from '../api-test-types.js';
import { KIND_COLOR, KIND_SHORT, METHOD_COLOR, METHOD_SHORT } from './integration-model.js';

/** The method of an HTTP request, or the protocol of the other kinds (GQL, gRPC, WS...). */
export function MethodLabel({
  method,
  kind = 'http',
  className,
}: {
  readonly method: HttpMethod;
  readonly kind?: RequestKind;
  readonly className?: string;
}): React.JSX.Element {
  const protocol = kind === 'http' ? null : kind;
  return (
    <span
      className={cn(
        'shrink-0 font-mono text-[10px] font-bold uppercase tracking-tight',
        protocol ? KIND_COLOR[protocol] : METHOD_COLOR[method],
        className,
      )}
    >
      {protocol ? KIND_SHORT[protocol] : (METHOD_SHORT[method] ?? method)}
    </span>
  );
}

export interface PaneTab<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Shown next to the label: a count, or a mark that the tab holds something. */
  readonly indicator?: string | number;
  readonly tone?: 'default' | 'success' | 'danger';
}

/** The tab row of the request, response, runner and settings panes. */
export function PaneTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  right,
}: {
  readonly tabs: readonly PaneTab<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly right?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2">
      <div
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        role="tablist"
        aria-label={label}
      >
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            type="button"
            role="tab"
            size="sm"
            aria-selected={value === tab.id}
            variant={value === tab.id ? 'secondary' : 'ghost'}
            className="h-7 shrink-0 gap-1 px-2 font-medium"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.indicator !== undefined && tab.indicator !== 0 && tab.indicator !== '' && (
              <sup
                className={cn(
                  'font-mono text-[9px]',
                  tab.tone === 'success'
                    ? 'text-[var(--text-success)]'
                    : tab.tone === 'danger'
                      ? 'text-[var(--text-danger)]'
                      : 'text-[var(--text-accent)]',
                )}
              >
                {tab.indicator}
              </sup>
            )}
          </Button>
        ))}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

/** Asks for a name: new folder, rename, clone. */
export function NameDialog({
  open,
  title,
  initial,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly initial: string;
  readonly confirmLabel: string;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const [name, setName] = useState(initial);
  useEffect(() => setName(initial), [initial, open]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <Modal open={open} onClose={onClose} labelledBy={id}>
      <form
        className="flex w-[min(92vw,440px)] flex-col gap-4 rounded-lg border border-border bg-surface-1 p-6 shadow-2xl"
        onSubmit={submit}
        data-testid="name-dialog"
      >
        <h2 id={id} className="text-lg font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        <Input
          autoFocus
          aria-label={t('common.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="name-dialog-input"
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim()} data-testid="name-dialog-submit">
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Centered hint of an empty pane. */
export function EmptyPane({
  icon,
  children,
}: {
  readonly icon: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-[var(--text-muted)]">
      <i className={cn('ti text-4xl', icon)} aria-hidden="true" />
      {children}
    </div>
  );
}

/** A labelled field of the settings panes. */
export function SettingField({
  label,
  hint,
  className,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label
      className={cn(
        'flex min-w-0 flex-col gap-1.5 text-xs text-[var(--text-secondary)]',
        className,
      )}
    >
      {label}
      {children}
      {hint && <span className="text-[11px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

/** An on/off setting with what it does under it. */
export function CheckboxField({
  label,
  hint,
  checked,
  disabled,
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
    <label className="flex cursor-pointer items-start gap-2 text-xs">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
      <span>
        <span className="font-medium text-[var(--text-primary)]">{label}</span>
        {hint && <span className="block text-[var(--text-muted)]">{hint}</span>}
      </span>
    </label>
  );
}

/** Title and description of a settings section. */
export function SectionTitle({
  title,
  hint,
}: {
  readonly title: string;
  readonly hint?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-[var(--text-primary)]">{title}</h3>
      {hint && <p className="text-xs text-[var(--text-secondary)]">{hint}</p>}
    </div>
  );
}
