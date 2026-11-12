import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** One row of the file tree of a session's worktree. */
export interface FileEntry {
  readonly name: string;
  /** Relative to the worktree, with forward slashes. */
  readonly path: string;
  readonly kind: 'directory' | 'file';
}

export type FileContent =
  | { readonly kind: 'text'; readonly content: string; readonly truncated: boolean }
  | { readonly kind: 'binary' };

/** How much of a file the viewer receives. */
export const MAX_FILE_BYTES = 512 * 1024;

/** The absolute path of `relative` inside `root`; a path that leaves the folder is refused. */
export function inside(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep))
    throw new Error('That path is outside the worktree.');
  return target;
}

/** Folders nobody wants to browse or search: git's own data and installed packages. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

/** How many files the index and the search look at. */
export const MAX_INDEXED_FILES = 20_000;

/** Every file of the worktree, as a relative path with forward slashes. */
export async function listAllFiles(root: string, limit = MAX_INDEXED_FILES): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(inside(root, relative), { withFileTypes: true })) {
      if (files.length >= limit) return;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) await walk(path);
      } else files.push(path);
    }
  };
  await walk('');
  return files.sort((a, b) => a.localeCompare(b));
}

export interface ContentMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Lines of the worktree's text files that contain `query`, ignoring case. */
export async function searchContent(
  root: string,
  query: string,
  limit = 200,
): Promise<ContentMatch[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: ContentMatch[] = [];
  for (const path of await listAllFiles(root)) {
    if (matches.length >= limit) break;
    /* v8 ignore next -- a file removed while the search runs is skipped */
    const file = await readTextFile(root, path).catch(() => null);
    if (file?.kind !== 'text') continue;
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < limit; index += 1)
      if (lines[index]!.toLowerCase().includes(needle))
        matches.push({ path, line: index + 1, text: lines[index]!.trim().slice(0, 300) });
  }
  return matches;
}

/** Saves a text file of the worktree, creating its folders; a folder cannot be overwritten. */
export async function writeTextFile(
  root: string,
  relative: string,
  content: string,
): Promise<void> {
  const file = inside(root, relative);
  if ((await stat(file).catch(() => null))?.isDirectory())
    throw new Error('That path is a folder.');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/** The folders, then the files, of one folder of the worktree. Git's own folder is left out. */
export async function listDirectory(root: string, relative = ''): Promise<FileEntry[]> {
  const entries = await readdir(inside(root, relative), { withFileTypes: true });
  const prefix = relative ? `${relative.replace(/\\/g, '/').replace(/\/+$/, '')}/` : '';
  return entries
    .filter((entry) => entry.name !== '.git')
    .map((entry): FileEntry => ({
      name: entry.name,
      path: prefix + entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
    );
}

/** The start of a text file; a file with NUL bytes is reported as binary instead. */
export async function readTextFile(root: string, relative: string): Promise<FileContent> {
  const file = await open(inside(root, relative), 'r');
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    await file.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, 8000).includes(0)) return { kind: 'binary' };
    return { kind: 'text', content: buffer.toString('utf8'), truncated: size > MAX_FILE_BYTES };
  } finally {
    await file.close();
  }
}
