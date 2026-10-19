import type { RequestContext } from '../../../shared/context.js';
import type { KnowledgeContentProvider, KnowledgePage } from '../application/knowledge-provider.js';

export interface GitHubProjectsProviderOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token?: string;
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
}

interface GitHubIssueItem {
  readonly id: number;
  readonly title: string;
  readonly body?: string;
  readonly updated_at?: string;
}

export class GitHubProjectsProvider implements KnowledgeContentProvider {
  public readonly name = 'GitHub Projects & Wiki';
  private readonly owner: string;
  private readonly repo: string;
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  public constructor(options: GitHubProjectsProviderOptions) {
    this.owner = options.owner.trim();
    this.repo = options.repo.trim();
    this.token = options.token?.trim();
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  public async listPages(_context: RequestContext): Promise<readonly KnowledgePage[]> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues?state=all&per_page=50`;
    const response = await this.fetcher(url, {
      headers: {
        accept: 'application/vnd.github.v3+json',
        'user-agent': 'adk',
        ...(this.token ? { authorization: `token ${this.token}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub provider returned HTTP ${response.status}.`);
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('GitHub provider returned an invalid response.');
    }

    return (data as readonly GitHubIssueItem[]).map((issue) => ({
      id: String(issue.id),
      source: `github:${this.owner}/${this.repo}`,
      content: `# ${issue.title}\n\n${issue.body ?? ''}`,
      updatedAt: issue.updated_at ?? new Date().toISOString(),
    }));
  }
}
