import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentE2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { E2eCreation, E2eTestCase } from '../src/modules/e2e/domain/e2e.js';

const images = vi.hoisted(() => ({ load: vi.fn() }));
const documents = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('../src/modules/shared/image-attachment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/shared/image-attachment.js')>()),
  loadImageAttachments: images.load,
}));
vi.mock('../src/modules/shared/document-attachment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/shared/document-attachment.js')>()),
  loadDocumentAttachments: documents.load,
}));

const FILE = '6f1c2a90-1f0e-4a3b-8f4e-5a2c9d7e1b11';
const DOC = '7a2d3b01-2a1f-4b4c-9a5f-6b3dad8f2c22';
const note = {
  name: 'notes.md',
  mimeType: 'text/markdown',
  data: Buffer.from('# Rules').toString('base64'),
};
const pdf = { name: 'spec.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' };
const creation = {
  id: 'c',
  workspaceId: 'ws',
  ownerId: 'owner',
  agentId: 'agent',
  name: 'Run',
  mode: 'frontend',
  scope: 'codebase',
  baseUrl: 'http://localhost:3000',
  path: '/',
  prd: `Login screen:\n\n![print](/attachments/files/${FILE})\n\nRules: [spec](/attachments/files/${DOC})`,
  prdFileNames: [],
  useBrain: false,
  locale: 'en-US',
} as unknown as E2eCreation;
const picture = { mimeType: 'image/png', data: 'AAAA' } as const;
const plan = '{"summary":"s","tests":[{"title":"Sign in"}]}';

function setup(workflow = false, readsFiles = true) {
  const complete = vi.fn().mockResolvedValue({ text: plan, provider: 'fake' });
  const executeAgent = vi.fn().mockResolvedValue({ result: plan });
  const llm = { provider: 'fake', readsFiles, complete, stream: vi.fn() } as unknown as LlmPort;
  const attachments = {} as E2eArtifactStore;
  const subject = new AgentE2eAuthor({
    agents: {
      getAgent: vi.fn().mockResolvedValue({ id: 'agent', instructions: 'QA', model: null }),
      getWorkflow: vi.fn().mockResolvedValue({ enabled: workflow, steps: workflow ? [{}] : [] }),
      executeAgent,
    } as unknown as AgentService,
    providers: {
      resolveLlmProvider: vi.fn().mockResolvedValue(llm),
    } as unknown as DynamicProviderFactory,
    attachments,
  });
  return { subject, complete, executeAgent, attachments };
}

describe('AgentE2eAuthor images in the PRD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    documents.load.mockResolvedValue([]);
  });

  it('shows the model the images written in the PRD', async () => {
    images.load.mockResolvedValue([picture]);
    const { subject, complete, attachments } = setup();
    await subject.plan({ creation, snapshot: null });
    expect(images.load).toHaveBeenCalledWith(attachments, 'ws', [
      expect.objectContaining({ id: FILE, scope: 'e2e', url: `/attachments/files/${FILE}` }),
    ]);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ images: [picture] }),
      undefined,
    );
  });

  it('sends no images when the PRD has none to show', async () => {
    images.load.mockResolvedValue([]);
    const { subject, complete } = setup();
    await subject.plan({ creation: { ...creation, prd: 'Only words.' }, snapshot: null });
    expect(images.load).toHaveBeenCalledWith(expect.anything(), 'ws', []);
    expect(complete.mock.calls[0]![0]).not.toHaveProperty('images');
  });

  it('plans through the workflow of the agent, handing it the images and documents too', async () => {
    images.load.mockResolvedValue([picture]);
    documents.load.mockResolvedValue([note]);
    const { subject, complete, executeAgent } = setup(true);
    await subject.plan({ creation, snapshot: null });
    expect(complete).not.toHaveBeenCalled();
    expect(executeAgent.mock.calls[0]![2]).toMatchObject({ images: [picture], files: [note] });
  });
});

