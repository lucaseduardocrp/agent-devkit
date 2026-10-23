import { render, fireEvent, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownViewer } from '../src/features/brain/MarkdownViewer.js';
import { parseMarkdownBlocks, renderInlineContent } from '../src/features/brain/markdown-parser.js';

describe('MarkdownViewer & markdown utilities', () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
  });

  describe('renderInlineContent', () => {
    it('does not make unsafe Markdown links clickable', () => {
      const { container } = render(
        <div>
          {renderInlineContent('[click](javascript:alert(1)) [safe](https://example.com)')}
        </div>,
      );
      expect(container.querySelectorAll('a')).toHaveLength(1);
      expect(container.querySelector('a')?.textContent).toBe('safe');
      expect(container.textContent).toContain('click');
    });
    it('parses inline code, bold, italic, bold-italic, strikethrough, links and wikilinks', () => {
      const sample =
        'Here is `code`, ***triple star*** and ___triple under___, plus **double star** and __double under__, with *single star* and _single under_, ~~strike~~, [Docs](https://docs.org), [incomplete, [[Vault|My Vault]] and [[SoloWiki]]. Trailing text.';

      const result = renderInlineContent(sample, undefined, (target) => `Link interno: ${target}`);
      const { container } = render(<div>{result}</div>);

      expect(container.querySelector('code')?.textContent).toBe('code');
      expect(container.querySelector('strong em')?.textContent).toBe('triple star');
      expect(container.querySelectorAll('strong em')[1]?.textContent).toBe('triple under');
      expect(container.querySelectorAll('strong')[2]?.textContent).toBe('double star');
      expect(container.querySelectorAll('strong')[3]?.textContent).toBe('double under');
      expect(container.querySelector('em')?.textContent).toBe('triple star');
      expect(container.querySelector('del')?.textContent).toBe('strike');

      const link = container.querySelector('a');
      expect(link?.getAttribute('href')).toBe('https://docs.org');
      expect(link?.textContent).toBe('Docs');

      const wikilinks = container.querySelectorAll('span[title^="Link interno:"]');
      expect(wikilinks[0]?.textContent).toBe('My Vault');
      expect(wikilinks[1]?.textContent).toBe('SoloWiki');
      expect(container.textContent).toContain('[incomplete');
      expect(container.textContent).toContain('Trailing text.');
    });

    it('renders wikilinks as accessible internal buttons when navigation is available', () => {
      const onWikilinkClick = vi.fn();
      render(<div>{renderInlineContent('Open [[Target|the document]]', onWikilinkClick)}</div>);

      fireEvent.click(screen.getByRole('button', { name: 'the document' }));
      expect(onWikilinkClick).toHaveBeenCalledWith('Target');
    });
  });

  describe('parseMarkdownBlocks', () => {
    it('parses Mermaid directive blocks as renderable Mermaid diagrams', () => {
      const blocks = parseMarkdownBlocks(`::: mermaid flowchart LR
    OCP[OCP]
    REPORTS[Acme Reports]
    OCP --> REPORTS
:::`);

      expect(blocks).toEqual([
        {
          type: 'code',
          language: 'mermaid',
          code: 'flowchart LR\nOCP[OCP]\nREPORTS[Acme Reports]\nOCP --> REPORTS',
        },
      ]);
    });

    it('keeps a "#" column header inside a table row', () => {
      const blocks = parseMarkdownBlocks(
        '| # | Eventos | Resultado |\n|---|---|---|\n| 1 | DT 01–05 | não sobrepõe |',
      );
      expect(blocks).toEqual([
        {
          type: 'table',
          headers: ['#', 'Eventos', 'Resultado'],
          alignments: ['left', 'left', 'left'],
          rows: [['1', 'DT 01–05', 'não sobrepõe']],
        },
      ]);
    });

    it('restores headings in flattened descriptions without changing fenced code', () => {
      const blocks = parseMarkdownBlocks(
        '## Goal Text. ## References More text.\n```md\n## stays in code\n```',
      );
      expect(blocks.filter((block) => block.type === 'heading')).toHaveLength(2);
      expect(blocks.find((block) => block.type === 'code')).toMatchObject({
        code: '## stays in code',
      });
    });
    it('handles orphaned pipe lines and hashtags without freezing', () => {
      const input = `
| orphaned pipe row without separator |
#hashtag without space
| another | pipe |
`;
      const blocks = parseMarkdownBlocks(input);
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('handles multi-line paragraphs containing pipe lines without table separators', () => {
      const input = `Paragraph start
| fake table row 1 |
| fake table row 2 |
Paragraph end`;
      const blocks = parseMarkdownBlocks(input);
      expect(blocks.length).toBe(1);
      expect(blocks[0]?.type).toBe('paragraph');
    });

    it('handles real-world wiki chunks with inline headers and tables without freezing', () => {
      const input = `Visão Geral As gratificações no **«Git Hub de RH»** representam adicionais financeiros concedidos a colaboradores por condições especiais de trabalho, como insalubridade, periculosidade, trabalho noturno, sobreaviso ativo, entre outras. ## Tipos de Gratificação | Código | Tipo | Descrição | |---|---|---| | GRT-01 | Insalubridade | Trabalho em ambiente com agentes nocivos à saúde | | GRT-02 | Periculosidade | Exposição...`;
      const blocks = parseMarkdownBlocks(input);
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('parses horizontal rules with spaces (* * *, - - -, _ _ _) as hr and not list items', () => {
      const input = `
Section One

* * *

Section Two

- - -

Section Three

_ _ _
`;
      const blocks = parseMarkdownBlocks(input);
      const hrBlocks = blocks.filter((b) => b.type === 'hr');
      expect(hrBlocks).toHaveLength(3);
      const listBlocks = blocks.filter((b) => b.type === 'list');
      expect(listBlocks).toHaveLength(0);
    });

    it('groups loose list items separated by empty lines into a single list block', () => {
      const input = `
*   Item 1

*   Item 2

*   Item 3
`;
      const blocks = parseMarkdownBlocks(input);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('list');
      if (blocks[0]?.type === 'list') {
        expect(blocks[0].items).toHaveLength(3);
        expect(blocks[0].items[0]?.text).toBe('Item 1');
        expect(blocks[0].items[1]?.text).toBe('Item 2');
        expect(blocks[0].items[2]?.text).toBe('Item 3');
      }
    });

    it('separates unordered and ordered lists even without blank lines between them', () => {
      const input = `- Unordered item\n1. Ordered item`;
      const blocks = parseMarkdownBlocks(input);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.type).toBe('list');
      expect((blocks[0] as { ordered: boolean }).ordered).toBe(false);
      expect(blocks[1]?.type).toBe('list');
      expect((blocks[1] as { ordered: boolean }).ordered).toBe(true);
    });

    it('parses all supported block types accurately', () => {
      const md = `
# Title Level 1
Setext Level 1
==============
Setext Level 2
--------------
### Subheading 3
#### Subheading 4
##### Subheading 5
###### Subheading 6

\`\`\`typescript
const x: number = 42;
\`\`\`

\`\`\`
raw code without lang
\`\`\`

---
***
___

> Quote line 1
> Quote line 2

| Col Left | Col Center | Col Right |
| :--- | :---: | ---: |
| L1 | C1 | R1 |
| L2 | C2 | R2 |

- [ ] Task pending
- [x] Task done
- [X] Task uppercase done
  - Subtask item

1. Ordered step 1
2. Ordered step 2

Regular paragraph line one.
Regular paragraph line two continuation.
`;

      const blocks = parseMarkdownBlocks(md);

      expect(blocks.some((b) => b.type === 'heading' && b.level === 1)).toBe(true);
      expect(
        blocks.some((b) => b.type === 'heading' && b.level === 1 && b.text === 'Setext Level 1'),
      ).toBe(true);
      expect(
        blocks.some((b) => b.type === 'heading' && b.level === 2 && b.text === 'Setext Level 2'),
      ).toBe(true);
      expect(blocks.some((b) => b.type === 'heading' && b.level === 3)).toBe(true);
      expect(blocks.some((b) => b.type === 'heading' && b.level === 4)).toBe(true);
      expect(blocks.some((b) => b.type === 'heading' && b.level === 5)).toBe(true);
      expect(blocks.some((b) => b.type === 'heading' && b.level === 6)).toBe(true);
      expect(
        blocks.some(
          (b) => b.type === 'code' && b.language === 'typescript' && b.code.includes('42'),
        ),
      ).toBe(true);
      expect(
        blocks.some((b) => b.type === 'code' && b.language === '' && b.code.includes('raw code')),
      ).toBe(true);
      expect(blocks.filter((b) => b.type === 'hr').length).toBe(3);
      expect(
        blocks.some(
          (b) => b.type === 'blockquote' && b.text.includes('Quote line 1\nQuote line 2'),
        ),
      ).toBe(true);

      const table = blocks.find((b) => b.type === 'table');
      expect(table).toBeDefined();
      if (table && table.type === 'table') {
        expect(table.headers).toEqual(['Col Left', 'Col Center', 'Col Right']);
        expect(table.alignments).toEqual(['left', 'center', 'right']);
        expect(table.rows.length).toBe(2);
      }

      const list = blocks.find((b) => b.type === 'list' && !b.ordered);
      expect(list).toBeDefined();
      if (list && list.type === 'list') {
        expect(list.items[0]?.checked).toBe(false);
        expect(list.items[1]?.checked).toBe(true);
        expect(list.items[2]?.checked).toBe(true);
        expect(list.items[3]?.indent).toBe(2);
      }

      const orderedList = blocks.find((b) => b.type === 'list' && b.ordered);
      expect(orderedList).toBeDefined();

      const para = blocks.find((b) => b.type === 'paragraph');
      expect(para).toBeDefined();
      if (para && para.type === 'paragraph') {
        expect(para.text).toBe(
          'Regular paragraph line one. Regular paragraph line two continuation.',
        );
      }
    });

    it('handles unclosed code block gracefully at EOF', () => {
      const unclosed = '```python\nprint("hello")';
      const blocks = parseMarkdownBlocks(unclosed);
      expect(blocks.length).toBe(1);
      expect(blocks[0]?.type).toBe('code');
    });
  });

  describe('MarkdownViewer Component', () => {
    it('renders preview mode and allows toggling to raw .md mode', () => {
      const content = '# Main Title\n\nParagraph text.\n\n```ts\nconst test = true;\n```';
      const { getByTestId, queryByTestId } = render(<MarkdownViewer content={content} />);

      expect(getByTestId('markdown-preview-view')).toBeInTheDocument();
      expect(queryByTestId('markdown-raw-view')).not.toBeInTheDocument();

      // Switch to Raw mode
      fireEvent.click(getByTestId('btn-markdown-raw'));
      expect(getByTestId('markdown-raw-view')).toBeInTheDocument();
      expect(queryByTestId('markdown-preview-view')).not.toBeInTheDocument();

      // Switch back to preview
      fireEvent.click(getByTestId('btn-markdown-preview'));
      expect(getByTestId('markdown-preview-view')).toBeInTheDocument();
    });

    it('renders all markdown block types correctly in preview mode', () => {
      const fullDoc = `
# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

---

> Blockquote line 1
> Blockquote line 2

| Name | Role | Status |
| :--- | :---: | ---: |
| Alice | Admin | Active |
| Bob | User | Inactive |

- Regular item 1
- [ ] Todo item
- [x] Done item

1. Step one
2. Step two

\`\`\`
plain code without language
\`\`\`

A normal text paragraph here.
`;
      const { getByTestId, getByText, getByRole } = render(<MarkdownViewer content={fullDoc} />);

      expect(getByRole('heading', { level: 1 })).toHaveTextContent('Heading 1');
      expect(getByRole('heading', { level: 2 })).toHaveTextContent('Heading 2');
      expect(getByRole('heading', { level: 3 })).toHaveTextContent('Heading 3');
      expect(getByRole('heading', { level: 4 })).toHaveTextContent('Heading 4');
      expect(getByRole('heading', { level: 5 })).toHaveTextContent('Heading 5');
      expect(getByRole('heading', { level: 6 })).toHaveTextContent('Heading 6');
      expect(getByText('Blockquote line 1')).toBeInTheDocument();
      expect(getByText('Alice')).toBeInTheDocument();
      expect(getByText('Regular item 1')).toBeInTheDocument();
      expect(getByText('Todo item')).toBeInTheDocument();
      expect(getByText('Done item')).toBeInTheDocument();
      expect(getByText('Step one')).toBeInTheDocument();
      expect(getByText('A normal text paragraph here.')).toBeInTheDocument();
      expect(getByTestId('markdown-preview-view').querySelector('hr')).toBeInTheDocument();
    });

    it('hides toolbar when showModeToggle is false', () => {
      const { queryByTestId, getByTestId } = render(
        <MarkdownViewer content="# Heading" showModeToggle={false} />,
      );
      expect(queryByTestId('btn-markdown-preview')).not.toBeInTheDocument();
      expect(getByTestId('markdown-preview-view')).toBeInTheDocument();
    });

    it('exports raw markdown file on export click and resets state after timeout', async () => {
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      const { getByTestId } = render(
        <MarkdownViewer content="# Export me" documentTitle="Meu Documento" />,
      );
      const exportBtn = getByTestId('btn-export-markdown');

      await act(async () => {
        fireEvent.click(exportBtn);
      });

      expect(createObjectURLSpy).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url');
      expect(exportBtn.textContent).toContain('Exportado!');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(exportBtn.textContent).toContain('Exportar .md');

      clickSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });

    it('renders "Abrir fonte" button beside export when sourceUrl is provided', () => {
      const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const { getByTestId } = render(
        <MarkdownViewer content="# With source" sourceUrl="https://example.com/wiki" />,
      );
      const openSourceBtn = getByTestId('btn-open-source');
      expect(openSourceBtn).toBeInTheDocument();
      expect(openSourceBtn.textContent).toContain('Abrir fonte');

      fireEvent.click(openSourceBtn);
      expect(windowOpenSpy).toHaveBeenCalledWith(
        'https://example.com/wiki',
        '_blank',
        'noopener,noreferrer',
      );
      windowOpenSpy.mockRestore();
    });

    it('copies code snippet from code block and resets after timeout', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        writable: true,
        configurable: true,
      });

      const content = '```js\nconsole.log(123);\n```';
      render(<MarkdownViewer content={content} />);

      const copySnippetBtn = screen.getByTitle('Copiar trecho de código');
      await act(async () => {
        fireEvent.click(copySnippetBtn);
      });

      expect(writeTextMock).toHaveBeenCalledWith('console.log(123);');
      expect(copySnippetBtn.textContent).toContain('Copiado');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(copySnippetBtn.textContent).toContain('Copiar');
    });

    it('handles code snippet copy error gracefully', async () => {
      const writeTextMock = vi.fn().mockRejectedValue(new Error('Copy error'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        writable: true,
        configurable: true,
      });

      const content = '```js\nconsole.log(123);\n```';
      render(<MarkdownViewer content={content} />);

      const copySnippetBtn = screen.getByTitle('Copiar trecho de código');
      await act(async () => {
        fireEvent.click(copySnippetBtn);
      });

      expect(writeTextMock).toHaveBeenCalled();
      expect(copySnippetBtn.textContent).toContain('Copiar');
    });

    it('renders mermaid code blocks and indented diagrams with specialized headers', () => {
      const md = `
\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`

    Pendente
          │
          ▼
    Em Treinamento
`;

      render(<MarkdownViewer content={md} />);

      expect(screen.getByText('mermaid')).toBeDefined();
      expect(screen.getByText('diagrama / fluxo')).toBeDefined();
      expect(screen.getByText(/Pendente/)).toBeDefined();
      expect(screen.getByText(/Em Treinamento/)).toBeDefined();
    });

    it('parses indented code blocks preserving empty lines between indented items', () => {
      const md = '    Line 1\n\n    Line 2';
      const blocks = parseMarkdownBlocks(md);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('code');
      expect((blocks[0] as { code: string }).code).toBe('Line 1\n\nLine 2');
    });

    it('parses tab-indented code blocks with empty lines correctly', () => {
      const md = '\tTab line 1\n\n\tTab line 2';
      const blocks = parseMarkdownBlocks(md);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('code');
      expect((blocks[0] as { code: string }).code).toBe('Tab line 1\n\nTab line 2');
    });

    it('parses tab-indented code blocks correctly', () => {
      const md = '\tTab line 1\n\tTab line 2';
      const blocks = parseMarkdownBlocks(md);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('code');
      expect((blocks[0] as { code: string }).code).toBe('Tab line 1\nTab line 2');
    });

    it('filters out redundant leading H1 matching documentTitle in preview mode while keeping it in raw mode', () => {
      const content = '# Teste Batatinha\n\nEste é o corpo do documento.';
      render(
        <MarkdownViewer content={content} documentTitle="Teste Batatinha" showModeToggle={true} />,
      );

      // In preview mode, the H1 "Teste Batatinha" should NOT be rendered in markdown-preview-view
      const preview = screen.getByTestId('markdown-preview-view');
      expect(preview.querySelector('h1')).toBeNull();
      expect(screen.getByText('Este é o corpo do documento.')).toBeDefined();

      // Switch to raw mode
      fireEvent.click(screen.getByTestId('btn-markdown-raw'));
      const raw = screen.getByTestId('markdown-raw-view');
      expect(raw.textContent).toContain('# Teste Batatinha');
    });

    it('shows fallback message when content contains only the leading H1 matching documentTitle', () => {
      const content = '# Teste Batatinha';
      render(<MarkdownViewer content={content} documentTitle="Teste Batatinha" />);

      expect(screen.getByText('Sem conteúdo adicional.')).toBeDefined();
    });

    it('preserves leading H1 when documentTitle does not match', () => {
      const content = '# Outro Titulo\n\nCorpo';
      render(<MarkdownViewer content={content} documentTitle="Teste Batatinha" />);

      const preview = screen.getByTestId('markdown-preview-view');
      expect(preview.querySelector('h1')?.textContent).toBe('Outro Titulo');
    });

    it('returns null and does not render block when code block is empty or whitespace', () => {
      const content = '```typescript\n   \n```';
      const { queryByTestId } = render(<MarkdownViewer content={content} />);
      expect(queryByTestId('code-block-header')).toBeNull();
    });
  });

  describe('rich formats', () => {
    it('parses raw HTML blocks, keeping elements together across blank lines', () => {
      const blocks = parseMarkdownBlocks(
        [
          'Intro',
          '<table>',
          '<tr><td>A</td></tr>',
          '',
          '<tr><td>B</td></tr>',
          '</table>',
          '',
          '<!-- note',
          '',
          'still comment -->',
          '',
          '<!DOCTYPE html>',
          '<html><body><p>Doc</p></body></html>',
          '',
          '</div>',
          '<hr>',
          '',
          '<span>inline</span> text',
        ].join('\n'),
      );
      expect(blocks.map((block) => block.type)).toEqual([
        'paragraph',
        'html',
        'html',
        'html',
        'html',
        'paragraph',
      ]);
      expect(blocks[1]).toEqual({
        type: 'html',
        html: '<table>\n<tr><td>A</td></tr>\n\n<tr><td>B</td></tr>\n</table>',
      });
      expect(blocks[2]).toEqual({ type: 'html', html: '<!-- note\n\nstill comment -->' });
    });

    it('renders a raw JSON payload as a formatted JSON code block', () => {
      expect(parseMarkdownBlocks('{"a":1,"b":[true]}')).toEqual([
        { type: 'code', language: 'json', code: '{\n  "a": 1,\n  "b": [\n    true\n  ]\n}' },
      ]);
      expect(parseMarkdownBlocks('[link](https://x.dev)')[0]?.type).toBe('paragraph');
      expect(parseMarkdownBlocks('plain')[0]?.type).toBe('paragraph');
    });

    it('renders sanitized HTML blocks and inline HTML mixed with Markdown', () => {
      const content = [
        '<div onclick="x()"><h2>Título</h2><script>alert(1)</script><p>Corpo</p></div>',
        '',
        'Texto <b>negrito</b> com **markdown** e `<i>literal</i>`',
        '',
        '```mmd',
        'flowchart TD',
        '```',
      ].join('\n');
      const { container } = render(<MarkdownViewer content={content} showModeToggle={false} />);
      const htmlBlock = screen.getByTestId('html-block-0');
      expect(htmlBlock.querySelector('h2')?.textContent).toBe('Título');
      expect(htmlBlock.querySelector('script')).toBeNull();
      expect(htmlBlock.querySelector('[onclick]')).toBeNull();
      expect(screen.getByText('negrito').tagName).toBe('B');
      expect(screen.getByText('markdown').tagName).toBe('STRONG');
      expect(container.querySelector('p code')?.textContent).toBe('<i>literal</i>');
      expect(screen.getByText('mermaid')).toBeDefined();
    });
  });
});
