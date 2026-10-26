import { lookup } from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryE2eArtifactStore,
  type E2eArtifactStore,
} from '../src/modules/e2e/application/artifact-store.js';
import {
  attachmentContentKey,
  attachmentKind,
  attachmentKindFromName,
  attachmentMetaKey,
  contentDisposition,
  detectAttachmentType,
  readAttachmentMeta,
  type Attachment,
} from '../src/modules/shared/attachment.js';
import {
  referencedFiles,
  sweepPendingFiles,
  syncItemFiles,
  syncItemFilesSafely,
} from '../src/modules/shared/attachment-files.js';
import {
  MAX_IMAGE_BYTES,
  decodeImageData,
  detectImageMimeType,
  imageExtension,
  imageKey,
  inlineImageAttachments,
  isPublicHttpsUrl,
  loadImageAttachments,
} from '../src/modules/shared/image-attachment.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
const lookupMock = vi.mocked(lookup) as unknown as ReturnType<typeof vi.fn>;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Buffer.from('RIFF0000WEBPVP8 ');
const GIF = Buffer.from('GIF89a....');
const ID = '00000000-0000-4000-8000-000000000001';

describe('attachment type detection by content and name', () => {
  it('recognises every signature and falls back to the name for text', () => {
    expect(detectAttachmentType(JPEG, 'noext')?.mimeType).toBe('image/jpeg');
    expect(detectAttachmentType(WEBP, 'a')?.mimeType).toBe('image/webp');
    expect(detectAttachmentType(Buffer.from('GIF87a'), 'a')?.mimeType).toBe('image/gif');
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  ')]);
    expect(detectAttachmentType(mov, 'a.mov')).toEqual({
      mimeType: 'video/quicktime',
      kind: 'video',
    });
    expect(detectAttachmentType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'a')?.mimeType).toBe(
      'video/webm',
    );
    expect(detectAttachmentType(Buffer.from([0xff, 0xfe, 0xfd]), 'notes.md')).toBeNull();
    expect(detectAttachmentType(Buffer.from('# Title'), 'NOTES.MD')?.mimeType).toBe(
      'text/markdown',
    );
    expect(detectAttachmentType(Buffer.from([0x89]), 'a')).toBeNull();
    expect(detectAttachmentType(Buffer.from('RIFF0000AVI xxxx'), 'a')).toBeNull();
    expect(detectAttachmentType(Buffer.from('GIF90a'), 'a')).toBeNull();
    expect(detectAttachmentType(Buffer.from([0x1a, 0x45, 0xdf, 0x00]), 'a')).toBeNull();
    expect(detectAttachmentType(Buffer.from([0x1a, 0x45, 0x00, 0x00]), 'a')).toBeNull();
    expect(detectAttachmentType(Buffer.from([0x1a, 0x00, 0x00, 0x00]), 'a')).toBeNull();
    expect(detectAttachmentType(Buffer.from([0xff, 0xd8, 0x00]), 'a')).toBeNull();
    expect(detectAttachmentType(Buffer.from([0xff, 0x00, 0x00]), 'a')).toBeNull();
  });

  it('derives kinds from stored data or file names', () => {
    expect(attachmentKind({ kind: 'video' })).toBe('video');
    expect(attachmentKind({ mimeType: 'application/pdf' })).toBe('document');
    expect(attachmentKind({ mimeType: 'application/x-unknown' })).toBe('image');
    expect(attachmentKind({})).toBe('image');
    expect(attachmentKindFromName('photo.JPEG')).toBe('image');
    expect(attachmentKindFromName('clip.mov')).toBe('video');
    expect(attachmentKindFromName('readme')).toBe('document');
    expect(contentDisposition('attachment', 'relatório "final".pdf')).toBe(
      `attachment; filename="relat_rio _final_.pdf"; filename*=UTF-8''relat%C3%B3rio%20%22final%22.pdf`,
    );
  });

  it('ignores unreadable stored metadata', async () => {
    const store = new InMemoryE2eArtifactStore();
    await store.put(attachmentMetaKey('ws', ID), Buffer.from('{broken'));
    expect(await readAttachmentMeta(store, 'ws', ID)).toBeNull();
  });
});