describe('AgentE2eAuthor images in the instructions of a script', () => {
  const SHOT = '9b8a7c60-3d2e-4f1a-8b5c-0a1b2c3d4e5f';
  const withInstructions = (scriptInstructions: string | null) =>
    ({
      id: 't',
      code: 'TC001',
      title: 'Sign in',
      description: 'd',
      steps: ['open'],
      scriptInstructions,
    }) as unknown as E2eTestCase;
  const instructions = `Open it by the route.\n\n![tela certa](/attachments/files/${SHOT})`;

  beforeEach(() => {
    vi.clearAllMocks();
    documents.load.mockResolvedValue([]);
  });

  it('shows the model the pictures of the instructions when it writes the script', async () => {
    images.load.mockResolvedValue([picture]);
    const { subject, complete, attachments } = setup();
    await subject.writeScript({
      creation,
      test: withInstructions(instructions),
      snapshot: null,
    });
    expect(images.load).toHaveBeenCalledWith(attachments, 'ws', [
      expect.objectContaining({
        id: SHOT,
        name: 'tela certa',
        scope: 'e2e',
        url: `/attachments/files/${SHOT}`,
      }),
    ]);
    const request = complete.mock.calls[0]![0] as { prompt: string; instruction: string };
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ images: [picture] }),
      undefined,
    );
    // The text goes with the task and the task tells the model what the pictures are.
    expect(request.prompt).toContain('Open it by the route.');
    expect(request.instruction).toContain('Images attached to the request are the pictures');
  });

  it('asks for the login and the first screen inside the first step of a UI test only', async () => {
    images.load.mockResolvedValue([]);
    const { subject, complete } = setup();
    await subject.writeScript({ creation, test: withInstructions(null), snapshot: null });
    await subject.writeScript({
      creation: { ...creation, mode: 'backend' } as E2eCreation,
      test: withInstructions(null),
      snapshot: null,
    });
    const rule = 'inside the first test.step, never before it';
    expect((complete.mock.calls[0]![0] as { instruction: string }).instruction).toContain(rule);
    expect((complete.mock.calls[1]![0] as { instruction: string }).instruction).not.toContain(rule);
  });

  it('shows them again when it adapts a script to what the user decided', async () => {
    images.load.mockResolvedValue([picture]);
    const { subject, complete } = setup();
    await subject.adaptScript({
      creation,
      test: withInstructions(instructions),
      script: 'old',
      steps: [],
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ images: [picture] }),
      undefined,
    );
  });

  it('hands the pictures to the workflow of the agent as well', async () => {
    images.load.mockResolvedValue([picture]);
    const { subject, complete, executeAgent } = setup(true);
    await subject.writeScript({ creation, test: withInstructions(instructions), snapshot: null });
    expect(complete).not.toHaveBeenCalled();
    expect(executeAgent.mock.calls[0]![2]).toMatchObject({ images: [picture] });
  });

  it('sends no pictures when the instructions have none, or there are no instructions', async () => {
    images.load.mockResolvedValue([]);
    const { subject, complete } = setup();
    await subject.writeScript({ creation, test: withInstructions('Only words.'), snapshot: null });
    await subject.writeScript({ creation, test: withInstructions(null), snapshot: null });
    expect(images.load).toHaveBeenNthCalledWith(1, expect.anything(), 'ws', []);
    expect(images.load).toHaveBeenNthCalledWith(2, expect.anything(), 'ws', []);
    for (const call of complete.mock.calls) expect(call[0]).not.toHaveProperty('images');
  });
});

