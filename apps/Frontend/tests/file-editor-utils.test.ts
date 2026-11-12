import { describe, expect, it } from 'vitest';
import {
  indentSelection,
  isMarkdown,
  languageOf,
  lineSegments,
  linePieces,
} from '../src/features/development/file-editor-utils.js';
import { parsePatch, splitPath } from '../src/features/development/diff-parse.js';
import { readPrefs, DEFAULT_PREFS } from '../src/features/development/files-prefs.js';

describe('indentSelection', () => {
  it('takes spaces up to the next tab stop at a caret', () => {
    expect(indentSelection('ab\ncd', 1, 1, 4, false)).toEqual({
      value: 'a   b\ncd',
      start: 4,
      end: 4,
    });
    expect(indentSelection('ab\ncd', 5, 5, 4, false)).toEqual({
      value: 'ab\ncd  ',
      start: 7,
      end: 7,
    });
    // A selection inside one line is replaced, as typing over it would.
    expect(indentSelection('abcdef', 1, 3, 2, false)).toEqual({ value: 'a def', start: 2, end: 2 });
  });

  it('moves whole lines one level for a selection across lines', () => {
    const edit = indentSelection('one\ntwo\nthree', 1, 9, 2, false);
    expect(edit.value).toBe('  one\n  two\n  three');
    expect(edit.start).toBe(3);
    expect(edit.end).toBe(15);
    const back = indentSelection(edit.value, edit.start, edit.end, 2, true);
    expect(back).toEqual({ value: 'one\ntwo\nthree', start: 1, end: 9 });
  });

  it('leaves out the next line when the selection ends right after a line break', () => {
    expect(indentSelection('one\ntwo', 0, 4, 2, false)).toEqual({
      value: '  one\ntwo',
      start: 2,
      end: 6,
    });
  });

  it('outdents a line at a caret by spaces or one tab, never below its start', () => {
    expect(indentSelection('      x', 7, 7, 4, true)).toEqual({ value: '  x', start: 3, end: 3 });
    expect(indentSelection('\tx', 2, 2, 4, true)).toEqual({ value: 'x', start: 1, end: 1 });
    expect(indentSelection('a\n  x', 3, 3, 4, true)).toEqual({ value: 'a\nx', start: 2, end: 2 });
    expect(indentSelection('x', 1, 1, 4, true)).toEqual({ value: 'x', start: 1, end: 1 });
  });
});

describe('lineSegments', () => {
  it('splits the indent in tab stops and the rest into text, spaces and tabs', () => {
    expect(lineSegments('      a b\t', 4)).toEqual([
      { text: '    ', kind: 'guide' },
      { text: '  ', kind: 'space' },
      { text: 'a', kind: 'text' },
      { text: ' ', kind: 'space' },
      { text: 'b', kind: 'text' },
      { text: '\t', kind: 'tab' },
    ]);
    expect(lineSegments('\t  x', 2)).toEqual([
      { text: '\t', kind: 'guide-tab' },
      { text: '  ', kind: 'guide' },
      { text: 'x', kind: 'text' },
    ]);
    expect(lineSegments('  \tx', 4)).toEqual([
      { text: '  ', kind: 'space' },
      { text: '\t', kind: 'guide-tab' },
      { text: 'x', kind: 'text' },
    ]);
    expect(lineSegments('', 4)).toEqual([]);
  });
});

describe('linePieces', () => {
  const keyword = { text: 'return', className: 'hljs-keyword' };

  it('draws the line plain without colours, or when the colours are not of this line', () => {
    const plain = [
      { text: '  ', kind: 'space', className: '' },
      { text: 'a', kind: 'text', className: '' },
    ];
    expect(linePieces('  a', undefined, 4)).toEqual(plain);
    expect(linePieces('  a', [{ text: 'other', className: 'x' }], 4)).toEqual(plain);
  });

  it('cuts the whitespace pieces where the colour changes', () => {
    const tokens = [
      { text: '    ', className: 'hljs-comment' },
      keyword,
      { text: ' x', className: '' },
    ];
    expect(linePieces('    return x', tokens, 2)).toEqual([
      { text: '  ', kind: 'guide', className: 'hljs-comment' },
      { text: '  ', kind: 'guide', className: 'hljs-comment' },
      { text: 'return', kind: 'text', className: 'hljs-keyword' },
      { text: ' ', kind: 'space', className: '' },
      { text: 'x', kind: 'text', className: '' },
    ]);
    // One token over the indent and the text: the pieces keep the whitespace kinds.
    expect(linePieces('\t  a', [{ text: '\t  a', className: 'c' }], 4)).toEqual([
      { text: '\t', kind: 'guide-tab', className: 'c' },
      { text: '  ', kind: 'space', className: 'c' },
      { text: 'a', kind: 'text', className: 'c' },
    ]);
  });
});

describe('file names', () => {
  it('tells the language and Markdown from the name', () => {
    expect(languageOf('src/app.TS')).toBe('ts');
    expect(languageOf('docker/Dockerfile')).toBe('dockerfile');
    expect(languageOf('LICENSE')).toBe('');
    expect(isMarkdown('docs/a.MD')).toBe(true);
    expect(isMarkdown('docs/a.mdx')).toBe(true);
    expect(isMarkdown('a.txt')).toBe(false);
  });
});

describe('parsePatch', () => {
  it('numbers the lines of every hunk and leaves the file header out', () => {
    const rows = parsePatch(
      [
        'diff --git a/a.ts b/a.ts',
        'index 1..2 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -3,3 +3,4 @@ function',
        ' keep',
        '-old',
        '+new',
        '+extra',
        '\\ No newline at end of file',
        '@@ -20 +21 @@',
        ' tail',
        '… diff truncated by the runner …',
        '',
      ].join('\n'),
    );
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine, row.text])).toEqual([
      ['hunk', null, null, '@@ -3,3 +3,4 @@ function'],
      ['context', 3, 3, 'keep'],
      ['del', 4, null, 'old'],
      ['add', null, 4, 'new'],
      ['add', null, 5, 'extra'],
      ['note', null, null, 'No newline at end of file'],
      ['hunk', null, null, '@@ -20 +21 @@'],
      ['context', 20, 21, 'tail'],
      ['note', null, null, '… diff truncated by the runner …'],
    ]);
    expect(parsePatch('Binary files differ')).toEqual([]);
    expect(splitPath('src/lib/a.ts')).toEqual({ dir: 'src/lib/', name: 'a.ts' });
    expect(splitPath('a.ts')).toEqual({ dir: '', name: 'a.ts' });
  });
});

describe('readPrefs', () => {
  it('keeps what has the right type and falls back to the defaults for the rest', () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(readPrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(readPrefs('4')).toEqual(DEFAULT_PREFS);
    expect(
      readPrefs(
        JSON.stringify({
          autoSave: false,
          wordWrap: 'yes',
          tabSize: 8,
          treePosition: 'left',
          treeVisible: false,
          indentGuides: false,
        }),
      ),
    ).toEqual({
      ...DEFAULT_PREFS,
      autoSave: false,
      tabSize: 8,
      treePosition: 'left',
      treeVisible: false,
      indentGuides: false,
    });
    expect(readPrefs(JSON.stringify({ tabSize: 3, treePosition: 'top' }))).toEqual(DEFAULT_PREFS);
  });
});
