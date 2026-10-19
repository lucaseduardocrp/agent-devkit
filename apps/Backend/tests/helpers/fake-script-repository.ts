import type { E2eRepositoryProvider, E2eRepositoryRef } from '../../src/modules/e2e/domain/e2e.js';
import type {
  E2eRepository,
  E2eScriptRepository,
} from '../../src/modules/e2e/application/script-repository.js';

/** In-memory stand-in for a GitHub / Azure DevOps repository with per-branch files. */
export class FakeScriptRepository implements E2eScriptRepository {
  readonly files = new Map<string, string>();
  readonly commits: { path: string; message: string; branch: string }[] = [];
  repositories: E2eRepository[] = [
    { id: '42', provider: 'github', name: 'acme/demo-app', defaultBranch: 'main' },
    { id: 'guid-1', provider: 'azure_devops', name: 'Finance/app', defaultBranch: 'develop' },
  ];

  private key(ref: E2eRepositoryRef, path: string): string {
    return `${ref.provider}:${ref.id}@${ref.branch}:${path}`;
  }

  seed(ref: E2eRepositoryRef, path: string, content: string): void {
    this.files.set(this.key(ref, path), content);
  }

  listRepositories() {
    return Promise.resolve({ repositories: this.repositories, warnings: [] });
  }

  listBranches(_workspaceId: string, _provider: E2eRepositoryProvider, repositoryId: string) {
    return Promise.resolve([
      { name: repositoryId === '42' ? 'main' : 'develop', isDefault: true },
      { name: 'feature/e2e', isDefault: false },
    ]);
  }

  listFiles(_workspaceId: string, ref: E2eRepositoryRef) {
    const prefix = `${ref.provider}:${ref.id}@${ref.branch}:`;
    return Promise.resolve(
      [...this.files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((path) => !ref.path || path.startsWith(`${ref.path}/`)),
    );
  }

  readFile(_workspaceId: string, ref: E2eRepositoryRef, path: string) {
    return Promise.resolve(this.files.get(this.key(ref, path)) ?? null);
  }

  writeFile(
    _workspaceId: string,
    ref: E2eRepositoryRef,
    path: string,
    content: string,
    message: string,
  ) {
    this.files.set(this.key(ref, path), content);
    this.commits.push({ path, message, branch: ref.branch });
    return Promise.resolve();
  }

  fileUrl(_workspaceId: string, ref: E2eRepositoryRef, path: string) {
    return Promise.resolve(`https://example.test/${ref.name}/blob/${ref.branch}/${path}`);
  }
}
