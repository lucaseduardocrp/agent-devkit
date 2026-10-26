import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import mermaid from 'mermaid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainGraph } from '../src/features/brain/BrainGraph.js';
import { BrainPushModal } from '../src/features/brain/BrainPushModal.js';
import { BrainView } from '../src/features/brain/BrainView.js';
import { MermaidDiagram } from '../src/features/brain/RenderedCode.js';
import {
  IntegrationConfigModal,
  type IntegrationCardItem,
} from '../src/features/connect/IntegrationConfigModal.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import {
  ApiClient,
  type KnowledgeDocumentDto,
  type KnowledgePushDestinationDto,
  type KnowledgeRelationDto,
} from '../src/lib/api-client.js';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const doc = (pageId: string, title: string, extra: Partial<KnowledgeDocumentDto> = {}) => ({
  id: `app://local?title=${title}:${pageId}`,
  pageId,
  source: `app://local?title=${title}`,
  title,
  content: `# ${title}`,
  chunksCount: 1,
  totalCharacters: 10,
  updatedAt: 'now',
  isCustom: true,
  ...extra,
});

function createClient(documents: readonly KnowledgeDocumentDto[]) {
  const client = new ApiClient();
  vi.spyOn(client, 'getKnowledgeStats').mockResolvedValue({
    documentsCount: documents.length,
    chunksCount: documents.length,
  });
  vi.spyOn(client, 'getKnowledgeDocuments').mockResolvedValue([...documents]);
  vi.spyOn(client, 'getKnowledgeRelations').mockResolvedValue([]);
  vi.spyOn(client, 'getAgents').mockResolvedValue([]);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrainView hierarchy', () => {
  it('collapses documents whose parents point at each other without looping', async () => {
    const first = doc('a', 'Alpha', { parentPageId: 'b' });
    const second = doc('b', 'Beta', { parentPageId: 'a' });
    const view = render(
      <BrainView apiClient={createClient([first, second])} initialDocuments={[first, second]} />,
    );
    const toggles = await view.findAllByTestId(`tree-toggle-${first.id}`);
    fireEvent.click(toggles[0]!);
    expect(view.getAllByTestId(`tree-toggle-${first.id}`)[0]).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(view.getAllByTestId(`tree-item-${first.id}`).length).toBeGreaterThan(0);
  });
});

describe('BrainView late responses', () => {
  it('ignores agents and relations that arrive after leaving the Brain', async () => {
    const client = createClient([]);
    const agents = deferred<CustomAgentDto[]>();
    const relations = deferred<KnowledgeRelationDto[]>();
    vi.mocked(client.getAgents).mockReturnValue(agents.promise);
    vi.mocked(client.getKnowledgeRelations).mockReturnValue(relations.promise);
    const view = render(<BrainView apiClient={client} initialDocuments={[]} />);
    await waitFor(() => expect(client.getKnowledgeRelations).toHaveBeenCalled());
    view.unmount();
    await act(async () => {
      agents.resolve([]);
      relations.resolve([]);
      await Promise.all([agents.promise, relations.promise]);
    });
    expect(client.getAgents).toHaveBeenCalled();
  });
});

