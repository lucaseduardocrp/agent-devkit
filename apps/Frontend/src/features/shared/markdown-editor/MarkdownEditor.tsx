import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { cn } from '../../../lib/utils.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { TranslationKey } from '../../../lib/i18n/types.js';
import { IMAGE_ACCEPT, type AttachmentScope } from '../attachment-types.js';
import {
  ImageInputStatus,
  useInlineImages,
  useMarkdownImageInput,
  useRichTextImageInput,
} from '../media.js';
import {
  codeBlock,
  insertLink,
  insertTable,
  setHeading,
  toggleLines,
  wrapSelection,
  type TextEdit,
} from './markdown-commands.js';
import { htmlContentClass } from './markdown-styles.js';
import {
  editorToMarkdown,
  escapeHtml,
  markdownOutline,
  markdownToEditorHtml,
  outlineOffsets,
} from './markdown-wysiwyg.js';

type Mode = 'formatted' | 'code';
type Menu = 'style' | 'color' | 'link' | null;

const TEXT_COLORS = [
  ['markdownEditor.colorRed', '#ef4444'],
  ['markdownEditor.colorOrange', '#f97316'],
  ['markdownEditor.colorYellow', '#eab308'],
  ['markdownEditor.colorGreen', '#22c55e'],
  ['markdownEditor.colorBlue', '#3b82f6'],
  ['markdownEditor.colorPurple', '#a855f7'],
  ['markdownEditor.colorGray', '#9ca3af'],
] as const satisfies readonly (readonly [TranslationKey, string])[];

const HEADING_LEVELS = [1, 2, 3, 4] as const;

const TABLE_HTML = `<table><thead><tr>${'<th><br></th>'.repeat(3)}</tr></thead><tbody>${`<tr>${'<td><br></td>'.repeat(3)}</tr>`.repeat(2)}</tbody></table><p><br></p>`;

const SURFACE_CLASS = cn(
  htmlContentClass,
  'text-[15px] [&_a]:cursor-text [&_blockquote]:italic [&_h1]:border-b [&_h1]:border-[#28282c] [&_h1]:pb-1 [&_h2]:border-b [&_h2]:border-[#242428] [&_h2]:pb-1 [&_img]:my-2 [&_img]:max-h-120 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-[#2a2a2e] [&_input]:mr-2 [&_input]:accent-[#4a8fe8] [&_li:has(>input)]:list-none [&_li:has(>input)]:-ml-5 [&_mark]:rounded-sm [&_pre]:whitespace-pre [&_pre]:font-[ui-monospace,SFMono-Regular,Consolas,Menlo,monospace] [&_pre]:text-xs [&_pre]:leading-[1.2] [&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_td]:min-w-16 [&_th]:min-w-16 [&_th[data-align=center]]:text-center [&_th[data-align=right]]:text-right [&_td[data-align=center]]:text-center [&_td[data-align=right]]:text-right',
);

/** Runs a browser editing command; false when the browser (or the target) does not offer it. */
function exec(command: string, value?: string): boolean {
  return typeof document.execCommand === 'function' && document.execCommand(command, false, value);
}

/** The element holding the caret, when it is inside `root`. */
function selectionElement(root: HTMLElement | null): Element | null {
  const node = window.getSelection()?.anchorNode ?? null;
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element && root?.contains(element) ? element : null;
}

function unwrap(element: Element): void {
  element.replaceWith(...element.childNodes);
}

/** The selection as HTML (or plain text), null when nothing is selected. */
function selectedHtml(asText: boolean): string | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  if (asText) return escapeHtml(selection.toString());
  const box = document.createElement('div');
  box.append(selection.getRangeAt(0).cloneContents());
  return box.innerHTML;
}

/** Wraps what is selected in `open`/`close` markup (or `placeholder` when nothing is). */
function wrapSelectedHtml(open: string, close: string, placeholder: string, asText = false): void {
  exec('insertHTML', `${open}${selectedHtml(asText) ?? escapeHtml(placeholder)}${close}`);
}