describe('attachment file lifecycle edges', () => {
  it('finds references, logs failed syncs and skips stores that cannot list', async () => {
    expect([...referencedFiles(`see /attachments/files/${ID.toUpperCase()}`)]).toEqual([ID]);
    await expect(syncItemFiles(undefined, 'ws', 'issue:1', null, 'x')).resolves.toBeUndefined();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = {
      get: () => Promise.reject(new Error('down')),
    } as unknown as E2eArtifactStore;
    await syncItemFilesSafely(failing, 'ws', 'issue:1', undefined, `/attachments/files/${ID}`);
    expect(error).toHaveBeenCalledWith(
      '[Attachments] Could not update the files of',
      'issue:1',
      expect.any(Error),
    );
    error.mockRestore();
    const noList = { get: vi.fn(), put: vi.fn(), removePrefix: vi.fn() };
    expect(await sweepPendingFiles(noList)).toBe(0);
  });
});

describe('image helpers', () => {
  it('names and keys images by media type', () => {
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/webp')).toBe('webp');
    expect(() => imageKey('ws', { id: ID, scope: 'issue', mimeType: 'text/plain' })).toThrow(
      'missing its media type',
    );
  });

  it('detects image signatures', () => {
    expect(detectImageMimeType(PNG)).toBe('image/png');
    expect(detectImageMimeType(JPEG)).toBe('image/jpeg');
    expect(detectImageMimeType(WEBP)).toBe('image/webp');
    expect(detectImageMimeType(GIF)).toBe('image/gif');
    expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x00, 0, 0, 0, 0]))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x00, 0, 0, 0, 0, 0]))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0x89, 0x00, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0x89]))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0x00]))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0xff, 0x00, 0x00]))).toBeNull();
    expect(detectImageMimeType(Buffer.from('RIFF0000AVI xxxx'))).toBeNull();
    expect(detectImageMimeType(Buffer.from('NOPE0000WEBP'))).toBeNull();
    expect(detectImageMimeType(Buffer.from('GIF90a'))).toBeNull();
  });

  it('collects Markdown and HTML images, skipping unsafe or malformed ones', () => {
    const description = [
      '![](https://cdn.test/a.png)',
      '![x](not a url)',
      '![y](http://cdn.test/plain.png)',
      '![z](https://user:pw@cdn.test/z.png)',
      "<img src='https://cdn.test/b.png?a=1&amp;b=2' alt='Single'>",
      '<img src=https://cdn.test/c.png alt=Bare>',
      '<img alt="no source">',
      '<img src="https://cdn.test/d.png">',
      '<img src="::bad::">',
    ].join('\n');
    expect(
      inlineImageAttachments(description, 'pbi').map((image) => [image.name, image.url]),
    ).toEqual([
      ['Image in description', 'https://cdn.test/a.png'],
      ['Single', 'https://cdn.test/b.png?a=1&b=2'],
      ['Bare', 'https://cdn.test/c.png'],
      ['Image in description', 'https://cdn.test/d.png'],
    ]);
  });

  it('decodes base64 image data and rejects anything else', () => {
    const data = PNG.toString('base64');
    expect(decodeImageData(`data:image/png;base64,${data}`)).toEqual(PNG);
    expect(() => decodeImageData('')).toThrow('valid base64');
    expect(() => decodeImageData('not base64!')).toThrow('valid base64');
    expect(() => decodeImageData('A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 9))).toThrow(
      'valid base64',
    );
    expect(() => decodeImageData('QR==')).toThrow('valid base64');
    expect(() => decodeImageData('=')).toThrow('valid base64');
  });
});

