import type { RequestContext } from '../../../shared/context.js';
import type { IssueStore } from '../../issues/issue-store.js';
import type { KnowledgeChunkRepository } from '../../knowledge/application/knowledge-provider.js';
import type { PbiItem, PbiStore } from '../../pbi/pbi-store.js';
import { documentTitle } from '../application/e2e-brain.js';
import {
  MAX_CONTEXT_DOCUMENT,
  type E2eContextReader,
  type E2eContextRequest,
} from '../application/e2e-context.js';
import type { E2eExplorationContextDocument } from '../domain/e2e-insight.js';

/** Text of a description kept as HTML (Azure DevOps) or Markdown. */
export function plainText(value: string): string {
  const sanitizeOnce = (input: string): string =>
    input
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');

  let previous: string;
  let current = value;
  do {
    previous = current;
    current = sanitizeOnce(current);
  } while (current !== previous);

  return current.trim();
}

/** Fields of a work item that say what to build or check, besides its description. */
const CRITERIA_KEY = /accept|criteri|aceite|repro|steps|passos|expect/i;

function pbiText(item: PbiItem, children: readonly PbiItem[]): string {
  const type = typeof item.sourceData['type'] === 'string' ? item.sourceData['type'] : item.kind;
  const lines = [`${type} · ${item.status}`, plainText(item.description)];
  for (const [key, value] of Object.entries(item.sourceData))
    if (CRITERIA_KEY.test(key) && typeof value === 'string' && value.trim())
      lines.push(`${key}:\n${plainText(value)}`);
  if (children.length) {
    lines.push('Child items:');
    for (const child of children)
      lines.push(
        `- ${child.title}${child.description ? `: ${plainText(child.description).slice(0, 700)}` : ''}`,
      );
  }
  return lines.filter(Boolean).join('\n\n');
}

/** Reads the context of an exploration from the PBIs, issues and Brain of the workspace. */
export class WorkspaceContextReader implements E2eContextReader {
  constructor(
    private readonly sources: {
      readonly pbis: Pick<PbiStore, 'get' | 'findByExternal' | 'listChildren'>;
      readonly issues: Pick<IssueStore, 'get'>;
      readonly knowledge: Pick<KnowledgeChunkRepository, 'all'>;
    },
  ) {}

  async read(
    context: RequestContext,
    requests: readonly E2eContextRequest[],
  ): Promise<E2eExplorationContextDocument[]> {
    const documents: E2eExplorationContextDocument[] = [];
    // The Brain is read once for every document of it that was chosen.
    let chunks: Awaited<ReturnType<KnowledgeChunkRepository['all']>> | null = null;
    for (const request of requests) {
      let document: E2eExplorationContextDocument | null = null;
      try {
        if (request.kind === 'pbi') document = await this.pbi(context, request.id);
        else if (request.kind === 'issue') document = await this.issue(context, request.id);
        else {
          chunks ??= await this.sources.knowledge.all(context);
          document = this.brain(chunks, request.id);
        }
      } catch (error) {
        // One unreadable item must not stop the exploration from using the others.
        console.error('[E2eContext] Could not read a context item:', error);
      }
      if (document && document.content.trim())
        documents.push({ ...document, content: document.content.slice(0, MAX_CONTEXT_DOCUMENT) });
    }
    return documents;
  }

  private async pbi(context: RequestContext, id: string) {
    const { workspaceId } = context;
    if (!workspaceId) return null;
    const { pbis } = this.sources;
    const item =
      (await pbis.get(workspaceId, id)) ??
      (/^\d+$/.test(id) ? await pbis.findByExternal(workspaceId, 'azure_devops', id) : null);
    if (!item) return null;
    const children = (await pbis.listChildren(workspaceId, item.id)).slice(0, 15);
    return {
      kind: 'pbi' as const,
      id,
      title: item.title,
      content: `${item.title}\n\n${pbiText(item, children)}`,
    };
  }

  private async issue(context: RequestContext, id: string) {
    const { workspaceId } = context;
    if (!workspaceId) return null;
    const issue = await this.sources.issues.get(workspaceId, id);
    if (!issue) return null;
    return {
      kind: 'issue' as const,
      id,
      title: issue.title,
      content: `${issue.title}\n\n${issue.status} · ${issue.priority}\n\n${plainText(issue.description)}`,
    };
  }

  private brain(
    chunks: Awaited<ReturnType<KnowledgeChunkRepository['all']>>,
    id: string,
  ): E2eExplorationContextDocument | null {
    const own = chunks
      .filter((chunk) => `${chunk.source}:${chunk.pageId}` === id || chunk.pageId === id)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (!own.length) return null;
    return {
      kind: 'brain',
      id,
      title: documentTitle(own),
      content: own.map((chunk) => chunk.content).join(''),
    };
  }
}
