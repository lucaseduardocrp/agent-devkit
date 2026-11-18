import { describe, expect, it } from 'vitest';
import {
  contextUsage,
  diffTree,
  filterTree,
  issueOption,
  pbiOption,
  shortTokens,
  splitFolder,
} from '../src/features/development/development-files.js';
import type { DiffFile } from '../src/features/development/development-types.js';

const file = (path: string): DiffFile => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '',
});

describe('development files', () => {
  it('builds the tree of the changed files, folders first', () => {
    const tree = diffTree([file('b.txt'), file('src/z.ts'), file('a/deep/x.ts'), file('src/a.ts')]);
    expect(tree['']?.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'directory:a',
      'directory:src',
      'file:b.txt',
    ]);
    expect(tree['src']?.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(tree['a/deep']).toEqual([{ name: 'x.ts', path: 'a/deep/x.ts', kind: 'file' }]);
    expect(diffTree([])).toEqual({ '': [] });
  });

  it('filters the files by a part of their path', () => {
    const tree = diffTree([file('src/z.ts'), file('src/a.ts'), file('docs/a.md')]);
    expect(filterTree(tree, ' SRC ').map((entry) => entry.path)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(filterTree(tree, 'nothing')).toEqual([]);
  });

  it('divides the context window', () => {
    expect(contextUsage({ windowTokens: 1000, usedTokens: 300, compactAtPercent: 80 })).toEqual({
      percent: 30,
      buffer: 200,
      free: 500,
      untilCompact: 500,
    });
    expect(contextUsage({ windowTokens: 1000, usedTokens: 1500, compactAtPercent: 80 })).toEqual({
      percent: 100,
      buffer: 200,
      free: 0,
      untilCompact: 0,
    });
  });

  it('shortens token counts and splits a folder path', () => {
    expect(shortTokens(950)).toBe('950');
    expect(shortTokens(45_300)).toBe('45.3k');
    expect(shortTokens(200_000)).toBe('200k');
    expect(shortTokens(1_000_000)).toBe('1M');
    expect(shortTokens(1_250_000)).toBe('1.3M');
    expect(splitFolder('D:\\Projects\\Work\\Shop')).toEqual({
      name: 'Shop',
      parent: 'D:\\Projects\\Work',
    });
    expect(splitFolder('/home/ana/shop')).toEqual({ name: 'shop', parent: '/home/ana' });
    expect(splitFolder('shop')).toEqual({ name: 'shop', parent: '' });
  });
});

describe('linked item labels', () => {
  it('reads a backlog item as its type, its id in the provider, then its title', () => {
    const link = { providerId: 'azure_devops' as const, externalId: '1234', externalUrl: null };
    const base = { id: 'p1', kind: 'pbi' as const, title: 'Fix login', status: 'New' };
    expect(pbiOption({ ...base, type: 'Bug', links: [link] })).toEqual({
      value: 'p1',
      label: 'Bug #1234 · Fix login',
    });
    expect(pbiOption({ ...base, type: null, links: [link] }).label).toBe('#1234 · Fix login');
    expect(pbiOption({ ...base, type: 'Task', links: [] }).label).toBe('Task · Fix login');
    expect(pbiOption({ ...base, type: null, links: [] }).label).toBe('Fix login');
  });

  it('reads an issue as its number, then its title', () => {
    expect(issueOption({ id: 'i1', number: 7, title: 'Slow page' })).toEqual({
      value: 'i1',
      label: '#7 · Slow page',
    });
  });
});
