import React from 'react';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { isVariableReference } from '../api-test-types.js';
import { VariableInput } from '../VariableInput.js';

// Credentials are personal: a literal typed in a credential field goes to the current user's own
// vault when the collection is saved and comes back blank; a `{{variable}}` reference stays shared.

/** The small "personal" lock mark of a field whose value only the current user has. */
export function PersonalBadge({ className }: { readonly className?: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded bg-[var(--bg-pro)] px-1.5 py-px text-[10px] font-medium text-[var(--text-pro)]',
        className,
      )}
      title={t('apiTests.workbench.personalHint')}
      data-testid="personal-badge"
    >
      <i className="ti ti-lock text-[11px]" aria-hidden="true" />
      {t('apiTests.workbench.personal')}
    </span>
  );
}

/** Explains once, above a group of credential fields, that their values are personal. */
export function PersonalHint({ className }: { readonly className?: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-[11px] text-[var(--text-secondary)]',
        className,
      )}
    >
      <i className="ti ti-lock mt-px text-sm text-[var(--text-pro)]" aria-hidden="true" />
      <span>
        {t('apiTests.workbench.personalHint')} {t('apiTests.workbench.personalUseVariables')}
      </span>
    </p>
  );
}

/** Whether a typed value will be kept in the user's own vault (a literal, not `{{refs}}`). */
const willBePersonal = (value: string | undefined) =>
  Boolean(value?.trim()) && !isVariableReference(value!);

/**
 * A credential field. With `personal` (the user has their own value) and nothing typed, it shows a
 * masked placeholder, the "personal" mark and "clear my value"; typing replaces the value.
 */
export function PersonalSecretField({
  label,
  value,
  onValueChange,
  personal,
  onClear,
  readOnly,
  placeholder,
  mono = true,
  className,
  testId,
  multiline,
  action,
}: {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly personal: boolean;
  readonly onClear?: () => void;
  readonly readOnly: boolean;
  readonly placeholder?: string;
  readonly mono?: boolean;
  readonly className?: string;
  readonly testId?: string;
  /** A PEM key or another value on several lines. */
  readonly multiline?: boolean;
  /** Shown at the end of the label row, e.g. a "Load file" button. */
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const masked = personal && !value;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 text-xs', className)} data-testid={testId}>
      <span className="flex items-center justify-between gap-2 text-[var(--text-secondary)]">
        <span className="flex items-center gap-2">
          {label}
          {personal && <PersonalBadge />}
        </span>
        {action}
      </span>
      <div className={cn('flex gap-1.5', multiline ? 'items-start' : 'items-center')}>
        {multiline ? (
          <Textarea
            className={cn('min-h-20 text-xs', mono && 'font-mono')}
            aria-label={label}
            value={value}
            disabled={readOnly}
            spellCheck={false}
            placeholder={masked ? t('apiTests.workbench.personalPlaceholder') : placeholder}
            onChange={(event) => onValueChange(event.target.value)}
          />
        ) : (
          <VariableInput
            mono={mono}
            aria-label={label}
            value={value}
            disabled={readOnly}
            placeholder={masked ? t('apiTests.workbench.personalPlaceholder') : placeholder}
            onValueChange={onValueChange}
          />
        )}
        {personal && onClear && !readOnly && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={<i className="ti ti-eraser text-sm" aria-hidden="true" />}
            label={t('apiTests.workbench.clearMyValueOf', { name: label })}
            title={t('apiTests.workbench.clearMyValue')}
            onClick={onClear}
            data-testid="clear-personal"
          />
        )}
      </div>
      {!readOnly && willBePersonal(value) && (
        <p className="flex items-center gap-1 text-[11px] text-[var(--text-pro)]" role="note">
          <i className="ti ti-lock text-xs" aria-hidden="true" />
          {t('apiTests.workbench.literalKeptPersonal')}
        </p>
      )}
    </div>
  );
}
