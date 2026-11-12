import { useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import { RenderedCode, highlightLines } from '../brain/RenderedCode.js';
import {
  indentSelection,
  isMarkdown,
  languageOf,
  linePieces,
  type Piece,
} from './file-editor-utils.js';
import type { FilePrefs } from './files-prefs.js';

interface Props {
  readonly path: string;
  readonly value: string;
  /** Whether the text can be changed; a read-only file can still be selected and copied. */
  readonly editable: boolean;
  readonly prefs: FilePrefs;
  /** The rendered, read-only view instead of the source. */
  readonly preview: boolean;
  /** The accessible name of the editor. */
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
}

/** Same type, padding and line height for the text a person edits and the layer that draws it. */
const TEXT = 'font-mono text-xs leading-5 p-3 pl-14';

/**
 * A source file. The text is a plain textarea, so selection, undo and the keyboard work as the
 * system does them, and a layer behind it draws what a textarea cannot: line numbers, indent
 * guides and visible whitespace. Both scroll together.
 */
export function FileEditor({
  path,
  value,
  editable,
  prefs,
  preview,
  label,
  onChange,
  onSave,
}: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // The selection to restore once React has drawn the text an indent produced.
  const selection = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    if (!selection.current || !area.current) return;
    area.current.setSelectionRange(selection.current.start, selection.current.end);
    selection.current = null;
  });

  // The colours of the language of the file, drawn behind the text being edited.
  const highlighted = useMemo(
    () => (preview ? null : highlightLines(value, languageOf(path))),
    [preview, value, path],
  );

  if (preview)
    return (
      <div
        className="h-full min-h-0 overflow-auto bg-[var(--surface-0)]"
        data-testid="file-preview"
      >
        {isMarkdown(path) ? (
          <div className="p-4">
            <MarkdownViewer content={value} showModeToggle={false} />
          </div>
        ) : (
          <RenderedCode code={value} language={languageOf(path)} />
        )}
      </div>
    );

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      return onSave();
    }
    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!prefs.tabIndents || !editable) return;
    event.preventDefault();
    const { selectionStart, selectionEnd } = event.currentTarget;
    const edit = indentSelection(
      value,
      selectionStart,
      selectionEnd,
      prefs.tabSize,
      event.shiftKey,
    );
    selection.current = { start: edit.start, end: edit.end };
    onChange(edit.value);
  };

  const scrolled = () => {
    layer.current!.scrollTop = area.current!.scrollTop;
    layer.current!.scrollLeft = area.current!.scrollLeft;
  };

  const wrap = prefs.wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre';
  const style = {
    tabSize: prefs.tabSize,
    ...(prefs.scrollPastEnd ? { paddingBottom: '50vh' } : {}),
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[var(--surface-0)]">
      <div
        ref={layer}
        aria-hidden="true"
        data-testid="editor-layer"
        className={cn(
          'pointer-events-none absolute inset-0 overflow-auto text-[var(--text-primary)]',
          TEXT,
          wrap,
        )}
        style={style}
      >
        {value.split('\n').map((line, index) => (
          <div
            key={index}
            data-line={index + 1}
            className="relative min-h-5 before:absolute before:-left-11 before:w-8 before:select-none before:text-right before:text-[var(--text-muted)] before:content-[attr(data-line)]"
          >
            {line === ''
              ? '​'
              : linePieces(line, highlighted?.[index], prefs.tabSize).map((piece, at) => (
                  <Segment key={at} segment={piece} prefs={prefs} />
                ))}
          </div>
        ))}
      </div>
      <textarea
        ref={area}
        aria-label={label}
        spellCheck={false}
        readOnly={!editable}
        wrap={prefs.wordWrap ? 'soft' : 'off'}
        value={value}
        className={cn(
          'absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-[var(--text-primary)] outline-none selection:bg-[var(--fill-accent)]/30',
          TEXT,
          wrap,
        )}
        style={style}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={keyDown}
        onScroll={scrolled}
      />
    </div>
  );
}

function Segment({ segment, prefs }: { readonly segment: Piece; readonly prefs: FilePrefs }) {
  const { kind, text, className } = segment;
  const guide = prefs.indentGuides && (kind === 'guide' || kind === 'guide-tab');
  const visible = prefs.showWhitespace;
  const isTab = kind === 'tab' || kind === 'guide-tab';
  const isSpace = kind === 'space' || kind === 'guide';
  if (!guide && !(visible && (isTab || isSpace)))
    return className ? <span className={className}>{text}</span> : <>{text}</>;
  return (
    <span
      className={cn(
        className,
        guide && 'shadow-[inset_1px_0_0_var(--border-strong)]',
        visible && isSpace && 'text-[var(--text-muted)]',
        visible &&
          isTab &&
          "relative before:absolute before:left-0 before:text-[var(--text-muted)] before:content-['→']",
      )}
    >
      {visible && isSpace ? '·'.repeat(text.length) : text}
    </span>
  );
}
