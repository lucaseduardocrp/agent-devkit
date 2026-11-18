import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPdfText } from '../src/lib/pdf-text.js';

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}));

vi.mock('pdfjs-dist', () => mocks);
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.js' }));

/** jsdom's File cannot be read as bytes. */
const pdfFile = (name: string) =>
  ({ name, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as File;

function pdf(pages: readonly (readonly unknown[])[]) {
  const destroy = vi.fn().mockResolvedValue(undefined);
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: pages.length,
      getPage: async (number: number) => ({
        getTextContent: async () => ({ items: pages[number - 1] }),
      }),
      destroy,
    }),
  });
  return destroy;
}

describe('extractPdfText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('joins the text of each page, keeping line breaks and skipping empty pages', async () => {
    const destroy = pdf([
      [
        { str: 'Login', hasEOL: false },
        { str: 'com e-mail', hasEOL: true },
        { str: 'e senha', hasEOL: false },
        { type: 'beginMarkedContent' },
      ],
      [{ str: '   ', hasEOL: false }],
      [{ str: 'Logout', hasEOL: false }],
    ]);
    const text = await extractPdfText(pdfFile('spec.pdf'));
    expect(text).toBe('Login com e-mail\ne senha\n\nLogout');
    expect(mocks.GlobalWorkerOptions.workerSrc).toBe('/pdf.worker.js');
    expect(mocks.getDocument).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
    expect(destroy).toHaveBeenCalled();
  });

  it('releases the document when a page cannot be read', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => {
          throw new Error('broken');
        },
        destroy,
      }),
    });
    await expect(extractPdfText(pdfFile('bad.pdf'))).rejects.toThrow('broken');
    expect(destroy).toHaveBeenCalled();
  });
});
