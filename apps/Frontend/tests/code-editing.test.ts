import { describe, expect, it } from 'vitest';
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
} from '../src/features/apitests/integration/code-editing.js';
import {
  tokenize,
  type CodeLanguage,
  type Token,
} from '../src/features/apitests/integration/code-syntax.js';

/** `a¦b` is a caret; `a«b»c` selects b. */
function parse(marked: string): Selection {
  const caret = marked.indexOf('¦');
  if (caret !== -1) {
    const value = marked.replace('¦', '');
    return { value, start: caret, end: caret };
  }
  const start = marked.indexOf('«');
  const end = marked.indexOf('»') - 1;
  return { value: marked.replace('«', '').replace('»', ''), start, end };
}

/** The text after the edit, with the selection marked the same way. */
function after(marked: string, run: (selection: Selection) => Edit | null): string {
  const selection = parse(marked);
  const edit = run(selection);
  if (!edit) return marked;
  const value = applyEdit(selection.value, edit);
  const [start, end] = edit.selection;
  return start === end
    ? `${value.slice(0, start)}¦${value.slice(start)}`
    : `${value.slice(0, start)}«${value.slice(start, end)}»${value.slice(end)}`;
}

describe('syntax tokens', () => {
  const samples: [CodeLanguage, string][] = [
    [
      'json',
      '{\n  "name": "{{$randomFullName}}",\n  "age": {{age}},\n  "ok": true, "n": null, "x": -1.5e3\n}',
    ],
    ['json', '{"broken": "never closed\n  "next": [1, 2,'],
    ['json', '"a\\"b" "c\\'],
    ['json', 'plain text {{var}} é ç 日本'],
    ['json', ''],
    ['xml', '<?xml version="1.0"?>\n<a id="{{id}}" b=\'x\'><!-- note -->{{text}}<b/></a>'],
    ['xml', '<unclosed attr="v'],
    ['xml', 'a < b > c <'],
    ['text', 'one {{two}} three {{ four }} {{'],
    ['json', 'line1\r\nline2\r\n'],
  ];

  it.each(samples)('never loses a character (%s)', (language, text) => {
    expect(
      tokenize(text, language)
        .map((token) => token.text)
        .join(''),
    ).toBe(text);
  });

  const kinds = (text: string, language: CodeLanguage) =>
    tokenize(text, language)
      .filter((token) => token.kind !== 'text' || token.text.trim())
      .map((token): [string, string] => [token.kind, token.text]);

  it('tells keys, strings, numbers, keywords, punctuation and variables apart in JSON', () => {
    expect(
      kinds('{"name": "Hi {{who}}!", "age": 42, "ok": true, "x": null, "id": {{id}}}', 'json'),
    ).toEqual([
      ['punct', '{'],
      ['key', '"name"'],
      ['punct', ':'],
      ['string', '"Hi '],
      ['variable', '{{who}}'],
      ['string', '!"'],
      ['punct', ','],
      ['key', '"age"'],
      ['punct', ':'],
      ['number', '42'],
      ['punct', ','],
      ['key', '"ok"'],
      ['punct', ':'],
      ['keyword', 'true'],
      ['punct', ','],
      ['key', '"x"'],
      ['punct', ':'],
      ['keyword', 'null'],
      ['punct', ','],
      ['key', '"id"'],
      ['punct', ':'],
      ['variable', '{{id}}'],
      ['punct', '}'],
    ]);
  });

  it('colors a variable inside a key, a negative number and an exponent', () => {
    expect(kinds('{"{{k}}": -1.5e3}', 'json')).toEqual([
      ['punct', '{'],
      ['key', '"'],
      ['variable', '{{k}}'],
      ['key', '"'],
      ['punct', ':'],
      ['number', '-1.5e3'],
      ['punct', '}'],
    ]);
  });

  it('does not take the middle of a word for a keyword', () => {
    expect(kinds('nullable truex true', 'json')).toEqual([
      ['text', 'nullable truex '],
      ['keyword', 'true'],
    ]);
  });

  it('ends an unfinished string at the line break', () => {
    const tokens = tokenize('{"a": "open\n"b": 1}', 'json');
    expect(tokens.find((token) => token.text === '"open')?.kind).toBe('string');
    expect(tokens.some((token) => token.kind === 'key' && token.text === '"b"')).toBe(true);
  });

  it('tells tags, attributes, strings, comments and variables apart in XML', () => {
    expect(kinds('<?xml v="1"?><a id="{{id}}" k=\'v\'><!-- c -->{{t}}<b/></a>', 'xml')).toEqual([
      ['keyword', '<?xml v="1"?>'],
      ['punct', '<'],
      ['tag', 'a'],
      ['attr', 'id'],
      ['punct', '='],
      ['string', '"'],
      ['variable', '{{id}}'],
      ['string', '"'],
      ['attr', 'k'],
      ['punct', '='],
      ['string', "'v'"],
      ['punct', '>'],
      ['comment', '<!-- c -->'],
      ['variable', '{{t}}'],
      ['punct', '<'],
      ['tag', 'b'],
      ['punct', '/>'],
      ['punct', '</'],
      ['tag', 'a'],
      ['punct', '>'],
    ]);
  });

  it('only marks variables in plain text', () => {
    const tokens: Token[] = tokenize('a {{b}} c {{ d }}', 'text');
    expect(tokens.map((token) => token.kind)).toEqual(['text', 'variable', 'text', 'variable']);
  });
});

