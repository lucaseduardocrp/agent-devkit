import fs from 'node:fs/promises';
import path from 'node:path';
import { ApplicationError } from '../../../shared/errors.js';
import type { E2eRepositoryLocation, E2eRepositoryRef } from '../domain/e2e.js';
import type {
  E2eBranch,
  E2eLocalFolder,
  E2eRepository,
  E2eRepositoryWarning,
  E2eScriptRepository,
} from '../application/script-repository.js';

/** Folders never worth walking when looking for specs. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

const notFound = (code: string, message: string) => new ApplicationError(code, message, 404);

/**
 * Specs kept in a folder of the computer running ADK (the desktop app), as the folder chosen in
 * Code. Files are written to the working tree and left uncommitted: the person reviews and commits
 * them with their own tools. Only the desktop app turns this on, because a hosted ADK has no
 * business reading the disk it runs on.
 */
export class LocalScriptRepository implements E2eScriptRepository {
  listRepositories(): Promise<{
    repositories: readonly E2eRepository[];
    warnings: readonly E2eRepositoryWarning[];
  }> {
    return Promise.resolve({ repositories: [], warnings: [] });
  }

  async listBranches(
    _workspaceId: string,
    _provider: E2eRepositoryLocation,
    repositoryId: string,
  ): Promise<readonly E2eBranch[]> {
    const folder = await this.resolveFolder(repositoryId);
    return [{ name: folder.defaultBranch, isDefault: true }];
  }

  async listFiles(_workspaceId: string, ref: E2eRepositoryRef): Promise<readonly string[]> {
    const root = await this.requireFolder(ref);
    const start = ref.path ? this.inside(root, ref.path) : root;
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name)) await walk(full);
        } else {
          files.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    await walk(start);
    return files.sort();
  }

  async readFile(
    _workspaceId: string,
    ref: E2eRepositoryRef,
    filePath: string,
  ): Promise<string | null> {
    const root = await this.requireFolder(ref);
    try {
      return await fs.readFile(this.inside(root, filePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeFile(
    workspaceId: string,
    ref: E2eRepositoryRef,
    filePath: string,
    content: string,
    message: string,
  ): Promise<void> {
    await this.commitFiles(workspaceId, ref, [{ path: filePath, content }], message);
  }

  async commitFiles(
    _workspaceId: string,
    ref: E2eRepositoryRef,
    changes: readonly { readonly path: string; readonly content: string | null }[],
    _message: string,
  ): Promise<string | null> {
    const root = await this.requireFolder(ref);
    for (const change of changes) {
      const target = this.inside(root, change.path);
      if (change.content === null) {
        await fs.rm(target, { force: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, change.content, 'utf8');
      }
    }
    // A working tree has no commit to link to.
    return null;
  }

  fileUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }

  /** The folder as a repository: its absolute path, its name and the branch checked out in it. */
  async resolveFolder(folder: string): Promise<E2eLocalFolder> {
    if (!path.isAbsolute(folder))
      throw new ApplicationError(
        'E2E_REPOSITORY_NOT_FOUND',
        'Choose the folder with its full path.',
        400,
        [{ field: 'repository.id' }],
      );
    const root = path.resolve(folder);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory())
      throw notFound('E2E_REPOSITORY_NOT_FOUND', 'The folder does not exist on this computer.');
    return {
      id: root,
      name: path.basename(root) || root,
      defaultBranch: await currentBranch(root),
    };
  }

  private async requireFolder(ref: E2eRepositoryRef): Promise<string> {
    return (await this.resolveFolder(ref.id)).id;
  }

  /** A path inside the folder: relative, with no way out of it. */
  private inside(root: string, relative: string): string {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`))
      throw new ApplicationError('E2E_SCRIPT_PATH_INVALID', 'The path leaves the folder.', 400);
    return target;
  }
}

/** The branch a folder has checked out; "local" when it is not a Git repository (or detached). */
async function currentBranch(root: string): Promise<string> {
  const head = await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8').catch(() => '');
  return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() || 'local';
}
