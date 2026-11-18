/**
 * Toolbar commands of the Markdown (code) mode. Each one turns the text and the selection into
 * a `TextEdit`: replace `from..to` with `insert`, then select `select`. Edits are small and
 * local so the editor can apply them as a typed change and keep the textarea's undo history.
 */
export interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly select: readonly [number, number];
}

/** Wraps the selection in `before`/`after`, or removes them when they already surround it. */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after = before,
  placeholder = '',
): TextEdit {
  const selected = value.slice(start, end);
  if (
    selected &&
    start >= before.length &&
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after
  ) {
    return {
      from: start - before.length,
      to: end + after.length,
      insert: selected,
      select: [start - before.length, end - before.length],
    };
  }
  const inner = selected || placeholder;
  return {
    from: start,
    to: end,
    insert: `${before}${inner}${after}`,
    select: [start + before.length, start + before.length + inner.length],
  };
}

const LIST_MARKER = /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/;
const LINE_MARKERS = {
  quote: /^>\s?/,
  ul: /^[-*+]\s+(?!\[[ xX]\]\s)/,
  ol: /^\d+\.\s+/,
  task: /^[-*+]\s+\[[ xX]\]\s+/,
} as const;

export type LineKind = keyof typeof LINE_MARKERS;

/** Whole lines the selection touches. */
function lineRange(value: string, start: number, end: number): { from: number; to: number } {
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const next = value.indexOf('\n', last);
  return { from, to: next === -1 ? value.length : next };
}

function replaceLines(
  value: string,
  start: number,
  end: number,
  change: (lines: string[]) => string[],
): TextEdit {
  const { from, to } = lineRange(value, start, end);
  const insert = change(value.slice(from, to).split('\n')).join('\n');
  return { from, to, insert, select: [from, from + insert.length] };
}

/** Quote, bullet, numbered and task lists: adds the marker to the lines, or removes it. */
export function toggleLines(value: string, start: number, end: number, kind: LineKind): TextEdit {
  return replaceLines(value, start, end, (lines) => {
    const filled = lines.filter((line) => line.trim());
    const active = filled.length ? filled : lines;
    if (active.every((line) => LINE_MARKERS[kind].test(line))) {
      return lines.map((line) => line.replace(LINE_MARKERS[kind], ''));
    }
    const strip = kind === 'quote' ? LINE_MARKERS.quote : LIST_MARKER;
    let number = 0;
    return lines.map((line) => {
      if (filled.length && !line.trim()) return line;
      const text = line.replace(strip, '');
      number += 1;
      return `${{ quote: '> ', ul: '- ', task: '- [ ] ', ol: `${number}. ` }[kind]}${text}`;
    });
  });
}

/** Turns the lines into a heading of `level` (1-6), or into plain text for level 0. */
export function setHeading(value: string, start: number, end: number, level: number): TextEdit {
  return replaceLines(value, start, end, (lines) =>
    lines.map((line) => {
      const text = line.replace(/^#{1,6}\s+/, '');
      return level ? `${'#'.repeat(level)} ${text}` : text;
    }),
  );
}

/** Puts a block (table, code fence...) in its own paragraph, replacing the selection. */
export function insertBlock(
  value: string,
  start: number,
  end: number,
  block: string,
  cursor: number = block.length,
): TextEdit {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = !after
    ? '\n'
    : after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n';
  const at = start + lead.length + cursor;
  return { from: start, to: end, insert: `${lead}${block}${trail}`, select: [at, at] };
}

/** Fenced code block around the selection (or an empty one with the cursor inside). */
export function codeBlock(value: string, start: number, end: number): TextEdit {
  const selected = value.slice(start, end);
  return insertBlock(value, start, end, `\`\`\`\n${selected}\n\`\`\``, selected.length + 4);
}

const TABLE = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';

export function insertTable(value: string, start: number, end: number): TextEdit {
  return insertBlock(value, start, end, TABLE);
}

/** `[text](url)`; the selection (or the address) becomes the link text. */
export function insertLink(value: string, start: number, end: number, url: string): TextEdit {
  const text = value.slice(start, end) || url;
  const insert = `[${text}](${url})`;
  return { from: start, to: end, insert, select: [start + insert.length, start + insert.length] };
}
