import { describe, expect, it, vi } from 'vitest';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  attachmentContentKey,
  attachmentMetaKey,
  type Attachment,
  type AttachmentKind,
  type StoredAttachmentMeta,
} from '../src/modules/shared/attachment.js';
import {
  inlineFileAttachments,
  isReadableDocumentType,
  loadDocumentAttachments,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
  MAX_EXTERNAL_DOCUMENTS,
} from '../src/modules/shared/document-attachment.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PDF = Buffer.from('%PDF-1.4 body');
const NOTES = Buffer.from('# Rules\n- one');

async function put(
  store: InMemoryE2eArtifactStore,
  n: number,
  name: string,
  mimeType: string,
  bytes: Buffer,
  kind: AttachmentKind = 'document',
  size = bytes.length,
) {
  const meta: StoredAttachmentMeta = {
    id: id(n),
    name,
    kind,
    mimeType,
    size,
    scope: 'issue',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await store.put(attachmentMetaKey('ws', id(n), kind), Buffer.from(JSON.stringify(meta)));
  await store.put(attachmentContentKey('ws', id(n), kind), bytes);
}

const attachment = (n: number, extra: Partial<Attachment> = {}): Attachment => ({
  id: id(n),
  name: `file ${n}`,
  kind: 'document',
  scope: 'issue',
  source: 'adk',
  url: `/attachments/files/${id(n)}`,
  ...extra,
});

describe('isReadableDocumentType', () => {
  it('takes PDFs and text, and nothing a model cannot read', () => {
    for (const type of ['application/pdf', 'text/plain', 'text/csv', 'application/json'])
      expect(isReadableDocumentType(type)).toBe(true);
    for (const type of [
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'video/mp4',
      'image/png',
      'text/unknown',
      undefined,
    ])
      expect(isReadableDocumentType(type)).toBe(false);
  });
});

describe('inlineFileAttachments', () => {
  it('finds the files linked in Markdown and HTML, and leaves images alone', () => {
    const found = inlineFileAttachments(
      [
        `See [the spec](/attachments/files/${id(1)}) and [again](</attachments/files/${id(2)}> "t").`,
        `![shot](/attachments/files/${id(3)})`,
        `<a class="x" href="/attachments/files/${id(4).toUpperCase()}">Plan <b>B</b></a>`,
      ].join('\n'),
      'pbi',
    );
    expect(found.map((item) => [item.id, item.name, item.scope, item.kind])).toEqual([
      [id(1), 'the spec', 'pbi', 'document'],
      [id(2), 'again', 'pbi', 'document'],
      [id(4), 'Plan B', 'pbi', 'document'],
    ]);
    expect(found[0]).toMatchObject({ source: 'adk', url: `/attachments/files/${id(1)}` });
  });

  it('finds the https links elsewhere, and ignores the ones that cannot be fetched safely', () => {
    const found = inlineFileAttachments(
      [
        '[Spec](https://docs.example.com/spec.pdf) and <a href="https://x.example.com/a?b=1&amp;c=2">Notes</a>',
        '[plain http](http://example.com/a.pdf) [login](https://user:pw@example.com/a.pdf)',
        '[mail](mailto:a@b.c) [relative](/docs/a.pdf) ![shot](https://example.com/shot.png)',
      ].join('\n'),
      'issue',
    );
    expect(found.map((item) => [item.name, item.source, item.url])).toEqual([
      ['Spec', 'url', 'https://docs.example.com/spec.pdf'],
      ['Notes', 'url', 'https://x.example.com/a?b=1&c=2'],
    ]);
    expect(found[0]).toMatchObject({ id: 'inline:https://docs.example.com/spec.pdf' });
  });

  it('names a link without text, and finds nothing in plain words', () => {
    expect(inlineFileAttachments(`[](/attachments/files/${id(1)})`, 'e2e')[0]!.name).toBe(
      'Linked file',
    );
    expect(inlineFileAttachments('nothing here', 'e2e')).toEqual([]);
  });
});

describe('loadDocumentAttachments', () => {
  it('reads PDFs and text files from the store, as base64 with the stored name', async () => {
    const store = new InMemoryE2eArtifactStore();
    await put(store, 1, 'spec.pdf', 'application/pdf', PDF);
    await put(store, 2, 'notes.md', 'text/markdown', NOTES);
    const files = await loadDocumentAttachments(store, 'ws', [attachment(1), attachment(2)]);
    expect(files).toEqual([
      { name: 'spec.pdf', mimeType: 'application/pdf', data: PDF.toString('base64') },
      { name: 'notes.md', mimeType: 'text/markdown', data: NOTES.toString('base64') },
    ]);
  });

  it('does nothing without a store, and counts a file once however often it is listed', async () => {
    expect(await loadDocumentAttachments(undefined, 'ws', [attachment(1)])).toEqual([]);
    const store = new InMemoryE2eArtifactStore();
    await put(store, 1, 'spec.pdf', 'application/pdf', PDF);
    expect(await loadDocumentAttachments(store, 'ws', [attachment(1), attachment(1)])).toHaveLength(
      1,
    );
  });

  it('leaves out what is not a document of the ADK, or that no model reads', async () => {
    const store = new InMemoryE2eArtifactStore();
    await put(store, 1, 'a.zip', 'application/zip', Buffer.from('PK\u0003\u0004zip'));
    await put(
      store,
      2,
      'shot.png',
      'image/png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      'image',
    );
    await put(store, 3, 'spec.pdf', 'application/pdf', PDF);
    const files = await loadDocumentAttachments(store, 'ws', [
      attachment(1),
      attachment(2, { kind: 'image' }),
      // Old entries have no kind (they are images); links to another host are not fetched.
      attachment(3, { kind: undefined }),
      attachment(3, { id: id(9), source: 'url' }),
      attachment(404),
    ]);
    expect(files).toEqual([]);
  });

  it('refuses a file whose content is not what it says, or that is too big', async () => {
    const store = new InMemoryE2eArtifactStore();
    await put(store, 1, 'fake.pdf', 'application/pdf', Buffer.from('<html>not a pdf</html>'));
    await put(store, 2, 'big.pdf', 'application/pdf', PDF, 'document', MAX_DOCUMENT_BYTES + 1);
    await put(store, 3, 'huge.txt', 'text/plain', Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 97));
    await put(store, 4, 'ok.txt', 'text/plain', Buffer.from('fine'));
    const files = await loadDocumentAttachments(store, 'ws', [
      attachment(1),
      attachment(2),
      attachment(3),
      attachment(4),
    ]);
    expect(files.map((file) => file.name)).toEqual(['ok.txt']);
  });

  it('keeps to a few documents, and to a total weight', async () => {
    const store = new InMemoryE2eArtifactStore();
    for (let n = 1; n <= MAX_DOCUMENTS + 2; n += 1)
      await put(store, n, `n${n}.txt`, 'text/plain', Buffer.from('x'));
    const many = await loadDocumentAttachments(
      store,
      'ws',
      Array.from({ length: MAX_DOCUMENTS + 2 }, (_, index) => attachment(index + 1)),
    );
    expect(many).toHaveLength(MAX_DOCUMENTS);

    const heavy = new InMemoryE2eArtifactStore();
    const nine = Buffer.alloc(9 * 1024 * 1024, 97);
    for (const n of [1, 2, 3]) await put(heavy, n, `h${n}.txt`, 'text/plain', nine);
    expect(
      (
        await loadDocumentAttachments(heavy, 'ws', [attachment(1), attachment(2), attachment(3)])
      ).map((file) => file.name),
    ).toEqual(['h1.txt', 'h2.txt']);
  });
});

