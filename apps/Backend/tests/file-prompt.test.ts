import { describe, expect, it } from 'vitest';
import type { LlmFile, LlmPort } from '../src/modules/agents/application/agent-ports.js';
import { documentsFor, inlineTextFiles } from '../src/modules/agents/application/file-prompt.js';

const text = (name: string, content: string, mimeType = 'text/plain'): LlmFile => ({
  name,
  mimeType,
  data: Buffer.from(content).toString('base64'),
});
const pdf: LlmFile = { name: 'spec.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' };
const llm = (readsFiles?: boolean) => ({ provider: 'x', readsFiles }) as unknown as LlmPort;

describe('inlineTextFiles', () => {
  it('writes text files after the text, and leaves the rest of the files alone', () => {
    const result = inlineTextFiles('Question', [text('a.txt', 'alpha'), pdf]);
    expect(result).toBe('Question\n\nAttached file "a.txt":\n```\nalpha\n```');
    expect(inlineTextFiles('Question', [pdf])).toBe('Question');
    expect(inlineTextFiles('Question', [])).toBe('Question');
  });

  it('fences a file that holds backticks with a longer fence, and cuts a very long one', () => {
    const fenced = inlineTextFiles('Q', [text('a.md', 'x\n```js\ny\n```', 'text/markdown')]);
    expect(fenced).toContain('````\nx\n```js\ny\n```\n````');
    const cut = inlineTextFiles('Q', [text('big.txt', 'a'.repeat(400_001))]);
    expect(cut).toContain('[cut: file too long]');
  });

  it('shows a name on one line, without quotes that could end it', () => {
    expect(inlineTextFiles('Q', [text('a"\nb.txt', 'x')])).toContain('Attached file "a  b.txt":');
    expect(inlineTextFiles('Q', [text('', 'x')])).toContain('Attached file "file 1":');
  });
});

describe('documentsFor', () => {
  it('hands PDFs to a provider that reads files', () => {
    expect(documentsFor([text('a.txt', 'x'), pdf], llm(true))).toEqual({ send: [pdf], note: '' });
  });

  it('keeps them from one that does not, and says so', () => {
    const none = documentsFor([text('a.txt', 'x'), pdf, pdf], llm(false));
    expect(none.send).toEqual([]);
    expect(none.note).toContain('2 attached document(s) could not be read');
    expect(documentsFor([text('a.txt', 'x')], llm())).toEqual({ send: [], note: '' });
  });
});
