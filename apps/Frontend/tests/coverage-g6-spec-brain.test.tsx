import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrainView } from '../src/features/brain/BrainView.js';
import { SpecView } from '../src/features/spec/SpecView.js';
import { SpecWorkflowAction } from '../src/features/spec/SpecWorkflowAction.js';
import { MediaProvider } from '../src/features/shared/media.js';
import { parseMarkdownBlocks, renderInlineContent } from '../src/features/brain/markdown-parser.js';
import { ApiClient, type SpecTemplateDto, type SpecificationDto } from '../src/lib/api-client.js';

const template: SpecTemplateDto = {
  id: 't1',
  workspaceId: 'w1',
  name: 'Base',
  sections: [{ id: 'objective', title: 'Objetivo', required: true }],
  createdAt: '',
  updatedAt: '',
};

const spec = (id: string, title: string): SpecificationDto => ({
  id,
  workspaceId: 'w1',
  title,
  sections: [],
  messages: [],
  createdAt: '',
  updatedAt: '',
});

function client(specs: SpecificationDto[] = []) {
  const api = new ApiClient();
  vi.spyOn(api, 'getSpecTemplates').mockResolvedValue([template]);
  vi.spyOn(api, 'getSpecifications').mockResolvedValue(specs);
  vi.spyOn(api, 'getAgents').mockResolvedValue([]);
  return api;
}

