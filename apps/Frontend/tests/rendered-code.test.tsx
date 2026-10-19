import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { MermaidDiagram, RenderedCode } from '../src/features/brain/RenderedCode.js';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn() },
}));

describe('RenderedCode', () => {
  it('highlights known languages and DBML while escaping unknown code', () => {
    const { rerender, container } = render(
      <RenderedCode language="typescript" code="const count = 1;" />,
    );
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const');

    rerender(<RenderedCode language="dbdiagram" code="Table users { id int [pk] }" />);
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('Table');

    rerender(<RenderedCode language="unknown" code={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('<script>alert(1)</script>');
  });
});

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.mocked(mermaid.render).mockReset();
  });

  it('renders a safe image from diagram SVG', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg></svg>' } as Awaited<
      ReturnType<typeof mermaid.render>
    >);
    render(<MermaidDiagram code="flowchart TD\nA-->B" />);
    const image = await screen.findByRole('img', { name: 'Mermaid diagram' });
    expect(image.getAttribute('src')).toContain('data:image/svg+xml');
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict' }),
    );
  });

  it('keeps the diagram hidden if parsing fails', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Invalid diagram'));
    render(<MermaidDiagram code="invalid" />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull();
  });
});
