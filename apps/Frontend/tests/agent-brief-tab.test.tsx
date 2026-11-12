import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { AgentBriefTab } from '../src/features/issues/AgentBriefTab.js';
import type { IssueAgentBrief } from '../src/features/issues/agent-brief-types.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const brief: IssueAgentBrief = {
  issueId: 'issue-1',
  workspaceId: 'ws',
  engineVersion: 1,
  generatedAt: '2026-11-05T12:00:00.000Z',
  updatedAt: '2026-11-05T12:00:00.000Z',
  source: 'engine',
  locked: [],
  complexity: { score: 6, level: 'medium', signals: ['Touches several modules'] },
  recommendation: {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    rationale: 'Balanced model for a medium change.',
    estimatedCostUsd: 0.0421,
    alternatives: [
      { provider: 'groq', model: 'llama', effort: 'low', reason: 'Cheaper, lower quality' },
    ],
  },
  readFirst: [{ kind: 'pbi', label: 'PBI 1', ref: 'pbi-1', reason: 'Parent scope' }],
  considerations: ['Keep backwards compatibility'],
  prompt: { system: 'You are a dev.', task: 'Do the work.', outputFormat: 'Markdown.' },
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
};

const generic = 'The operation could not be completed.';

const uploadedFile = {
  id: 'att-1',
  name: 'rules.pdf',
  kind: 'document',
  size: 2048,
  scope: 'issue',
  source: 'adk',
  url: '/attachments/files/att-1',
};

