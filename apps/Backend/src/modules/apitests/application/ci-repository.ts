import type { CiProvider } from '../formats/ci.js';

export interface CiRepository {
  readonly id: string;
  readonly provider: CiProvider;
  /** GitHub "owner/repo" or Azure DevOps "Project/Repo". */
  readonly name: string;
  readonly defaultBranch: string;
  readonly webUrl?: string;
}

export interface CiRepositoryRef {
  readonly provider: CiProvider;
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  /** Folder inside the repository, without leading or trailing slashes. */
  readonly path: string;
}

/** A file to create or replace, or to delete when `content` is null. */
export interface CiFileChange {
  readonly path: string;
  readonly content: string | null;
}

/**
 * The connected GitHub and Azure DevOps repositories. The E2E script repository already speaks
 * to both providers with the workspace's integrations, so it is the implementation.
 */
export interface CiRepositoryGateway {
  listRepositories(workspaceId: string): Promise<{
    repositories: readonly CiRepository[];
    warnings: readonly {
      readonly provider: CiProvider;
      readonly code: 'CREDENTIALS_MISSING' | 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE';
    }[];
  }>;
  listBranches(
    workspaceId: string,
    provider: CiProvider,
    repositoryId: string,
  ): Promise<readonly { readonly name: string; readonly isDefault: boolean }[]>;
  /** Repository-relative paths of every file under `ref.path`. */
  listFiles(workspaceId: string, ref: CiRepositoryRef): Promise<readonly string[]>;
  readFile(workspaceId: string, ref: CiRepositoryRef, filePath: string): Promise<string | null>;
  /**
   * Applies every change in one commit on `ref.branch`. Resolves with the commit's browser link,
   * or null when the files already matched.
   */
  commitFiles(
    workspaceId: string,
    ref: CiRepositoryRef,
    changes: readonly CiFileChange[],
    message: string,
  ): Promise<string | null>;
}
