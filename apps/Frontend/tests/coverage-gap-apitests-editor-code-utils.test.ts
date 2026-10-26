import { describe, expect, it } from 'vitest';
import {
  formatJson,
  formatXml,
  indent,
} from '../src/features/apitests/integration/code-editing.js';
import { tokenize } from '../src/features/apitests/integration/code-syntax.js';

const kinds = (text: string, language: 'json' | 'xml' | 'text') =>
  tokenize(text, language).map((token) => [token.kind, token.text]);

describe('code-editing', () => {
  it('indents lines from the middle of the first one, moving the selection start too', () => {
    expect(indent({ value: 'ab\ncd', start: 1, end: 4 })).toEqual({
      from: 0,
      to: 5,
      text: '  ab\n  cd',
      selection: [3, 8],
    });
  });

  it('formats JSON with leading whitespace and rejects an extra closing bracket', () => {
    expect(formatJson('  1')).toBe('1');
    expect(formatJson('}')).toBeNull();
  });

  it('formats an empty XML body to nothing', () => {
    expect(formatXml('')).toBe('');
  });
});

describe('code-syntax', () => {
  it('keeps text tokens joined and colors keywords only as whole words', () => {
    expect(kinds('ab', 'json')).toEqual([['text', 'ab']]);
    expect(kinds('xtrue', 'json')).toEqual([['text', 'xtrue']]);
  });

  it('skips a {{ that does not close and keeps the text whole', () => {
    expect(kinds('a {{ b', 'text')).toEqual([['text', 'a {{ b']]);
    expect(
      tokenize('a {{x\n}} {{y}}', 'text')
        .map((token) => token.text)
        .join(''),
    ).toBe('a {{x\n}} {{y}}');
  });

  it('colors XML declarations, doctypes and unfinished parts', () => {
    expect(kinds('<?xml version="1.0"?><!DOCTYPE a>', 'xml')).toEqual([
      ['keyword', '<?xml version="1.0"?>'],
      ['keyword', '<!DOCTYPE a>'],
    ]);
    expect(kinds('<!-- open', 'xml')).toEqual([['comment', '<!-- open']]);
    expect(kinds('<?pi', 'xml')).toEqual([['keyword', '<?pi']]);
    expect(kinds('<a/>tail', 'xml')).toEqual([
      ['punct', '<'],
      ['tag', 'a'],
      ['punct', '/>'],
      ['text', 'tail'],
    ]);
  });

  it('colors XML attributes with single quotes, variables and unfinished values', () => {
    expect(kinds("<a b='x' c={{v}} />", 'xml')).toEqual([
      ['punct', '<'],
      ['tag', 'a'],
      ['text', ' '],
      ['attr', 'b'],
      ['punct', '='],
      ['string', "'x'"],
      ['text', ' '],
      ['attr', 'c'],
      ['punct', '='],
      ['variable', '{{v}}'],
      ['text', ' '],
      ['punct', '/>'],
    ]);
    expect(kinds('<a b="x', 'xml')).toEqual([
      ['punct', '<'],
      ['tag', 'a'],
      ['text', ' '],
      ['attr', 'b'],
      ['punct', '='],
      ['string', '"x'],
    ]);
    // A tag without a name, and one cut short.
    expect(kinds('< >', 'xml')).toEqual([
      ['punct', '<'],
      ['text', ' '],
      ['punct', '>'],
    ]);
    expect(kinds('<a', 'xml')).toEqual([
      ['punct', '<'],
      ['tag', 'a'],
    ]);
  });
});

describe('more JSON shapes', () => {
  it('formats values separated by spaces before punctuation', () => {
    expect(formatJson('[1 ,2]')).toBe('[\n  1,\n  2\n]');
    expect(formatJson('{"a" : 1}')).toBe('{\n  "a": 1\n}');
    // Two values in a row keep one space between them.
    expect(formatJson('1   2')).toBe('1 2');
  });

  it('colors a keyword, a number and a lone minus at the start of the body', () => {
    expect(kinds('true', 'json')).toEqual([['keyword', 'true']]);
    expect(kinds('-1', 'json')).toEqual([['number', '-1']]);
    expect(kinds('-x', 'json')).toEqual([['text', '-x']]);
  });
});
