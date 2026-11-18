import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inside,
  listAllFiles,
  listDirectory,
  MAX_FILE_BYTES,
  readTextFile,
  searchContent,
  writeTextFile,
} from '../src/main/workspace-files.js';

describe('worktree files', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'adk-files-'));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'README.md'), '# Shop\n');
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'src', 'index.ts'), 'export {};\n');
    await writeFile(join(root, 'image.bin'), Buffer.from([1, 0, 2]));
    await writeFile(join(root, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 10));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('refuses paths that leave the worktree', () => {
    expect(inside(root, '')).toBe(root);
    expect(inside(root, 'src/index.ts')).toBe(join(root, 'src', 'index.ts'));
    expect(() => inside(root, '../other')).toThrow('outside the worktree');
    expect(() => inside(root, `${root}-sibling`)).toThrow('outside the worktree');
  });

  it('lists folders first and hides the folder of git', async () => {
    expect((await listDirectory(root)).map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'directory:docs',
      'directory:src',
      'file:a.txt',
      'file:big.txt',
      'file:image.bin',
      'file:README.md',
    ]);
    expect(await listDirectory(root, 'src\\')).toEqual([
      { name: 'deep', path: 'src/deep', kind: 'directory' },
      { name: 'index.ts', path: 'src/index.ts', kind: 'file' },
    ]);
    await expect(listDirectory(root, '..')).rejects.toThrow('outside the worktree');
  });

  it('reads text, cuts long files and does not show binary ones', async () => {
    expect(await readTextFile(root, 'README.md')).toEqual({
      kind: 'text',
      content: '# Shop\n',
      truncated: false,
    });
    const big = await readTextFile(root, 'big.txt');
    expect(big).toMatchObject({ kind: 'text', truncated: true });
    expect(big.kind === 'text' && big.content.length).toBe(MAX_FILE_BYTES);
    expect(await readTextFile(root, 'image.bin')).toEqual({ kind: 'binary' });
    await expect(readTextFile(root, 'missing.txt')).rejects.toThrow();
  });

  it('indexes every file except git data and installed packages', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(join(root, '.git', 'HEAD'), 'ref');
    expect(await listAllFiles(root)).toEqual([
      'a.txt',
      'big.txt',
      'image.bin',
      'README.md',
      'src/index.ts',
    ]);
    expect(await listAllFiles(root, 2)).toHaveLength(2);
  });

  it('finds the lines that hold a text, ignoring case, binary and unreadable files', async () => {
    await writeFile(
      join(root, 'docs', 'guide.md'),
      'Intro\r\nSHOP is here\n  another shop line  \n',
    );
    expect(await searchContent(root, '  ')).toEqual([]);
    expect(await searchContent(root, 'shop')).toEqual([
      { path: 'docs/guide.md', line: 2, text: 'SHOP is here' },
      { path: 'docs/guide.md', line: 3, text: 'another shop line' },
      { path: 'README.md', line: 1, text: '# Shop' },
    ]);
    expect(await searchContent(root, 'shop', 2)).toHaveLength(2);
    expect(await searchContent(root, 'shop', 1)).toHaveLength(1);
  });

  it('saves a file of the worktree, creating its folders, but not over a folder', async () => {
    await writeTextFile(root, 'new/deep/file.txt', 'saved');
    expect(await readTextFile(root, 'new/deep/file.txt')).toEqual({
      kind: 'text',
      content: 'saved',
      truncated: false,
    });
    await writeTextFile(root, 'new/deep/file.txt', 'again');
    expect((await readTextFile(root, 'new/deep/file.txt')) as { content: string }).toMatchObject({
      content: 'again',
    });
    await expect(writeTextFile(root, 'docs', 'x')).rejects.toThrow('is a folder');
    await expect(writeTextFile(root, '../escape.txt', 'x')).rejects.toThrow('outside the worktree');
  });
});