describe('BrainView publishing and editing', () => {
  it('keeps the active tab when the push publishes a different document', async () => {
    const alpha = doc('a', 'Alpha');
    const client = createClient([alpha]);
    vi.spyOn(client, 'getKnowledgePushProviders').mockResolvedValue([
      { providerId: 'azure_devops_wiki', name: 'Azure DevOps Wiki', settings: {} },
    ]);
    vi.spyOn(client, 'getKnowledgePushDestinations').mockResolvedValue([]);
    const push = vi.spyOn(client, 'pushKnowledgeDocument').mockResolvedValue({
      success: true,
      remoteUrl: 'https://wiki/alpha',
      published: [{ oldId: 'unrelated', newId: 'other', remoteUrl: 'https://wiki/other' }],
    });
    const view = render(<BrainView apiClient={client} initialDocuments={[alpha]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${alpha.id}`));
    fireEvent.click(view.getByTestId('btn-push-document'));
    const dialog = await view.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Azure DevOps Wiki' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fazer push' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    expect(view.getByTestId('tab-active-doc')).toHaveTextContent('Alpha');
  });

  it('keeps wikilink suggestions open on other keys and saves a document from another tab', async () => {
    const alpha = doc('a', 'Alpha');
    const beta = doc('b', 'Beta');
    const client = createClient([alpha, beta]);
    const update = vi
      .spyOn(client, 'updateKnowledgeDocument')
      .mockResolvedValue({ ...beta, title: 'Beta 2' });
    const view = render(<BrainView apiClient={client} initialDocuments={[alpha, beta]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${alpha.id}`));
    fireEvent.click(view.getByTestId(`tree-item-${beta.id}`));
    fireEvent.click(view.getByTestId('btn-edit-document'));

    const editor = view.getByTestId('textarea-document-content');
    fireEvent.change(editor, { target: { value: '[[', selectionStart: 2 } });
    expect(view.getByRole('listbox', { name: 'Documentos para correlacionar' })).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'a' });
    expect(view.getByRole('listbox', { name: 'Documentos para correlacionar' })).toBeTruthy();

    const alphaTab = view
      .getAllByTestId('tab-active-doc')
      .find((tab) => tab.textContent?.includes('Alpha'))!;
    fireEvent.click(alphaTab);
    fireEvent.click(view.getByTestId('btn-save-document'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('b', 'Beta', '[['));
    expect((await view.findAllByText(/Beta 2/)).length).toBeGreaterThan(0);
    expect(view.getByTestId(`tree-item-${alpha.id}`)).toBeInTheDocument();
  });
});

describe('BrainGraph without a canvas context', () => {
  it('renders the graph shell when the browser cannot provide a 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const view = render(
      <BrainGraph
        documents={[doc('a', 'Alpha')]}
        onOpenDocument={vi.fn()}
        onOpenWelcome={vi.fn()}
      />,
    );
    expect(view.getByTestId('graph-canvas')).toBeInTheDocument();
  });
});

describe('BrainPushModal late destinations', () => {
  it.each([
    ['resolved', (d: ReturnType<typeof deferred<KnowledgePushDestinationDto[]>>) => d.resolve([])],
    ['rejected', (d: ReturnType<typeof deferred<KnowledgePushDestinationDto[]>>) => d.reject('x')],
  ])('ignores destinations %s after closing', async (_label, settle) => {
    const client = new ApiClient();
    vi.spyOn(client, 'getKnowledgePushProviders').mockResolvedValue([
      { providerId: 'trello', name: 'Trello', settings: {} },
    ]);
    const destinations = deferred<KnowledgePushDestinationDto[]>();
    const getDestinations = vi
      .spyOn(client, 'getKnowledgePushDestinations')
      .mockReturnValue(destinations.promise);
    const alpha = doc('a', 'Alpha');
    const view = render(
      <BrainPushModal
        apiClient={client}
        document={alpha}
        documents={[alpha]}
        pushing={false}
        onClose={vi.fn()}
        onPush={vi.fn()}
      />,
    );
    await waitFor(() => expect(getDestinations).toHaveBeenCalledWith('trello'));
    view.unmount();
    await act(async () => {
      settle(destinations);
      await destinations.promise.catch(() => undefined);
    });
  });
});

describe('MermaidDiagram after unmount', () => {
  it('drops a diagram that finishes rendering after the code block is gone', async () => {
    const rendered = deferred<{ svg: string }>();
    vi.mocked(mermaid.render).mockReturnValue(
      rendered.promise as unknown as ReturnType<typeof mermaid.render>,
    );
    const view = render(<MermaidDiagram code="flowchart TD\nA-->B" />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    view.unmount();
    await act(async () => {
      rendered.resolve({ svg: '<svg></svg>' });
      await rendered.promise;
    });
  });
});

describe('IntegrationConfigModal keyboard', () => {
  it('does not close on Escape while it is hidden', () => {
    const item: IntegrationCardItem = {
      id: 'azure',
      providerId: 'azure_devops_wiki',
      category: 'KNOWLEDGE',
      name: 'Azure DevOps',
      desc: 'Wikis',
      icon: 'ti-brand-azure',
      iconBg: 'var(--bg-accent)',
      iconColor: 'var(--text-accent)',
      status: 'connected',
    };
    const onClose = vi.fn();
    render(
      <IntegrationConfigModal
        isOpen={false}
        onClose={onClose}
        integration={item}
        onSaveSuccess={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
