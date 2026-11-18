import { useEffect, useState } from 'react';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/modal.js';
import { Switch } from '../../components/ui/switch.js';
import { MarkdownEditor } from '../shared/markdown-editor/MarkdownEditor.js';
import { discardDrafts } from '../shared/media.js';
import { MAX_INSTRUCTIONS } from './e2e-types.js';

export interface E2eRegenerateChoice {
  readonly instructions: string;
  readonly useLastRun: boolean;
}

/**
 * Asks how the AI should rewrite a test's script: what the user wants (kept on the test for the
 * next rewrites) and whether it starts from the old script and what its last run produced. The
 * instructions are Markdown and may hold images: the AI sees them when it writes the script.
 * Images pasted or attached here are drafts until `onConfirm` hands them over, so whoever
 * confirms is the one that uploads them (`saveWithDrafts`).
 */
export function E2eRegenerateDialog({
  open,
  initialInstructions,
  hasLastRun,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  /** Instructions already saved on the test. */
  readonly initialInstructions: string;
  /** Whether the test has a script and a result to learn from. */
  readonly hasLastRun: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (choice: E2eRegenerateChoice) => void;
}) {
  const { t } = useI18n();
  const [instructions, setInstructions] = useState(initialInstructions);
  const [useLastRun, setUseLastRun] = useState(hasLastRun);

  // Every opening starts from what the test holds now.
  useEffect(() => {
    if (!open) return;
    setInstructions(initialInstructions);
    setUseLastRun(hasLastRun);
  }, [open, initialInstructions, hasLastRun]);

  // The API takes at most this much text; Markdown marks count too, so the editor cannot cut it.
  const tooLong = instructions.trim().length > MAX_INSTRUCTIONS;

  const cancel = () => {
    // Images added and not sent are forgotten with the edit.
    discardDrafts(instructions);
    onCancel();
  };

  return (
    <Modal open={open} labelledBy="e2e-regenerate-title" onClose={busy ? undefined : cancel}>
      <div
        className="flex max-h-[90vh] w-[min(96vw,1280px)] flex-col gap-4 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6"
        data-testid="e2e-regenerate-dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2
              id="e2e-regenerate-title"
              className="text-lg font-semibold text-[var(--text-primary)]"
            >
              {t('e2e.regenerateTitle')}
            </h2>
            <p className="text-sm text-[var(--text-secondary)]">{t('e2e.regenerateHint')}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label={t('common.close')}
            onClick={cancel}
            disabled={busy}
          >
            <i className="ti ti-x" aria-hidden="true" />
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('e2e.regenerateInstructions')}</span>
          <MarkdownEditor
            scope="e2e"
            value={instructions}
            onChange={setInstructions}
            placeholder={t('e2e.regenerateInstructionsPlaceholder')}
            testId="e2e-regenerate-instructions"
          />
          {tooLong && (
            <p className="text-xs text-red-400" role="alert">
              {t('e2e.regenerateInstructionsTooLong', { max: MAX_INSTRUCTIONS })}
            </p>
          )}
        </div>
        <label className="flex items-start gap-3 text-sm text-[var(--text-primary)]">
          <Switch
            checked={useLastRun}
            disabled={!hasLastRun}
            onChange={(event) => setUseLastRun(event.target.checked)}
            aria-label={t('e2e.regenerateUseLastRun')}
          />
          <span className="flex flex-col gap-0.5">
            <span>{t('e2e.regenerateUseLastRun')}</span>
            <span className="text-xs text-[var(--text-secondary)]">
              {hasLastRun ? t('e2e.regenerateUseLastRunHint') : t('e2e.regenerateNoLastRun')}
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t('e2e.cancel')}
          </Button>
          <Button
            disabled={tooLong}
            onClick={() => onConfirm({ instructions: instructions.trim(), useLastRun })}
            isLoading={busy}
          >
            <i className="ti ti-sparkles" aria-hidden="true" />
            {t('e2e.regenerateConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
