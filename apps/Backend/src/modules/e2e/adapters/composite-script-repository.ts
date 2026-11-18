import type { E2eRepositoryLocation, E2eRepositoryRef } from '../domain/e2e.js';
import type { E2eLocalFolder, E2eScriptRepository } from '../application/script-repository.js';

/**
 * The specs of a run live in a Git host or, in the desktop app, in a folder of the computer.
 * Each call goes to the one that owns the repository.
 */
export class CompositeScriptRepository implements E2eScriptRepository {
  constructor(
    private readonly remote: E2eScriptRepository,
    private readonly local: E2eScriptRepository & {
      resolveFolder(folder: string): Promise<E2eLocalFolder>;
    },
  ) {}

  private owner(provider: E2eRepositoryLocation): E2eScriptRepository {
    return provider === 'local' ? this.local : this.remote;
  }

  listRepositories(workspaceId: string) {
    return this.remote.listRepositories(workspaceId);
  }

  listBranches(workspaceId: string, provider: E2eRepositoryLocation, repositoryId: string) {
    return this.owner(provider).listBranches(workspaceId, provider, repositoryId);
  }

  listFiles(workspaceId: string, ref: E2eRepositoryRef) {
    return this.owner(ref.provider).listFiles(workspaceId, ref);
  }

  readFile(workspaceId: string, ref: E2eRepositoryRef, filePath: string) {
    return this.owner(ref.provider).readFile(workspaceId, ref, filePath);
  }

  writeFile(
    workspaceId: string,
    ref: E2eRepositoryRef,
    filePath: string,
    content: string,
    message: string,
  ) {
    return this.owner(ref.provider).writeFile(workspaceId, ref, filePath, content, message);
  }

  commitFiles(
    workspaceId: string,
    ref: E2eRepositoryRef,
    changes: readonly { readonly path: string; readonly content: string | null }[],
    message: string,
  ) {
    return this.owner(ref.provider).commitFiles(workspaceId, ref, changes, message);
  }

  fileUrl(workspaceId: string, ref: E2eRepositoryRef, filePath: string) {
    return this.owner(ref.provider).fileUrl(workspaceId, ref, filePath);
  }

  resolveFolder(folder: string) {
    return this.local.resolveFolder(folder);
  }
}
