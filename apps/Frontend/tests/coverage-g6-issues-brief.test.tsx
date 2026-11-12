import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { AgentBriefTab } from '../src/features/issues/AgentBriefTab.js';
import type { IssueAgentBrief } from '../src/features/issues/agent-brief-types.js';
import { ReferenceViewer } from '../src/features/issues/agent-brief-reference-viewer.js';
import { openReferencedFile } from '../src/features/issues/agent-brief-reference-open.js';
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
    alternatives: [],
  },
  readFirst: [{ kind: 'pbi', label: 'PBI 1', ref: 'pbi-1', reason: 'Parent scope' }],
  considerations: ['Keep backwards compatibility'],
  prompt: { system: 'You are a dev.', task: 'Do the work.', outputFormat: 'Markdown.' },
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    getIssueBrief: vi.fn().mockResolvedValue(brief),
    updateIssueBrief: vi.fn(),
    regenerateIssueBrief: vi.fn().mockResolvedValue(brief),
    getPbiItems: vi.fn().mockResolvedValue([{ id: 'pbi-1', title: 'PBI 1' }]),
    getIssues: vi.fn().mockResolvedValue([
      { id: 'issue-1', number: 1, title: 'This one' },
      {
        id: 'issue-2',
        number: 2,
        title: 'Other issue',
        status: 'todo',
        description: '<p>Issue <b>text</b></p>',
      },
    ]),
    getKnowledgeDocuments: vi.fn().mockResolvedValue([]),
    getSpecifications: vi.fn().mockResolvedValue([]),
    getAllSavedTestPlans: vi.fn().mockResolvedValue([
      {
        id: 'plan-1',
        title: 'Plan 1',
        plans: [{ title: 'Login', description: '<p>Happy path</p>', steps: [{}, {}] }],
      },
    ]),
    uploadAttachment: vi.fn(),
    updateIssue: vi.fn(),
    ...overrides,
  };
}

function view(
  api: ReturnType<typeof client>,
  props: { locale?: 'pt-BR' | 'en-US'; issueAttachments?: unknown[] } = {},
) {
  const { locale = 'en-US', ...rest } = props;
  return render(
    <I18nProvider initialLocale={locale}>
      <AgentBriefTab
        apiClient={api as unknown as ApiClient}
        issueId="issue-1"
        issueVersion="v1"
        {...(rest as object)}
      />
    </I18nProvider>,
  );
}

const ready = () => screen.findByText('Balanced model for a medium change.');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent brief references: viewing sources', () => {
  it('opens an issue and a test plan with the text they hold', async () => {
    view(client());
    await ready();
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'issue' } });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Item 1' }));
    fireEvent.click(await screen.findByRole('option', { name: '#2 Other issue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('todo');
    expect(dialog.textContent).toContain('Issue text');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'testplan' } });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Item 1' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Plan 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
    dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Login');
    expect(dialog.textContent).toContain('Happy path');
  });

  it('says the item is gone when the source no longer lists it', async () => {
    const api = client({
      getIssueBrief: vi.fn().mockResolvedValue({
        ...brief,
        readFirst: [{ kind: 'issue', label: '', ref: 'issue-9', reason: 'Gone' }],
      }),
    });
    view(api);
    await ready();
    // A saved reference stays visible by its id even without a label.
    expect((screen.getByLabelText('Item 1') as HTMLInputElement).value).toBe('issue-9');
    fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/no longer exists/)).toBeInTheDocument();
  });

  it('shows a loading state while the source loads', async () => {
    let release: (items: unknown[]) => void = () => undefined;
    const api = client({
      getPbiItems: vi.fn().mockReturnValue(new Promise((resolve) => (release = resolve))),
    });
    view(api);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading the content…');
    release([]);
    expect(await within(dialog).findByText(/no longer exists/)).toBeInTheDocument();
  });
});