describe('Tab and Shift+Tab', () => {
  it('inserts one level at the caret, replacing a selection inside one line', () => {
    expect(after('ab¦cd', indent)).toBe('ab  ¦cd');
    expect(after('a«bc»d', indent)).toBe('a  ¦d');
  });

  it('indents every line of a multi-line selection', () => {
    expect(after('«one\ntwo\n\nthree»', indent)).toBe('«  one\n  two\n\n  three»');
  });

  it('takes a level off each line, spaces or a tab, never more than one', () => {
    expect(after('«    a\n  b\nc\n\td»', outdent)).toBe('«  a\nb\nc\nd»');
    expect(after('  ab¦c', outdent)).toBe('ab¦c');
    expect(after('x\n    ¦y', outdent)).toBe('x\n  ¦y');
  });

  it('does nothing when there is nothing to take off', () => {
    expect(outdent(parse('a¦b'))).toBeNull();
  });
});

describe('copy, duplicate, move and delete lines', () => {
  it('copies the line down and keeps the caret on the copy', () => {
    expect(after('one\nt¦wo\nthree', (s) => copyLines(s, 'down'))).toBe('one\ntwo\nt¦wo\nthree');
  });

  it('copies the line up and keeps the caret on the copy above', () => {
    expect(after('one\nt¦wo\nthree', (s) => copyLines(s, 'up'))).toBe('one\nt¦wo\ntwo\nthree');
  });

  it('copies every line the selection touches, also on the first and the last line', () => {
    expect(after('«a\nb»\nc', (s) => copyLines(s, 'down'))).toBe('a\nb\n«a\nb»\nc');
    expect(after('a\n«b\nc»', (s) => copyLines(s, 'up'))).toBe('a\n«b\nc»\nb\nc');
    expect(after('o¦nly', (s) => copyLines(s, 'down'))).toBe('only\no¦nly');
  });

  it('leaves out the line a selection only touches at its start', () => {
    expect(after('«a\n»b', (s) => copyLines(s, 'down'))).toBe('a\n«a\n»b');
  });

  it('duplicates the line, or the selection after itself', () => {
    expect(after('a¦b', duplicate)).toBe('ab\na¦b');
    expect(after('x«yz»w', duplicate)).toBe('xyz«yz»w');
  });

  it('moves lines up and down, with the selection', () => {
    expect(after('a\nb¦\nc', (s) => moveLines(s, 'up'))).toBe('b¦\na\nc');
    expect(after('a\nb¦\nc', (s) => moveLines(s, 'down'))).toBe('a\nc\nb¦');
    expect(after('«a\nb»\nc\nd', (s) => moveLines(s, 'down'))).toBe('c\n«a\nb»\nd');
    expect(after('\n¦b', (s) => moveLines(s, 'up'))).toBe('¦b\n');
  });

  it('does not move past the first or the last line', () => {
    expect(moveLines(parse('a¦\nb'), 'up')).toBeNull();
    expect(moveLines(parse('a\nb¦'), 'down')).toBeNull();
  });

  it('deletes the lines, taking the line break that goes with them', () => {
    expect(after('a\nb¦\nc', deleteLines)).toBe('a\n¦c');
    expect(after('a\nb\nc¦', deleteLines)).toBe('a\nb¦');
    expect(after('o¦nly', deleteLines)).toBe('¦');
    expect(after('«a\nb»\nc', deleteLines)).toBe('¦c');
  });

  it('copies the whole line with its break when nothing is selected', () => {
    expect(currentLine(parse('one\nt¦wo\nthree'))).toBe('two\n');
    expect(currentLine(parse('last¦'))).toBe('last\n');
  });
});

