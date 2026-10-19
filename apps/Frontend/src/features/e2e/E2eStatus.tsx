import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import type { E2eCreationStatus, E2eTestStatus } from './e2e-types.js';

const testStatus: Record<E2eTestStatus, { label: TranslationKey; icon: string; tone: string }> = {
  pending: { label: 'e2e.testPending', icon: 'ti-clock', tone: 'text-[var(--text-muted)]' },
  generating: {
    label: 'e2e.testGenerating',
    icon: 'ti-loader-2 animate-spin',
    tone: 'text-sky-400',
  },
  running: { label: 'e2e.testRunning', icon: 'ti-loader-2 animate-spin', tone: 'text-sky-400' },
  passed: { label: 'e2e.testPassed', icon: 'ti-circle-check-filled', tone: 'text-emerald-400' },
  failed: { label: 'e2e.testFailed', icon: 'ti-alert-circle-filled', tone: 'text-red-400' },
  error: { label: 'e2e.testError', icon: 'ti-alert-triangle', tone: 'text-red-400' },
  cancelled: { label: 'e2e.testCancelled', icon: 'ti-ban', tone: 'text-[var(--text-muted)]' },
};

const creationStatus: Record<
  E2eCreationStatus,
  { label: TranslationKey; icon: string; tone: string }
> = {
  draft: { label: 'e2e.statusDraft', icon: 'ti-pencil', tone: 'text-amber-400' },
  queued: { label: 'e2e.statusQueued', icon: 'ti-clock', tone: 'text-sky-400' },
  planning: {
    label: 'e2e.statusPlanning',
    icon: 'ti-loader-2 animate-spin',
    tone: 'text-sky-400',
  },
  running: { label: 'e2e.statusRunning', icon: 'ti-loader-2 animate-spin', tone: 'text-sky-400' },
  completed: {
    label: 'e2e.statusCompleted',
    icon: 'ti-circle-check-filled',
    tone: 'text-emerald-400',
  },
  failed: { label: 'e2e.statusFailed', icon: 'ti-alert-circle-filled', tone: 'text-red-400' },
  cancelled: { label: 'e2e.statusCancelled', icon: 'ti-ban', tone: 'text-[var(--text-muted)]' },
};

export function E2eTestStatusLabel({
  status,
  className,
}: {
  readonly status: E2eTestStatus;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const config = testStatus[status];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-sm', config.tone, className)}
      data-status={status}
    >
      <i className={cn('ti text-base', config.icon)} aria-hidden="true" />
      {t(config.label)}
    </span>
  );
}

export function E2eCreationStatusLabel({
  status,
  passed,
  total,
}: {
  readonly status: E2eCreationStatus;
  readonly passed: number;
  readonly total: number;
}) {
  const { t } = useI18n();
  const settled = !['queued', 'planning', 'running'].includes(status);
  if (settled && total > 0) {
    const tone =
      passed === total ? 'text-emerald-400' : passed === 0 ? 'text-red-400' : 'text-amber-400';
    const icon =
      passed === total
        ? 'ti-circle-check-filled'
        : passed === 0
          ? 'ti-alert-circle-filled'
          : 'ti-alert-triangle-filled';
    return (
      <span
        className={cn('inline-flex items-center gap-1.5 text-sm font-medium', tone)}
        data-status={status}
      >
        <i className={cn('ti text-base', icon)} aria-hidden="true" />
        {t('e2e.passCount', { passed, total })}
      </span>
    );
  }
  const config = creationStatus[status];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-sm font-medium', config.tone)}
      data-status={status}
    >
      <i className={cn('ti text-base', config.icon)} aria-hidden="true" />
      {t(config.label)}
      {total > 0 && !settled && (
        <span className="text-[var(--text-muted)]">· {t('e2e.passCount', { passed, total })}</span>
      )}
    </span>
  );
}