describe('public HTTPS URLs', () => {
  beforeEach(() => lookupMock.mockReset());

  it('rejects malformed, insecure, credentialed and non-default port URLs', async () => {
    expect(await isPublicHttpsUrl('nope')).toBe(false);
    expect(await isPublicHttpsUrl('http://cdn.test/a')).toBe(false);
    expect(await isPublicHttpsUrl('https://u@cdn.test/a')).toBe(false);
    expect(await isPublicHttpsUrl('https://u:p@cdn.test/a')).toBe(false);
    expect(await isPublicHttpsUrl('https://cdn.test:8443/a')).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('classifies IPv4 literals', async () => {
    for (const ip of [
      '0.1.2.3',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.0.1',
      '198.18.0.1',
      '198.19.0.1',
      '224.0.0.1',
    ])
      expect(await isPublicHttpsUrl(`https://${ip}/a`), ip).toBe(false);
    for (const ip of [
      '8.8.8.8',
      '169.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '192.1.1.1',
      '100.63.0.1',
      '100.128.0.1',
      '198.20.0.1',
    ])
      expect(await isPublicHttpsUrl(`https://${ip}:443/a`), ip).toBe(true);
  });

  it('refuses local names and resolves the others, refusing private IPv6 answers', async () => {
    expect(await isPublicHttpsUrl('https://localhost/a')).toBe(false);
    expect(await isPublicHttpsUrl('https://app.localhost/a')).toBe(false);
    expect(await isPublicHttpsUrl('https://printer.local/a')).toBe(false);
    const answer = (address: string) => [{ address, family: address.includes(':') ? 6 : 4 }];
    lookupMock.mockResolvedValueOnce(answer('2606:4700::1'));
    expect(await isPublicHttpsUrl('https://cdn.test/a')).toBe(true);
    for (const address of [
      '::',
      '::1',
      'FC00::1',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:10.0.0.1',
      '10.0.0.1',
    ]) {
      lookupMock.mockResolvedValueOnce(answer(address));
      expect(await isPublicHttpsUrl('https://cdn.test/a'), address).toBe(false);
    }
    lookupMock.mockResolvedValueOnce([]);
    expect(await isPublicHttpsUrl('https://cdn.test/a')).toBe(false);
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await isPublicHttpsUrl('https://cdn.test/a')).toBe(false);
  });
});

describe('loading images for a model', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const external = (n: number): Attachment => ({
    id: `inline:${n}`,
    name: 'x',
    scope: 'issue',
    source: 'url',
    url: `https://cdn.test/${n}.png`,
  });

  it('returns nothing without a store', async () => {
    expect(await loadImageAttachments(undefined, 'ws', [external(1)])).toEqual([]);
  });

  it('downloads public images only when they are what they claim, within the size limit', async () => {
    const store = new InMemoryE2eArtifactStore();
    const png = (headers: Record<string, string> = {}) =>
      new Response(PNG, { headers: { 'content-type': 'image/png; charset=binary', ...headers } });
    const huge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    fetchMock
      .mockResolvedValueOnce(png())
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(png({ 'content-length': String(MAX_IMAGE_BYTES + 1) }))
      .mockResolvedValueOnce(new Response(huge, { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(PNG, { headers: { 'content-type': 'image/gif' } }))
      .mockResolvedValueOnce(new Response(Buffer.from('text'), { headers: {} }))
      .mockRejectedValueOnce(new Error('timeout'));
    const attachments = Array.from({ length: 9 }, (_, index) => external(index));
    const images = await loadImageAttachments(store, 'ws', attachments);
    expect(images).toEqual([{ mimeType: 'image/png', data: PNG.toString('base64') }]);
    expect(fetchMock).toHaveBeenCalledTimes(9);

    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    fetchMock.mockClear();
    expect(await loadImageAttachments(store, 'ws', [external(1)])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads stored images, deduplicated, skipping other kinds and invalid content', async () => {
    const store = new InMemoryE2eArtifactStore();
    const ids = Array.from(
      { length: 6 },
      (_, index) => `0000000${index}-0000-4000-8000-000000000000`,
    );
    const meta = (id: string, mimeType: string, kind = 'image') =>
      store.put(attachmentMetaKey('ws', id), Buffer.from(JSON.stringify({ id, kind, mimeType })));
    await meta(ids[0]!, 'image/png');
    await store.put(attachmentContentKey('ws', ids[0]!), PNG);
    await meta(ids[1]!, 'image/png', 'video');
    await meta(ids[2]!, 'image/tiff');
    await meta(ids[3]!, 'image/jpeg');
    await store.put(attachmentContentKey('ws', ids[3]!), PNG);
    const adk = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
      id,
      name: id,
      kind: 'image',
      scope: 'issue',
      source: 'adk',
      url: `/attachments/files/${id}`,
      ...extra,
    });
    const legacyGif = adk(ids[4]!, { kind: undefined, mimeType: 'image/gif' });
    await store.put(imageKey('ws', legacyGif), GIF);
    const legacyJpeg = adk(ids[5]!, { kind: undefined, mimeType: 'image/jpeg' });
    await store.put(imageKey('ws', legacyJpeg), PNG);
    const images = await loadImageAttachments(store, 'ws', [
      adk(ids[0]!),
      adk(ids[0]!),
      adk('video', { kind: 'video' }),
      adk(ids[1]!),
      adk(ids[2]!),
      adk(ids[3]!),
      adk('missing-meta'),
      legacyGif,
      legacyJpeg,
      adk('legacy-none', { kind: undefined }),
      adk('legacy-missing', { kind: undefined, mimeType: 'image/png' }),
    ]);
    expect(images.map((image) => image.mimeType)).toEqual(['image/png', 'image/gif']);
  });
});