describe('loadDocumentAttachments, links elsewhere', () => {
  const PUBLIC = 'https://93.184.216.34';
  const link = (path: string, name = 'Doc'): Attachment => ({
    id: `inline:${PUBLIC}${path}`,
    name,
    kind: 'document',
    scope: 'issue',
    source: 'url',
    url: `${PUBLIC}${path}`,
  });
  const answer = (body: string | Buffer, type: string, init: ResponseInit = {}) =>
    new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status: 200,
      headers: { 'content-type': type },
      ...init,
    });
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  const via = (...responses: Response[]) => {
    const fetcher = vi.fn();
    for (const response of responses) fetcher.mockResolvedValueOnce(response);
    return fetcher as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  };

  it('downloads a PDF and a text file, with no credentials and without a store', async () => {
    const fetcher = via(
      answer(PDF, 'application/pdf'),
      answer(NOTES, 'text/markdown; charset=utf-8'),
    );
    const files = await loadDocumentAttachments(
      undefined,
      'ws',
      [link('/a.pdf', 'Spec'), link('/n.md', 'Notes')],
      fetcher,
    );
    expect(files).toEqual([
      { name: 'Spec', mimeType: 'application/pdf', data: PDF.toString('base64') },
      { name: 'Notes', mimeType: 'text/markdown', data: NOTES.toString('base64') },
    ]);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('trusts a PDF by its content when the server calls it octet-stream', async () => {
    const files = await loadDocumentAttachments(
      undefined,
      'ws',
      [link('/a')],
      via(answer(PDF, 'application/octet-stream')),
    );
    expect(files[0]?.mimeType).toBe('application/pdf');
    expect(
      await loadDocumentAttachments(
        undefined,
        'ws',
        [link('/b')],
        via(answer('plain', 'application/octet-stream')),
      ),
    ).toEqual([]);
  });

  it('follows a redirect, but only to a public address', async () => {
    const ok = via(redirect(`${PUBLIC}/real.pdf`), answer(PDF, 'application/pdf'));
    expect(await loadDocumentAttachments(undefined, 'ws', [link('/short')], ok)).toHaveLength(1);
    expect(ok.mock.calls[1]![0].toString()).toBe(`${PUBLIC}/real.pdf`);

    const inward = via(redirect('https://10.0.0.5/secret.pdf'), answer(PDF, 'application/pdf'));
    expect(await loadDocumentAttachments(undefined, 'ws', [link('/short')], inward)).toEqual([]);
    expect(inward).toHaveBeenCalledTimes(1);

    const loop = via(...Array.from({ length: 6 }, () => redirect(`${PUBLIC}/again`)));
    expect(await loadDocumentAttachments(undefined, 'ws', [link('/loop')], loop)).toEqual([]);
  });

  it('never asks a private or local address in the first place', async () => {
    const fetcher = via(answer(PDF, 'application/pdf'));
    const inside = (url: string): Attachment => ({ ...link('/x'), id: `inline:${url}`, url });
    expect(
      await loadDocumentAttachments(
        undefined,
        'ws',
        [
          inside('https://10.0.0.5/a.pdf'),
          inside('https://localhost/a.pdf'),
          inside('https://127.0.0.1/a.pdf'),
          inside('http://93.184.216.34/a.pdf'),
        ],
        fetcher,
      ),
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('leaves out web pages, images, lies about the type, and failed requests', async () => {
    const fetcher = via(
      answer('<html></html>', 'text/html'),
      answer(PDF, 'image/png'),
      answer('<html>not a pdf</html>', 'application/pdf'),
      answer(Buffer.from([0, 1, 2, 3]), 'text/plain'),
      new Response('nope', { status: 404, headers: { 'content-type': 'application/pdf' } }),
    );
    const files = await loadDocumentAttachments(
      undefined,
      'ws',
      ['/1', '/2', '/3', '/4', '/5'].map((path) => link(path)),
      fetcher,
    );
    expect(files).toEqual([]);
    const broken = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    expect(await loadDocumentAttachments(undefined, 'ws', [link('/a.pdf')], broken)).toEqual([]);
  });

  it('refuses one that is too big, declared or not', async () => {
    const declared = answer(PDF, 'application/pdf', {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(MAX_DOCUMENT_BYTES + 1),
      },
    });
    const streamed = answer(Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 97), 'text/plain');
    expect(
      await loadDocumentAttachments(
        undefined,
        'ws',
        [link('/a'), link('/b')],
        via(declared, streamed),
      ),
    ).toEqual([]);
  });

  it('tries only a few links, and counts what it downloaded toward the same limits', async () => {
    const fetcher = via(...Array.from({ length: 8 }, () => answer('x', 'text/plain')));
    const files = await loadDocumentAttachments(
      undefined,
      'ws',
      Array.from({ length: 8 }, (_, n) => link(`/${n}`)),
      fetcher,
    );
    expect(files).toHaveLength(MAX_EXTERNAL_DOCUMENTS);
    expect(fetcher).toHaveBeenCalledTimes(MAX_EXTERNAL_DOCUMENTS);

    const store = new InMemoryE2eArtifactStore();
    await put(store, 1, 'a.txt', 'text/plain', Buffer.from('mine'));
    const both = await loadDocumentAttachments(
      store,
      'ws',
      [attachment(1), link('/b')],
      via(answer('theirs', 'text/plain')),
    );
    expect(both.map((file) => file.name)).toEqual(['a.txt', 'Doc']);
  });
});
