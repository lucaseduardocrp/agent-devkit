import type { E2eRepositoryProvider, E2eRepositoryRef } from '../domain/e2e.js';

export interface E2eRepository {
  readonly id: string;
  readonly provider: E2eRepositoryProvider;
  /** GitHub "owner/repo" or Azure DevOps "Project/Repo". */
  readonly name: string;
  readonly defaultBranch: string;
  readonly webUrl?: string;
}

export interface E2eBranch {
  readonly name: string;
  readonly isDefault: boolean;
}

export interface E2eRepositoryWarning {
  readonly provider: E2eRepositoryProvider;
  readonly code: 'CREDENTIALS_MISSING' | 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE';
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
    provider: E2eRepositoryProvider,
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
  /** Browser link to the file, when the provider exposes one. */
  fileUrl(workspaceId: string, ref: E2eRepositoryRef, filePath: string): Promise<string | null>;
}
