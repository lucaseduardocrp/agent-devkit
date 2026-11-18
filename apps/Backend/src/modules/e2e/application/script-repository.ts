import type {
  E2eRepositoryLocation,
  E2eRepositoryProvider,
  E2eRepositoryRef,
} from '../domain/e2e.js';

export interface E2eRepository {
  readonly id: string;
  readonly provider: E2eRepositoryProvider;
  /** GitHub "owner/repo" or Azure DevOps "Project/Repo". */
  readonly name: string;
  readonly defaultBranch: string;
  readonly webUrl?: string;
}

/** A folder of this computer chosen as the place of the specs (desktop app only). */
export interface E2eLocalFolder {
  /** Absolute path. */
  readonly id: string;
  /** Folder name. */
  readonly name: string;
  /** The branch checked out in it, or "local" when it is not a Git repository. */
  readonly defaultBranch: string;
}

export interface E2eBranch {
  readonly name: string;
  readonly isDefault: boolean;
}

export interface E2eRepositoryWarning {
  readonly provider: E2eRepositoryProvider;
  readonly code:
    'CREDENTIALS_MISSING' | 'CREDENTIALS_UNREADABLE' | 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE';
}

/**
 * Reads and writes the Playwright specs of a run in the user's GitHub or Azure DevOps
 * repository, using the workspace's existing integrations.
 */
export interface E2eScriptRepository {
  listRepositories(workspaceId: string): Promise<{
    repositories: readonly E2eRepository[];
    warnings: readonly E2eRepositoryWarning[];
  }>;
  listBranches(
    workspaceId: string,
    provider: E2eRepositoryLocation,
    repositoryId: string,
  ): Promise<readonly E2eBranch[]>;
  /** Repository-relative paths of every file under `ref.path`. */
  listFiles(workspaceId: string, ref: E2eRepositoryRef): Promise<readonly string[]>;
  readFile(workspaceId: string, ref: E2eRepositoryRef, filePath: string): Promise<string | null>;
  /** Creates or updates one file with a commit on `ref.branch`. */
  writeFile(
    workspaceId: string,
    ref: E2eRepositoryRef,
    filePath: string,
    content: string,
    message: string,
  ): Promise<void>;
  /**
   * Creates, updates (`content`) or deletes (`content: null`) several files in one commit on
   * `ref.branch`. Resolves with the commit's browser link, or null when nothing changed.
   */
  commitFiles(
    workspaceId: string,
    ref: E2eRepositoryRef,
    changes: readonly { readonly path: string; readonly content: string | null }[],
    message: string,
  ): Promise<string | null>;
  /**
   * Reads a folder of this computer as a repository. Present only where the app runs on the
   * person's own computer (desktop); absent, a "local" repository is refused.
   */
  resolveFolder?(folder: string): Promise<E2eLocalFolder>;
  /** Browser link to the file, when the provider exposes one. */
  fileUrl(workspaceId: string, ref: E2eRepositoryRef, filePath: string): Promise<string | null>;
}
