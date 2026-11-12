import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  execGit,
  Git,
  MAX_PATCH_LENGTH,
  safeRef,
  type Exec,
  type ExecResult,
} from '../src/development/git.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A real repository with one commit on `main`. */
async function repository() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'adk-git-')));
  temporary.push(root);
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@adk.test');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(repo, 'keep.txt'), 'one\ntwo\n');
  await fs.writeFile(path.join(repo, 'gone.txt'), 'bye\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, repo, git };
}

const scripted = (results: readonly Partial<ExecResult>[]): Exec => {
  const queue = [...results];
  return () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, ...queue.shift() });
};

describe('execGit', () => {
  it('returns the output, a failing exit code or the reason git could not run', async () => {
    const { repo } = await repository();
    expect(await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).toEqual({
      stdout: 'main\n',
      stderr: '',
      exitCode: 0,
    });
    const failed = await execGit(['rev-parse', '--verify', 'refs/heads/missing'], repo);
    expect(failed.exitCode).toBeGreaterThan(0);
    expect(failed.stderr).toContain('fatal');
    const noFolder = await execGit(['status'], path.join(repo, 'missing-folder'));
    expect(noFolder.exitCode).toBe(1);
    expect(noFolder.stderr).not.toBe('');
  });
});

describe('safeRef', () => {
  it('accepts branch names and refuses options and path tricks', () => {
    expect(safeRef('adk/add-login-1a2b3c4d')).toBe('adk/add-login-1a2b3c4d');
    expect(safeRef('release/1.2_x')).toBe('release/1.2_x');
    for (const name of ['-b', '--upload-pack=x', 'a..b', 'has space', '', '/abs'])
      expect(() => safeRef(name)).toThrow('is not a branch name this runner accepts');
  });
});

