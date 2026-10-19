import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Textarea } from '../../components/ui/textarea.js';
import { RenderedCode } from '../brain/RenderedCode.js';
import type { E2eScript } from './e2e-types.js';

/** The test's spec as it is in the repository, with pull, edit and push. */
export function E2eScriptPanel({
  apiClient,
  testId,
  isReadOnly,
  disabled,
}: {
  readonly apiClient: ApiClient;
  readonly testId: string;
  readonly isReadOnly: boolean;
  /** True while the run is executing; pushing then would race with it. */
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  const [script, setScript] = useState<E2eScript | null>(null);
  /** The spec being edited, with the content it started from to detect changes. */
  const [draft, setDraft] = useState<{ original: string; value: string } | null>(null);
  const [busy, setBusy] = useState<'pull' | 'push' | null>('pull');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pull = useCallback(async () => {
    setBusy('pull');
    setError(null);
    setNotice(null);
    try {
      setScript(await apiClient.getE2eScript(testId));
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.scriptLoadFailed'));
    } finally {
      setBusy(null);
    }
  }, [apiClient, testId, t]);

  useEffect(() => {
    void pull();
  }, [pull]);

  const push = async (content: string) => {
    setBusy('push');
    setError(null);
    try {
      setScript(await apiClient.pushE2eScript(testId, content));
      setDraft(null);
      setNotice(t('e2e.pushed'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.pushFailed'));
    } finally {
      setBusy(null);
    }
  };

  const startEditing = (current: E2eScript) => {
    const original = current.content ?? '';
    setDraft({ original, value: original });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="e2e-script-panel">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <i className="ti ti-git-branch" aria-hidden="true" />
        {script ? (
          <span className="min-w-0 truncate font-mono">
            {script.repository.name}@{script.repository.branch}/{script.path}
          </span>
        ) : (
          <Skeleton className="h-4 w-64" />
        )}
        {script?.url && (
          <a
            href={script.url}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--text-accent)] underline-offset-4 hover:underline"
          >
            {t('e2e.openInRepository')}
          </a>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void pull()}
            disabled={busy !== null}
            isLoading={busy === 'pull'}
          >
            <i className="ti ti-download" aria-hidden="true" />
            {t('e2e.pull')}
          </Button>
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
                onClick={() => void push(draft.value)}
                disabled={busy !== null || disabled || draft.value === draft.original}
                isLoading={busy === 'push'}
              >
                <i className="ti ti-upload" aria-hidden="true" />
                {t('e2e.push')}
              </Button>
            </>
          )}
          {!isReadOnly && !draft && script && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => startEditing(script)}
              disabled={busy !== null}
            >
              <i className="ti ti-pencil" aria-hidden="true" />
              {t('e2e.editScript')}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}
      {draft ? (
        <Textarea
          aria-label={t('e2e.code')}
          value={draft.value}
          onChange={(event) => setDraft({ ...draft, value: event.target.value })}
          spellCheck={false}
          rows={18}
          className="font-mono text-xs"
        />
      ) : script?.content ? (
        <RenderedCode code={script.content} language="typescript" />
      ) : script ? (
        <p className="rounded-md bg-[var(--surface-0)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          {t('e2e.noScript')}
        </p>
      ) : null}
    </div>
  );
}
