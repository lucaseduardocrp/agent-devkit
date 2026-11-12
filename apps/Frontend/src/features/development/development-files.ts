import type { SearchableSelectOption } from '../../components/ui/searchable-select.js';
import type { Issue } from '../issues/issue-types.js';
import type { PbiOption } from '../pbi/pbi-types.js';
import type { DiffFile, RepositoryOption } from './development-types.js';

const PROVIDER_NAMES: Readonly<Record<RepositoryOption['provider'], string>> = {
  github: 'GitHub',
  azure_devops: 'Azure DevOps',
};

/** A repository is addressed by its provider and id, which the option value carries together. */
export const repositoryValue = (repository: Pick<RepositoryOption, 'provider' | 'id'>): string =>
  `${repository.provider}:${repository.id}`;

/** A backlog item in its select: its type, the id it has in its provider, then its title. */
export const pbiOption = (item: PbiOption): SearchableSelectOption => {
  const externalId = item.links[0]?.externalId;
  const prefix = [item.type, externalId && `#${externalId}`].filter(Boolean).join(' ');
  return { value: item.id, label: prefix ? `${prefix} · ${item.title}` : item.title };
};
/** An issue in its select: its number, then its title. */
export const issueOption = (
  issue: Pick<Issue, 'id' | 'number' | 'title'>,
): SearchableSelectOption => ({
  value: issue.id,
  label: `#${issue.number} · ${issue.title}`,
});

/** How a repository reads in its select: where it lives, then its name. */
export const repositoryLabel = (repository: RepositoryOption): string =>
  `${PROVIDER_NAMES[repository.provider]} · ${repository.name}`;

/** One row of the file tree of a session. */
export interface TreeEntry {
  readonly name: string;
  /** Relative to the worktree, with forward slashes. */
  readonly path: string;
  readonly kind: 'directory' | 'file';
}

/** Folder path ('' is the root) to what it holds. */
export type FileTree = Readonly<Record<string, readonly TreeEntry[]>>;

/**
 * The tree of the files a session changed. A browser cannot read the worktree, so there the
 * tree shows what the diff knows about.
 */
export function diffTree(files: readonly DiffFile[]): FileTree {
  const tree: Record<string, TreeEntry[]> = { '': [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let folder = '';
    parts.forEach((name, index) => {
      const path = folder ? `${folder}/${name}` : name;
      const siblings = (tree[folder] ??= []);
      if (!siblings.some((entry) => entry.path === path))
        siblings.push({ name, path, kind: index === parts.length - 1 ? 'file' : 'directory' });
      folder = path;
    });
  }
  for (const entries of Object.values(tree))
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
    );
  return tree;
}

/** The files of the loaded folders whose path has the text, for the filter above the tree. */
export function filterTree(tree: FileTree, text: string): TreeEntry[] {
  const query = text.trim().toLowerCase();
  return Object.values(tree)
    .flat()
    .filter((entry) => entry.kind === 'file' && entry.path.toLowerCase().includes(query))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface ContextUsage {
  readonly percent: number;
  /** Kept free so the conversation can be summarized before the window is full. */
  readonly buffer: number;
  readonly free: number;
  readonly untilCompact: number;
}

/** How the context window of a session divides, the way the sidebar shows it. */
export function contextUsage(context: {
  readonly windowTokens: number;
  readonly usedTokens: number;
  readonly compactAtPercent: number;
}): ContextUsage {
  const limit = Math.round((context.windowTokens * context.compactAtPercent) / 100);
  const buffer = context.windowTokens - limit;
  return {
    percent: Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100)),
    buffer,
    free: Math.max(0, context.windowTokens - buffer - context.usedTokens),
    untilCompact: Math.max(0, limit - context.usedTokens),
  };
}

/** `1234567` as `1.2M`, `45300` as `45.3k`: the short form the sidebar has room for. */
export function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(value);
}

/** `D:\Projects\Work\Shop` as the folder's name and where it is. */
export function splitFolder(path: string): { name: string; parent: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { name: path.slice(cut + 1), parent: path.slice(0, Math.max(cut, 0)) };
}