describe('Git on a real repository', () => {
  it('finds the root and the origin', async () => {
    const { repo, git } = await repository();
    await fs.mkdir(path.join(repo, 'src'));
    const client = new Git();
    expect(path.resolve(await client.root(path.join(repo, 'src')))).toBe(path.resolve(repo));
    expect(await client.remote(repo)).toBe('');
    git('remote', 'add', 'origin', 'https://github.com/acme/shop.git');
    expect(await client.remote(repo)).toBe('https://github.com/acme/shop.git');
    await expect(client.root(os.tmpdir())).rejects.toThrow('git rev-parse failed');
  });

  it('creates the worktree of a session, reuses it and restores it from its branch', async () => {
    const { root, repo, git } = await repository();
    const client = new Git();
    const worktree = {
      branch: 'adk/add-login-1a2b3c4d',
      baseBranch: 'main',
      path: path.join(root, 'wt'),
    };
    expect(await client.ensureWorktree(repo, worktree)).toBe('created');
    expect(git('branch', '--list', 'adk/*')).toContain('adk/add-login-1a2b3c4d');
    expect(await fs.readFile(path.join(worktree.path, 'keep.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(await client.ensureWorktree(repo, worktree)).toBe('reused');

    // The folder was removed between attempts: the branch still holds the work.
    git('worktree', 'remove', '--force', worktree.path);
    expect(await client.ensureWorktree(repo, worktree)).toBe('created');
    expect(git('worktree', 'list')).toContain('adk/add-login-1a2b3c4d');

    await expect(
      client.ensureWorktree(repo, {
        ...worktree,
        baseBranch: 'missing',
        path: path.join(root, 'x'),
      }),
    ).rejects.toThrow('Base branch "missing" does not exist in this repository.');
    await expect(
      client.ensureWorktree(repo, { ...worktree, branch: '-b', path: path.join(root, 'x') }),
    ).rejects.toThrow('is not a branch name');

    // A base that only exists as fetched from origin.
    git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    expect(
      await client.ensureWorktree(repo, {
        branch: 'adk/from-origin',
        baseBranch: 'trunk',
        path: path.join(root, 'wt-origin'),
      }),
    ).toBe('created');
  });

  it('reports what a worktree changed: commits, uncommitted and untracked files', async () => {
    const { root, repo } = await repository();
    const client = new Git();
    const wt = path.join(root, 'wt');
    await client.ensureWorktree(repo, { branch: 'adk/work', baseBranch: 'main', path: wt });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8' });

    expect(await client.diff(wt, 'main')).toEqual([]);
    expect(await client.commits(wt, 'main')).toEqual([]);
    await fs.writeFile(path.join(wt, 'keep.txt'), 'one\nTWO\nthree\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'agent\tcommit');
    expect(await client.commits(wt, 'main')).toEqual([
      {
        hash: git('rev-parse', 'HEAD').trim(),
        author: 'Test',
        date: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
        subject: 'agent\tcommit',
      },
    ]);
    // The history is the branch's own commits on top of the ones it was made from.
    expect((await client.history(wt)).map((commit) => commit.subject)).toEqual([
      'agent\tcommit',
      ...git('log', '--format=%s', 'main').trim().split('\n'),
    ]);
    await fs.rm(path.join(wt, 'gone.txt'));
    await fs.mkdir(path.join(wt, 'src'));
    await fs.writeFile(path.join(wt, 'src', 'new file.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(wt, 'image.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    await fs.writeFile(path.join(wt, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(5000));

    const files = await client.diff(wt, 'main');
    expect(
      files.map(({ path: file, status, additions, deletions }) => ({
        file,
        status,
        additions,
        deletions,
      })),
    ).toEqual([
      { file: 'big.txt', status: 'added', additions: 5000, deletions: 0 },
      { file: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
      { file: 'image.bin', status: 'added', additions: 0, deletions: 0 },
      { file: 'keep.txt', status: 'modified', additions: 2, deletions: 1 },
      { file: 'src/new file.ts', status: 'added', additions: 1, deletions: 0 },
    ]);
    const patch = (name: string) => files.find((file) => file.path === name)!.patch;
    expect(patch('keep.txt')).toContain('-two\n+TWO\n+three');
    expect(patch('src/new file.ts')).toContain('+export const a = 1;');
    expect(patch('big.txt').length).toBeLessThanOrEqual(MAX_PATCH_LENGTH);
    expect(patch('big.txt')).toContain('diff truncated by the runner');
    // Nothing was committed on the agent's behalf.
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(2);
  });
});

describe('Git branches and commits', () => {
  it('lists the branches by name and shows what one commit changed', async () => {
    const { root, repo, git } = await repository();
    const client = new Git();
    git('branch', 'feature/login');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('update-ref', 'refs/remotes/origin/release', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await client.branches(repo)).toEqual(['feature/login', 'main', 'release']);

    const wt = path.join(root, 'wt');
    await client.ensureWorktree(repo, { branch: 'adk/work', baseBranch: 'main', path: wt });
    const inWorktree = (...args: string[]) =>
      execFileSync('git', args, { cwd: wt, encoding: 'utf8' });
    await fs.writeFile(path.join(wt, 'keep.txt'), 'one\nTWO\n');
    await fs.rm(path.join(wt, 'gone.txt'));
    await fs.writeFile(path.join(wt, 'new.txt'), 'new\n');
    inWorktree('add', '-A');
    inWorktree('commit', '-q', '-m', 'agent commit');
    const hash = inWorktree('rev-parse', 'HEAD').trim();
    const files = await client.commitDiff(wt, hash);
    expect(files.map((file) => `${file.status}:${file.path}`)).toEqual([
      'deleted:gone.txt',
      'modified:keep.txt',
      'added:new.txt',
    ]);
    expect(files[1]!.patch).toContain('-two\n+TWO');
    // The first commit has no parent: everything it holds was added by it.
    const first = inWorktree('rev-list', '--max-parents=0', 'HEAD').trim();
    expect((await client.commitDiff(wt, first.slice(0, 10))).map((file) => file.status)).toEqual([
      'added',
      'added',
    ]);
    await expect(client.commitDiff(wt, '--output=x')).rejects.toThrow('is not a commit');
    await expect(client.commitDiff(wt, 'abc')).rejects.toThrow('is not a commit');
  });
});

describe('Git revert', () => {
  it('puts one file back, deletes the ones the session created, and rejects odd paths', async () => {
    const { root, repo } = await repository();
    const client = new Git();
    const wt = path.join(root, 'wt');
    await client.ensureWorktree(repo, { branch: 'adk/work', baseBranch: 'main', path: wt });
    const inWorktree = (...args: string[]) =>
      execFileSync('git', args, { cwd: wt, encoding: 'utf8' });
    await fs.writeFile(path.join(wt, 'keep.txt'), 'one\nTWO\n');
    inWorktree('commit', '-q', '-am', 'agent commit');
    await fs.writeFile(path.join(wt, 'new.txt'), 'new\n');
    await fs.writeFile(path.join(wt, 'gone.txt'), 'edited\n');
    inWorktree('add', 'new.txt');
    await fs.writeFile(path.join(wt, 'loose.txt'), 'loose\n');

    await client.revertFile(wt, 'main', 'keep.txt');
    expect(await fs.readFile(path.join(wt, 'keep.txt'), 'utf8')).toBe('one\ntwo\n');
    await client.revertFile(wt, 'main', 'new.txt');
    await client.revertFile(wt, 'main', 'loose.txt');
    await expect(fs.access(path.join(wt, 'new.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(wt, 'loose.txt'))).rejects.toThrow();
    for (const bad of ['', '-rf', '/etc/passwd', '../x', 'a/../../x'])
      await expect(client.revertFile(wt, 'main', bad)).rejects.toThrow('not a file');

    await client.revertAll(wt, 'main');
    expect(await client.diff(wt, 'main')).toEqual([]);
    expect(await fs.readFile(path.join(wt, 'gone.txt'), 'utf8')).toBe('bye\n');
    expect(inWorktree('log', '--format=%s', 'main..HEAD').trim()).toBe('');
  });
});

describe('Git failures', () => {
  it('explains a failed command with stderr or its exit code', async () => {
    await expect(
      new Git(scripted([{ exitCode: 128, stderr: 'fatal: not a repository\n' }])).root('.'),
    ).rejects.toThrow('git rev-parse failed: fatal: not a repository');
    await expect(new Git(scripted([{ exitCode: 2 }])).root('.')).rejects.toThrow(
      'git rev-parse failed: exit 2',
    );
  });

  it('counts nothing for a file git gave no numbers for', async () => {
    const git = new Git(
      scripted([
        {}, // base exists
        { stdout: 'abc123\n' }, // merge-base
        {}, // add
        { stdout: 'M\todd.txt\n' }, // name-status
        { stdout: '' }, // numstat
        { stdout: 'patch' },
      ]),
    );
    expect(await git.diff('.', 'main')).toEqual([
      { path: 'odd.txt', status: 'modified', additions: 0, deletions: 0, patch: 'patch' },
    ]);
  });
});
