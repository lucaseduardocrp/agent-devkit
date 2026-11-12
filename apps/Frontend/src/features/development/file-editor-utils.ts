export interface Edit {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * What Tab and Shift+Tab do in the editor. A caret (or a selection inside one line) takes spaces up
 * to the next tab stop; a selection that spans lines, and every Shift+Tab, move whole lines by one
 * level. The returned selection still covers what was selected.
 */
export function indentSelection(
  value: string,
  start: number,
  end: number,
  size: number,
  outdent: boolean,
): Edit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const spansLines = value.slice(start, end).includes('\n');
  if (!outdent && !spansLines) {
    const spaces = ' '.repeat(size - ((start - lineStart) % size));
    const next = value.slice(0, start) + spaces + value.slice(end);
    return { value: next, start: start + spaces.length, end: start + spaces.length };
  }

  // The lines the selection touches, whole. A selection that ends right after a line break leaves
  // the next line out, as its caret is not in it.
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = value.indexOf('\n', last);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  let first = 0;
  let total = 0;
  const moved = lines.map((line, index) => {
    const changed = outdent ? removeIndent(line, size) : ' '.repeat(size) + line;
    const delta = changed.length - line.length;
    if (index === 0) first = delta;
    total += delta;
    return changed;
  });
  const nextStart = Math.max(lineStart, start + first);
  return {
    value: value.slice(0, lineStart) + moved.join('\n') + value.slice(lineEnd),
    start: nextStart,
    end: Math.max(nextStart, end + total),
  };
}

/** One level less of indent: up to `size` spaces, or one tab. */
function removeIndent(line: string, size: number): string {
  if (line.startsWith('\t')) return line.slice(1);
  const spaces = /^ */.exec(line)![0].length;
  return line.slice(Math.min(spaces, size));
}

export interface Segment {
  readonly text: string;
  readonly kind: 'text' | 'space' | 'tab' | 'guide' | 'guide-tab';
}

/**
 * Splits a line the way the editor draws it: the indent in tab-stop pieces (each can carry a
 * guide) and the rest with its spaces and tabs told apart (so they can be made visible).
 */
export function lineSegments(line: string, size: number): Segment[] {
  const indent = /^[ \t]*/.exec(line)![0];
  const segments: Segment[] = [];
  let spaces = 0;
  const flush = () => {
    if (spaces)
      segments.push({ text: ' '.repeat(spaces), kind: spaces === size ? 'guide' : 'space' });
    spaces = 0;
  };
  for (const char of indent) {
    if (char === '\t') {
      flush();
      segments.push({ text: '\t', kind: 'guide-tab' });
    } else {
      spaces += 1;
      if (spaces === size) flush();
    }
  }
  flush();
  for (const part of line.slice(indent.length).split(/( +|\t)/)) {
    if (!part) continue;
    segments.push({
      text: part,
      kind: part === '\t' ? 'tab' : part.startsWith(' ') ? 'space' : 'text',
    });
  }
  return segments;
}

export interface Piece extends Segment {
  /** The highlighter classes of the piece, '' for plain text. */
  readonly className: string;
}

/**
 * A line as the editor draws it: its whitespace pieces (see lineSegments) cut again wherever the
 * highlighter changes colour. Tokens that do not add up to the line (a stale highlight) are left
 * out, and the line is drawn plain.
 */
export function linePieces(
  line: string,
  tokens: readonly { readonly text: string; readonly className: string }[] | undefined,
  size: number,
): Piece[] {
  const segments = lineSegments(line, size);
  const usable = tokens && tokens.map((token) => token.text).join('') === line ? tokens : null;
  if (!usable) return segments.map((segment) => ({ ...segment, className: '' }));
  const pieces: Piece[] = [];
  let at = 0;
  let used = 0;
  for (const segment of segments) {
    for (let from = 0; from < segment.text.length;) {
      const token = usable[at]!;
      const take = Math.min(segment.text.length - from, token.text.length - used);
      pieces.push({
        text: segment.text.slice(from, from + take),
        kind: segment.kind,
        className: token.className,
      });
      from += take;
      used += take;
      if (used === token.text.length) {
        at += 1;
        used = 0;
      }
    }
  }
  return pieces;
}

/** The language name a file's extension stands for, for the highlighter of the read-only view. */
export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return extension;
}

export const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);