function placeCaret(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function ToolButton({
  icon,
  label,
  onClick,
  pressed,
  popup,
  testId,
}: {
  readonly icon: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly pressed?: boolean;
  readonly popup?: boolean;
  readonly testId: string;
}) {
  return (
    <Button
      type="button"
      variant={pressed ? 'secondary' : 'ghost'}
      className="h-8 w-8 p-0 text-[#b4b4ba] [&_i]:text-base"
      aria-label={label}
      title={label}
      aria-pressed={popup ? undefined : pressed}
      aria-haspopup={popup ? 'true' : undefined}
      aria-expanded={popup ? pressed : undefined}
      data-testid={testId}
      // Keeps the selection of the document while the button is used.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <i className={`ti ${icon}`} aria-hidden="true" />
    </Button>
  );
}

function Separator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-[#2e2e32]" aria-hidden="true" />;
}

export interface MarkdownEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly scope: AttachmentScope;
  readonly placeholder?: string;
  /** The Markdown (code) textarea, for callers that read its selection. */
  readonly codeRef?: RefObject<HTMLTextAreaElement | null>;
  /** Typing in the Markdown textarea, with the caret position (wikilink suggestions). */
  readonly onCodeInput?: (value: string, cursor: number) => void;
  readonly onCodeKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Floats over the Markdown textarea (wikilink suggestions). */
  readonly codeOverlay?: ReactNode;
  /** Extra classes of the root; the editor always fills the width it is given. */
  readonly className?: string;
  /** `data-testid` of the root. */
  readonly testId?: string;
  /** `data-testid` of the Markdown textarea. */
  readonly codeTestId?: string;
  /**
   * Whether images can be added (picker, paste and drop). Turn it off where the text is read by
   * something that cannot see pictures: files are then ignored instead of inserted.
   */
  readonly images?: boolean;
  /** Shows the formatted document without the toolbar, and it cannot be edited. */
  readonly readOnly?: boolean;
}

/** Files dropped where images are not accepted: the browser would open them or insert them. */
const refuseDroppedFiles = (event: DragEvent<HTMLElement>) => {
  if (event.dataTransfer.files.length) event.preventDefault();
};

/**
 * Reusable Markdown editor: any screen that edits Markdown can use it. It has a formatting
 * toolbar and two ways to write the same text, formatted
 * (what the document will look like) and code (the Markdown source), switched at the right end
 * of the toolbar. Both edit `value`; pasted or dropped images are kept as drafts of `scope`.
 */
