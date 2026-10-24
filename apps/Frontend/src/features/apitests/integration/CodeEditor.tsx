import React, {
  forwardRef,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';
import type { ApiMockValue } from '../api-test-types.js';
import { VariableSuggestionList } from '../VariableInput.js';
import { rankSuggestions, restOfToken, textWidth, typingMatch } from '../variable-suggest.js';
import { VariablesContext, type VariableSuggestion } from '../variables-context.js';
import {
  applyEdit,
  copyLines,
  currentLine,
  deleteLines,
  duplicate,
  formatJson,
  formatXml,
  indent,
  moveLines,
  newLine,
  outdent,
  type Edit,
  type Selection,
} from './code-editing.js';
import { TOKEN_CLASS, tokenize, type CodeLanguage, type Token } from './code-syntax.js';
import {
  completeValue,
  keyBefore,
  rankMocksForKey,
  valueQuote,
  type ValueQuote,
} from './mock-completion.js';
import { insideJsonString, mockSnippet } from './mock-templates.js';

const LINE_HEIGHT = 20;
const PADDING_Y = 8;
const PADDING_X = 12;

/** What the toolbar next to the editor can ask of it. */
export interface CodeEditorHandle {
  /** Re-indents the body; false when it cannot (brackets or tags do not match, or plain text). */
  format: () => boolean;
  /** Inserts `{{$name}}` at the caret, quoted in JSON where a string is expected. */
  insertMock: (name: string) => void;
  /** Inserts a body at the caret, or replaces the content when the editor is empty. */
  insertTemplate: (body: string) => void;
}

/** Why the list is open: a `{{` was typed, a value was opened with a quote, or Ctrl+Space. */
type MenuMode =
  | { readonly kind: 'variable' }
  | { readonly kind: 'value'; readonly opened: ValueQuote }
  | { readonly kind: 'invoke' };

interface Menu {
  readonly mode: MenuMode;
  readonly start: number;
  readonly items: readonly VariableSuggestion[];
  readonly index: number;
  readonly left: number;
  readonly top: number;
}

const MOCK_STYLE = 'rounded-sm bg-[var(--bg-pro)] text-[var(--text-pro)]';
const KNOWN_STYLE = 'rounded-sm bg-[var(--bg-success)] text-[var(--text-success)]';
const UNKNOWN_STYLE = 'rounded-sm bg-[var(--bg-danger)] text-[var(--text-danger)]';

/**
 * Request body editor: a textarea with the text colored by what it is (keys, strings, numbers,
 * tags, `{{variables}}`, mocks), line numbers and the usual editor commands. The colors are a second
 * layer with the same text, font and size right under the textarea, whose own text is transparent;
 * the textarea grows with its content, so the two never need to scroll in step.
 */
export const CodeEditor = forwardRef<
  CodeEditorHandle,
  {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly readOnly: boolean;
    readonly language: CodeLanguage;
    readonly label: string;
    readonly placeholder?: string;
    /** The mock values the API offers; null when not loaded, to avoid flagging them as unknown. */
    readonly mocks?: readonly ApiMockValue[] | null;
  }
>(function CodeEditor(
  { value, onChange, readOnly, language, label, placeholder, mocks = null },
  ref,
) {
  const variables = useContext(VariablesContext);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<readonly [number, number] | null>(null);
  // After Escape, the next Tab leaves the field instead of indenting (keyboard users need a way out).
  const escaped = useRef(false);
  const [menu, setMenu] = useState<Menu | null>(null);

  const known = useMemo(() => new Set(variables?.map((variable) => variable.name)), [variables]);
  const mockNames = useMemo(
    () => (mocks ? new Set(mocks.map((mock) => mock.name)) : null),
    [mocks],
  );
  const tokens = useMemo(() => tokenize(value, language), [value, language]);

  const layers = useMemo(() => {
    const variableStyle = (name: string) => {
      if (name.startsWith('$'))
        return !mockNames || mockNames.has(name) ? MOCK_STYLE : UNKNOWN_STYLE;
      return !variables || known.has(name) ? KNOWN_STYLE : UNKNOWN_STYLE;
    };
    const classOf = (token: Token) =>
      token.kind === 'variable'
        ? variableStyle(token.text.slice(2, -2).trim())
        : token.kind === 'text'
          ? 'text-[var(--text-primary)]'
          : TOKEN_CLASS[token.kind];
    return tokens.map((token, index) => (
      <span key={index} className={classOf(token)}>
        {token.text}
      </span>
    ));
  }, [tokens, known, mockNames, variables]);

  const lines = value.split('\n');
  const widest = Math.max(1, ...lines.map((line) => line.length));

  const selection = (): Selection => {
    const element = textarea.current!;
    return { value: element.value, start: element.selectionStart, end: element.selectionEnd };
  };

  /**
   * Applies an edit through the browser, so Ctrl+Z undoes it like typing; where the browser cannot
   * (`execCommand` is missing), the text is set directly and the selection restored after render.
   */
  const apply = (edit: Edit) => {
    const element = textarea.current;
    if (!element) return;
    const next = applyEdit(element.value, edit);
    element.focus();
    element.setSelectionRange(edit.from, edit.to);
    if (!edit.text && edit.from === edit.to) {
      // Nothing to replace; `execCommand('delete')` would remove a character.
      element.setSelectionRange(edit.selection[0], edit.selection[1]);
      return;
    }
    let done = false;
    if (typeof document.execCommand === 'function') {
      try {
        done = edit.text
          ? document.execCommand('insertText', false, edit.text)
          : document.execCommand('delete');
      } catch {
        done = false;
      }
      done = done && element.value === next;
    }
    if (done) {
      element.setSelectionRange(edit.selection[0], edit.selection[1]);
      return;
    }
    pendingSelection.current = edit.selection;
    onChange(next);
  };

  useLayoutEffect(() => {
    if (!pendingSelection.current || !textarea.current) return;
    textarea.current.setSelectionRange(pendingSelection.current[0], pendingSelection.current[1]);
    pendingSelection.current = null;
  }, [value]);

  const format = (): boolean => {
    const element = textarea.current;
    if (!element) return false;
    const current = element.value;
    const formatted =
      language === 'json' ? formatJson(current) : language === 'xml' ? formatXml(current) : null;
    if (formatted === null) return false;
    if (formatted !== current) {
      const caret = Math.min(element.selectionStart, formatted.length);
      apply({ from: 0, to: current.length, text: formatted, selection: [caret, caret] });
    }
    return true;
  };

  useImperativeHandle(ref, () => ({
    format,
    insertMock(name) {
      const element = textarea.current;
      if (!element) return;
      const { selectionStart: start, selectionEnd: end } = element;
      const inString = language === 'json' && insideJsonString(element.value, start);
      const text = mockSnippet(name, language, inString);
      apply({ from: start, to: end, text, selection: [start + text.length, start + text.length] });
    },
    insertTemplate(body) {
      const element = textarea.current;
      if (!element) return;
      const empty = !element.value.trim();
      const start = empty ? 0 : element.selectionStart;
      const end = empty ? element.value.length : element.selectionEnd;
      apply({
        from: start,
        to: end,
        text: body,
        selection: [start + body.length, start + body.length],
      });
    },
  }));

  // ---------- `{{` suggestions ----------

  /**
   * Opens, updates or closes the list for the caret. `invoked` is Ctrl+Space: it offers mocks for
   * the value of the key before the caret even when nothing was typed yet.
   */
  const refreshMenu = (invoked = false) => {
    const element = textarea.current;
    if (!element || !variables || document.activeElement !== element) return setMenu(null);
    const caret = element.selectionStart;
    if (caret !== element.selectionEnd) return setMenu(null);
    const text = element.value;
    const typing = typingMatch(text.slice(0, caret));
    const opened = !typing && language === 'json' ? valueQuote(text, caret) : null;
    let mode: MenuMode | null = null;
    let items: VariableSuggestion[] = [];
    let start = caret;
    if (typing) {
      mode = { kind: 'variable' };
      items = rankSuggestions(variables, typing.query);
      start = typing.start;
    } else if (opened) {
      mode = { kind: 'value', opened };
      items = rankMocksForKey(variables, opened.key, opened.query);
      start = opened.quote;
    } else if (invoked && language === 'json') {
      mode = { kind: 'invoke' };
      items = rankMocksForKey(variables, keyBefore(text, caret), '');
    }
    if (!mode || !items.length) return setMenu(null);
    const before = text.slice(0, start);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineIndex = before.split('\n').length - 1;
    const rect = element.getBoundingClientRect();
    const left = rect.left + PADDING_X + textWidth(element, before.slice(lineStart));
    const top = rect.top + PADDING_Y + (lineIndex + 1) * LINE_HEIGHT + 4;
    const shown = mode;
    setMenu((current) => ({
      mode: shown,
      start,
      items,
      index:
        current?.start === start && current.mode.kind === shown.kind
          ? Math.min(current.index, items.length - 1)
          : 0,
      left: Math.max(8, Math.min(left, window.innerWidth - 328)),
      top: Math.min(top, window.innerHeight - 240),
    }));
  };

  const choose = (suggestion: VariableSuggestion) => {
    const element = textarea.current;
    if (!element || !menu) return;
    const caret = element.selectionStart;
    if (menu.mode.kind === 'value') {
      // `"name": "|` becomes `"name": "{{$randomFullName}}"`; a number replaces the quote.
      setMenu(null);
      return apply(completeValue(element.value, menu.mode.opened, caret, suggestion.name));
    }
    if (menu.mode.kind === 'invoke') {
      setMenu(null);
      const text = mockSnippet(suggestion.name, language, insideJsonString(element.value, caret));
      return apply({
        from: caret,
        to: caret,
        text,
        selection: [caret + text.length, caret + text.length],
      });
    }
    const rest = element.value.slice(caret);
    // Completing inside an existing token replaces the rest of it.
    const removed = rest.length - restOfToken(rest).length;
    // A mock typed where a JSON value goes is quoted for the user, as the Mocks menu does.
    const plain =
      language !== 'json' ||
      suggestion.source !== 'dynamic' ||
      insideJsonString(element.value, menu.start);
    const text = plain ? `{{${suggestion.name}}}` : mockSnippet(suggestion.name, language, false);
    setMenu(null);
    apply({
      from: menu.start,
      to: caret + removed,
      text,
      selection: [menu.start + text.length, menu.start + text.length],
    });
  };

  // ---------- keyboard ----------

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenu({ ...menu, index: (menu.index + step + menu.items.length) % menu.items.length });
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        choose(menu.items[menu.index]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        return;
      }
    }
    if (event.nativeEvent.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    const run = (edit: Edit | null) => {
      if (!edit) return;
      event.preventDefault();
      apply(edit);
    };

    if (event.key === 'Escape') {
      escaped.current = true;
      return;
    }
    const leaving = escaped.current && event.key === 'Tab';
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) escaped.current = false;
    if (leaving) return;

    const vertical = event.key === 'ArrowDown' ? 'down' : event.key === 'ArrowUp' ? 'up' : null;
    if (event.key === 'Tab' && !mod && !event.altKey) {
      // Shift+Tab with nothing to take off still stays in the field.
      event.preventDefault();
      const edit = event.shiftKey ? outdent(selection()) : indent(selection());
      if (edit) apply(edit);
    } else if (event.key === 'Enter' && !mod && !event.altKey) {
      run(newLine(selection()));
    } else if (vertical && event.altKey && event.shiftKey && !mod) {
      run(copyLines(selection(), vertical));
    } else if (vertical && event.altKey && !event.shiftKey && !mod) {
      run(moveLines(selection(), vertical));
    } else if (event.altKey && event.shiftKey && !mod && event.code === 'KeyF') {
      event.preventDefault();
      format();
    } else if (mod && !event.shiftKey && !event.altKey && event.code === 'Space') {
      event.preventDefault();
      refreshMenu(true);
    } else if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyD') {
      run(duplicate(selection()));
    } else if (mod && event.shiftKey && !event.altKey && event.code === 'KeyK') {
      run(deleteLines(selection()));
    }
  };

  /** Copy and cut with nothing selected take the whole line, as in VS Code. */
  const onClipboard = (event: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    const current = selection();
    if (current.start !== current.end || (cut && readOnly)) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', currentLine(current));
    if (cut) apply(deleteLines(current));
  };

  return (
    <div className="flex min-h-[220px] flex-1 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] focus-within:border-[var(--border-accent)]">
      <div
        aria-hidden="true"
        className="sticky left-0 z-[1] select-none border-r border-[var(--border)] bg-[var(--surface-2)] px-2 py-2 text-right font-mono text-xs leading-5 text-[var(--text-muted)]"
      >
        {lines.map((_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <pre
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 m-0 whitespace-pre px-3 py-2 font-mono text-xs leading-5 [tab-size:2]',
            readOnly && 'opacity-60',
          )}
          data-testid="code-highlight"
        >
          {layers}
        </pre>
        <Textarea
          ref={textarea}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={Boolean(menu)}
          spellCheck={false}
          autoComplete="off"
          wrap="off"
          className="relative min-h-full resize-none rounded-none border-0 bg-transparent px-3 py-2 font-mono text-xs leading-5 text-transparent caret-[var(--text-primary)] shadow-none selection:bg-[rgba(74,143,232,0.3)] focus-visible:ring-0 [tab-size:2]"
          style={{
            height: `${lines.length * LINE_HEIGHT + PADDING_Y * 2}px`,
            width: `calc(${widest}ch + ${PADDING_X * 2 + 16}px)`,
            minWidth: '100%',
          }}
          value={value}
          disabled={readOnly}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
            refreshMenu();
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
            // Letting go of Ctrl+Space must not close the list it just opened.
            if (menu?.mode.kind === 'invoke' && ['Control', 'Meta', ' '].includes(event.key))
              return;
            refreshMenu();
          }}
          onClick={() => refreshMenu()}
          onBlur={() => setMenu(null)}
          onCopy={(event) => onClipboard(event, false)}
          onCut={(event) => onClipboard(event, true)}
        />
      </div>
      {menu && (
        <VariableSuggestionList
          items={menu.items}
          index={menu.index}
          left={menu.left}
          top={menu.top}
          onChoose={choose}
          onHover={(index) => setMenu({ ...menu, index })}
        />
      )}
    </div>
  );
});
