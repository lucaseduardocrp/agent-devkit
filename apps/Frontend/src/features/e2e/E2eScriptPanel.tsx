import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Textarea } from '../../components/ui/textarea.js';
import { RichTextEditor } from '../shared/RichTextEditor.js';
import { RICH_TEXT } from '../shared/rich-text.js';
import { sanitizeRichText } from '../testplans/test-case-fields.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { RenderedCode } from '../brain/RenderedCode.js';
import { E2ePlannedSteps, E2eSection } from './E2ePlannedSteps.js';
import { hookStepTexts, type E2eMode, type E2eScript, type E2eScriptKind } from './e2e-types.js';

type HookKind = Exclude<E2eScriptKind, 'spec'>;
const hookTexts: Record<
  HookKind,
  { hint: TranslationKey; empty: TranslationKey; steps: TranslationKey; icon: string }
> = {
  beforeRun: {
    hint: 'e2e.beforeRunHint',
    empty: 'e2e.noBeforeRun',
    steps: 'e2e.beforeRunSteps',
    icon: 'ti-database-plus',
  },
  afterRun: {
    hint: 'e2e.afterRunHint',
    empty: 'e2e.noAfterRun',
    steps: 'e2e.afterRunSteps',
    icon: 'ti-eraser',
  },
};

/**
 * Starting point of a new Before Run or After Run; API runs get no browser page. The comment on
 * top lists its steps, which the tab shows like the steps of a test case.
 */
function hookTemplate(kind: HookKind, mode: E2eMode): string {
  const [types, fixtures] =
    mode === 'frontend'
      ? [
          'type APIRequestContext, type Page',
          '{ page, request }: { page: Page; request: APIRequestContext }',
        ]
      : ['type APIRequestContext', '{ request }: { request: APIRequestContext }'];
  const [title, action, expected] =
    kind === 'beforeRun'
      ? ['Before Run', 'Create the record the test needs, named "E2E TC001 - ..."', 'It exists']
      : ['After Run', 'Delete the record "E2E TC001 - ..." when it exists', 'It no longer exists'];
  return `/**
 * ${title} steps, one "action => expected result" each:
 * 1. ${action} => ${expected}
 */
import { expect, test, ${types} } from '@playwright/test';

export default async function ${kind}(${fixtures}) {
  await test.step(${JSON.stringify(`1 - ${action}`)}, async () => {
    // ...
  });
}
`;
}

/**
 * What the user wants the AI to do when it writes this hook (screens to go through, routes,
 * records to use). It is saved on the test and sent with the next generation of the script.
 */
