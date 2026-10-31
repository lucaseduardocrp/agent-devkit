import type { ReactNode } from 'react';
import { FormattedContent } from '../../components/ui/formatted-content.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import type { E2eStepText } from './e2e-types.js';

/** A titled block of the test detail: description, steps, linked case, details. */
export function E2eSection({
  icon,
  title,
  children,
}: {
  readonly icon: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-2 border-b border-[var(--border)] pb-1.5 text-sm font-semibold text-[var(--text-primary)]">
        <i className={cn('ti text-[var(--text-accent)]', icon)} aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Steps planned for a test, or for its Before Run and After Run, with their expected results. */
export function E2ePlannedSteps({
  steps,
  'data-testid': testId = 'e2e-planned-steps',
}: {
  readonly steps: readonly E2eStepText[];
  readonly 'data-testid'?: string;
}) {
  const { t } = useI18n();
  return (
    <ol className="space-y-2" data-testid={testId}>
      {steps.map((step, index) => (
        <li
          key={index}
          className="flex items-start rounded-md border border-[var(--border)] bg-[var(--surface-0)] p-2.5 text-xs"
        >
          <dl className="min-w-0 flex-1 space-y-1 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            <div>
              <dt className="inline font-semibold text-[var(--text-primary)]">
                {t('testplans.actionLabel')}
              </dt>{' '}
              <dd className="inline">
                <FormattedContent content={step.action} inline />
              </dd>
            </div>
            {step.expectedResult.trim() && (
              <div>
                <dt className="inline font-semibold text-emerald-400">
                  {t('testplans.expectedResultLabel')}
                </dt>{' '}
                <dd className="inline">
                  <FormattedContent content={step.expectedResult} inline />
                </dd>
              </div>
            )}
          </dl>
        </li>
      ))}
    </ol>
  );
}
