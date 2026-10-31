import { useRef, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { sanitizeRichText } from '../testplans/test-case-fields.js';
import { editorHtml } from './media.js';
import { RICH_TEXT } from './rich-text.js';

export interface RichTextEditorProps {
  /** Content when the editor mounts; later changes come from the user, so remount to reset it. */
  readonly initialHtml: string;
  readonly onChange: (html: string) => void;
  readonly ariaLabel: string;
  readonly readOnly?: boolean;
  readonly placeholder?: string;
  readonly editorRef?: RefObject<HTMLDivElement | null>;
  readonly onPaste?: (event: ClipboardEvent<HTMLElement>) => void;
  readonly onDrop?: (event: DragEvent<HTMLElement>) => void;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

/** Rich text box with a bold, italic, underline, list and heading toolbar. */
export function RichTextEditor({
  initialHtml,
  onChange,
  ariaLabel,
  readOnly = false,
  placeholder,
  editorRef,
  onPaste,
  onDrop,
  className,
  'data-testid': testId,
}: RichTextEditorProps) {
  const { t } = useI18n();
  const ownRef = useRef<HTMLDivElement>(null);
  const editor = editorRef ?? ownRef;

  const format = (command: string, value?: string) => {
    editor.current?.focus();
    if (value === undefined) document.execCommand(command, false);
    else document.execCommand(command, false, value);
    if (editor.current) onChange(sanitizeRichText(editorHtml(editor.current)));
  };

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)]">
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] p-1.5">
          {(
            [
              ['bold', 'ti-bold', t('testplans.toolbarBold')],
              ['italic', 'ti-italic', t('testplans.toolbarItalic')],
              ['underline', 'ti-underline', t('testplans.toolbarUnderline')],
              ['insertUnorderedList', 'ti-list', t('testplans.toolbarList')],
            ] as const
          ).map(([command, icon, label]) => (
            <button
              key={command}
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-1 hover:text-[var(--text-primary)]"
              aria-label={label}
              title={label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => format(command)}
            >
              <i className={`ti ${icon}`} aria-hidden="true" />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <button
            type="button"
            className="flex h-8 items-center gap-1 rounded px-2 text-xs text-muted hover:bg-surface-1 hover:text-[var(--text-primary)]"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format('formatBlock', 'h3')}
            aria-label={t('testplans.toolbarHeading')}
          >
            <i className="ti ti-heading" aria-hidden="true" /> H
          </button>
        </div>
      )}
      <div
        ref={editor}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-readonly={readOnly}
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        data-testid={testId}
        className={cn(
          'min-h-56 overflow-x-auto whitespace-pre-wrap p-4 outline-none',
          placeholder &&
            'empty:before:pointer-events-none empty:before:text-[var(--text-muted)] empty:before:content-[attr(data-placeholder)]',
          RICH_TEXT,
          className,
        )}
        dangerouslySetInnerHTML={{ __html: sanitizeRichText(initialHtml) }}
        onInput={(event) => onChange(sanitizeRichText(editorHtml(event.currentTarget)))}
        onPaste={readOnly ? undefined : onPaste}
        onDrop={readOnly ? undefined : onDrop}
      />
    </div>
  );
}