describe('agent brief references: files and uploads', () => {
  it('ignores an empty file selection', async () => {
    const api = client();
    view(api);
    await ready();
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'file' } });
    fireEvent.change(screen.getByLabelText('Attach file 1'), { target: { files: [] } });
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stops at the attachment limit', async () => {
    const api = client();
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      id: `att-${index}`,
      name: `f${index}.pdf`,
      kind: 'document',
      scope: 'issue',
      source: 'adk',
      url: `/attachments/files/att-${index}`,
    }));
    view(api, { issueAttachments: attachments });
    await ready();
    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'file' } });
    fireEvent.change(screen.getByLabelText('Attach file 1'), {
      target: { files: [new File(['x'], 'one-more.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Up to 20 attachments');
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  it('explains the size limit and the custom provider in Portuguese', async () => {
    const api = client();
    view(api, { locale: 'pt-BR' });
    await screen.findByText('Balanced model for a medium change.');
    fireEvent.change(screen.getByLabelText('Tipo 1'), { target: { value: 'file' } });
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('Anexar arquivo 1'), { target: { files: [big] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('big.pdf passa do limite de 25 MB.');

    const provider = screen.getAllByRole('combobox')[0]!;
    fireEvent.focus(provider);
    fireEvent.change(provider, { target: { value: 'acme-ai' } });
    expect(await screen.findByRole('option', { name: 'Usar “acme-ai”' })).toBeInTheDocument();
  });
});

describe('ReferenceViewer', () => {
  const reference = { kind: 'brain', label: 'Page', ref: 'p', reason: 'r' } as const;
  const show = (
    props: Partial<Parameters<typeof ReferenceViewer>[0]>,
    locale: 'pt-BR' | 'en-US' = 'en-US',
  ) =>
    render(
      <I18nProvider initialLocale={locale}>
        <ReferenceViewer
          reference={reference}
          detail={undefined}
          status="ready"
          onClose={() => undefined}
          {...props}
        />
      </I18nProvider>,
    );

  it('shows the label while loading and a failure message on error', () => {
    const loading = show({ status: 'loading' });
    expect(screen.getByRole('heading', { name: 'Page' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the content…');
    loading.unmount();
    show({ status: 'error' }, 'pt-BR');
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar o conteúdo.');
  });

  it('says when a ready item has no text, and when it is missing', () => {
    const empty = show({ detail: { title: 'Page', subtitle: 'Planning', body: '' } });
    expect(screen.getByText('No content.')).toBeInTheDocument();
    expect(screen.getByText(/Planning/)).toBeInTheDocument();
    empty.unmount();
    show({ detail: undefined });
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
  });

  it('scrolls the highlighted passage into view when the browser can', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    });
    try {
      show({
        reference: { ...reference, excerpt: 'second line' },
        detail: { title: 'Page', body: 'first line\nsecond line\nthird line' },
      });
      expect(screen.getByLabelText('Referenced passage').textContent).toBe('second line');
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('treats a blank passage as no passage', () => {
    show({
      reference: { ...reference, excerpt: '   ' },
      detail: { title: 'Page', body: 'Body text' },
    });
    expect(screen.queryByLabelText('Referenced passage')).not.toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
  });
});

describe('openReferencedFile', () => {
  const file = {
    id: 'att-0',
    name: 'rules.pdf',
    scope: 'issue',
    source: 'adk',
    url: '/attachments/files/att-0',
  } as const;

  it('downloads the file when the browser blocks the new tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const apiClient = { getMedia: vi.fn().mockResolvedValue(new Blob(['x'])) };
    await openReferencedFile(apiClient as unknown as ApiClient, file);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('passes the failure on when there is no tab to close', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const apiClient = { getMedia: vi.fn().mockRejectedValue(new Error('gone')) };
    await expect(
      openReferencedFile(apiClient as unknown as ApiClient, {
        ...file,
        url: '/attachments/files/att-failing',
      }),
    ).rejects.toThrow('gone');
  });
});

describe('provider labels', () => {
  it('falls back to the id for a catalog provider without a label', async () => {
    vi.resetModules();
    vi.doMock('../src/features/connect/llm-model-catalog.js', () => ({
      llmModelCatalog: { acme: { models: [] } },
      getLlmModelCatalog: () => undefined,
    }));
    const { providerChoices } = await import('../src/features/issues/agent-brief-models.js');
    expect(providerChoices()).toEqual([{ value: 'acme', label: 'acme' }]);
    vi.doUnmock('../src/features/connect/llm-model-catalog.js');
    vi.resetModules();
  });
});
