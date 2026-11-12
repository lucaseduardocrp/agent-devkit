import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newRequest,
  type ApiFolder,
  type ApiItem,
} from '../src/features/apitests/api-test-types.js';
import {
  formatGraphql,
  formatJson,
  formatXml,
  indent,
} from '../src/features/apitests/integration/code-editing.js';
import { tokenize, type Token } from '../src/features/apitests/integration/code-syntax.js';
import {
  addItem,
  cloneItem,
  composeUrl,
  fillPathParams,
  findItem,
  findRequest,
  insertAfter,
  itemMatches,
  readLayout,
  removeItem,
  sameUrl,
  writeLayout,
} from '../src/features/apitests/integration/integration-model.js';

const kinds = (tokens: Token[]) => tokens.map((token) => `${token.kind}:${token.text}`);
const joined = (tokens: Token[]) => tokens.map((token) => token.text).join('');

describe('tokenizer edges', () => {
  it('joins neighbour strings into one token and keeps neighbour comments apart', () => {
    expect(kinds(tokenize('<a b="x""y"/>', 'xml'))).toContain('string:"x""y"');
    expect(kinds(tokenize('/*a*//*b*/', 'javascript'))).toEqual(['comment:/*a*/', 'comment:/*b*/']);
  });

  it('keeps unfinished comments, declarations and trailing text of an XML body', () => {
    expect(kinds(tokenize('<!-- open', 'xml'))).toEqual(['comment:<!-- open']);
    expect(kinds(tokenize('<!DOCTYPE html>', 'xml'))).toEqual(['keyword:<!DOCTYPE html>']);
    expect(kinds(tokenize('<?xml version="1.0"?>', 'xml'))).toEqual([
      'keyword:<?xml version="1.0"?>',
    ]);
    expect(kinds(tokenize('plain text', 'xml'))).toEqual(['text:plain text']);
  });

  it('colors a {{variable}} placed among the attributes of a tag', () => {
    const code = '<a {{attrs}} id="1">';
    const tokens = tokenize(code, 'xml');
    expect(kinds(tokens)).toContain('variable:{{attrs}}');
    expect(joined(tokens)).toBe(code);
  });
});

describe('code editing edges', () => {
  it('indents a multi-line selection that starts at a line start without moving its start', () => {
    const value = 'a\nb';
    const edit = indent({ value, start: 0, end: value.length });
    expect(edit.text).toBe('  a\n  b');
    expect(edit.selection[0]).toBe(0);
  });

  it('moves the start of a multi-line selection that starts mid-line past the new indentation', () => {
    const value = 'ab\ncd';
    const edit = indent({ value, start: 1, end: value.length });
    expect(edit.text).toBe('  ab\n  cd');
    expect(edit.selection).toEqual([3, value.length + 4]);
  });

  it('keeps a single space between two values separated by whitespace in JSON', () => {
    expect(formatJson('[1 2]')).toBe('[\n  1 2\n]');
  });

  it('formats an empty XML document as nothing', () => {
    expect(formatXml('')).toBe('');
  });

  it('formats GraphQL with whitespace around the whole document', () => {
    expect(formatGraphql('  { a }\n\n')).toBe('{\n  a\n}');
  });

  it('separates a word glued to a closing parenthesis with a space', () => {
    expect(formatGraphql('{ a(x: 1)b }')).toBe('{\n  a(x: 1) b\n}');
  });
});

describe('request tree helpers', () => {
  const inner = newRequest('inner');
  const sibling = newRequest('sibling');
  const folder: ApiFolder = { id: 'f1', type: 'folder', name: 'Users', items: [inner] };
  const outer: ApiFolder = { id: 'f0', type: 'folder', name: 'Outer', items: [folder, sibling] };
  const root = newRequest('root');
  const tree: ApiItem[] = [outer, root];

  it('removes an item from any folder depth, leaving requests untouched', () => {
    expect(removeItem(tree, inner.id)).toEqual([
      { ...outer, items: [{ ...folder, items: [] }, sibling] },
      root,
    ]);
    expect(removeItem(tree, 'f0')).toEqual([root]);
  });

  it('adds to the root, to a folder, and ignores a target that is not a folder', () => {
    const added = newRequest('added');
    expect(addItem(tree, null, added)).toEqual([...tree, added]);
    const inFolder = addItem(tree, 'f1', added);
    expect((findItem(inFolder, 'f1') as ApiFolder).items).toEqual([inner, added]);
    expect(addItem(tree, root.id, added)).toEqual(tree);
  });

  it('inserts a copy right after the original, also inside folders, and ignores unknown ids', () => {
    const copy = newRequest('copy');
    expect(insertAfter(tree, root.id, copy).map((item) => item.id)).toEqual([
      'f0',
      root.id,
      copy.id,
    ]);
    const nested = insertAfter(tree, inner.id, copy);
    expect((findItem(nested, 'f1') as ApiFolder).items.map((item) => item.id)).toEqual([
      inner.id,
      copy.id,
    ]);
    expect(insertAfter(tree, 'missing', copy)).toEqual(tree);
  });

  it('finds items and requests, and tells a folder from a request', () => {
    expect(findItem(tree, inner.id)).toBe(inner);
    expect(findItem(tree, 'missing')).toBeNull();
    expect(findRequest(tree, inner.id)).toBe(inner);
    expect(findRequest(tree, 'f1')).toBeNull();
  });

  it('clones folders and requests with new ids, and the given name on the top item', () => {
    const copy = cloneItem(outer, 'Outer copy') as ApiFolder;
    expect(copy.name).toBe('Outer copy');
    expect(copy.id).not.toBe(outer.id);
    const innerCopy = (copy.items[0] as ApiFolder).items[0]!;
    expect(innerCopy.id).not.toBe(inner.id);
    const requestCopy = cloneItem(root, 'Root copy');
    expect(requestCopy.type === 'request' && requestCopy.assertions[0]!.id).not.toBe(
      root.assertions[0]!.id,
    );
  });

  it('matches a filter against the folder name, its children, and a request line', () => {
    expect(itemMatches(root, '')).toBe(true);
    expect(itemMatches(outer, 'OUTER')).toBe(true);
    expect(itemMatches(outer, 'inner')).toBe(true);
    expect(itemMatches(outer, 'zzz')).toBe(false);
    expect(itemMatches(root, 'get root')).toBe(true);
    expect(itemMatches(root, 'zzz')).toBe(false);
  });
});

describe('layout storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('remembers the layout and falls back when storage is blocked', () => {
    writeLayout('vertical');
    expect(readLayout()).toBe('vertical');
    writeLayout('horizontal');
    expect(readLayout()).toBe('horizontal');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLayout()).toBe('horizontal');
    expect(() => writeLayout('vertical')).not.toThrow();
  });
});

describe('URL helpers', () => {
  it('keeps a path param segment that has no value row', () => {
    expect(fillPathParams('/a/:id/b/:other', [{ key: 'id', value: '7' }])).toBe('/a/7/b/:other');
  });

  it('appends the query to a URL that already has one, and shows value-only rows', () => {
    expect(composeUrl('/a?x=1', [{ key: 'y', value: '2' }])).toBe('/a?x=1&y=2');
    expect(composeUrl('/a', [{ key: '', value: 'raw' }])).toBe('/a?=raw');
  });

  it('compares typed URLs with value-only rows in the query', () => {
    expect(sameUrl('/a?=raw', '/a', [{ key: '', value: 'raw' }])).toBe(true);
    expect(sameUrl('/a?=other', '/a', [{ key: '', value: 'raw' }])).toBe(false);
  });
});