export function MarkdownEditor({
  value,
  onChange,
  scope,
  placeholder,
  codeRef,
  onCodeInput,
  onCodeKeyDown,
  codeOverlay,
  className,
  testId = 'markdown-editor',
  codeTestId = `${testId}-code`,
  images = true,
  readOnly = false,
}: MarkdownEditorProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('formatted');
  const [menu, setMenu] = useState<Menu>(null);
  const [outline, setOutline] = useState(false);
  const [url, setUrl] = useState('');
  const toolbar = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const ownTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = codeRef ?? ownTextarea;
  const emitted = useRef<string | null>(null);
  const savedRange = useRef<Range | null>(null);

  const emit = () => {
    emitted.current = editorToMarkdown(surface.current!);
    onChange(emitted.current);
  };
  const richImages = useRichTextImageInput(scope, surface, emit);
  const codeImages = useMarkdownImageInput(scope, onChange);
  useInlineImages(surface, `${mode}:${value}`);

  // The formatted view is rebuilt from the Markdown whenever it did not write that text itself
  // (opening it, switching mode, an agent inserting text), never while the person types.
  useLayoutEffect(() => {
    if (mode !== 'formatted') {
      emitted.current = null;
      return;
    }
    if (value === emitted.current) return;
    emitted.current = value;
    surface.current!.innerHTML = markdownToEditorHtml(value);
  }, [mode, value]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const headings = useMemo(() => markdownOutline(value), [value]);

  const changeCode = (next: string, cursor: number) => {
    onChange(next);
    onCodeInput?.(next, cursor);
  };

  const applyEdit = (edit: TextEdit) => {
    const area = textarea.current!;
    area.focus();
    area.setSelectionRange(edit.from, edit.to);
    if (!edit.insert || !exec('insertText', edit.insert)) {
      changeCode(
        `${area.value.slice(0, edit.from)}${edit.insert}${area.value.slice(edit.to)}`,
        edit.from + edit.insert.length,
      );
    }
    requestAnimationFrame(() => area.setSelectionRange(edit.select[0], edit.select[1]));
  };

  /** A command of the Markdown source: builds an edit from the text and the selection. */
  const onSource = (build: (value: string, start: number, end: number) => TextEdit): void => {
    const area = textarea.current!;
    applyEdit(build(area.value, area.selectionStart, area.selectionEnd));
  };

  /** A command of the formatted view: edits the document, then writes it back as Markdown. */
  const onDocument = (command: () => void): void => {
    surface.current!.focus();
    command();
    emit();
  };

  const run = (source: () => void, visual: () => void) => {
    setMenu(null);
    if (mode === 'code') source();
    else onDocument(visual);
  };

  const bold = () =>
    run(
      () => onSource((v, s, e) => wrapSelection(v, s, e, '**', '**', t('markdownEditor.bold'))),
      () => exec('bold'),
    );
  const italic = () =>
    run(
      () => onSource((v, s, e) => wrapSelection(v, s, e, '*', '*', t('markdownEditor.italic'))),
      () => exec('italic'),
    );
  const strike = () =>
    run(
      () => onSource((v, s, e) => wrapSelection(v, s, e, '~~', '~~', t('markdownEditor.strike'))),
      () => exec('strikeThrough'),
    );
  const heading = (level: number) =>
    run(
      () => onSource((v, s, e) => setHeading(v, s, e, level)),
      () => exec('formatBlock', level ? `h${level}` : 'p'),
    );
  const list = (kind: 'ul' | 'ol' | 'task') =>
    run(
      () => onSource((v, s, e) => toggleLines(v, s, e, kind)),
      () =>
        kind === 'task'
          ? exec('insertHTML', '<ul><li><input type="checkbox">&nbsp;</li></ul>')
          : exec(kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList'),
    );
  const table = () =>
    run(
      () => onSource(insertTable),
      () => exec('insertHTML', TABLE_HTML),
    );
  const quote = () =>
    run(
      () => onSource((v, s, e) => toggleLines(v, s, e, 'quote')),
      () =>
        selectionElement(surface.current)?.closest('blockquote')
          ? exec('outdent')
          : exec('formatBlock', 'blockquote'),
    );
  const inlineCode = () =>
    run(
      () =>
        onSource((v, s, e) =>
          wrapSelection(v, s, e, '`', '`', t('markdownEditor.placeholderCode')),
        ),
      () => {
        const code = selectionElement(surface.current)?.closest('code');
        if (code) unwrap(code);
        else wrapSelectedHtml('<code>', '</code>', t('markdownEditor.placeholderCode'), true);
      },
    );
  const codeFence = () =>
    run(
      () => onSource(codeBlock),
      () =>
        selectionElement(surface.current)?.closest('pre')
          ? exec('formatBlock', 'p')
          : exec('formatBlock', 'pre'),
    );
  const highlight = () =>
    run(
      () =>
        onSource((v, s, e) =>
          wrapSelection(v, s, e, '<mark>', '</mark>', t('markdownEditor.highlight')),
        ),
      () => {
        const mark = selectionElement(surface.current)?.closest('mark');
        if (mark) unwrap(mark);
        else wrapSelectedHtml('<mark>', '</mark>', t('markdownEditor.highlight'));
      },
    );
  const color = (hex: string) =>
    run(
      () =>
        onSource((v, s, e) =>
          wrapSelection(
            v,
            s,
            e,
            `<span style="color: ${hex}">`,
            '</span>',
            t('markdownEditor.textColor'),
          ),
        ),
      () =>
        wrapSelectedHtml(`<span style="color: ${hex}">`, '</span>', t('markdownEditor.textColor')),
    );
  const clearColor = () => {
    setMenu(null);
    onDocument(() => {
      const span = selectionElement(surface.current)?.closest('span[style]');
      if (span) unwrap(span);
    });
  };
  const applyLink = () => {
    const address = url.trim();
    if (!address) return;
    setUrl('');
    run(
      () => onSource((v, s, e) => insertLink(v, s, e, address)),
      () => {
        const selection = window.getSelection()!;
        if (savedRange.current) {
          selection.removeAllRanges();
          selection.addRange(savedRange.current);
        }
        if (selection.isCollapsed) {
          exec('insertHTML', `<a href="${escapeHtml(address)}">${escapeHtml(address)}</a>`);
        } else {
          exec('createLink', address);
        }
      },
    );
  };
  const history = (command: 'undo' | 'redo') => {
    setMenu(null);
    (mode === 'code' ? textarea : surface).current!.focus();
    exec(command);
    if (mode === 'formatted') emit();
  };

  const toggleMenu = (next: Exclude<Menu, null>) => {
    if (next === 'link' && menu !== 'link') {
      const selection = window.getSelection();
      savedRange.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    }
    setMenu(menu === next ? null : next);
  };

  const switchMode = (next: Mode) => {
    setMenu(null);
    setMode(next);
  };

  const goToHeading = (index: number) => {
    if (mode === 'code') {
      const area = textarea.current!;
      const offset = outlineOffsets(value, headings)[index]!;
      const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 20;
      area.focus();
      area.setSelectionRange(offset, offset);
      area.scrollTop = value.slice(0, offset).split('\n').length * lineHeight - lineHeight;
      return;
    }
    const target = [...surface.current!.children].filter((child) => /^H[1-6]$/.test(child.tagName))[
      index
    ];
    target?.scrollIntoView({ block: 'start' });
  };

  const onSurfaceKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const cell = selectionElement(surface.current)?.closest('td,th');
    if (!cell) return;
    event.preventDefault();
    const grid = cell.closest('table')!;
    let cells = [...grid.querySelectorAll('th,td')];
    const next = cells.indexOf(cell) + (event.shiftKey ? -1 : 1);
    if (next === cells.length) {
      // Tab in the last cell adds a row.
      const row = document.createElement('tr');
      row.innerHTML = '<td><br></td>'.repeat(cell.parentElement!.children.length);
      grid.tBodies[0]!.append(row);
      cells = [...grid.querySelectorAll('th,td')];
      emit();
    }
    const target = cells[next];
    if (target) placeCaret(target);
  };

  const onSurfacePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (images) richImages.onPaste(event);
    if (event.defaultPrevented) return;
    // Pasted web content brings its own styles; text is inserted as Markdown instead.
    const text = event.clipboardData.getData('text/plain');
    if (!text) {
      // A picture alone would be inserted by the browser itself.
      if (!images && event.clipboardData.files.length) event.preventDefault();
      return;
    }
    event.preventDefault();
    if (text.includes('\n')) exec('insertHTML', markdownToEditorHtml(text));
    else exec('insertText', text);
    emit();
  };

  const insertImages = (files: File[]) => {
    if (mode === 'code') codeImages.insertFiles(textarea.current!, files);
    else richImages.insertFiles(files);
  };

  return (
    <div className={cn('w-full min-w-0 space-y-1.5', className)} data-testid={testId}>
      <div className="overflow-hidden rounded-md border border-border bg-surface-2">
        {!readOnly && (
          <div
            ref={toolbar}
            role="toolbar"
            aria-label={t('markdownEditor.toolbar')}
            className="flex items-start justify-between gap-3 border-b border-border bg-surface-2 p-1.5"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
              <ToolButton
                icon="ti-list-details"
                label={t('markdownEditor.outline')}
                pressed={outline}
                onClick={() => setOutline(!outline)}
                testId="editor-outline"
              />
              <Separator />
              <div className="relative">
                <ToolButton
                  icon="ti-typography"
                  label={t('markdownEditor.textStyle')}
                  popup
                  pressed={menu === 'style'}
                  onClick={() => toggleMenu('style')}
                  testId="editor-style"
                />
                {menu === 'style' && (
                  <div
                    role="menu"
                    aria-label={t('markdownEditor.textStyle')}
                    className="absolute left-0 top-9 z-30 w-40 rounded-md border border-[#34343a] bg-[#202024] p-1 shadow-2xl"
                  >
                    {[0, ...HEADING_LEVELS].map((level) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={level}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => heading(level)}
                        data-testid={`editor-heading-${level}`}
                        className="block w-full rounded px-3 py-1.5 text-left text-sm text-[#d4d4d8] hover:bg-[#29292e]"
                      >
                        {level
                          ? t('markdownEditor.heading', { level })
                          : t('markdownEditor.paragraph')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ToolButton
                icon="ti-bold"
                label={t('markdownEditor.bold')}
                onClick={bold}
                testId="editor-bold"
              />
              <ToolButton
                icon="ti-italic"
                label={t('markdownEditor.italic')}
                onClick={italic}
                testId="editor-italic"
              />
              <ToolButton
                icon="ti-strikethrough"
                label={t('markdownEditor.strike')}
                onClick={strike}
                testId="editor-strike"
              />
              <div className="relative">
                <ToolButton
                  icon="ti-link"
                  label={t('markdownEditor.link')}
                  popup
                  pressed={menu === 'link'}
                  onClick={() => toggleMenu('link')}
                  testId="editor-link"
                />
                {menu === 'link' && (
                  <div className="absolute left-0 top-9 z-30 flex w-72 gap-1.5 rounded-md border border-[#34343a] bg-[#202024] p-2 shadow-2xl">
                    <Input
                      inputSize="sm"
                      autoFocus
                      value={url}
                      placeholder="https://..."
                      aria-label={t('markdownEditor.linkUrl')}
                      data-testid="editor-link-url"
                      onChange={(event) => setUrl(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          applyLink();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={applyLink}
                      data-testid="editor-link-apply"
                      disabled={!url.trim()}
                    >
                      {t('markdownEditor.linkApply')}
                    </Button>
                  </div>
                )}
              </div>
              <Separator />
              <div className="relative">
                <ToolButton
                  icon="ti-palette"
                  label={t('markdownEditor.textColor')}
                  popup
                  pressed={menu === 'color'}
                  onClick={() => toggleMenu('color')}
                  testId="editor-color"
                />
                {menu === 'color' && (
                  <div
                    role="menu"
                    aria-label={t('markdownEditor.textColor')}
                    className="absolute left-0 top-9 z-30 flex items-center gap-1.5 rounded-md border border-[#34343a] bg-[#202024] p-2 shadow-2xl"
                  >
                    {TEXT_COLORS.map(([name, hex]) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={hex}
                        aria-label={t(name)}
                        title={t(name)}
                        data-testid={`editor-color-${hex.slice(1)}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => color(hex)}
                        className="h-5 w-5 rounded-full border border-white/20"
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                    {mode === 'formatted' && (
                      <button
                        type="button"
                        role="menuitem"
                        aria-label={t('markdownEditor.colorDefault')}
                        title={t('markdownEditor.colorDefault')}
                        data-testid="editor-color-default"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={clearColor}
                        className="flex h-5 w-5 items-center justify-center rounded-full border border-white/20 text-[#b4b4ba]"
                      >
                        <i className="ti ti-x text-xs" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <ToolButton
                icon="ti-highlight"
                label={t('markdownEditor.highlight')}
                onClick={highlight}
                testId="editor-highlight"
              />
              <Separator />
              <ToolButton
                icon="ti-list"
                label={t('markdownEditor.bulletList')}
                onClick={() => list('ul')}
                testId="editor-ul"
              />
              <ToolButton
                icon="ti-list-numbers"
                label={t('markdownEditor.numberedList')}
                onClick={() => list('ol')}
                testId="editor-ol"
              />
              <ToolButton
                icon="ti-checklist"
                label={t('markdownEditor.taskList')}
                onClick={() => list('task')}
                testId="editor-task"
              />
              <ToolButton
                icon="ti-table"
                label={t('markdownEditor.table')}
                onClick={table}
                testId="editor-table"
              />
              <Separator />
              <ToolButton
                icon="ti-quote"
                label={t('markdownEditor.quote')}
                onClick={quote}
                testId="editor-quote"
              />
              <ToolButton
                icon="ti-code"
                label={t('markdownEditor.inlineCode')}
                onClick={inlineCode}
                testId="editor-inline-code"
              />
              <ToolButton
                icon="ti-source-code"
                label={t('markdownEditor.codeBlock')}
                onClick={codeFence}
                testId="editor-code-block"
              />
              <Separator />
              <ToolButton
                icon="ti-arrow-back-up"
                label={t('markdownEditor.undo')}
                onClick={() => history('undo')}
                testId="editor-undo"
              />
              <ToolButton
                icon="ti-arrow-forward-up"
                label={t('markdownEditor.redo')}
                onClick={() => history('redo')}
                testId="editor-redo"
              />
            </div>
            <div
              className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-[#2a2a2e] bg-[#141416] p-0.5"
              role="group"
              aria-label={t('markdownEditor.mode')}
            >
              {(
                [
                  ['formatted', 'ti-eye', 'markdownEditor.modeFormatted'],
                  ['code', 'ti-code', 'markdownEditor.modeCode'],
                ] as const
              ).map(([item, icon, label]) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant={mode === item ? 'secondary' : 'ghost'}
                  className={cn('h-7 px-2.5 text-xs', mode === item && 'bg-[#26262a] text-white')}
                  aria-pressed={mode === item}
                  data-testid={`editor-mode-${item}`}
                  leftIcon={<i className={`ti ${icon} text-xs`} aria-hidden="true" />}
                  onClick={() => switchMode(item)}
                >
                  {t(label)}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="flex">
          {outline && (
            <nav
              aria-label={t('markdownEditor.outline')}
              className="thin-scrollbar max-h-[560px] w-52 shrink-0 space-y-0.5 overflow-y-auto border-r border-[#2e2e32] p-2"
              data-testid="editor-outline-panel"
            >
              {headings.length === 0 ? (
                <p className="px-2 py-1 text-xs text-[#85858b]">
                  {t('markdownEditor.outlineEmpty')}
                </p>
              ) : (
                headings.map((entry, index) => (
                  <button
                    type="button"
                    key={`${index}-${entry.text}`}
                    onClick={() => goToHeading(index)}
                    style={{ paddingLeft: `${8 + (entry.level - 1) * 12}px` }}
                    className="block w-full truncate rounded py-1 pr-2 text-left text-xs text-[#c4c4ca] hover:bg-[#26262a]"
                  >
                    {entry.text}
                  </button>
                ))
              )}
            </nav>
          )}
          <div className="relative min-w-0 flex-1">
            {mode === 'formatted' ? (
              <div
                ref={surface}
                contentEditable={!readOnly}
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                aria-readonly={readOnly || undefined}
                aria-label={t('markdownEditor.formattedLabel')}
                data-testid={`${testId}-formatted`}
                className={cn(
                  'thin-scrollbar min-h-[360px] max-h-[560px] overflow-y-auto p-4 outline-none',
                  SURFACE_CLASS,
                )}
                onInput={emit}
                onClick={(event) => {
                  if (event.target instanceof HTMLInputElement) emit();
                }}
                onKeyDown={onSurfaceKeyDown}
                onPaste={onSurfacePaste}
                onDrop={images ? richImages.onDrop : refuseDroppedFiles}
              />
            ) : (
              <>
                <textarea
                  ref={textarea}
                  value={value}
                  onChange={(event) => changeCode(event.target.value, event.target.selectionStart)}
                  onKeyDown={onCodeKeyDown}
                  onPaste={images ? codeImages.onPaste : undefined}
                  onDrop={images ? codeImages.onDrop : refuseDroppedFiles}
                  placeholder={placeholder}
                  rows={16}
                  className="thin-scrollbar block min-h-[360px] w-full resize-y bg-transparent p-4 font-mono text-xs leading-relaxed text-[#e0e0e0] placeholder-[#606060] focus:outline-none"
                  data-testid={codeTestId}
                />
                {codeOverlay}
              </>
            )}
          </div>
        </div>
      </div>
      {images && !readOnly && (
        <div className="flex items-center justify-between gap-3">
          <ImageInputStatus state={mode === 'code' ? codeImages : richImages} />
          <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded border border-[#2a2a2e] bg-[#1a1a1d] px-3 py-1.5 text-xs font-medium text-[#a0a0a0] transition hover:text-white has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
            <i className="ti ti-photo-plus text-xs" aria-hidden="true" />
            {t('markdownEditor.insertImage')}
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              multiple
              className="sr-only"
              data-testid="input-document-image"
              onChange={(event) => {
                const files = [...event.currentTarget.files!];
                event.currentTarget.value = '';
                insertImages(files);
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
