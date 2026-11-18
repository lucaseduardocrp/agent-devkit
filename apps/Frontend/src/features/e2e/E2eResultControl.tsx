import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { E2eCollapsibleSection } from './E2eCollapsibleSection.js';
import { type E2eTestDetail } from './e2e-types.js';

const MAX_CRITERIA = 10_000;
type Pending = 'save' | 'reevaluate' | 'run';

/**
 * Where the user decides what counts as success for a finished test, without redoing the work:
 * a criteria the AI judges the evidence against. Passing or failing by hand is decided per step,
 * in the executed steps. Scripts, video and evidence stay as they are; the next execution decides
 * the result again.
 */
export function E2eResultControl({
  apiClient,
  test,
  isReadOnly = false,
  disabled = false,
  onChanged,
}: {
  readonly apiClient: ApiClient;
  readonly test: E2eTestDetail;
  readonly isReadOnly?: boolean;
  /** The test is running: nothing can be decided until it ends. */
  readonly disabled?: boolean;
  readonly onChanged: (test: E2eTestDetail) => void;
}) {
  const { t } = useI18n();
  const saved = test.successCriteria ?? '';
  const [criteria, setCriteria] = useState(saved);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = test.resultSource ?? 'run';
  const finished = test.status === 'passed' || test.status === 'failed';
  const dirty = criteria.trim() !== saved.trim();
  const busy = pending !== null || disabled;

  // What the server holds replaces the draft: after a save, a rerun or a change elsewhere.
  useEffect(() => {
    setCriteria(saved);
  }, [saved]);

  const act = async (kind: Pending, action: () => Promise<E2eTestDetail>, done?: string) => {
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      onChanged(await action());
      setNotice(done ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.actionFailed'));
    } finally {
      setPending(null);
    }
  };

  const showsSource = source !== 'run';
  if (isReadOnly && !showsSource && !saved) return null;

  return (
    <E2eCollapsibleSection
      title={t('e2e.resultTitle')}
      icon="ti-scale"
      testId="e2e-result-control"
    >
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        {showsSource && (
          <p
            className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sky-200"
            data-testid="e2e-result-source"
          >
            {source === 'criteria' ? t('e2e.resultByCriteria') : t('e2e.resultByUser')}
            {source === 'manual' && test.resultNote ? ` ${test.resultNote}` : ''}
          </p>
        )}

        {isReadOnly ? (
          saved && <p className="whitespace-pre-wrap text-[var(--text-secondary)]">{saved}</p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[var(--text-primary)]">
                {t('e2e.criteriaTitle')}
              </span>
              <span className="text-xs text-[var(--text-secondary)]">{t('e2e.criteriaHint')}</span>
              <Textarea
                aria-label={t('e2e.criteriaTitle')}
                value={criteria}
                maxLength={MAX_CRITERIA}
                rows={3}
                placeholder={t('e2e.criteriaPlaceholder')}
                disabled={busy}
                onChange={(event) => setCriteria(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !dirty}
                isLoading={pending === 'save'}
                onClick={() =>
                  void act(
                    'save',
                    () => apiClient.saveE2eSuccessCriteria(test.id, criteria.trim()),
                    t('e2e.criteriaSaved'),
                  )
                }
              >
                <i className="ti ti-device-floppy" aria-hidden="true" />
                {t('e2e.criteriaSave')}
              </Button>
              {finished && (test.status === 'failed' || showsSource) && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || dirty || !saved.trim()}
                  isLoading={pending === 'reevaluate'}
                  title={
                    dirty || !saved.trim() ? t('e2e.reevaluateSaveFirst') : t('e2e.reevaluateHint')
                  }
                  onClick={() => void act('reevaluate', () => apiClient.reevaluateE2eTest(test.id))}
                >
                  <i className="ti ti-sparkles" aria-hidden="true" />
                  {t('e2e.reevaluate')}
                </Button>
              )}
            </div>

            {finished && showsSource && (
              <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    isLoading={pending === 'run'}
                    onClick={() =>
                      void act('run', () => apiClient.setE2eTestResult(test.id, 'run'))
                    }
                  >
                    <i className="ti ti-arrow-back-up" aria-hidden="true" />
                    {t('e2e.resultUseRun')}
                  </Button>
                </div>
                <p className="text-xs text-[var(--text-muted)]">{t('e2e.resultManualHint')}</p>
              </div>
            )}
          </>
        )}

        {notice && (
          <p className="text-emerald-400" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    </E2eCollapsibleSection>
  );
}
