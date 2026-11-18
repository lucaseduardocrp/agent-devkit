import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
/** Runs git without a shell; a non-zero exit is a result, not an exception. */
export type Exec = (args: readonly string[], cwd: string) => Promise<ExecResult>;

export const execGit: Exec = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          stdout,
          stderr: stderr || (error?.message ?? ''),
          exitCode: !error ? 0 : typeof code === 'number' ? code : 1,
        });
      },
    );
  });

export interface DiffFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

export interface Commit {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

/** The empty tree object every git repository knows: what the first commit is compared to. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** What ADK accepts for one session diff. */
export const MAX_DIFF_FILES = 300;
export const MAX_PATCH_LENGTH = 400_000;

const STATUSES: Readonly<Record<string, DiffFile['status']>> = { A: 'added', D: 'deleted' };

/** Branch names come from ADK: refuse anything git could read as an option or a path trick. */
export function safeRef(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..'))
    throw new Error(`"${name}" is not a branch name this runner accepts.`);
  return name;
}

export class Git {
  public constructor(private readonly exec: Exec = execGit) {}

  private async run(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.exec(args, cwd);
    if (result.exitCode !== 0)
      throw new Error(
        `git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    return result.stdout;
  }

  private async succeeds(cwd: string, args: readonly string[]): Promise<boolean> {
    return (await this.exec(args, cwd)).exitCode === 0;
  }

  /** The top folder of the repository `cwd` is in. */
  public async root(cwd: string): Promise<string> {
    return (await this.run(cwd, ['rev-parse', '--show-toplevel'])).trim();
  }

  /** The address of `origin`, or an empty string for a repository without one. */
  public async remote(root: string): Promise<string> {
    const result = await this.exec(['remote', 'get-url', 'origin'], root);
    return result.exitCode === 0 ? result.stdout.trim() : '';
  }

  /** The base branch as it exists here: local first, then the one fetched from origin. */
  private async baseRef(root: string, baseBranch: string): Promise<string> {
    for (const ref of [baseBranch, `origin/${baseBranch}`])
      if (await this.succeeds(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))
        return ref;
    throw new Error(`Base branch "${baseBranch}" does not exist in this repository.`);
  }

  /**
   * Makes sure the session's worktree exists: reuses the folder of an earlier attempt, checks out
   * the branch when only the folder is gone, or creates both from the base branch.
   */
  public async ensureWorktree(
    root: string,
    worktree: { readonly branch: string; readonly baseBranch: string; readonly path: string },
  ): Promise<'reused' | 'created'> {
    const branch = safeRef(worktree.branch);
    const base = await this.baseRef(root, safeRef(worktree.baseBranch));
    if (
      await fs.access(worktree.path).then(
        () => true,
        () => false,
      )
    )
      return 'reused';
    const exists = await this.succeeds(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    await this.run(
      root,
      exists
        ? ['worktree', 'add', worktree.path, branch]
        : ['worktree', 'add', '-b', branch, worktree.path, base],
    );
    return 'created';
  }

  /**
   * Everything the worktree changed since it left the base branch: commits the agent made and
   * what it left uncommitted or untracked. Nothing is committed; the changes are only staged.
   */
  public async diff(worktree: string, baseBranch: string): Promise<DiffFile[]> {
    const base = await this.baseRef(worktree, safeRef(baseBranch));
    const fork = (await this.run(worktree, ['merge-base', 'HEAD', base])).trim();
    await this.run(worktree, ['add', '-A']);
    return this.changedFiles(worktree, ['--cached'], [fork]);
  }

  /**
   * Puts one file back as it was where the worktree left the base branch: its commits and edits
   * are discarded, and a file the session created is deleted.
   */
  public async revertFile(worktree: string, baseBranch: string, path: string): Promise<void> {
    if (!path || path.startsWith('-') || path.startsWith('/') || path.split(/[\\/]/).includes('..'))
      throw new Error(`"${path}" is not a file of this worktree.`);
    const base = await this.baseRef(worktree, safeRef(baseBranch));
    const fork = (await this.run(worktree, ['merge-base', 'HEAD', base])).trim();
    const existed = await this.succeeds(worktree, ['cat-file', '-e', `${fork}:${path}`]);
    await this.run(
      worktree,
      existed ? ['checkout', fork, '--', path] : ['rm', '-f', '-q', '--ignore-unmatch', '--', path],
    );
    // A file that was never added is not known to git: remove it from the disk as well.
    if (!existed) await fs.rm(`${worktree}/${path}`, { force: true });
  }

  /** Discards everything the worktree changed since it left the base branch, commits included. */
  public async revertAll(worktree: string, baseBranch: string): Promise<void> {
    const base = await this.baseRef(worktree, safeRef(baseBranch));
    const fork = (await this.run(worktree, ['merge-base', 'HEAD', base])).trim();
    await this.run(worktree, ['reset', '--hard', fork]);
    await this.run(worktree, ['clean', '-fd']);
  }

  /** What one commit changed, against its parent (against nothing, for the first commit). */
  public async commitDiff(worktree: string, hash: string): Promise<DiffFile[]> {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error(`"${hash}" is not a commit.`);
    const hasParent = await this.succeeds(worktree, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${hash}^`,
    ]);
    return this.changedFiles(worktree, [], [hasParent ? `${hash}^` : EMPTY_TREE, hash]);
  }

