import { describe, expect, it } from 'vitest';
import {
  MAX_DATA_COLUMNS,
  MAX_DATA_ROWS,
  parseCsv,
  parseDataFile,
} from '../src/features/apitests/integration/runner-data.js';
import { folderPath, inheritedAuth } from '../src/features/apitests/integration/inheritance.js';
import type { ApiCollection } from '../src/features/apitests/api-test-types.js';

describe('parseCsv', () => {
  it('reads quoted fields with commas, escaped quotes and line breaks', () => {
    const text = '﻿name,note\r\n"Silva, Ana","She said ""hi""\nthen left"\nBob,plain\r\n\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['Silva, Ana', 'She said "hi"\nthen left'],
      ['Bob', 'plain'],
    ]);
  });

  it('keeps empty fields, reads a last line without a break and a lone CR', () => {
    expect(parseCsv('a,,c\rx,y,')).toEqual([
      ['a', '', 'c'],
      ['x', 'y', ''],
    ]);
    expect(parseCsv('a;b\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('fails on a quote that never closes', () => {
    expect(() => parseCsv('a\n"open')).toThrow('unclosedQuote');
  });
});

describe('parseDataFile', () => {
  it('reads CSV with a header row, filling missing cells and naming blank headers', () => {
    expect(parseDataFile('user, \nana,1,extra\nbob', 'data.csv')).toEqual({
      ok: true,
      columns: ['user', 'column2'],
      rows: [
        { user: 'ana', column2: '1' },
        { user: 'bob', column2: '' },
      ],
    });
  });

  it('detects semicolon CSV', () => {
    const file = parseDataFile('a;b\n1;2');
    expect(file).toMatchObject({ ok: true, columns: ['a', 'b'], rows: [{ a: '1', b: '2' }] });
  });

  it('reads a JSON array of objects, as text', () => {
    const file = parseDataFile(
      '[{"id":1,"tags":["x"],"ok":true},{"name":"b","none":null,"text":"t"}]',
      'rows.json',
    );
    expect(file).toEqual({
      ok: true,
      columns: ['id', 'tags', 'ok', 'name', 'none', 'text'],
      rows: [
        { id: '1', tags: '["x"]', ok: 'true', name: '', none: '', text: '' },
        { id: '', tags: '', ok: '', name: 'b', none: '', text: 't' },
      ],
    });
  });

  it('reports what is wrong', () => {
    expect(parseDataFile('  ')).toEqual({ ok: false, error: 'empty' });
    expect(parseDataFile('header only')).toEqual({ ok: false, error: 'empty' });
    expect(parseDataFile('[]')).toEqual({ ok: false, error: 'empty' });
    expect(parseDataFile('{oops', 'x.json')).toEqual({ ok: false, error: 'invalidJson' });
    expect(parseDataFile('{"a":1}', 'x.json')).toEqual({ ok: false, error: 'notArray' });
    expect(parseDataFile('[1]')).toEqual({ ok: false, error: 'notObjects' });
    expect(parseDataFile('[[1]]')).toEqual({ ok: false, error: 'notObjects' });
    expect(parseDataFile('[null]')).toEqual({ ok: false, error: 'notObjects' });
    expect(parseDataFile('a\n"b')).toEqual({ ok: false, error: 'unclosedQuote' });
  });

  it('enforces the row and column limits', () => {
    const rows = ['v', ...Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => String(i))];
    expect(parseDataFile(rows.join('\n'))).toEqual({ ok: false, error: 'tooManyRows' });
    const header = Array.from({ length: MAX_DATA_COLUMNS + 1 }, (_, i) => `c${i}`).join(',');
    expect(parseDataFile(`${header}\n1`)).toEqual({ ok: false, error: 'tooManyColumns' });
  });
});

describe('inheritance', () => {
  const collection: Pick<ApiCollection, 'name' | 'auth' | 'items'> = {
    name: 'Orders',
    auth: { type: 'bearer', token: '{{t}}' },
    items: [
      {
        id: 'f1',
        type: 'folder',
        name: 'Admin',
        auth: { type: 'basic', username: 'a', password: 'b' },
        items: [
          { id: 'r0', type: 'request', name: 'Not a folder' } as ApiCollection['items'][number],
          { id: 'f2', type: 'folder', name: 'Inner', auth: { type: 'inherit' }, items: [] },
        ],
      },
      {
        id: 'f3',
        type: 'folder',
        name: 'Open',
        items: [{ id: 'r1', type: 'request', name: 'Unauthed' } as ApiCollection['items'][number]],
      },
    ],
  };

  it('finds the folders of an item and the auth it inherits', () => {
    expect(folderPath(collection.items, 'f2')?.map((folder) => folder.name)).toEqual(['Admin']);
    expect(folderPath(collection.items, 'missing')).toBeNull();
    // r0 sits before f2 in Admin's items: the search skips past a plain request to find it.
    expect(folderPath(collection.items, 'r0')?.map((folder) => folder.name)).toEqual(['Admin']);
    expect(inheritedAuth(collection, 'f2')).toEqual({
      from: 'Admin',
      auth: { type: 'basic', username: 'a', password: 'b' },
    });
    expect(inheritedAuth(collection, 'f3').from).toBe('Orders');
    expect(inheritedAuth(collection, 'missing').from).toBe('Orders');
    // Open (f3) sets no auth at all, unlike Inner's explicit "inherit": both fall through.
    expect(inheritedAuth(collection, 'r1').from).toBe('Orders');
  });
});
