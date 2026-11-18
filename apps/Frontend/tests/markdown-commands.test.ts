import { describe, expect, it } from 'vitest';
import {
  codeBlock,
  insertBlock,
  insertLink,
  insertTable,
  setHeading,
  toggleLines,
  wrapSelection,
  type TextEdit,
} from '../src/features/shared/markdown-editor/markdown-commands.js';

/** Result of applying an edit to the text. */
function apply(value: string, edit: TextEdit): string {
  return `${value.slice(0, edit.from)}${edit.insert}${value.slice(edit.to)}`;
}

describe('wrapSelection', () => {
  it('wraps the selection and keeps it selected', () => {
    const edit = wrapSelection('say hello now', 4, 9, '**');
    expect(apply('say hello now', edit)).toBe('say **hello** now');
    expect(edit.select).toEqual([6, 11]);
  });

  it('removes the markers when they already surround the selection', () => {
    const value = 'say **hello** now';
    const edit = wrapSelection(value, 6, 11, '**');
    expect(apply(value, edit)).toBe('say hello now');
    expect(edit.select).toEqual([4, 9]);
  });

  it('inserts the placeholder when nothing is selected', () => {
    const edit = wrapSelection('ab', 1, 1, '<mark>', '</mark>', 'text');
    expect(apply('ab', edit)).toBe('a<mark>text</mark>b');
    expect(edit.select).toEqual([7, 11]);
    expect(apply('', wrapSelection('', 0, 0, '*'))).toBe('**');
  });

  it('does not mistake text before the start of the document for markers', () => {
    expect(apply('a**', wrapSelection('a**', 1, 3, '**'))).toBe('a******');
    expect(apply('xhi**', wrapSelection('xhi**', 1, 3, '**'))).toBe('x**hi****');
    expect(apply('hi', wrapSelection('hi', 0, 2, '**'))).toBe('**hi**');
  });
});

describe('toggleLines', () => {
  it('adds and removes a quote on every selected line', () => {
    const value = 'one\ntwo\nthree';
    const quoted = apply(value, toggleLines(value, 0, 7, 'quote'));
    expect(quoted).toBe('> one\n> two\nthree');
    expect(apply(quoted, toggleLines(quoted, 0, 11, 'quote'))).toBe(value);
  });

  it('numbers ordered lists and skips blank lines', () => {
    const value = 'a\n\nb';
    expect(apply(value, toggleLines(value, 0, value.length, 'ol'))).toBe('1. a\n\n2. b');
  });

  it('switches between list kinds instead of stacking markers', () => {
    expect(apply('- a', toggleLines('- a', 0, 3, 'ol'))).toBe('1. a');
    expect(apply('1. a', toggleLines('1. a', 0, 4, 'task'))).toBe('- [ ] a');
    expect(apply('- [x] a', toggleLines('- [x] a', 0, 7, 'ul'))).toBe('- a');
    expect(apply('- [ ] a', toggleLines('- [ ] a', 0, 7, 'task'))).toBe('a');
    expect(apply('* a', toggleLines('* a', 0, 3, 'ul'))).toBe('a');
  });

  it('works on the empty line the caret is in', () => {
    expect(apply('', toggleLines('', 0, 0, 'ul'))).toBe('- ');
    const value = 'a\n\nb';
    expect(apply(value, toggleLines(value, 2, 2, 'task'))).toBe('a\n- [ ] \nb');
  });

  it('ignores a trailing line break in the selection', () => {
    const value = 'one\ntwo';
    expect(apply(value, toggleLines(value, 0, 4, 'ul'))).toBe('- one\ntwo');
  });
});

describe('setHeading', () => {
  it('sets, changes and clears the heading level', () => {
    expect(apply('title', setHeading('title', 0, 0, 2))).toBe('## title');
    expect(apply('# title', setHeading('# title', 3, 3, 3))).toBe('### title');
    expect(apply('### title', setHeading('### title', 0, 0, 0))).toBe('title');
  });

  it('only changes the line the caret is in', () => {
    const value = 'a\nb\nc';
    const edit = setHeading(value, 2, 2, 1);
    expect(apply(value, edit)).toBe('a\n# b\nc');
    expect(edit.select).toEqual([2, 5]);
  });
});

describe('blocks', () => {
  it('separates a block from the text around it', () => {
    expect(apply('a', insertBlock('a', 1, 1, 'B'))).toBe('a\n\nB\n');
    expect(apply('a\n', insertBlock('a\n', 2, 2, 'B'))).toBe('a\n\nB\n');
    expect(apply('a\n\n', insertBlock('a\n\n', 3, 3, 'B'))).toBe('a\n\nB\n');
    expect(apply('a\nz', insertBlock('a\nz', 1, 1, 'B'))).toBe('a\n\nB\n\nz');
    expect(apply('ab', insertBlock('ab', 1, 1, 'B'))).toBe('a\n\nB\n\nb');
    expect(apply('a\n\nz', insertBlock('a\n\nz', 1, 1, 'B'))).toBe('a\n\nB\n\nz');
  });

  it('places the cursor inside the block', () => {
    expect(insertBlock('', 0, 0, 'abc', 1).select).toEqual([1, 1]);
    expect(insertBlock('x', 1, 1, 'abc').select).toEqual([6, 6]);
  });

  it('fences the selection, or an empty block', () => {
    expect(apply('', codeBlock('', 0, 0))).toBe('```\n\n```\n');
    expect(codeBlock('', 0, 0).select).toEqual([4, 4]);
    expect(apply('let a', codeBlock('let a', 0, 5))).toBe('```\nlet a\n```\n');
  });

  it('inserts a table', () => {
    expect(apply('', insertTable('', 0, 0))).toContain('| Column 1 | Column 2 | Column 3 |');
  });
});

describe('insertLink', () => {
  it('uses the selection as the text, or the address when nothing is selected', () => {
    expect(apply('see docs', insertLink('see docs', 4, 8, 'https://x.dev'))).toBe(
      'see [docs](https://x.dev)',
    );
    const edit = insertLink('', 0, 0, 'https://x.dev');
    expect(edit.insert).toBe('[https://x.dev](https://x.dev)');
    expect(edit.select).toEqual([30, 30]);
  });
});
