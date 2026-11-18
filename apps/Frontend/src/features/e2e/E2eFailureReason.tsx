import { useI18n } from '../../lib/i18n/index.js';
import { failureReason, type E2eTestDetail } from './e2e-types.js';

/** Why a run failed, in plain text next to the video: the step, what failed and the likely cause. */
export function E2eFailureReason({ test }: { readonly test: E2eTestDetail }) {
  const { t } = useI18n();
  const reason = failureReason(test);
  if (!reason) return null;
  const { step, summary, cause, headline, expected, received } = reason;

  return (
    <section
      className="rounded-lg border border-red-500/30 bg-red-950/30"
      data-testid="e2e-failure-reason"
    >
      <h3 className="flex items-center gap-2 border-b border-red-500/20 px-4 py-2 text-sm font-semibold text-red-300">
        <i className="ti ti-alert-triangle" aria-hidden="true" />
        {t('e2e.failureTitle')}
      </h3>
      <div className="flex flex-col gap-2 px-4 py-3 text-sm text-[var(--text-primary)]">
        {step && (
          <p className="font-medium">
            {t('e2e.failureStep', { position: step.position, title: step.title })}
          </p>
        )}
        {summary && <p className="text-[var(--text-secondary)]">{summary}</p>}
        {headline && <p className="font-mono text-xs text-red-200">{headline}</p>}
        {(expected !== null || received !== null) && (
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            {expected !== null && (
              <div>
                <dt className="inline font-semibold text-emerald-400">
                  {t('e2e.failureExpected')}:
                </dt>{' '}
                <dd className="inline font-mono">{expected}</dd>
              </div>
            )}
            {received !== null && (
              <div>
                <dt className="inline font-semibold text-red-300">{t('e2e.failureReceived')}:</dt>{' '}
                <dd className="inline font-mono">{received}</dd>
              </div>
            )}
          </dl>
        )}
        {cause && (
          <p className="text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              {t('e2e.failureCause')}:
            </span>{' '}
            {cause}
          </p>
        )}
      </div>
    </section>
  );
}
