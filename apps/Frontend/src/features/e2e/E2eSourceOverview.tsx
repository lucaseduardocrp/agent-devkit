import { useState } from 'react';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Badge, type BadgeProps } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import type { E2eSourceDocumentation, E2eSourceFlowOrigin } from './e2e-types.js';

const ORIGINS: Record<
  E2eSourceFlowOrigin,
  { readonly label: TranslationKey; readonly variant: BadgeProps['variant'] }
> = {
  both: { label: 'e2e.sourcesOriginBoth', variant: 'success' },
  documented: { label: 'e2e.sourcesOriginDocumented', variant: 'default' },
  discovered: { label: 'e2e.sourcesOriginDiscovered', variant: 'outline' },
};

export interface E2eSourceOverviewProps {
  readonly documentation: E2eSourceDocumentation | null;
  /** Why the documentation could not be written. */
  readonly error: string | null;
}

/**
 * The documentation of the system kept by the Source: an overview and every flow of each feature
 * area, written by the AI from the Brain and from what the agent discovered in the application.
 */
export function E2eSourceOverview({ documentation, error }: E2eSourceOverviewProps) {
  const { t, formatDate } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  if (!documentation)
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center"
        data-testid="e2e-source-overview-empty"
      >
        <i className="ti ti-file-off text-4xl text-[var(--text-muted)]" aria-hidden="true" />
        <p className="font-medium text-[var(--text-primary)]">{t('e2e.sourcesDocMissing')}</p>
        {error && (
          <p className="max-w-2xl text-sm text-red-300" role="alert">
            {error}
          </p>
        )}
        <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
          {t('e2e.sourcesDocMissingHint')}
        </p>
      </div>
    );

  const { areas, brainDocuments } = documentation;
  const flowCount = areas.reduce((total, area) => total + area.flows.length, 0);
  const toggle = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <div
      className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]"
      data-testid="e2e-source-overview"
    >
      <div className="flex min-w-0 flex-col gap-4">
        {error && (
          <p
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
            role="alert"
          >
            {t('e2e.sourcesDocError', { error })}
          </p>
        )}
        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-5">
          <h2 className="mb-2 font-semibold text-[var(--text-primary)]">
            {t('e2e.sourcesOverview')}
          </h2>
          <MarkdownViewer
            content={documentation.overview}
            showModeToggle={false}
            className="text-sm"
          />
        </section>

        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-5">
          <h2 className="font-semibold text-[var(--text-primary)]">
            {t('e2e.sourcesSystemFlows')}
            <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
              {t('e2e.sourcesDocStats', { areas: areas.length, flows: flowCount })}
            </span>
          </h2>
          {areas.length === 0 && (
            <p className="mt-2 text-sm text-[var(--text-muted)]">{t('e2e.sourcesNoAreas')}</p>
          )}
          <div className="mt-3 flex flex-col gap-2">
            {areas.map((area) => {
              const open = !collapsed.has(area.name);
              return (
                <section key={area.name} className="rounded-md border border-[var(--border)]">
                  <Button
                    variant="ghost"
                    className="flex h-auto w-full items-center justify-start gap-2 px-3 py-2.5 text-left"
                    aria-expanded={open}
                    onClick={() => toggle(area.name)}
                  >
                    <i
                      className={cn(
                        'ti ti-chevron-down transition-transform',
                        !open && '-rotate-90',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate font-semibold text-[var(--text-primary)]">
                      {area.name}
                    </span>
                    <span className="shrink-0 text-xs font-normal text-[var(--text-muted)]">
                      {t('e2e.sourcesAreaFlows', { count: area.flows.length })}
                    </span>
                  </Button>
                  {open && (
                    <div className="flex flex-col gap-3 border-t border-[var(--border)] p-3">
                      {area.description && (
                        <p className="text-sm text-[var(--text-secondary)]">{area.description}</p>
                      )}
                      {area.flows.map((flow, index) => (
                        <article
                          key={index}
                          className="rounded-md bg-[var(--surface-2)] p-3"
                          aria-label={flow.title}
                        >
                          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                            {flow.title}
                            <Badge variant={ORIGINS[flow.origin].variant}>
                              {t(ORIGINS[flow.origin].label)}
                            </Badge>
                          </h3>
                          {flow.description && (
                            <p className="mt-1 text-sm text-[var(--text-secondary)]">
                              {flow.description}
                            </p>
                          )}
                          {flow.steps.length > 0 && (
                            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--text-primary)]">
                              {flow.steps.map((step, position) => (
                                <li key={position}>{step}</li>
                              ))}
                            </ol>
                          )}
                          {flow.pages.length > 0 && (
                            <p className="mt-2 flex flex-wrap gap-1.5">
                              {flow.pages.map((page) => (
                                <span
                                  key={page}
                                  className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-muted)]"
                                >
                                  {page}
                                </span>
                              ))}
                            </p>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </section>
      </div>

      <aside className="flex flex-col gap-3 self-start rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm">
        <h2 className="font-semibold text-[var(--text-primary)]">{t('e2e.sourcesBrainDocs')}</h2>
        {brainDocuments.length === 0 ? (
          <p className="text-[var(--text-muted)]">{t('e2e.sourcesNoBrainDocs')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {brainDocuments.map((document) => (
              <li
                key={document.source}
                className="flex items-start gap-2 text-[var(--text-secondary)]"
                title={document.source}
              >
                <i className="ti ti-file-text mt-0.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{document.title}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">
          {t('e2e.sourcesDocGenerated', {
            date: formatDate(documentation.generatedAt, { dateStyle: 'short', timeStyle: 'short' }),
          })}
        </p>
      </aside>
    </div>
  );
}
