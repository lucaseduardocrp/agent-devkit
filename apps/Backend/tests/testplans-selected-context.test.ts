import { afterEach, describe, expect, it, vi } from 'vitest';
import { testPlanCreateSchema } from '../src/contracts/http.js';
import {
  AiKnowledgeTestPlanGenerator,
  type TestPlanContextReader,
} from '../src/modules/testplans/application/generate-test-plan.js';

const requirement = 'The report screen must display every employee dismissal record.';
const requestContext = { requestId: 'r', ownerId: 'owner-1', workspaceId: 'ws-1' };

const readerReturning = (
  documents: Awaited<ReturnType<TestPlanContextReader['read']>>,
): { reader: TestPlanContextReader; read: ReturnType<typeof vi.fn> } => {
  const read = vi.fn().mockResolvedValue(documents);
  return { reader: { read }, read };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Test Plan generation with selected context', () => {
  it('gives the chosen PBIs, issues and documents to the model before the requirement', async () => {
    const { reader, read } = readerReturning([
      { kind: 'pbi', id: 'p1', title: 'Dismissal report', content: 'Acceptance: filter by date.' },
      { kind: 'issue', id: 'i1', title: 'Wrong totals', content: 'Totals ignore filters.' },
      { kind: 'brain', id: 'b1', title: 'HR rules', content: 'Dismissals need approval.' },
    ]);
    const requests = [
      { kind: 'pbi', id: 'p1' },
      { kind: 'issue', id: 'i1' },
      { kind: 'brain', id: 'b1' },
    ] as const;

    const brief = await new AiKnowledgeTestPlanGenerator({ contextReader: reader }).prepare(
      { prompt: requirement, context: requests },
      requestContext,
    );

    expect(read).toHaveBeenCalledWith(requestContext, requests);
    expect(brief.context).toContain('--- [PBI: Dismissal report] ---\nAcceptance: filter by date.');
    expect(brief.context).toContain('--- [Issue: Wrong totals] ---');
    expect(brief.context).toContain('--- [Documento: HR rules] ---');
    expect(brief.context.indexOf('Dismissal report')).toBeLessThan(
      brief.context.indexOf('## Requisito'),
    );
    expect(brief.knowledgeSources).toEqual(['Dismissal report', 'Wrong totals', 'HR rules']);
    // With context the model is told to ground itself in it.
    expect(brief.instruction).toContain('Knowledge Base pages and rules');
  });

  it('keeps the kind of an unknown document as its label', async () => {
    const { reader } = readerReturning([{ kind: 'wiki', id: 'w', title: 'Page', content: 'Text' }]);
    const brief = await new AiKnowledgeTestPlanGenerator({ contextReader: reader }).prepare(
      { prompt: requirement, context: [{ kind: 'brain', id: 'w' }] },
      requestContext,
    );
    expect(brief.context).toContain('--- [wiki: Page] ---');
  });

  it('does not read anything when nothing was chosen', async () => {
    const { reader, read } = readerReturning([]);
    const generator = new AiKnowledgeTestPlanGenerator({ contextReader: reader });

    const none = await generator.prepare({ prompt: requirement }, requestContext);
    const empty = await generator.prepare({ prompt: requirement, context: [] }, requestContext);
    // Without a request context there is no workspace to read from.
    const anonymous = await generator.prepare({
      prompt: requirement,
      context: [{ kind: 'pbi', id: 'p1' }],
    });

    expect(read).not.toHaveBeenCalled();
    for (const brief of [none, empty, anonymous]) {
      expect(brief.context).toBe(`## Requisito\n${requirement}`);
    }
  });

  it('ignores the choices when no reader is configured', async () => {
    const brief = await new AiKnowledgeTestPlanGenerator().prepare(
      { prompt: requirement, context: [{ kind: 'pbi', id: 'p1' }] },
      requestContext,
    );
    expect(brief.context).toBe(`## Requisito\n${requirement}`);
  });

  it('still generates when the chosen items cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader: TestPlanContextReader = { read: vi.fn().mockRejectedValue(new Error('db down')) };

    const brief = await new AiKnowledgeTestPlanGenerator({ contextReader: reader }).prepare(
      { prompt: requirement, context: [{ kind: 'pbi', id: 'p1' }] },
      requestContext,
    );

    expect(brief.context).toBe(`## Requisito\n${requirement}`);
    expect(error).toHaveBeenCalledWith(
      '[AiKnowledgeTestPlanGenerator] Reading the selected context failed:',
      expect.objectContaining({ message: 'db down' }),
    );
  });

  it('puts the chosen context before the Brain search results', async () => {
    const { reader } = readerReturning([
      { kind: 'pbi', id: 'p1', title: 'Dismissal report', content: 'Chosen text.' },
    ]);
    const knowledgeSearch = {
      search: vi
        .fn()
        .mockResolvedValue([
          { source: 'wiki/Rules', pageId: 'r', chunkIndex: 0, content: 'Found text.' },
        ]),
    };

    const brief = await new AiKnowledgeTestPlanGenerator({
      contextReader: reader,
      knowledgeSearch,
    }).prepare({ prompt: requirement, context: [{ kind: 'pbi', id: 'p1' }] }, requestContext);

    const chosen = brief.context.indexOf('Chosen text.');
    const found = brief.context.indexOf('Found text.');
    const asked = brief.context.indexOf('## Requisito / Funcionalidade Solicitada');
    expect(chosen).toBeGreaterThan(-1);
    expect(chosen).toBeLessThan(found);
    expect(found).toBeLessThan(asked);
  });
});

describe('testPlanCreateSchema context', () => {
  it('accepts the three kinds of context', () => {
    const parsed = testPlanCreateSchema.parse({
      prompt: requirement,
      context: [
        { kind: 'pbi', id: ' 12 ' },
        { kind: 'issue', id: 'abc' },
        { kind: 'brain', id: 'wiki:page' },
      ],
    });
    expect(parsed.context).toEqual([
      { kind: 'pbi', id: '12' },
      { kind: 'issue', id: 'abc' },
      { kind: 'brain', id: 'wiki:page' },
    ]);
  });

  it('is optional', () => {
    expect(testPlanCreateSchema.parse({ prompt: requirement }).context).toBeUndefined();
  });

  it.each([
    ['an unknown kind', [{ kind: 'spec', id: '1' }]],
    ['an empty id', [{ kind: 'pbi', id: '  ' }]],
    ['too many items', Array.from({ length: 31 }, (_, i) => ({ kind: 'pbi', id: `${i}` }))],
  ])('rejects %s', (_label, context) => {
    expect(testPlanCreateSchema.safeParse({ prompt: requirement, context }).success).toBe(false);
  });
});
