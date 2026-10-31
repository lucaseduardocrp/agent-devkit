// Colors for request bodies, GraphQL queries and scripts. The tokenizer is forgiving (a body is usually half written) and
// never loses a character: joining the tokens gives back the text, which is what keeps the colored
// layer exactly under the textarea it decorates.

export type CodeLanguage = 'json' | 'xml' | 'text' | 'javascript' | 'graphql';

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

const JS_KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'of',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const JS_NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?|\.\d+)/y;

/** Scripts: keywords, strings, template literals, comments and numbers. No `{{variables}}`. */
function tokenizeJavascript(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '/' && text[index + 1] === '/') {
      const next = text.indexOf('\n', index);
      const end = next === -1 ? text.length : next;
      push(tokens, 'comment', text.slice(index, end));
      index = end;
    } else if (char === '/' && text[index + 1] === '*') {
      const next = text.indexOf('*/', index + 2);
      const end = next === -1 ? text.length : next + 2;
      push(tokens, 'comment', text.slice(index, end));
      index = end;
    } else if (char === '"' || char === "'" || char === '`') {
      // Quotes end at the line break; template literals may span lines.
      let end = index + 1;
      while (end < text.length && text[end] !== char && (char === '`' || text[end] !== '\n')) {
        end += text[end] === '\\' ? 2 : 1;
      }
      end = Math.min(text[end] === char ? end + 1 : end, text.length);
      push(tokens, 'string', text.slice(index, end));
      index = end;
    } else if (/[A-Za-z_$]/.test(char)) {
      const word = at(IDENTIFIER, text, index)!;
      push(tokens, JS_KEYWORDS.has(word) ? 'keyword' : 'text', word);
      index += word.length;
    } else if (/\d/.test(char) || (char === '.' && /\d/.test(text[index + 1] ?? ''))) {
      // A digit, or a dot followed by one, always matches.
      const number = at(JS_NUMBER, text, index)!;
      tokens.push({ kind: 'number', text: number });
      index += number.length;
    } else if ('{}[]().,;:?=+-*/%!<>&|^~'.includes(char)) {
      tokens.push({ kind: 'punct', text: char });
      index += 1;
    } else {
      push(tokens, 'text', char);
      index += 1;
    }
  }
  return tokens;
}

const GRAPHQL_KEYWORDS = new Set([
  'query',
  'mutation',
  'subscription',
  'fragment',
  'on',
  'true',
  'false',
  'null',
  'schema',
  'type',
  'input',
  'enum',
  'interface',
  'union',
  'scalar',
  'extend',
  'implements',
  'directive',
]);
const GRAPHQL_NAME = /[_A-Za-z][_0-9A-Za-z]*/y;

/**
 * GraphQL queries: keywords, `$variables` (attr), `@directives` (tag), argument and alias names
 * (key), strings, block strings, numbers and `#` comments; `{{variables}}` as in the bodies.
 */
function tokenizeGraphql(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const variable = char === '{' ? at(VARIABLE, text, index) : null;
    if (variable) {
      tokens.push({ kind: 'variable', text: variable });
      index += variable.length;
    } else if (char === '#') {
      const next = text.indexOf('\n', index);
      const end = next === -1 ? text.length : next;
      push(tokens, 'comment', text.slice(index, end));
      index = end;
    } else if (text.startsWith('"""', index)) {
      const next = text.indexOf('"""', index + 3);
      const end = next === -1 ? text.length : next + 3;
      withVariables(tokens, 'string', text.slice(index, end));
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') {
        end += text[end] === '\\' && text[end + 1] !== '\n' ? 2 : 1;
      }
      end = Math.min(text[end] === '"' ? end + 1 : end, text.length);
      withVariables(tokens, 'string', text.slice(index, end));
      index = end;
    } else if ((char === '$' || char === '@') && /[_A-Za-z]/.test(text[index + 1] ?? '')) {
      const name = at(GRAPHQL_NAME, text, index + 1)!;
      tokens.push({ kind: char === '$' ? 'attr' : 'tag', text: char + name });
      index += name.length + 1;
    } else if (/[_A-Za-z]/.test(char)) {
      const name = at(GRAPHQL_NAME, text, index)!;
      let after = index + name.length;
      while (text[after] === ' ' || text[after] === '\t') after += 1;
      const kind = GRAPHQL_KEYWORDS.has(name) ? 'keyword' : text[after] === ':' ? 'key' : 'text';
      tokens.push({ kind, text: name });
      index += name.length;
    } else if (/[-\d]/.test(char) && at(NUMBER, text, index)) {
      const number = at(NUMBER, text, index)!;
      tokens.push({ kind: 'number', text: number });
      index += number.length;
    } else if (text.startsWith('...', index)) {
      tokens.push({ kind: 'punct', text: '...' });
      index += 3;
    } else if ('{}()[]:!=,|&'.includes(char)) {
      tokens.push({ kind: 'punct', text: char });
      index += 1;
    } else {
      push(tokens, 'text', char);
      index += 1;
    }
  }
  return tokens;
}

export function tokenize(text: string, language: CodeLanguage): Token[] {
  if (language === 'json') return tokenizeJson(text);
  if (language === 'xml') return tokenizeXml(text);
  if (language === 'javascript') return tokenizeJavascript(text);
  if (language === 'graphql') return tokenizeGraphql(text);
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
