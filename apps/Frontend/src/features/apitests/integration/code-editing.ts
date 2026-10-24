// Editor commands of the request body, as pure functions: each takes the text and the selection
// and returns the replacement to apply (or null when there is nothing to do). The component applies
// it through the browser so undo keeps working; here it is only text and offsets.

import { tokenize } from './code-syntax.js';

export const INDENT = '  ';

export interface Selection {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Replaces `value[from, to]` by `text`; `selection` is where the caret goes, in the new text. */
export interface Edit {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly selection: readonly [number, number];
}

export const applyEdit = (value: string, edit: Edit): string =>
  value.slice(0, edit.from) + edit.text + value.slice(edit.to);

/** Where the line that contains `index` starts (`lastIndexOf` with -1 would look at index 0). */
const lineStart = (value: string, index: number) =>
  index <= 0 ? 0 : value.lastIndexOf('\n', index - 1) + 1;

/** Whole lines touched by the selection: a selection that ends at a line start leaves that line out. */
function lineBounds({ value, start, end }: Selection): { from: number; to: number } {
  const from = lineStart(value, start);
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const next = value.indexOf('\n', last);
  return { from, to: next === -1 ? value.length : next };
}

/** Tab: indents the lines of a multi-line selection, or inserts one level at the caret. */
export function indent(selection: Selection): Edit {
  const { value, start, end } = selection;
  const { from, to } = lineBounds(selection);
  if (!value.slice(start, end).includes('\n')) {
    return {
      from: start,
      to: end,
      text: INDENT,
      selection: [start + INDENT.length, start + INDENT.length],
    };
  }
  const lines = value.slice(from, to).split('\n');
  return {
    from,
    to,
    text: lines.map((line) => (line ? INDENT + line : line)).join('\n'),
    // A selection that starts at the line start keeps covering the new indentation.
    selection: [
      start === from ? start : start + INDENT.length,
      end + INDENT.length * lines.filter(Boolean).length,
    ],
  };
}

/** Shift+Tab: takes one level off the start of each line of the selection. */
export function outdent(selection: Selection): Edit | null {
  const { value, start, end } = selection;
  const { from, to } = lineBounds(selection);
  const lines = value.slice(from, to).split('\n');
  const removed = lines.map((line) =>
    /^\t/.test(line) ? 1 : (/^ {1,2}/.exec(line)?.[0].length ?? 0),
  );
  const total = removed.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  const text = lines.map((line, index) => line.slice(removed[index])).join('\n');
  return {
    from,
    to,
    text,
    selection: [Math.max(from, start - removed[0]!), Math.max(from, end - total)],
  };
}

/** Copy line down / up (Shift+Alt+Down / Up): the lines of the selection, repeated below or above. */
export function copyLines(selection: Selection, direction: 'up' | 'down'): Edit {
  const { value, start, end } = selection;
  const { from, to } = lineBounds(selection);
  const block = value.slice(from, to);
  if (direction === 'down') {
    return {
      from: to,
      to,
      text: `\n${block}`,
      selection: [start + block.length + 1, end + block.length + 1],
    };
  }
  // The text moves down; the caret stays where it was, on the new copy above.
  return { from, to: from, text: `${block}\n`, selection: [start, end] };
}

/** Ctrl+D: repeats the selected text after itself, or the line when nothing is selected. */
export function duplicate(selection: Selection): Edit {
  const { value, start, end } = selection;
  if (start === end) return copyLines(selection, 'down');
  const text = value.slice(start, end);
  return { from: end, to: end, text, selection: [end, end + text.length] };
}

/** Alt+Up / Alt+Down: moves the lines of the selection over the neighbour line. */
export function moveLines(selection: Selection, direction: 'up' | 'down'): Edit | null {
  const { value, start, end } = selection;
  const { from, to } = lineBounds(selection);
  const block = value.slice(from, to);
  if (direction === 'up') {
    if (from === 0) return null;
    const previousFrom = lineStart(value, from - 1);
    const previous = value.slice(previousFrom, from - 1);
    const shift = previous.length + 1;
    return {
      from: previousFrom,
      to,
      text: `${block}\n${previous}`,
      selection: [start - shift, end - shift],
    };
  }
  if (to >= value.length) return null;
  const nextTo = value.indexOf('\n', to + 1);
  const next = value.slice(to + 1, nextTo === -1 ? value.length : nextTo);
  const shift = next.length + 1;
  return {
    from,
    to: to + shift,
    text: `${next}\n${block}`,
    selection: [start + shift, end + shift],
  };
}

/** Ctrl+Shift+K and cut with nothing selected: removes the lines of the selection. */
export function deleteLines(selection: Selection): Edit {
  const { value } = selection;
  const { from, to } = lineBounds(selection);
  // The line break goes with the line: the one after it, or the one before when it is the last.
  const [cutFrom, cutTo] =
    to < value.length ? [from, to + 1] : from > 0 ? [from - 1, to] : [from, to];
  const caret = Math.min(cutFrom, value.length - (cutTo - cutFrom));
  return { from: cutFrom, to: cutTo, text: '', selection: [caret, caret] };
}

/** What copy and cut put on the clipboard when nothing is selected: the line, with its break. */
export function currentLine(selection: Selection): string {
  const { from, to } = lineBounds(selection);
  return `${selection.value.slice(from, to)}\n`;
}

/** Enter: keeps the indentation of the line, and opens a level after `{` or `[`. */
export function newLine(selection: Selection): Edit {
  const { value, start, end } = selection;
  const lead = /^[ \t]*/.exec(value.slice(lineStart(value, start), start))![0];
  const before = value[start - 1];
  const after = value[end];
  if (before === '{' || before === '[') {
    const closes = (before === '{' && after === '}') || (before === '[' && after === ']');
    const inner = `\n${lead}${INDENT}`;
    const text = closes ? `${inner}\n${lead}` : inner;
    const caret = start + inner.length;
    return { from: start, to: end, text, selection: [caret, caret] };
  }
  const caret = start + 1 + lead.length;
  return { from: start, to: end, text: `\n${lead}`, selection: [caret, caret] };
}

const OPENING = new Set(['{', '[']);

/**
 * Re-indents JSON. It works on tokens, not on parsed data, so a body with `{{variables}}` where a
 * value goes (`"age": {{age}}`) formats too. Null when the brackets do not balance.
 */
export function formatJson(text: string): string | null {
  const tokens = tokenize(text, 'json');
  let out = '';
  let depth = 0;
  // Whitespace between two values is kept as one space; inside a string the tokens touch.
  let spaced = false;
  let previous: (typeof tokens)[number] | undefined;
  const lineBreak = () => `\n${INDENT.repeat(depth)}`;
  for (const token of tokens) {
    if (token.kind === 'text' && !token.text.trim()) {
      spaced = true;
      continue;
    }
    const punct = token.kind === 'punct' ? token.text : '';
    const afterOpening = previous?.kind === 'punct' && OPENING.has(previous.text);
    if (punct === '}' || punct === ']') {
      depth -= 1;
      if (depth < 0) return null;
      // `{}` and `[]` stay on one line.
      out += (afterOpening ? '' : lineBreak()) + punct;
    } else {
      const afterComma = previous?.kind === 'punct' && previous.text === ',';
      if (afterOpening || afterComma) out += lineBreak();
      else if (spaced && previous && previous.kind !== 'punct' && !punct) out += ' ';
      if (punct === ':') out += ': ';
      else out += token.text;
      if (OPENING.has(punct)) depth += 1;
    }
    previous = token;
    spaced = false;
  }
  return depth === 0 ? out : null;
}

const XML_PART = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![\s\S]*?>|<[^>]+>|[^<]+/g;

/** Re-indents XML: one element per line, `<a>text</a>` kept together. Null when tags do not balance. */
export function formatXml(text: string): string | null {
  const parts = (text.match(XML_PART) ?? []).filter((part) => part.trim());
  const lines: string[] = [];
  let depth = 0;
  const open = (part: string) => /^<[^!?/]/.test(part) && !part.endsWith('/>');
  const close = (part: string) => part.startsWith('</');
  const pad = () => INDENT.repeat(depth);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = parts[index + 1];
    if (
      open(part) &&
      next &&
      !next.startsWith('<') &&
      parts[index + 2] &&
      close(parts[index + 2]!)
    ) {
      lines.push(`${pad()}${part}${next.trim()}${parts[index + 2]}`);
      index += 2;
    } else if (close(part)) {
      depth -= 1;
      if (depth < 0) return null;
      lines.push(pad() + part);
    } else {
      lines.push(pad() + part.trim());
      if (open(part)) depth += 1;
    }
  }
  return depth === 0 ? lines.join('\n') : null;
}