/** Opens a searchable list and picks one of its options (lists of a source load first). */
const pick = async (name: string, option: string | RegExp) => {
  fireEvent.focus(screen.getByRole('combobox', { name }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
};

/** The options of the open list, not the native <option> of the selects around it. */
const listed = (name: string) =>
  within(screen.getByRole('listbox', { name })).queryAllByRole('option');

const valueOf = (element: HTMLElement) => (element as HTMLInputElement).value;
const field = (name: string) => screen.getByRole('textbox', { name });

function client(overrides: Record<string, unknown> = {}) {
  return {
    getIssueBrief: vi.fn().mockResolvedValue(brief),
    updateIssueBrief: vi.fn().mockImplementation((_id: string, edits: object) =>
      Promise.resolve({
        ...brief,
        ...edits,
        source: 'edited',
        locked: Object.keys(edits),
      }),
    ),
    regenerateIssueBrief: vi.fn().mockResolvedValue(brief),
    getPbiItems: vi.fn().mockResolvedValue([{ id: 'pbi-1', title: 'PBI 1' }]),
    getIssues: vi.fn().mockResolvedValue([
      { id: 'issue-1', number: 1, title: 'This one' },
      { id: 'issue-2', number: 2, title: 'Other issue' },
    ]),
    getKnowledgeDocuments: vi.fn().mockResolvedValue([
      { pageId: 'page-1', title: 'Approval of events' },
      { pageId: 'page-1', title: 'Duplicate' },
    ]),
    getSpecifications: vi
      .fn()
      .mockResolvedValue([
        { id: 'spec-a', title: 'Spec A', sections: [{ title: 'Goal', content: 'Spec body' }] },
      ]),
    getAllSavedTestPlans: vi.fn().mockResolvedValue([{ id: 'plan-1', title: 'Plan 1', plans: [] }]),
    uploadAttachment: vi.fn().mockResolvedValue(uploadedFile),
    updateIssue: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function tree(
  api: ReturnType<typeof client>,
  props: {
    isReadOnly?: boolean;
    locale?: 'pt-BR' | 'en-US';
    version?: string;
    issueAttachments?: unknown[];
  } = {},
) {
  const { locale = 'en-US', version = 'v1', ...rest } = props;
  return (
    <I18nProvider initialLocale={locale}>
      <AgentBriefTab
        apiClient={api as unknown as ApiClient}
        issueId="issue-1"
        issueVersion={version}
        {...(rest as object)}
      />
    </I18nProvider>
  );
}

const view = (api: ReturnType<typeof client>, props: Parameters<typeof tree>[1] = {}) =>
  render(tree(api, props));

afterEach(() => vi.restoreAllMocks());

describe('AgentBriefTab', () => {
  it('shows the loading state and then every section of the brief', async () => {
    const api = client();
    view(api);
    expect(screen.getByRole('status', { name: 'Loading agent information' })).toBeInTheDocument();
    expect(await screen.findByText('Balanced model for a medium change.')).toBeInTheDocument();
    expect(screen.getAllByText('Medium').length).toBeGreaterThan(0);
    expect(screen.getByText('Score: 6/10')).toBeInTheDocument();
    expect(screen.getByText('Touches several modules')).toBeInTheDocument();
    expect(screen.getByText('US$ 0.0421')).toBeInTheDocument();
    expect(screen.getByText(/groq\/llama/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Anthropic (Claude) · anthropic')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Claude Sonnet 5.5 (claude-sonnet-5-5)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep backwards compatibility')).toBeInTheDocument();
    expect(screen.getByDisplayValue('You are a dev.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('8000')).toBeInTheDocument();
    expect(screen.getByText(/Generated by the engine/)).toBeInTheDocument();
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.getIssueBrief).toHaveBeenCalledWith('issue-1', expect.any(AbortSignal));
  });

  it('renders in Portuguese and without the optional parts', async () => {
    const api = client({
      getIssueBrief: vi.fn().mockResolvedValue({
        ...brief,
        complexity: { score: 1, level: 'trivial', signals: [] },
        recommendation: { ...brief.recommendation, estimatedCostUsd: null, alternatives: [] },
        readFirst: [],
        considerations: [],
      }),
    });
    view(api, { locale: 'pt-BR' });
    expect(await screen.findByText('Sem tarifa configurada')).toBeInTheDocument();
    expect(screen.getByText('Trivial')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma referência sugerida.')).toBeInTheDocument();
    expect(screen.getByText('Nenhum item a considerar.')).toBeInTheDocument();
    expect(screen.queryByText('Alternativas')).not.toBeInTheDocument();
  });

  it('edits every section and saves only what changed', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    await pick('Provider', 'OpenAI');
    // The model of the previous provider is replaced by one the new provider offers.
    expect(screen.getByDisplayValue('GPT-5.1 (gpt-5.1)')).toBeInTheDocument();
    await pick('Model', /GPT-5 mini/);
    fireEvent.change(screen.getByDisplayValue('Medium'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'spec' } });
    await pick('Item 1', 'Spec A');
    fireEvent.change(screen.getByLabelText('Reason 1'), { target: { value: 'Contract' } });
    fireEvent.change(screen.getByLabelText('Item to consider 1'), { target: { value: 'Be safe' } });
    fireEvent.change(screen.getByDisplayValue('You are a dev.'), { target: { value: 'Sys' } });
    fireEvent.change(screen.getByDisplayValue('8000'), { target: { value: '9000' } });
    fireEvent.change(screen.getByDisplayValue('2000'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalledTimes(1));
    const edits = api.updateIssueBrief.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(edits).sort()).toEqual(
      ['budget', 'considerations', 'prompt', 'readFirst', 'recommendation'].sort(),
    );
    expect(edits['budget']).toEqual({ maxInputTokens: 9000, maxOutputTokens: 0 });
    expect(edits['recommendation']).toMatchObject({
      provider: 'openai',
      model: 'gpt-5-mini',
      effort: 'high',
    });
    expect(edits['readFirst']).toEqual([
      { kind: 'spec', label: 'Spec A', ref: 'spec-a', reason: 'Contract' },
    ]);
    expect(await screen.findAllByText('Edited by a human')).toHaveLength(5);
    expect(screen.getByText(/Edited ·/)).toBeInTheDocument();
  });

  it('adds and removes references and considerations', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    expect((screen.getByLabelText('Item 2') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference 1' }));
    expect((screen.getByLabelText('Item 1') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove item 1' }));
    expect((screen.getByLabelText('Item to consider 1') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalled());
  });

  it('edits one row among several and clears a token limit', async () => {
    const api = client({
      getIssueBrief: vi.fn().mockResolvedValue({
        ...brief,
        readFirst: [...brief.readFirst, { kind: 'file', label: 'b', ref: 'b', reason: 'r' }],
        considerations: ['one', 'two'],
      }),
      updateIssueBrief: vi.fn().mockRejectedValue(new Error('save failed')),
    });
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Reason 2'), { target: { value: 'changed' } });
    fireEvent.change(screen.getByLabelText('Item to consider 2'), { target: { value: 'three' } });
    fireEvent.change(screen.getByDisplayValue('8000'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('save failed');
    expect((screen.getByLabelText('Item 1') as HTMLInputElement).value).toBe('PBI 1');
    expect((screen.getByLabelText('Item to consider 1') as HTMLInputElement).value).toBe('one');
  });

  it('regenerates keeping edits and restores the engine suggestions', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(api.regenerateIssueBrief).toHaveBeenCalledWith('issue-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore engine suggestions' }));
    await waitFor(() => expect(api.regenerateIssueBrief).toHaveBeenCalledWith('issue-1', true));
  });

  it('copies the prompt and reports a clipboard failure', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    view(client());
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(await screen.findByText('Prompt copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('You are a dev.\n\nDo the work.\n\nMarkdown.');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(generic);
  });

  it('shows the empty state and generates a brief', async () => {
    const api = client({ getIssueBrief: vi.fn().mockResolvedValue(null) });
    view(api);
    expect(
      await screen.findByText('There is no agent information for this issue yet.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate now' }));
    expect(await screen.findByText('Balanced model for a medium change.')).toBeInTheDocument();
    expect(api.regenerateIssueBrief).toHaveBeenCalledWith('issue-1');
  });

  it('reports load failures, retries, and failed saves', async () => {
    const api = client({
      getIssueBrief: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(brief),
      updateIssueBrief: vi.fn().mockRejectedValue('nope'),
    });
    view(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByDisplayValue('8000'), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(generic);
  });

  it('falls back to a generic message when the load rejects without an Error', async () => {
    view(client({ getIssueBrief: vi.fn().mockRejectedValue('x') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(generic);
  });

  it('ignores a load that was aborted when the issue changes', async () => {
    let rejectFirst: (reason: unknown) => void = () => undefined;
    const getIssueBrief = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => (rejectFirst = reject as typeof rejectFirst)),
      )
      .mockResolvedValue(brief);
    const api = client({ getIssueBrief });
    const { rerender } = view(api);
    rerender(tree(api, { version: 'v2' }));
    rejectFirst(new Error('late'));
    expect(await screen.findByText('Balanced model for a medium change.')).toBeInTheDocument();
    expect(screen.queryByText('late')).not.toBeInTheDocument();
  });

  it('is read only without edit controls', async () => {
    const api = client({
      getIssueBrief: vi.fn().mockResolvedValue({ ...brief, source: 'edited' }),
    });
    view(api, { isReadOnly: true });
    await screen.findByText('Balanced model for a medium change.');
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('combobox', { name: 'Item 1' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add reference' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  it('read only empty state offers no generate button', async () => {
    view(client({ getIssueBrief: vi.fn().mockResolvedValue(null) }), { isReadOnly: true });
    await screen.findByText('There is no agent information for this issue yet.');
    expect(screen.queryByRole('button', { name: 'Generate now' })).not.toBeInTheDocument();
  });

  it('lets the user type a provider or model the lists do not know', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    // No extra input: the value is typed in the same field and picked from its list.
    const provider = screen.getByRole('combobox', { name: 'Provider' });
    fireEvent.focus(provider);
    fireEvent.change(provider, { target: { value: 'azure-openai' } });
    fireEvent.click(screen.getByRole('option', { name: 'Use “azure-openai”' }));
    expect(valueOf(screen.getByRole('combobox', { name: 'Provider' }))).toBe('azure-openai');
    // A provider typed by hand has no model list, but keeps the model already chosen.
    expect(valueOf(screen.getByRole('combobox', { name: 'Model' }))).toBe('claude-sonnet-5-5');
    const model = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.focus(model);
    fireEvent.change(model, { target: { value: 'my-model-v1' } });
    // Typing alone changes nothing until the typed value is picked.
    fireEvent.blur(model);
    fireEvent.focus(model);
    fireEvent.change(model, { target: { value: 'my-model-v1' } });
    fireEvent.click(screen.getByRole('option', { name: 'Use “my-model-v1”' }));
    expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalledTimes(1));
    expect(
      (api.updateIssueBrief.mock.calls[0]![1] as { recommendation: object }).recommendation,
    ).toMatchObject({ provider: 'azure-openai', model: 'my-model-v1' });
  });

  it('searches the workspace items of each reference type', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'issue' } });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Item 1' }));
    // The issue itself is not offered as its own reference.
    expect(await screen.findByRole('option', { name: '#2 Other issue' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '#1 This one' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Item 1' }), {
      target: { value: 'other' },
    });
    expect(listed('Item 1')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: '#2 Other issue' }));
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'brain' } });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Item 1' }));
    // Pages repeated by the source appear once.
    await screen.findByRole('option', { name: 'Approval of events' });
    expect(listed('Item 1')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'Approval of events' }));
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'testplan' } });
    await pick('Item 1', 'Plan 1');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalledTimes(1));
    expect(
      (api.updateIssueBrief.mock.calls[0]![1] as { readFirst: unknown[] }).readFirst,
    ).toMatchObject([{ kind: 'testplan', label: 'Plan 1', ref: 'plan-1' }]);
  });

  it('shows a message when a source cannot be loaded', async () => {
    const api = client({ getSpecifications: vi.fn().mockRejectedValue(new Error('down')) });
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'spec' } });
    fireEvent.focus(await screen.findByRole('combobox', { name: 'Item 1' }));
    expect(await screen.findByText('The list could not be loaded.')).toBeInTheDocument();
  });

  it('picks issue attachments and sends a new file, attaching it to the issue on save', async () => {
    const api = client();
    const existing = {
      id: 'att-0',
      name: 'old.png',
      kind: 'image',
      scope: 'issue',
      source: 'adk',
      url: '/attachments/files/att-0',
    };
    view(api, { issueAttachments: [existing] });
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'attachment' } });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Item 1' }));
    expect(screen.getByRole('option', { name: 'old.png' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'old.png' }));

    fireEvent.change(screen.getByLabelText('Attach file 1'), {
      target: { files: [new File(['x'], 'rules.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(api.uploadAttachment).toHaveBeenCalledWith('issue', expect.any(File)),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Item 1') as HTMLInputElement).value).toBe('rules.pdf · 2 KB'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalledTimes(1));
    // The file joins the attachments the issue already had, before the brief is saved.
    expect(api.updateIssue).toHaveBeenCalledWith('issue-1', {
      attachments: [existing, uploadedFile],
    });
    expect(
      (api.updateIssueBrief.mock.calls[0]![1] as { readFirst: unknown[] }).readFirst,
    ).toMatchObject([{ kind: 'attachment', ref: 'att-1', label: 'rules.pdf' }]);
  });

  it('does not attach a file that no reference uses', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'file' } });
    fireEvent.change(screen.getByLabelText('Attach file 1'), {
      target: { files: [new File(['x'], 'rules.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByLabelText('Item 1') as HTMLInputElement).value).toBe('rules.pdf · 2 KB'),
    );
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'pbi' } });
    await pick('Item 1', 'PBI 1');
    fireEvent.change(screen.getByLabelText('Reason 1'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalledTimes(1));
    expect(api.updateIssue).not.toHaveBeenCalled();
  });

  it('rejects unsupported and oversized files before sending them', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'file' } });
    fireEvent.change(screen.getByLabelText('Attach file 1'), {
      target: { files: [new File(['x'], 'tool.exe')] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('tool.exe: Unsupported file type.');
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('Attach file 1'), { target: { files: [big] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('big.pdf is over the 25 MB limit.');
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  it('reports a failed upload', async () => {
    const api = client({ uploadAttachment: vi.fn().mockRejectedValue(new Error('no')) });
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'file' } });
    fireEvent.change(screen.getByLabelText('Attach file 1'), {
      target: { files: [new File(['x'], 'rules.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The file could not be uploaded.');
  });

  it('edits the prompt one part at a time and previews what the agent receives', async () => {
    const api = client();
    view(api);
    await screen.findByText('Balanced model for a medium change.');
    expect(screen.getByRole('tab', { name: 'System instruction' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.change(field('System instruction'), { target: { value: 'Sys' } });
    expect(screen.getByRole('img', { name: 'Edited' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Task/ }));
    expect(valueOf(field('Task'))).toBe('Do the work.');
    expect(screen.getByText(/12 characters/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Output format/ }));
    expect(valueOf(field('Output format'))).toBe('Markdown.');
    fireEvent.click(screen.getByRole('tab', { name: /Preview/ }));
    expect(valueOf(field('Preview'))).toBe('Sys\n\nDo the work.\n\nMarkdown.');
    expect(field('Preview')).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('tab', { name: /System instruction/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }));
    expect(valueOf(field('System instruction'))).toBe('You are a dev.');
    expect(screen.queryByRole('img', { name: 'Edited' })).not.toBeInTheDocument();
  });

  it('warns when the prompt is larger than the input budget', async () => {
    view(client());
    await screen.findByText('Balanced model for a medium change.');
    expect(screen.queryByText(/input limit/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('8000'), { target: { value: '2' } });
    expect(screen.getByText(/input limit is 2/)).toBeInTheDocument();
  });

  it('keeps the prompt read only without edit rights but still previewable', async () => {
    view(client(), { isReadOnly: true });
    await screen.findByText('Balanced model for a medium change.');
    expect((field('System instruction') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: /Preview/ }));
    expect((field('Preview') as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Undo edit' })).not.toBeInTheDocument();
  });

  describe('opening a reference', () => {
    const withBrain = (excerpt?: string) =>
      client({
        getIssueBrief: vi.fn().mockResolvedValue({
          ...brief,
          readFirst: [
            {
              kind: 'brain',
              label: 'Approval of events',
              ref: 'page-1',
              reason: 'Matches',
              ...(excerpt === undefined ? {} : { excerpt }),
            },
          ],
        }),
        getKnowledgeDocuments: vi.fn().mockResolvedValue([
          {
            pageId: 'page-1',
            title: 'Approval of events',
            source: 'Planning',
            content:
              'Intro line.\n\nThe manager approves or rejects\nthe request.\n\nClosing line.',
          },
        ]),
      });

    it('opens the Brain page at the exact passage that was attached', async () => {
      const api = withBrain('The manager approves or rejects the request.');
      view(api);
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText('Approval of events', { selector: 'h2' }),
      ).toBeInTheDocument();
      // The passage is found even though the page broke the line differently.
      const passage = within(dialog).getByLabelText('Referenced passage');
      expect(passage.tagName).toBe('MARK');
      expect(passage.textContent).toBe('The manager approves or rejects\nthe request.');
      expect(dialog.textContent).toContain('Intro line.');
      expect(dialog.textContent).toContain('Closing line.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('says so when the attached passage is no longer in the page', async () => {
      view(withBrain('Text that was deleted from the page'));
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByLabelText('Referenced passage')).not.toBeInTheDocument();
      expect(dialog.textContent).toContain('Text that was deleted from the page');
      expect(dialog.textContent).toContain('the page may have changed');
      expect(dialog.textContent).toContain('Closing line.');
    });

    it('opens the page from its top when no passage was attached', async () => {
      view(withBrain());
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('Intro line.');
      expect(within(dialog).queryByLabelText('Referenced passage')).not.toBeInTheDocument();
    });

    it('goes to the module of the reference', async () => {
      const onOpenModule = vi.fn();
      render(
        <I18nProvider initialLocale="en-US">
          <AgentBriefTab
            apiClient={withBrain() as unknown as ApiClient}
            issueId="issue-1"
            issueVersion="v1"
            onOpenModule={onOpenModule}
          />
        </I18nProvider>,
      );
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Open in module' }));
      expect(onOpenModule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'brain', ref: 'page-1', label: 'Approval of events' }),
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows the text of a PBI without its markup, and says when the item is gone', async () => {
      const api = client({
        getPbiItems: vi.fn().mockResolvedValue([
          {
            id: 'pbi-1',
            title: 'PBI 1',
            kind: 'feature',
            status: 'active',
            description: '<p>Scope <b>text</b></p>',
          },
        ]),
      });
      view(api);
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
      let dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('feature · active');
      expect(dialog.textContent).toContain('Scope text');
      expect(dialog.querySelector('b')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

      fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'spec' } });
      await pick('Item 1', 'Spec A');
      fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
      dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('Spec A');
    });

    it('reports a source that failed to load', async () => {
      const api = client({ getPbiItems: vi.fn().mockRejectedValue(new Error('down')) });
      view(api);
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The content could not be loaded.',
      );
    });

    it('cannot open an empty reference, and drops the passage when another item is picked', async () => {
      const api = withBrain('The manager approves or rejects the request.');
      view(api);
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      expect((screen.getByRole('button', { name: 'Open 2' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Remove reference 2' }));
      fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'spec' } });
      await pick('Item 1', 'Spec A');
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalledTimes(1));
      const [reference] = (api.updateIssueBrief.mock.calls[0]![1] as { readFirst: object[] })
        .readFirst;
      expect(reference).not.toHaveProperty('excerpt');
    });

    it('keeps the passage when only the reason is edited', async () => {
      const api = withBrain('The manager approves or rejects the request.');
      view(api);
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.change(screen.getByLabelText('Reason 1'), { target: { value: 'Rules' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(api.updateIssueBrief).toHaveBeenCalledTimes(1));
      expect(
        (api.updateIssueBrief.mock.calls[0]![1] as { readFirst: unknown[] }).readFirst,
      ).toMatchObject([{ excerpt: 'The manager approves or rejects the request.' }]);
    });

    it('opens an attached file in a new tab, and an external one at its address', async () => {
      const opened = { opener: {}, location: { href: '' }, close: vi.fn() };
      const open = vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);
      const stored = {
        id: 'att-0',
        name: 'rules.pdf',
        kind: 'document',
        scope: 'issue',
        source: 'adk',
        url: '/attachments/files/att-0',
      };
      const external = {
        id: 'att-9',
        name: 'spec.pdf',
        kind: 'document',
        scope: 'issue',
        source: 'url',
        url: 'https://files.example.com/spec.pdf',
      };
      const getMedia = vi.fn().mockResolvedValue(new Blob(['x']));
      const api = client({
        getIssueBrief: vi.fn().mockResolvedValue({
          ...brief,
          readFirst: [
            { kind: 'attachment', label: 'rules.pdf', ref: 'att-0', reason: 'r' },
            { kind: 'file', label: 'spec.pdf', ref: 'att-9', reason: 'r' },
          ],
        }),
        getMedia,
      });
      view(api, { issueAttachments: [stored, external] });
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open the file 1' }));
      await waitFor(() => expect(opened.location.href).toContain('blob:'));
      expect(opened.opener).toBeNull();
      expect(getMedia).toHaveBeenCalledWith('/attachments/files/att-0');
      fireEvent.click(screen.getByRole('button', { name: 'Open the file 2' }));
      expect(open).toHaveBeenLastCalledWith(
        'https://files.example.com/spec.pdf',
        '_blank',
        'noopener,noreferrer',
      );
    });

    it('closes the blank tab and reports a file that cannot be opened', async () => {
      const opened = { opener: {}, location: { href: '' }, close: vi.fn() };
      vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);
      const stored = {
        id: 'att-0',
        name: 'rules.pdf',
        kind: 'document',
        scope: 'issue',
        source: 'adk',
        url: '/attachments/files/att-0',
      };
      const api = client({
        getIssueBrief: vi.fn().mockResolvedValue({
          ...brief,
          readFirst: [{ kind: 'attachment', label: 'rules.pdf', ref: 'att-0', reason: 'r' }],
        }),
        getMedia: vi.fn().mockRejectedValue(new Error('gone')),
      });
      view(api, { issueAttachments: [stored] });
      await screen.findByText('Balanced model for a medium change.');
      fireEvent.click(screen.getByRole('button', { name: 'Open the file 1' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The file could not be opened.');
      expect(opened.close).toHaveBeenCalled();
    });
  });
});
