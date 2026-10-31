import React, { useState } from 'react';
import { ModeSwitch, type ViewMode } from '../../../components/ui/mode-switch.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { MarkdownViewer } from '../../brain/MarkdownViewer.js';

/**
 * The Docs of a collection, folder or request: Markdown written in place, with a preview. It fills
 * the pane, so the notes have the same room as the other tabs' editors.
 */
export function DocsEditor({
  value,
  readOnly,
  hint,
  onChange,
  'data-testid': testId,
}: {
  readonly value: string;
  readonly readOnly: boolean;
  /** One line above the editor explaining what these notes are for. */
  readonly hint?: string;
  readonly onChange: (value: string) => void;
  readonly 'data-testid'?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  // Docs are read far more often than written, so existing notes open rendered.
  const [mode, setMode] = useState<ViewMode>(value.trim() ? 'preview' : 'code');

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-xs font-semibold text-[var(--text-primary)]">
            {t('apiTests.tabs.docs')}
          </h3>
          {hint && <p className="text-xs text-[var(--text-secondary)]">{hint}</p>}
        </div>
        <ModeSwitch mode={mode} onChange={setMode} ariaLabel={t('apiTests.ui.docsMode')} />
      </div>
      {mode === 'code' ? (
        <Textarea
          className="min-h-0 flex-1 resize-none font-mono text-xs"
          aria-label={t('apiTests.tabs.docs')}
          value={value}
          placeholder={t('apiTests.descriptionPlaceholder')}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        />
      ) : (
        <div
          className="thin-scrollbar min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-4"
          data-testid={testId ? `${testId}-preview` : undefined}
        >
          {value.trim() ? (
            <MarkdownViewer content={value} showModeToggle={false} />
          ) : (
            <p className="text-xs text-[var(--text-muted)]">{t('apiTests.ui.docsEmpty')}</p>
          )}
        </div>
      )}
    </div>
  );
}
