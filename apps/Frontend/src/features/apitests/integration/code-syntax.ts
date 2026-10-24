// Colors for request bodies. The tokenizer is forgiving (a body is usually half written) and
// never loses a character: joining the tokens gives back the text, which is what keeps the colored
// layer exactly under the textarea it decorates.

export type CodeLanguage = 'json' | 'xml' | 'text';

export type TokenKind =
  | 'key'
  | 'string'
  | 'number'
  | 'keyword'
  | 'punct'
  | 'tag'
  | 'attr'
  | 'comment'
  | 'variable'
  | 'text';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const VARIABLE = /\{\{[^{}\n]*\}\}/y;
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /(?:true|false|null)(?!\w)/y;
const NAME = /[\w:.-]+/y;

/** Matches `pattern` (sticky) at `index`. */
function at(pattern: RegExp, text: string, index: number): string | null {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0] ?? null;
}

/** Appends a token, joining it to the previous one when they are the same kind of plain text. */
function push(tokens: Token[], kind: TokenKind, text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind && (kind === 'text' || kind === 'string' || kind === 'key')) {
    tokens[tokens.length - 1] = { kind, text: last.text + text };
    return;
  }
  tokens.push({ kind, text });
}

/** `text` as tokens of `kind`, with its `{{variables}}` as their own tokens. */
function withVariables(tokens: Token[], kind: TokenKind, text: string): void {
  let from = 0;
  let index = text.indexOf('{{');
  while (index !== -1) {
    const variable = at(VARIABLE, text, index);
    if (variable) {
      push(tokens, kind, text.slice(from, index));
      tokens.push({ kind: 'variable', text: variable });
      from = index + variable.length;
      index = text.indexOf('{{', from);
    } else {
      index = text.indexOf('{{', index + 2);
    }
  }
  push(tokens, kind, text.slice(from));
}

function tokenizeJson(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const variable = char === '{' ? at(VARIABLE, text, index) : null;
    if (variable) {
      tokens.push({ kind: 'variable', text: variable });
      index += variable.length;
    } else if (char === '"') {
      // Up to the closing quote; an unfinished string ends at the line break.
      let end = index + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') {
        end += text[end] === '\\' && text[end + 1] !== '\n' ? 2 : 1;
      }
      if (text[end] === '"') end += 1;
      end = Math.min(end, text.length);
      let after = end;
      while (text[after] === ' ' || text[after] === '\t') after += 1;
      withVariables(tokens, text[after] === ':' ? 'key' : 'string', text.slice(index, end));
      index = end;
    } else if ('{}[],:'.includes(char)) {
      tokens.push({ kind: 'punct', text: char });
      index += 1;
    } else {
      const number = /[-\d]/.test(char) ? at(NUMBER, text, index) : null;
      const word = number || /\w/.test(text[index - 1] ?? '') ? null : at(WORD, text, index);
      if (number || word) {
        const found = (number ?? word)!;
        tokens.push({ kind: number ? 'number' : 'keyword', text: found });
        index += found.length;
      } else {
        push(tokens, 'text', char);
        index += 1;
      }
    }
  }
  return tokens;
}

function tokenizeXml(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const closing = (marker: string, from: number) => {
    const found = text.indexOf(marker, from);
    return found === -1 ? text.length : found + marker.length;
  };
  while (index < text.length) {
    if (text[index] !== '<') {
      const next = text.indexOf('<', index);
      const end = next === -1 ? text.length : next;
      withVariables(tokens, 'text', text.slice(index, end));
      index = end;
    } else if (text.startsWith('<!--', index)) {
      const end = closing('-->', index + 4);
      push(tokens, 'comment', text.slice(index, end));
      index = end;
    } else if (text.startsWith('<?', index) || text.startsWith('<!', index)) {
      const end = closing(text[index + 1] === '?' ? '?>' : '>', index + 2);
      push(tokens, 'keyword', text.slice(index, end));
      index = end;
    } else {
      // A tag: `<name attr="value">`, `</name>` or `<name/>`.
      const open = text.startsWith('</', index) ? '</' : '<';
      tokens.push({ kind: 'punct', text: open });
      index += open.length;
      const name = at(NAME, text, index);
      if (name) {
        tokens.push({ kind: 'tag', text: name });
        index += name.length;
      }
      while (index < text.length && text[index] !== '>' && !text.startsWith('/>', index)) {
        const char = text[index]!;
        if (char === '"' || char === "'") {
          let end = text.indexOf(char, index + 1);
          end = end === -1 ? text.length : end + 1;
          withVariables(tokens, 'string', text.slice(index, end));
          index = end;
          continue;
        }
        const variable = char === '{' ? at(VARIABLE, text, index) : null;
        const attribute = variable ? null : at(NAME, text, index);
        if (variable) {
          tokens.push({ kind: 'variable', text: variable });
          index += variable.length;
        } else if (attribute) {
          tokens.push({ kind: 'attr', text: attribute });
          index += attribute.length;
        } else {
          push(tokens, char === '=' ? 'punct' : 'text', char);
          index += 1;
        }
      }
      const end = text.startsWith('/>', index) ? '/>' : text[index] === '>' ? '>' : '';
      if (end) tokens.push({ kind: 'punct', text: end });
      index += end.length;
    }
  }
  return tokens;
}

export function tokenize(text: string, language: CodeLanguage): Token[] {
  if (language === 'json') return tokenizeJson(text);
  if (language === 'xml') return tokenizeXml(text);
  const tokens: Token[] = [];
  withVariables(tokens, 'text', text);
  return tokens;
}

/** Tailwind classes of each token kind; the colors are the `--code-*` tokens of index.css. */
export const TOKEN_CLASS: Record<Exclude<TokenKind, 'variable' | 'text'>, string> = {
  key: 'text-[var(--code-key)]',
  string: 'text-[var(--code-string)]',
  number: 'text-[var(--code-number)]',
  keyword: 'text-[var(--code-keyword)]',
  punct: 'text-[var(--code-punct)]',
  tag: 'text-[var(--code-tag)]',
  attr: 'text-[var(--code-attr)]',
  comment: 'italic text-[var(--code-comment)]',
};
