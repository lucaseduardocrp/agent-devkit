import { useState } from 'react';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/modal.js';
import { MarkdownEditor } from '../shared/markdown-editor/MarkdownEditor.js';
import { discardDrafts } from '../shared/media.js';
import { MAX_INSTRUCTIONS } from './e2e-types.js';

/**
 * Asks how the AI should fix one failed step of a test's script: the AI rewrites only that step
 * (the rest of the script stays) from what the user writes here and from what the last run
 * produced. The instructions are Markdown and may hold images, which are drafts until
 * `onConfirm` hands them over, so whoever confirms is the one that uploads them. It is mounted
 * for one step at a time, so what was said about a step never leaks into the next one.
 */
export function E2eStepFixDialog({
  step,
  onCancel,
  onConfirm,
}: {
  /** The failed step being fixed. */
  readonly step: { readonly position: number; readonly title: string };
  readonly onCancel: () => void;
  readonly onConfirm: (instructions: string) => void;
}) {
  const { t } = useI18n();
  const [instructions, setInstructions] = useState('');
  const tooLong = instructions.trim().length > MAX_INSTRUCTIONS;

  const cancel = () => {
    // Images added and not sent are forgotten with the edit.
    discardDrafts(instructions);
    onCancel();
  };

  return (
    <Modal open labelledBy="e2e-step-fix-title" onClose={cancel}>
      <div
        className="flex max-h-[90vh] w-[min(96vw,1280px)] flex-col gap-4 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6"
        data-testid="e2e-step-fix-dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2
              id="e2e-step-fix-title"
              className="text-lg font-semibold text-[var(--text-primary)]"
            >
              {t('e2e.fixStepTitle', { position: step.position })}
            </h2>
            <p className="text-sm text-[var(--text-primary)]">{step.title}</p>
            <p className="text-sm text-[var(--text-secondary)]">{t('e2e.fixStepHint')}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label={t('common.close')}
            onClick={cancel}
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
            placeholder={t('e2e.fixStepInstructionsPlaceholder')}
            testId="e2e-step-fix-instructions"
          />
          {tooLong && (
            <p className="text-xs text-red-400" role="alert">
              {t('e2e.regenerateInstructionsTooLong', { max: MAX_INSTRUCTIONS })}
            </p>
          )}
        </div>
        <p className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
          <i className="ti ti-info-circle mt-0.5" aria-hidden="true" />
          {t('e2e.fixStepContext')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={cancel}>
            {t('e2e.cancel')}
          </Button>
          <Button disabled={tooLong} onClick={() => onConfirm(instructions.trim())}>
            <i className="ti ti-sparkles" aria-hidden="true" />
            {t('e2e.fixStepConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
