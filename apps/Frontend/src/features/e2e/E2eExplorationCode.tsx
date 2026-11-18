import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { RenderedCode } from '../brain/RenderedCode.js';
import { FileEditor } from '../development/FileEditor.js';
import { DEFAULT_PREFS } from '../development/files-prefs.js';
import type { E2eExplorationCode } from './e2e-types.js';

/**
 * The code of an exploration: what the agent did, written as a Playwright test. The user reads
 * it and can edit it; the edit is kept until the next exploration replaces it.
 */
export function E2eExplorationCodePanel({
  apiClient,
  creationId,
  version,
  isReadOnly,
}: {
  readonly apiClient: ApiClient;
  readonly creationId: string;
  /** Changes with each exploration, so the code is loaded again. */
  readonly version: string;
  readonly isReadOnly: boolean;
}) {
  const { t } = useI18n();
  const [current, setCurrent] = useState<E2eExplorationCode | null>(null);
  /** The code being edited, with the one it started from to detect changes. */
  const [draft, setDraft] = useState<{ original: string; value: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'restore' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCurrent(await apiClient.getE2eExplorationCode(creationId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.exploreCodeLoadFailed'));
    }
  }, [apiClient, creationId, t]);

  useEffect(() => {
    setCurrent(null);
    setDraft(null);
    setNotice(null);
    void load();
  }, [load, version]);

  const save = async (code: string, action: 'save' | 'restore') => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      setCurrent(await apiClient.saveE2eExplorationCode(creationId, code));
      setDraft(null);
      setNotice(t('e2e.exploreCodeSaved'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.exploreCodeSaveFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4"
      data-testid="e2e-exploration-code"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-sm text-[var(--text-secondary)]">
          {t('e2e.exploreCodeHint')}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {current?.edited && (
            <span className="rounded bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
              {t('e2e.exploreCodeEdited')}
            </span>
          )}
          {!isReadOnly && current?.edited && !draft && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void save('', 'restore')}
              disabled={busy !== null}
              isLoading={busy === 'restore'}
            >
              <i className="ti ti-restore" aria-hidden="true" />
              {t('e2e.exploreCodeRestore')}
            </Button>
          )}
          {!isReadOnly && draft && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(null)}
                disabled={busy !== null}
              >
                {t('e2e.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void save(draft.value, 'save')}
                disabled={busy !== null || draft.value === draft.original}
                isLoading={busy === 'save'}
              >
                <i className="ti ti-device-floppy" aria-hidden="true" />
                {t('e2e.exploreCodeSave')}
              </Button>
            </>
          )}
          {!isReadOnly && !draft && current && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDraft({ original: current.code, value: current.code })}
              disabled={busy !== null}
            >
              <i className="ti ti-pencil" aria-hidden="true" />
              {t('e2e.exploreCodeEdit')}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-red-400">{error}</p>
          {!current && (
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('e2e.retry')}
            </Button>
          )}
        </div>
      )}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}
      {draft ? (
        <div className="h-[70vh] overflow-hidden rounded-md">
          <FileEditor
            path="exploration.spec.ts"
            value={draft.value}
            editable
            prefs={DEFAULT_PREFS}
            preview={false}
            label={t('e2e.exploreCodeLabel')}
            onChange={(value) => setDraft({ ...draft, value })}
            onSave={() => {
              if (busy === null && draft.value !== draft.original) void save(draft.value, 'save');
            }}
          />
        </div>
      ) : current ? (
        current.code.trim() ? (
          <div className="max-h-[70vh] overflow-auto rounded-md bg-[var(--surface-0)]">
            <RenderedCode code={current.code} language="typescript" />
          </div>
        ) : (
          <p className="rounded-md bg-[var(--surface-0)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
            {t('e2e.exploreCodeEmpty')}
          </p>
        )
      ) : error ? null : (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-4 w-3/4 rounded-md" />
          <Skeleton className="h-4 w-1/2 rounded-md" />
          <Skeleton className="h-4 w-2/3 rounded-md" />
        </div>
      )}
    </section>
  );
}
