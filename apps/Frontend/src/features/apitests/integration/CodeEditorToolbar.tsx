import React, { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { ApiMockValue } from '../api-test-types.js';
import type { CodeEditorHandle } from './CodeEditor.js';
import type { CodeLanguage } from './code-syntax.js';
import { EditorPopover } from './EditorPopover.js';
import { MocksMenu } from './MocksMenu.js';

/** The shortcuts of CodeEditor, in the order they are listed. `Mod` is Ctrl, or ⌘ on a Mac. */
const SHORTCUTS = [
  ['format', 'Shift+Alt+F'],
  ['indent', 'Tab'],
  ['outdent', 'Shift+Tab'],
  ['copyDown', 'Shift+Alt+↓'],
  ['copyUp', 'Shift+Alt+↑'],
  ['duplicate', 'Mod+D'],
  ['moveDown', 'Alt+↓'],
  ['moveUp', 'Alt+↑'],
  ['deleteLine', 'Mod+Shift+K'],
  ['cutLine', 'Mod+X'],
  ['copyLine', 'Mod+C'],
  ['complete', '{{'],
  ['mock', 'Mod+Space'],
] as const;

function ShortcutsList(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="overflow-y-auto p-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        {t('apiTests.editor.shortcutsTitle')}
      </h3>
      <p className="mt-0.5 text-xs text-[var(--text-muted)]">
        {t('apiTests.editor.shortcutsHint')}
      </p>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
        {SHORTCUTS.map(([id, keys]) => (
          <React.Fragment key={id}>
            <dt className="text-[var(--text-secondary)]">
              {t(`apiTests.editor.shortcutList.${id}`)}
            </dt>
            <dd className="text-right font-mono text-[var(--text-primary)]">
              {keys.replace('Mod', 'Ctrl')}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-[var(--text-muted)]">{t('apiTests.editor.leaveField')}</p>
    </div>
  );
}

/**
 * Format, mocks and shortcuts for a CodeEditor, next to the body type selector. It talks to the
 * editor through `editor`, so it can sit anywhere in the layout.
 */
export function CodeEditorToolbar({
  editor,
  language,
  readOnly,
  mocks,
  mocksFailed,
  onRetryMocks,
}: {
  readonly editor: React.RefObject<CodeEditorHandle | null>;
  readonly language: CodeLanguage;
  readonly readOnly: boolean;
  readonly mocks: readonly ApiMockValue[] | null;
  readonly mocksFailed: boolean;
  readonly onRetryMocks: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <>
      {language !== 'text' && !readOnly && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="Shift+Alt+F"
          data-testid="format-body"
          onClick={() =>
            setNotice(
              editor.current?.format() === false
                ? t(
                    language === 'json'
                      ? 'apiTests.editor.formatInvalidJson'
                      : 'apiTests.editor.formatInvalidXml',
                  )
                : null,
            )
          }
        >
          <i className="ti ti-braces" aria-hidden="true" />
          {t('apiTests.editor.format')}
        </Button>
      )}
      {!readOnly && (
        <EditorPopover
          icon="ti-wand"
          label={t('apiTests.mocks.button')}
          title={t('apiTests.mocks.title')}
          width={420}
          testId="mocks"
        >
          {(close) => (
            <MocksMenu
              mocks={mocks}
              failed={mocksFailed}
              onRetry={onRetryMocks}
              language={language}
              onPickValue={(name) => {
                close();
                editor.current?.insertMock(name);
              }}
              onPickTemplate={(template) => {
                close();
                editor.current?.insertTemplate(template.body);
              }}
            />
          )}
        </EditorPopover>
      )}
      <EditorPopover
        icon="ti-keyboard"
        label={t('apiTests.editor.shortcuts')}
        title={t('apiTests.editor.shortcutsTitle')}
        width={340}
        testId="shortcuts"
      >
        {() => <ShortcutsList />}
      </EditorPopover>
      {notice && (
        <span role="status" className="text-xs text-[var(--text-warning)]">
          {notice}
        </span>
      )}
    </>
  );
}
