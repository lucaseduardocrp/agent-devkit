import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderInlineContent } from '../src/features/brain/markdown-parser.js';

describe('renderInlineContent images', () => {
  it('shows the alt text instead of an image served over plain http', () => {
    const { container } = render(
      <p>{renderInlineContent('Veja ![Diagrama](http://example.com/a.png) aqui')}</p>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('Veja Diagrama aqui');
  });

  it('keeps a malformed image reference as written', () => {
    const { container } = render(<p>{renderInlineContent('Antes ![Logo]( ) depois')}</p>);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('Antes ![Logo]( ) depois');
  });
});

describe('renderInlineContent safe images', () => {
  it('renders an https image with its alt text, ignoring a title and size', () => {
    const { getByRole } = render(
      <p>{renderInlineContent('![Fluxo](https://example.com/f.png "Fluxo" =500x)')}</p>,
    );
    expect(getByRole('img', { name: 'Fluxo' })).toHaveAttribute('src', 'https://example.com/f.png');
  });
});