  /** The branches of the repository, local and fetched, by the name a person gives them. */
  public async branches(worktree: string): Promise<string[]> {
    const refs = await this.run(worktree, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
      'refs/remotes',
    ]);
    const names = refs
      .split('\n')
      .map((name) => name.trim().replace(/^origin\//, ''))
      .filter((name) => name && name !== 'origin' && name !== 'HEAD');
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }

  private async changedFiles(
    worktree: string,
    mode: readonly string[],
    refs: readonly string[],
  ): Promise<DiffFile[]> {
    const diff = ['-c', 'core.quotepath=false', 'diff', ...mode, '--no-renames'];
    const statuses = await this.run(worktree, [...diff, '--name-status', ...refs]);
    const counts = new Map(
      (await this.run(worktree, [...diff, '--numstat', ...refs]))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [additions, deletions, ...path] = line.split('\t');
          // Binary files report "-" for both counts.
          return [path.join('\t'), [Number(additions) || 0, Number(deletions) || 0]] as const;
        }),
    );
    const files: DiffFile[] = [];
    for (const line of statuses.split('\n').filter(Boolean).slice(0, MAX_DIFF_FILES)) {
      const [status, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const [additions, deletions] = counts.get(path) ?? [0, 0];
      const patch = await this.run(worktree, [...diff, ...refs, '--', path]);
      files.push({
        path,
        status: STATUSES[status!] ?? 'modified',
        additions,
        deletions,
        patch:
          patch.length > MAX_PATCH_LENGTH
            ? `${patch.slice(0, MAX_PATCH_LENGTH - 40)}\n… diff truncated by the runner …`
            : patch,
      });
    }
    return files;
  }

  /** The commits the worktree has and the base branch does not, newest first. */
  public async commits(worktree: string, baseBranch: string): Promise<Commit[]> {
    const base = await this.baseRef(worktree, safeRef(baseBranch));
    return this.log(worktree, `${base}..HEAD`);
  }

  /** The last commits of the branch the worktree is on, newest first: what it was made from too. */
  public async history(worktree: string): Promise<Commit[]> {
    return this.log(worktree, 'HEAD');
  }

  private async log(worktree: string, range: string): Promise<Commit[]> {
    const log = await this.run(worktree, [
      'log',
      '--max-count=100',
      '--format=%H%x09%an%x09%aI%x09%s',
      range,
    ]);
    return log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, ...subject] = line.split('\t');
        return { hash: hash!, author: author!, date: date!, subject: subject.join('\t') };
      });
  }
}
