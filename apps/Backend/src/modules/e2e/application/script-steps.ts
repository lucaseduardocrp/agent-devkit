/**
 * Finds the top-level `await test.step(...)` statements of a Playwright spec and swaps one of
 * them for a rewritten one, so that fixing a step can never change the rest of the file (the
 * login, the helpers, the other steps). It reads just enough TypeScript to skip strings,
 * template literals, comments and regular expressions: the specs are written by a model and
 * checked by the script guard, not by a full parser.
 */

export interface SpecStep {
  /** Offset of the statement: its `await`, or `test.step` when there is none. */
  readonly start: number;
  /** Offset right after the statement, its `;` included. */
  readonly end: number;
  /** The title literal as written (quotes included), when the step is named by one. */
  readonly title: { readonly start: number; readonly end: number } | null;
}

/** After one of these a `/` starts a regular expression instead of dividing. */
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-']);

/** End of the string, template, comment or regular expression starting at `index`; null if none. */
function skipLiteral(source: string, index: number, previous: string): number | null {
  const char = source[index]!;
  if (char === "'" || char === '"') {
    let i = index + 1;
    while (i < source.length && source[i] !== char) i += source[i] === '\\' ? 2 : 1;
    return i + 1;
  }
  if (char === '`') return skipTemplate(source, index + 1);
  if (char !== '/') return null;
  const next = source[index + 1];
  if (next === '/') {
    const eol = source.indexOf('\n', index);
    return eol === -1 ? source.length : eol;
  }
  if (next === '*') {
    const close = source.indexOf('*/', index + 2);
    return close === -1 ? source.length : close + 2;
  }
  if (!BEFORE_REGEX.has(previous)) return null;
  let i = index + 1;
  let inClass = false;
  while (i < source.length && source[i] !== '\n') {
    const current = source[i]!;
    if (current === '\\') i += 1;
    else if (current === '[') inClass = true;
    else if (current === ']') inClass = false;
    else if (current === '/' && !inClass) break;
    i += 1;
  }
  i += 1;
  while (/[a-z]/i.test(source[i] ?? '')) i += 1;
  return i;
}

const isComment = (source: string, index: number): boolean =>
  source[index] === '/' && (source[index + 1] === '/' || source[index + 1] === '*');

/** End of a template literal whose body starts at `index`, `${...}` included. */
function skipTemplate(source: string, index: number): number {
  let i = index;
  while (i < source.length && source[i] !== '`') {
    if (source[i] === '\\') i += 2;
    else if (source[i] === '$' && source[i + 1] === '{') i = skipBalanced(source, i + 1, '{', '}');
    else i += 1;
  }
  return i + 1;
}

/** Offset after the bracket that closes the one at `open`; the end of the source when it never does. */
function skipBalanced(source: string, open: number, opening: string, closing: string): number {
  let depth = 0;
  let previous = '';
  let i = open;
  while (i < source.length) {
    const skipped = skipLiteral(source, i, previous);
    if (skipped !== null) {
      // Comments do not count as what came before; strings and expressions do.
      if (!isComment(source, i)) previous = 'a';
      i = skipped;
      continue;
    }
    const char = source[i]!;
    if (char === opening) depth += 1;
    else if (char === closing && (depth -= 1) === 0) return i + 1;
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return source.length;
}

/** The top-level steps of the spec in the order they run; steps nested in a step are part of it. */
export function topLevelSteps(source: string): SpecStep[] {
  const steps: SpecStep[] = [];
  let previous = '';
  let i = 0;
  while (i < source.length) {
    const skipped = skipLiteral(source, i, previous);
    if (skipped !== null) {
      if (!isComment(source, i)) previous = 'a';
      i = skipped;
      continue;
    }
    const isStep =
      source.startsWith('test.step(', i) && !/[\w$.]/.test(i > 0 ? source[i - 1]! : ' ');
    if (!isStep) {
      if (!/\s/.test(source[i]!)) previous = source[i]!;
      i += 1;
      continue;
    }
    const open = i + 'test.step'.length;
    let end = skipBalanced(source, open, '(', ')');
    const awaited = /await\s+$/.exec(source.slice(0, i));
    const argument = open + 1 + /^\s*/.exec(source.slice(open + 1))![0].length;
    const titleEnd = /['"`]/.test(source[argument] ?? '')
      ? skipLiteral(source, argument, '(')
      : null;
    end += /^[ \t]*;?/.exec(source.slice(end))![0].length;
    steps.push({
      start: awaited ? i - awaited[0].length : i,
      end,
      title: titleEnd === null ? null : { start: argument, end: titleEnd },
    });
    previous = ';';
    i = end;
  }
  return steps;
}

export type StepSwap =
  { readonly ok: true; readonly script: string } | { readonly ok: false; readonly problem: string };

/**
 * Puts `rewritten` (one `await test.step(...)` statement) in place of step `position` (from 1) of
 * `original`. Everything else stays byte for byte, and the step keeps the name it had, so the
 * evidence and the report still find it.
 */
export function replaceStep(original: string, position: number, rewritten: string): StepSwap {
  const target = topLevelSteps(original)[position - 1];
  if (!target) return { ok: false, problem: `The script has no step ${position}.` };
  const block = rewritten.trim();
  const found = topLevelSteps(block);
  if (found.length !== 1 || found[0]!.start !== 0 || found[0]!.end !== block.length)
    return {
      ok: false,
      problem:
        'The answer must be exactly one await test.step(...) statement, the rewritten step, with nothing before or after it (no imports, test(...), fixtures or other steps).',
    };
  const title = found[0]!.title;
  const named =
    title && target.title
      ? block.slice(0, title.start) +
        original.slice(target.title.start, target.title.end) +
        block.slice(title.end)
      : block;
  return { ok: true, script: original.slice(0, target.start) + named + original.slice(target.end) };
}
