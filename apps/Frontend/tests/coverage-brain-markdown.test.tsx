import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownViewer } from '../src/features/brain/MarkdownViewer.js';
import { parseMarkdownBlocks } from '../src/features/brain/markdown-parser.js';
import { RenderedCode } from '../src/features/brain/RenderedCode.js';
import { CreateSpecFromDocument } from '../src/features/brain/CreateSpecFromDocument.js';
import { ApiClient, type SpecificationDto } from '../src/lib/api-client.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MarkdownViewer export file names', () => {
  const exportWith = async (documentTitle?: string) => {
    const created: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      created.push(this);
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const view = render(<MarkdownViewer content="body" documentTitle={documentTitle} />);
    await act(async () => {
      fireEvent.click(view.getByTestId('btn-export-markdown'));
    });
    view.unmount();
    return created[0]?.download;
  };

  it('keeps an existing .md extension and falls back to a default name', async () => {
    expect(await exportWith('Notes: v1.MD')).toBe('Notes- v1.MD');
    expect(await exportWith(undefined)).toBe('documento.md');
  });

  it('stays in the idle state when the download cannot be prepared', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('blocked');
    });
    const view = render(<MarkdownViewer content="body" documentTitle="Doc" />);
    const button = view.getByTestId('btn-export-markdown');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toContain('Exportar .md');
  });
});

describe('markdown parser edge cases', () => {
  it('treats a closing HTML block tag as a self-contained HTML block', () => {
    expect(parseMarkdownBlocks('</div>\n\nText')).toEqual([
      { type: 'html', html: '</div>' },
      { type: 'paragraph', text: 'Text' },
    ]);
  });

  it('parses unterminated and empty mermaid directives', () => {
    expect(parseMarkdownBlocks('::: mermaid\n  flowchart LR\n    A-->B')).toEqual([
      { type: 'code', language: 'mermaid', code: 'flowchart LR\n  A-->B' },
    ]);
    expect(parseMarkdownBlocks(':::mermaid\n:::\nAfter')).toEqual([
      { type: 'paragraph', text: 'After' },
    ]);
  });
});

describe('RenderedCode language normalization', () => {
  it('uses the first word of the info string and falls back to plain text for blanks', () => {
    const { container, rerender } = render(<RenderedCode language="TS title=x" code="let a" />);
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('let');
    rerender(<RenderedCode language="" code="plain" />);
    expect(container.querySelector('code')?.className).toBe('');
    expect(container.textContent).toBe('plain');
  });
});

describe('CreateSpecFromDocument notification', () => {
  it('dismisses the generated Spec notification', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([
      { id: 'writer', name: 'Writer' } as CustomAgentDto,
    ]);
    vi.spyOn(client, 'createSpecificationFromKnowledge').mockResolvedValue({
      id: 's',
      title: 'Generated',
    } as SpecificationDto);
    render(
      <CreateSpecFromDocument
        apiClient={client}
        document={{
          id: 'd',
          pageId: 'd',
          source: 'wiki',
          title: 'Source',
          chunksCount: 1,
          totalCharacters: 1,
          updatedAt: '',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Criar Spec com Agent' }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Generated');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar notificação' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