describe('AgentE2eAuthor fixing one step', () => {
  const SHOT = '9b8a7c60-3d2e-4f1a-8b5c-0a1b2c3d4e5f';
  const screen = { mimeType: 'image/png', data: 'SCREEN' } as const;
  const test = {
    id: 't',
    code: 'TC001',
    title: 'Sign in',
    description: 'd',
    steps: ['open', 'filter'],
    scriptInstructions: 'for the whole test',
    successCriteria: 'the table shows the rows',
  } as unknown as E2eTestCase;
  const request = {
    creation,
    test,
    script: 'const current = 1;',
    step: { position: 2, title: 'Passo 2 - Filtrar' },
    instructions: `Fill only the Documents filter.\n\n![tela](/attachments/files/${SHOT})`,
    problem: 'Expected: 4 Received: 5',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    documents.load.mockResolvedValue([]);
  });

  it('gives the model the step, the words and pictures of the user, the failure and its screen', async () => {
    images.load.mockResolvedValue([picture]);
    const { subject, complete, attachments } = setup();
    complete.mockResolvedValue({ text: '```ts\nconst fixed = 1;\n```', provider: 'fake' });
    const fixed = await subject.fixStep({
      ...request,
      images: [screen],
      hooks: { beforeRun: 'const before = 1;', afterRun: 'const after = 1;' },
      variableNames: ['TOKEN'],
    });
    expect(fixed).toBe('const fixed = 1;');
    // The pictures of the step's instructions come first, then the screen of the failed step.
    expect(images.load).toHaveBeenCalledWith(attachments, 'ws', [
      expect.objectContaining({ id: SHOT, scope: 'e2e' }),
    ]);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ images: [picture, screen] }),
      undefined,
    );
    const sent = complete.mock.calls[0]![0] as { prompt: string; instruction: string };
    expect(sent.instruction).toContain('Fix ONE step');
    expect(sent.instruction).toContain('E2E_VAR_TOKEN');
    for (const text of [
      'const current = 1;',
      'Passo 2 - Filtrar',
      'Fill only the Documents filter.',
      'Expected: 4 Received: 5',
      'the table shows the rows',
      'const before = 1;',
      'const after = 1;',
    ])
      expect(sent.prompt).toContain(text);
    // What the user said about the whole test is not what they said about this step.
    expect(sent.prompt).not.toContain('for the whole test');
  });

  it('shows the rejected rewrite and why when repairing, and leaves out what is not there', async () => {
    images.load.mockResolvedValue([]);
    const { subject, complete } = setup();
    complete.mockResolvedValue({ text: 'const again = 1;', provider: 'fake' });
    await subject.fixStep({
      ...request,
      test: { ...test, successCriteria: null } as unknown as E2eTestCase,
      instructions: '  ',
      previous: { script: 'const rejected = 1;', problem: 'it used eval' },
    });
    const sent = complete.mock.calls[0]![0] as { prompt: string };
    expect(sent.prompt).toContain('const rejected = 1;');
    expect(sent.prompt).toContain('it used eval');
    // The whole script still goes with the request: the rewrite is of the step alone.
    expect(sent.prompt).toContain('const current = 1;');
    expect(sent.prompt).not.toContain('userInstructions');
    expect(sent.prompt).not.toContain('successCriteria');
    expect(complete.mock.calls[0]![0]).not.toHaveProperty('images');
  });
});

describe('AgentE2eAuthor documents linked in the PRD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    images.load.mockResolvedValue([]);
  });

  it('writes a text document into the prompt and hands a PDF to a provider that reads it', async () => {
    documents.load.mockResolvedValue([note, pdf]);
    const { subject, complete, attachments } = setup(false, true);
    await subject.plan({ creation, snapshot: null });
    expect(documents.load).toHaveBeenCalledWith(attachments, 'ws', [
      expect.objectContaining({ id: DOC, scope: 'e2e', kind: 'document', name: 'spec' }),
    ]);
    const request = complete.mock.calls[0]![0] as { prompt: string; files?: unknown };
    // Text sits inside the sandbox envelope, like the rest of the PRD.
    const start = request.prompt.indexOf('Attached file "notes.md"');
    expect(start).toBeGreaterThan(0);
    expect(request.prompt.lastIndexOf('</untrusted_input>')).toBeGreaterThan(start);
    expect(request.files).toEqual([pdf]);
  });

  it('says a PDF was left out when the provider cannot read it', async () => {
    documents.load.mockResolvedValue([pdf]);
    const { subject, complete } = setup(false, false);
    await subject.plan({ creation, snapshot: null });
    const request = complete.mock.calls[0]![0] as { prompt: string };
    expect(request.prompt).toContain('1 attached document(s) could not be read');
    expect(request).not.toHaveProperty('files');
  });
});
