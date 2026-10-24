import type { RequestContext } from '../../../shared/context.js';
import { ApplicationError } from '../../../shared/errors.js';
import type { KnowledgeChunkRepository } from '../../knowledge/application/knowledge-provider.js';
import type { PbiStore } from '../../pbi/pbi-store.js';
import type { SpecRepository } from '../../spec/application/spec-service.js';
import { renderSpecificationMarkdown } from '../../spec/domain/specification.js';
import type {
  SavedTestPlan,
  SavedTestPlanStore,
} from '../../testplans/application/saved-test-plans.js';
import type { TestSuiteStore } from '../../testplans/application/test-suites.js';
import type {
  ApiTestSourceLoader,
  ApiTestSourceRef,
  LoadedSource,
} from '../application/api-test-service.js';

export interface WorkspaceSourceLoaderOptions {
  readonly tests: SavedTestPlanStore;
  readonly suites: TestSuiteStore;
  readonly knowledge: KnowledgeChunkRepository;
  readonly specs: SpecRepository;
  readonly pbis: PbiStore;
}

function renderTests(plan: SavedTestPlan): string {
  return plan.plans
    .map((testCase, index) =>
      [
        `### Test case ${index + 1}: ${testCase.title}`,
        `Case id: ${plan.id}#${index}`,
        testCase.description,
        ...testCase.steps.map(
          (step, position) =>
            `${position + 1}. ${step.action}${step.data ? ` (data: ${step.data})` : ''} → ${step.expectedResult}`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

/** Reads ADK items as text for test generation, with the access rules of each module. */
export class WorkspaceSourceLoader implements ApiTestSourceLoader {
  constructor(private readonly options: WorkspaceSourceLoaderOptions) {}

  async load(context: RequestContext, ref: ApiTestSourceRef): Promise<LoadedSource> {
    const workspaceId = context.workspaceId ?? '';
    const missing = () =>
      new ApplicationError(
        'API_TEST_SOURCE_NOT_FOUND',
        `${ref.type} '${ref.id}' not found.`,
        404,
        [{ ...ref }],
        { source: `${ref.type} ${ref.id}` },
      );
    switch (ref.type) {
      case 'testPlan': {
        const plan = await this.options.tests.find(ref.id, workspaceId);
        if (!plan) throw missing();
        return { ...ref, title: plan.title, text: renderTests(plan) };
      }
      case 'testSuite': {
        const suite = await this.options.suites.find(ref.id, workspaceId);
        if (!suite) throw missing();
        const all = await this.options.tests.list(workspaceId, 0, 1_000);
        const plans = all.filter((plan) => plan.suiteId === suite.id);
        return {
          ...ref,
          title: suite.name,
          text:
            plans.map((plan) => `## ${plan.title}\n\n${renderTests(plan)}`).join('\n\n') ||
            '(empty suite)',
        };
      }
      case 'brain': {
        const chunks = (await this.options.knowledge.all(context))
          .filter((chunk) => chunk.pageId === ref.id)
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
        if (!chunks.length) throw missing();
        const title = decodeURIComponent(
          chunks[0]!.source.split('/').filter(Boolean).at(-1) ?? ref.id,
        );
        return { ...ref, title, text: chunks.map((chunk) => chunk.content).join('\n\n') };
      }
      case 'spec': {
        const specification = await this.options.specs.findSpecification(ref.id, workspaceId);
        if (!specification) throw missing();
        return {
          ...ref,
          title: specification.title,
          text: renderSpecificationMarkdown(specification),
        };
      }
      case 'pbi': {
        const item = await this.options.pbis.get(workspaceId, ref.id);
        if (!item) throw missing();
        const children = await this.options.pbis.listChildren(workspaceId, item.id);
        return {
          ...ref,
          title: item.title,
          text: [
            `${item.kind.toUpperCase()}: ${item.title} (${item.status})`,
            item.description,
            ...children.map((child) => `- ${child.kind}: ${child.title} — ${child.description}`),
          ]
            .filter(Boolean)
            .join('\n\n'),
        };
      }
    }
  }
}
