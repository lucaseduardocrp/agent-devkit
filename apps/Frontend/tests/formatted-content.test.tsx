import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  FormattedContent,
  parseInlineTokens,
  renderInlineTokens,
  parseScenarioBlocks,
  decodeHtmlEntities,
} from '../src/components/ui/formatted-content.js';

describe('FormattedContent', () => {
  it('returns null when content is empty or null', () => {
    const { container: c1 } = render(<FormattedContent content="" />);
    expect(c1.innerHTML).toBe('');

    const { container: c2 } = render(<FormattedContent content={null} />);
    expect(c2.innerHTML).toBe('');

    const { container: c3 } = render(<FormattedContent />);
    expect(c3.innerHTML).toBe('');
  });

  it('renders inline content with line breaks, HTML tags and markdown', () => {
    const content =
      'Ação <b>negrito</b> e <i>itálico</i> com <u>sublinhado</u> e <code>código</code><br>Segunda linha com `code` e **bold** e *italic* e [link](https://example.com)';

    const { getByTestId, getByText } = render(
      <FormattedContent content={content} inline data-testid="inline-content" />,
    );

    const container = getByTestId('inline-content');
    expect(container).toBeInTheDocument();
    expect(getByText('negrito').tagName).toBe('STRONG');
    expect(getByText('itálico').tagName).toBe('EM');
    expect(getByText('sublinhado').tagName).toBe('U');
    expect(getByText('código').tagName).toBe('CODE');
    expect(getByText('code').tagName).toBe('CODE');
    expect(getByText('bold').tagName).toBe('STRONG');
    expect(getByText('italic').tagName).toBe('EM');

    const link = getByText('link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('renders rich scenario blocks with headings, lists, paragraphs and diagrams', () => {
    const scenario = `<b>## Caso de uso</b><br>Validar o recálculo de folga.<br><br><b>## Pré-condições</b><br>- Colaborador logado com <b>Gestor</b>.<br>* Possui folga aprovada.<br><br><b>## Dados de entrada</b><br>Evento de trabalho na data D.<br><br><b>## Resultado esperado</b><br>Folga marcada como <code>Convertida</code>.<br><br><b>## Pós-condições</b><br>Sistema atualizado.<br><br><b>## Fluxo do Processo</b><br>┌───────────────────┐<br>│ Etapa 1           │<br>└─────────┬─────────┘<br>          ▼<br>┌─────────┴─────────┐<br>│ Etapa 2           │<br>└───────────────────┘`;

    const { getByTestId, getByText } = render(
      <FormattedContent content={scenario} data-testid="test-scenario" />,
    );

    expect(getByTestId('test-scenario')).toBeInTheDocument();
    expect(getByTestId('heading-caso-de-uso')).toHaveTextContent('Caso de uso');
    expect(getByTestId('heading-pré-condições')).toHaveTextContent('Pré-condições');
    expect(getByTestId('heading-dados-de-entrada')).toHaveTextContent('Dados de entrada');
    expect(getByTestId('heading-resultado-esperado')).toHaveTextContent('Resultado esperado');
    expect(getByTestId('heading-pós-condições')).toHaveTextContent('Pós-condições');
    expect(getByTestId('heading-fluxo-do-processo')).toHaveTextContent('Fluxo do Processo');

    expect(getByText('Validar o recálculo de folga.')).toBeInTheDocument();
    expect(getByText('Gestor').tagName).toBe('STRONG');
    expect(getByText('Convertida').tagName).toBe('CODE');

    const diagram = getByTestId('flowchart-diagram');
    expect(diagram).toBeInTheDocument();
    expect(diagram).toHaveTextContent('Etapa 1');
    expect(diagram).toHaveTextContent('Etapa 2');
    expect(diagram.querySelector('pre')).toBeInTheDocument();
  });

  it('handles markdown ATX headings, generic headings and unformatted links', () => {
    const text = '## Seção Genérica\nLinha com link quebrado [invalido e texto final.';
    const { getByTestId, getByText } = render(<FormattedContent content={text} />);

    expect(getByTestId('heading-seção-genérica')).toHaveTextContent('Seção Genérica');
    expect(getByText(/Linha com link quebrado/)).toBeInTheDocument();
  });

  it('covers parseInlineTokens and renderInlineTokens directly', () => {
    const tokens = parseInlineTokens('<strong>bold</strong><em>italic</em>[bad link](');
    expect(tokens.length).toBeGreaterThan(0);
    const nodes = renderInlineTokens(tokens);
    expect(nodes.length).toBe(tokens.length);
  });

  it('covers parseScenarioBlocks with empty lines, diagram flushing and edge cases', () => {
    const raw =
      'Linha inicial\n\n┌─┐\n│ │\n└─┘\n<b>Dados de entrada:</b>\n<strong>Apenas um destaque normal</strong>\nLinha final';
    const blocks = parseScenarioBlocks(raw);
    expect(blocks.some((b) => b.type === 'diagram')).toBe(true);
    expect(blocks.some((b) => b.type === 'empty')).toBe(true);
    expect(blocks.some((b) => b.type === 'heading')).toBe(true);
    expect(blocks.some((b) => b.type === 'paragraph')).toBe(true);
  });
});

describe('test case description template', () => {
  it('decodes escaped entities without turning them into markup', () => {
    expect(
      decodeHtmlEntities('A &amp; B &lt;b&gt; &quot;x&quot; &apos;y&apos;&nbsp;&#9660; &bogus;'),
    ).toBe('A & B <b> "x" \'y\' ▼ &bogus;');
    const tokens = parseInlineTokens('&lt;b&gt;not bold&lt;/b&gt; <b>## Caso de uso</b>');
    expect(tokens).toEqual([
      { type: 'text', content: '<b>not bold</b> ' },
      { type: 'bold', content: '## Caso de uso' },
    ]);
  });

  it('renders the default description template with bold headings and the flow', () => {
    const { container } = render(
      <FormattedContent content="<b>## Caso de uso</b><br>Status &amp; Certificação<br><br><b>## Fluxo do Processo</b><br>┌──┐<br>│▼" />,
    );
    expect(container.textContent).toContain('Status & Certificação');
    expect(container.textContent).toContain('┌──┐');
    expect(container.textContent).toContain('Caso de uso');
    expect(container.textContent).toContain('Fluxo do Processo');
  });
});