describe('SpecView', () => {
  it('deletes the only template and falls back to the default one', async () => {
    const api = client();
    vi.spyOn(api, 'deleteSpecTemplate').mockResolvedValue();
    const view = render(<SpecView apiClient={api} activeWorkspaceId="w1" />);
    await view.findByRole('heading', { name: 'Nova especificação' });
    const picker = (await view.findByLabelText('Template')) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 't1' } });
    expect(picker.value).toBe('t1');
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir template' }));
    fireEvent.click(within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }));
    expect(await view.findByText('Template excluído com sucesso.')).toBeInTheDocument();
    expect((view.getByLabelText('Nome do template') as HTMLInputElement).value).toBe(
      'Template padrão',
    );
  });

  it('moves to the next template when the selected one is deleted', async () => {
    const api = client();
    vi.spyOn(api, 'getSpecTemplates').mockResolvedValue([
      template,
      { ...template, id: 't2', name: 'Release' },
    ]);
    vi.spyOn(api, 'deleteSpecTemplate').mockResolvedValue();
    const view = render(<SpecView apiClient={api} activeWorkspaceId="w1" />);
    await view.findByRole('heading', { name: 'Nova especificação' });
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir template' }));
    fireEvent.click(within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }));
    expect(await view.findByText('Template excluído com sucesso.')).toBeInTheDocument();
    expect((view.getByLabelText('Nome do template') as HTMLInputElement).value).toBe('Release');
  });

  it('opens the specification another module sent the user to, once', async () => {
    const api = client([spec('s1', 'Login'), spec('s2', 'Checkout')]);
    const onFocusHandled = vi.fn();
    const view = render(
      <SpecView
        apiClient={api}
        activeWorkspaceId="w1"
        focus={{ kind: 'brain', ref: 's2', nonce: 1 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    await view.findByRole('button', { name: 'Checkout' });
    expect(onFocusHandled).not.toHaveBeenCalled();
    view.rerender(
      <SpecView
        apiClient={api}
        activeWorkspaceId="w1"
        focus={{ kind: 'spec', ref: 'missing', nonce: 2 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(onFocusHandled).not.toHaveBeenCalled();
    view.rerender(
      <SpecView
        apiClient={api}
        activeWorkspaceId="w1"
        focus={{ kind: 'spec', ref: 's2', nonce: 3 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
  });

  it('opens it without a handler to tell', async () => {
    const api = client([spec('s1', 'Login')]);
    render(
      <SpecView
        apiClient={api}
        activeWorkspaceId="w1"
        focus={{ kind: 'spec', ref: 's1', nonce: 1 }}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Nova especificação' })).toBeNull(),
    );
  });

  it('attaches a file by URL while editing a new specification', async () => {
    const api = client();
    render(
      <MediaProvider apiClient={api}>
        <SpecView apiClient={api} activeWorkspaceId="w1" />
      </MediaProvider>,
    );
    await screen.findByRole('heading', { name: 'Nova especificação' });
    fireEvent.change(screen.getByLabelText('URL do arquivo'), {
      target: { value: 'https://files.example.com/brief.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
  });
});

describe('SpecWorkflowAction notifications', () => {
  it('dismisses the notification', async () => {
    const api = new ApiClient();
    vi.spyOn(api, 'clearSpecificationMessages').mockRejectedValue(new Error('offline'));
    const view = render(
      <SpecWorkflowAction
        apiClient={api}
        spec={spec('s', 'Generated')}
        action="clear"
        disabled={false}
        onCleared={() => undefined}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Limpar contexto' }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar' }),
    );
    expect(await view.findByRole('alert')).toHaveTextContent('offline');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar notificação' }));
    expect(view.queryByRole('alert')).toBeNull();
  });
});

describe('markdown parser', () => {
  it('shows an image without an address as plain text', () => {
    render(<p>{renderInlineContent('![chart]( )')}</p>);
    expect(screen.getByText('![chart]( )')).toBeInTheDocument();
  });

  it('ends a doctype block that has no html element to close', () => {
    expect(parseMarkdownBlocks('<!doctype html>\nline\n\nAfter')).toHaveLength(2);
  });

  it('renders safe images and falls back to text for unsafe ones', () => {
    render(
      <MediaProvider apiClient={new ApiClient()}>
        <p>
          {renderInlineContent('![chart](https://files.example.com/a.png) ![bad](javascript:x)')}
        </p>
      </MediaProvider>,
    );
    expect(screen.getByText('bad')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'chart' })).toBeInTheDocument();
  });
});

describe('BrainView attachments, files and focus', () => {
  const doc = {
    id: 'app://local?title=Alpha:a',
    pageId: 'a',
    source: 'app://local?title=Alpha',
    title: 'Alpha',
    content: '# Alpha\n\nThe passage to find.\n\nMore.',
    chunksCount: 1,
    totalCharacters: 10,
    updatedAt: 'now',
    isCustom: true,
  };
  const other = { ...doc, id: 'app://local?title=Beta:b', pageId: 'b', title: 'Beta' };

  function brain() {
    const api = new ApiClient();
    vi.spyOn(api, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 2, chunksCount: 2 });
    vi.spyOn(api, 'getKnowledgeDocuments').mockResolvedValue([doc, other]);
    vi.spyOn(api, 'getKnowledgeRelations').mockResolvedValue([]);
    vi.spyOn(api, 'getAgents').mockResolvedValue([]);
    vi.spyOn(api, 'getDocumentAttachments').mockResolvedValue([]);
    return api;
  }

  it('saves attachments and places an attached image in the text', async () => {
    const api = brain();
    vi.spyOn(api, 'updateKnowledgeDocument').mockResolvedValue(doc);
    vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
      id: 'up-1',
      name: 'shot.png',
      kind: 'image',
      scope: 'brain',
      source: 'adk',
      url: '/attachments/files/0f8fad5b-d9cb-469f-a165-70867728950e',
    });
    const saveAttachments = vi.spyOn(api, 'saveDocumentAttachments').mockResolvedValue([]);
    const view = render(
      <MediaProvider apiClient={api}>
        <BrainView apiClient={api} initialDocuments={[doc, other]} />
      </MediaProvider>,
    );
    fireEvent.click(await view.findByTestId(`tree-item-${doc.id}`));
    fireEvent.click(await view.findByTestId('btn-edit-document'));
    const panel = screen.getByRole('region', { name: 'Anexos' });
    fireEvent.change(panel.querySelector('input[type="file"]')!, {
      target: { files: [new File(['p'], 'shot.png', { type: 'image/png' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Inserir no texto: shot.png' }));
    fireEvent.change(view.getByTestId('textarea-document-content'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inserir no texto: shot.png' }));
    expect((view.getByTestId('textarea-document-content') as HTMLTextAreaElement).value).toContain(
      '![shot.png](',
    );
    fireEvent.click(view.getByTestId('btn-save-document'));
    await waitFor(() => expect(saveAttachments).toHaveBeenCalledWith('a', expect.any(Array)));
  });

  it('inserts images chosen with the file picker into the editor', async () => {
    const api = brain();
    const view = render(
      <MediaProvider apiClient={api}>
        <BrainView apiClient={api} initialDocuments={[doc, other]} />
      </MediaProvider>,
    );
    fireEvent.click(await view.findByTestId(`tree-item-${doc.id}`));
    fireEvent.click(await view.findByTestId('btn-edit-document'));
    const picker = view.getByTestId('input-document-image');
    fireEvent.change(picker, {
      target: { files: [new File(['p'], 'chosen.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(
        (view.getByTestId('textarea-document-content') as HTMLTextAreaElement).value,
      ).toContain('![chosen.png]('),
    );
  });

  it('opens the page another module sent the user to, highlighting its passage', async () => {
    const api = brain();
    const onFocusHandled = vi.fn();
    const view = render(
      <BrainView
        apiClient={api}
        initialDocuments={[doc, other]}
        focus={{ kind: 'brain', ref: 'a', excerpt: 'The passage to find.', nonce: 1 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.body.innerHTML).toContain('passage'));
    view.rerender(
      <BrainView
        apiClient={api}
        initialDocuments={[doc, other]}
        focus={{ kind: 'brain', ref: 'missing', nonce: 2 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    view.rerender(
      <BrainView
        apiClient={api}
        initialDocuments={[doc, other]}
        focus={{ kind: 'brain', ref: 'b', nonce: 3 }}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('tab-active-doc').length).toBe(2));
  });

  it('keeps looking for a passage that is not on the page, then gives up', async () => {
    const api = brain();
    let frames = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames++;
      return setTimeout(() => callback(0), 0) as unknown as number;
    });
    render(
      <BrainView
        apiClient={api}
        initialDocuments={[doc, other]}
        focus={{ kind: 'brain', ref: 'a', excerpt: 'Text that is nowhere', nonce: 1 }}
      />,
    );
    await waitFor(() => expect(frames).toBeGreaterThan(30));
    vi.unstubAllGlobals();
  });

  it('ignores attachments that arrive after the document was closed', async () => {
    const api = brain();
    let release: (items: never[]) => void = () => undefined;
    vi.spyOn(api, 'getDocumentAttachments').mockReturnValue(
      new Promise((resolve) => (release = resolve)),
    );
    const view = render(<BrainView apiClient={api} initialDocuments={[doc, other]} />);
    fireEvent.click(await view.findByTestId(`tree-item-${doc.id}`));
    fireEvent.click(await view.findByTestId(`tree-item-${other.id}`));
    release([]);
    await waitFor(() => expect(api.getDocumentAttachments).toHaveBeenCalled());
  });
});
