/**
 * Reads the text of a PDF in the browser, page by page. The PDF library is loaded on the
 * first use, so the screens that never read one do not pay for it.
 */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    .promise;
  const pages: string[] = [];
  try {
    for (let number = 1; number <= document.numPages; number++) {
      const content = await (await document.getPage(number)).getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
      if (text) pages.push(text);
    }
  } finally {
    await document.destroy();
  }
  return pages.join('\n\n');
}