describe('Enter', () => {
  it('keeps the indentation of the line', () => {
    expect(after('  a¦b', newLine)).toBe('  a\n  ¦b');
    expect(after('ab¦', newLine)).toBe('ab\n¦');
  });

  it('opens one level after { or [', () => {
    expect(after('{¦', newLine)).toBe('{\n  ¦');
    expect(after('  "a": [¦', newLine)).toBe('  "a": [\n    ¦');
  });

  it('puts the closing bracket on its own line when the caret is between a pair', () => {
    expect(after('{¦}', newLine)).toBe('{\n  ¦\n}');
    expect(after('  [¦]', newLine)).toBe('  [\n    ¦\n  ]');
  });

  it('replaces the selection', () => {
    expect(after('a«bc»d', newLine)).toBe('a\n¦d');
  });
});

describe('formatJson', () => {
  it('matches JSON.stringify(…, null, 2) for valid JSON', () => {
    const value = {
      name: 'Ana',
      tags: ['a', 'b'],
      address: { city: 'São Paulo', empty: {}, none: [] },
      n: [1, 2.5, -3, 1e21],
      ok: true,
      nothing: null,
    };
    expect(formatJson(JSON.stringify(value))).toBe(JSON.stringify(value, null, 2));
    expect(formatJson(JSON.stringify(value, null, 8))).toBe(JSON.stringify(value, null, 2));
  });

  it('formats a body with variables where JSON.parse would fail', () => {
    expect(formatJson('{"id":"{{$guid}}","age":{{age}},"tags":[{{a}},"{{b}}"]}')).toBe(
      '{\n  "id": "{{$guid}}",\n  "age": {{age}},\n  "tags": [\n    {{a}},\n    "{{b}}"\n  ]\n}',
    );
  });

  it('never adds a space inside a string that holds a variable', () => {
    expect(formatJson('{"a":"x{{b}}y{{c}}"}')).toBe('{\n  "a": "x{{b}}y{{c}}"\n}');
  });

  it('keeps empty containers on one line and strings untouched', () => {
    expect(formatJson('{ "a" : { } , "b" : [ ] , "c" : "x  :  y,{}" }')).toBe(
      '{\n  "a": {},\n  "b": [],\n  "c": "x  :  y,{}"\n}',
    );
  });

  it('is stable: formatting twice gives the same text', () => {
    const once = formatJson('{"a":[1,{"b":2}],"c":"{{d}}"}')!;
    expect(formatJson(once)).toBe(once);
  });

  it('gives up on brackets that do not balance', () => {
    expect(formatJson('{"a": [1, 2}')).toBeNull();
    expect(formatJson('{"a": 1')).toBeNull();
    expect(formatJson('}')).toBeNull();
  });

  it('formats an empty body as empty', () => {
    expect(formatJson('  \n ')).toBe('');
  });
});

describe('formatXml', () => {
  it('puts one element per line, keeps text with its element, and indents', () => {
    expect(
      formatXml(
        '<?xml version="1.0"?><order id="{{id}}"><item><name>Mesa</name><qty>2</qty></item><note/></order>',
      ),
    ).toBe(
      '<?xml version="1.0"?>\n<order id="{{id}}">\n  <item>\n    <name>Mesa</name>\n    <qty>2</qty>\n  </item>\n  <note/>\n</order>',
    );
  });

  it('keeps comments and variables', () => {
    expect(formatXml('<a><!-- x --><b>{{v}}</b></a>')).toBe(
      '<a>\n  <!-- x -->\n  <b>{{v}}</b>\n</a>',
    );
  });

  it('gives up on tags that do not balance', () => {
    expect(formatXml('<a><b></a>')).toBeNull();
    expect(formatXml('</a>')).toBeNull();
    expect(formatXml('<a>')).toBeNull();
  });
});