function E2eHookInstructions({
  apiClient,
  testId,
  kind,
  initial,
  isReadOnly,
}: {
  readonly apiClient: ApiClient;
  readonly testId: string;
  readonly kind: HookKind;
  readonly initial: string;
  readonly isReadOnly: boolean;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different test or tab brings its own instructions; the editor starts from them again.
  useEffect(() => {
    setSaved(initial);
    setDraft(null);
    setError(null);
  }, [initial, testId, kind]);

  const save = async (content: string) => {
    setSaving(true);
    setError(null);
    try {
      const test = await apiClient.saveE2eHookInstructions(testId, kind, content);
      setSaved(test[kind === 'beforeRun' ? 'beforeRunInstructions' : 'afterRunInstructions'] ?? '');
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.hookInstructionsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <E2eSection icon="ti-notes" title={t('e2e.hookInstructions')}>
      <p className="mb-2 text-xs text-[var(--text-secondary)]">{t('e2e.hookInstructionsHint')}</p>
      {draft === null ? (
        <div className="flex flex-col gap-2">
          {saved.trim() ? (
            <div
              className={`[overflow-wrap:anywhere] ${RICH_TEXT}`}
              data-testid={`e2e-${kind}-instructions`}
              dangerouslySetInnerHTML={{ __html: sanitizeRichText(saved) }}
            />
          ) : (
            <p className="text-sm text-[var(--text-muted)]">{t('e2e.noHookInstructions')}</p>
          )}
          {!isReadOnly && (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={() => setDraft(saved)}
              data-testid={`e2e-${kind}-instructions-edit`}
            >
              <i className="ti ti-pencil" aria-hidden="true" />
              {t('e2e.editHookInstructions')}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <RichTextEditor
            initialHtml={saved}
            onChange={setDraft}
            ariaLabel={t('e2e.hookInstructions')}
            placeholder={t('e2e.hookInstructionsPlaceholder')}
            className="min-h-32"
            data-testid={`e2e-${kind}-instructions-editor`}
          />
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>
              {t('e2e.cancel')}
            </Button>
            <Button size="sm" onClick={() => void save(draft)} isLoading={saving}>
              <i className="ti ti-device-floppy" aria-hidden="true" />
              {t('e2e.saveHookInstructions')}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="mt-2 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </E2eSection>
  );
}

/**
 * One script of the test as it is in the repository, with pull, edit and push: the spec, or
 * the Before Run and After Run that the runner calls around it.
 */
export function E2eScriptPanel({
  apiClient,
  testId,
  kind = 'spec',
  mode = 'frontend',
  instructions = null,
  isReadOnly,
  disabled,
}: {
  readonly apiClient: ApiClient;
  readonly testId: string;
  readonly kind?: E2eScriptKind;
  /** Decides whether a new Before Run or After Run receives the browser page. */
  readonly mode?: E2eMode;
  /** What the user already told the AI about this hook; only read on a hook tab. */
  readonly instructions?: string | null;
  readonly isReadOnly: boolean;
  /** True while the run is executing; pushing then would race with it. */
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  const hook = kind === 'spec' ? null : hookTexts[kind];
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
      setScript(await apiClient.getE2eScript(testId, kind));
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.scriptLoadFailed'));
    } finally {
      setBusy(null);
    }
  }, [apiClient, testId, kind, t]);

  useEffect(() => {
    void pull();
  }, [pull]);

  const push = async (content: string) => {
    setBusy('push');
    setError(null);
    try {
      setScript(await apiClient.pushE2eScript(testId, content, kind));
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
    const value = kind !== 'spec' && !original.trim() ? hookTemplate(kind, mode) : original;
    setDraft({ original, value });
  };

  // While editing, the steps follow the draft, so the list shows what will be pushed.
  const hookContent = draft?.value ?? script?.content ?? '';
  const hookSteps = hook ? hookStepTexts(hookContent) : [];

  return (
    <div className="flex flex-col gap-3" data-testid="e2e-script-panel" data-kind={kind}>
      {hook && <p className="text-xs text-[var(--text-secondary)]">{t(hook.hint)}</p>}
      {hook && (
        <E2eHookInstructions
          apiClient={apiClient}
          testId={testId}
          kind={kind as HookKind}
          initial={instructions ?? ''}
          isReadOnly={isReadOnly}
        />
      )}
      {hook && hookContent.trim() && (
        <E2eSection icon={hook.icon} title={t(hook.steps)}>
          {hookSteps.length > 0 ? (
            <E2ePlannedSteps steps={hookSteps} data-testid={`e2e-${kind}-steps`} />
          ) : (
            <p className="text-xs text-[var(--text-muted)]">{t('e2e.hookNoSteps')}</p>
          )}
        </E2eSection>
      )}
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
          aria-label={t(
            kind === 'beforeRun'
              ? 'e2e.beforeRun'
              : kind === 'afterRun'
                ? 'e2e.afterRun'
                : 'e2e.code',
          )}
          value={draft.value}
          onChange={(event) => setDraft({ ...draft, value: event.target.value })}
          spellCheck={false}
          rows={18}
          className="font-mono text-xs"
        />
      ) : script?.content?.trim() ? (
        <RenderedCode code={script.content} language="typescript" />
      ) : script ? (
        <p className="rounded-md bg-[var(--surface-0)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          {t(hook ? hook.empty : 'e2e.noScript')}
        </p>
      ) : null}
    </div>
  );
}
