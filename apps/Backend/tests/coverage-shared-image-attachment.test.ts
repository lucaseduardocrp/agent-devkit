import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  attachmentContentKey,
  attachmentMetaKey,
  type Attachment,
} from '../src/modules/shared/attachment.js';
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
const GIF = Buffer.from('GIF89a-data');
const GIF87 = Buffer.from('GIF87a-data');
const WEBP = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPdata', 'latin1');
const ID = '11111111-1111-4111-8111-111111111111';

describe('image helpers', () => {
  it('maps mime types to extensions and storage keys', () => {
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/png')).toBe('png');
    expect(imageKey('ws', { id: 'a', scope: 'issue', mimeType: 'image/webp' })).toBe(
      'images/issue/ws/a.webp',
    );
    expect(() => imageKey('ws', { id: 'a', scope: 'issue', mimeType: 'text/plain' })).toThrow(
      /missing its media type/,
    );
    expect(() => imageKey('ws', { id: 'a', scope: 'issue' })).toThrow(/missing its media type/);
  });

  it('detects image types by signature', () => {
    expect(detectImageMimeType(PNG)).toBe('image/png');
    expect(detectImageMimeType(JPEG)).toBe('image/jpeg');
    expect(detectImageMimeType(WEBP)).toBe('image/webp');
    expect(detectImageMimeType(GIF)).toBe('image/gif');
    expect(detectImageMimeType(GIF87)).toBe('image/gif');
    expect(detectImageMimeType(Buffer.from('plain text here'))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x48, 0, 0, 0, 0]))).toBeNull();
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageMimeType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBX'))).toBeNull();
    expect(detectImageMimeType(Buffer.from('RIFF'))).toBeNull();
    expect(detectImageMimeType(Buffer.from('GIF'))).toBeNull();
  });

  it('decodes base64 image data, with or without a data URL prefix', () => {
    const encoded = PNG.toString('base64');
    expect(decodeImageData(encoded)).toEqual(PNG);
    expect(decodeImageData(`data:image/png;base64,${encoded}`)).toEqual(PNG);
  });

  it('rejects invalid image data', () => {
    const message = /valid base64/;
    expect(() => decodeImageData('')).toThrow(message);
    expect(() => decodeImageData('data:image/png;base64,')).toThrow(message);
    expect(() => decodeImageData('not base64!')).toThrow(message);
    expect(() => decodeImageData('A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 12))).toThrow(
      message,
    );
    // Base64 that does not round-trip (non-canonical padding bits).
    expect(() => decodeImageData('QR==')).toThrow(message);
    // Valid alphabet but decodes to an oversized buffer.
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString('base64');
    expect(() => decodeImageData(huge)).toThrow(message);
  });
});

describe('inlineImageAttachments', () => {
  it('finds Markdown and HTML images in a description', () => {
    const description = [
      `![shot](/attachments/files/${ID})`,
      '![](https://example.com/a.png "title")',
      '![bad](http://example.com/a.png)',
      '![cred](https://user:pw@example.com/a.png)',
      '![nope](not a url)',
      `<img src="/attachments/files/${ID}" alt="Local">`,
      "<img alt='Single' src='https://example.com/b.png?a=1&amp;b=2'>",
      '<img src=https://example.com/c.png alt=Bare>',
      '<img src="https://example.com/d.png">',
      '<img alt="no source">',
      '<img src="">',
      '<img src="::bad::">',
    ].join('\n');
    const result = inlineImageAttachments(description, 'issue');
    expect(result.map((item) => [item.name, item.source, item.url])).toEqual([
      ['shot', 'adk', `/attachments/files/${ID}`],
      ['Image in description', 'url', 'https://example.com/a.png'],
      ['Local', 'adk', `/attachments/files/${ID}`],
      ['Single', 'url', 'https://example.com/b.png?a=1&b=2'],
      ['Bare', 'url', 'https://example.com/c.png'],
      ['Image in description', 'url', 'https://example.com/d.png'],
    ]);
    expect(result[1]!.id).toBe('inline:https://example.com/a.png');
    expect(result.every((item) => item.scope === 'issue' && item.kind === 'image')).toBe(true);
  });
});

describe('isPublicHttpsUrl', () => {
  beforeEach(() => dns.lookup.mockReset());

  it('rejects malformed and non-https URLs', async () => {
    expect(await isPublicHttpsUrl('nope')).toBe(false);
    expect(await isPublicHttpsUrl('http://example.com/a.png')).toBe(false);
    expect(await isPublicHttpsUrl('https://u:p@example.com/a.png')).toBe(false);
    expect(await isPublicHttpsUrl('https://u@example.com/a.png')).toBe(false);
    expect(await isPublicHttpsUrl('https://example.com:8443/a.png')).toBe(false);
  });

  it('classifies literal IP addresses', async () => {
    const privateHosts = [
      '0.1.1.1',
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
    ];
    for (const host of privateHosts)
      expect(await isPublicHttpsUrl(`https://${host}/a.png`), host).toBe(false);
    const publicHosts = [
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.1.1',
      '100.63.0.1',
      '100.128.0.1',
      '198.17.0.1',
      '198.20.0.1',
      '169.253.0.1',
    ];
    for (const host of publicHosts)
      expect(await isPublicHttpsUrl(`https://${host}:443/a.png`), host).toBe(true);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('classifies IPv6 addresses returned by name resolution', async () => {
    const privateV6 = [
      '::',
      '::1',
      'FC00::1',
      'fd00::1',
      'fe80::1',
      'febf::1',
      '2001:db8::1',
      '::ffff:7f00:1',
    ];
    for (const address of privateV6) {
      dns.lookup.mockResolvedValueOnce([{ address, family: 6 }]);
      expect(await isPublicHttpsUrl('https://v6.example.com/a.png'), address).toBe(false);
    }
    dns.lookup.mockResolvedValueOnce([{ address: '2606:4700::1111', family: 6 }]);
    expect(await isPublicHttpsUrl('https://v6.example.com/a.png')).toBe(true);
    // IPv6 literals keep their brackets in URL host names, so they are looked up as names.
    dns.lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await isPublicHttpsUrl('https://[2606:4700::1111]/a.png')).toBe(false);
  });

  it('rejects local host names without resolving them', async () => {
    expect(await isPublicHttpsUrl('https://localhost/a.png')).toBe(false);
    expect(await isPublicHttpsUrl('https://app.localhost/a.png')).toBe(false);
    expect(await isPublicHttpsUrl('https://printer.local/a.png')).toBe(false);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('resolves other host names and requires every address to be public', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    expect(await isPublicHttpsUrl('https://example.com/a.png')).toBe(true);
    dns.lookup.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    expect(await isPublicHttpsUrl('https://example.com/a.png')).toBe(false);
    dns.lookup.mockResolvedValueOnce([]);
    expect(await isPublicHttpsUrl('https://example.com/a.png')).toBe(false);
    dns.lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await isPublicHttpsUrl('https://example.com/a.png')).toBe(false);
  });
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function urlImage(url = 'https://example.com/a.png'): Attachment {
  return {
    id: `inline:${url}`,
    name: 'x',
    kind: 'image',
    scope: 'issue',
    source: 'url',
    url,
  };
}

describe('loadImageAttachments', () => {
  beforeEach(() => {
    dns.lookup.mockReset();
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns nothing without a store', async () => {
    expect(await loadImageAttachments(undefined, 'ws', [urlImage()])).toEqual([]);
  });

  it('loads stored files of generic attachments after verifying their content', async () => {
    const store = new InMemoryE2eArtifactStore();
    const save = async (id: string, meta: Record<string, unknown> | null, content?: Buffer) => {
      if (meta) await store.put(attachmentMetaKey('ws', id), Buffer.from(JSON.stringify(meta)));
      if (content) await store.put(attachmentContentKey('ws', id), content);
    };
    const ids = [1, 2, 3, 4, 5, 6].map((n) => `${n}0000000-0000-4000-8000-000000000000`);
    await save(ids[0]!, { kind: 'image', mimeType: 'image/png' }, PNG);
    await save(ids[1]!, { kind: 'video', mimeType: 'video/mp4' }, PNG);
    await save(ids[2]!, { kind: 'image', mimeType: 'image/png' }, JPEG);
    await save(ids[3]!, { kind: 'image', mimeType: 'image/png' });
    await save(
      ids[4]!,
      { kind: 'image', mimeType: 'image/png' },
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
    );
    const stored = (id: string, kind?: Attachment['kind']): Attachment => ({
      id,
      name: id,
      kind,
      scope: 'issue',
      source: 'adk',
      url: `/attachments/files/${id}`,
    });
    const documents: Attachment = { ...stored(ids[5]!), kind: 'document' };
    const result = await loadImageAttachments(store, 'ws', [
      stored(ids[0]!, 'image'),
      stored(ids[0]!, 'image'),
      stored(ids[1]!, 'image'),
      stored(ids[2]!, 'image'),
      stored(ids[3]!, 'image'),
      stored(ids[4]!, 'image'),
      stored(ids[5]!, 'image'),
      documents,
    ]);
    expect(result).toEqual([{ mimeType: 'image/png', data: PNG.toString('base64') }]);
  });

  it('loads legacy images stored by media type', async () => {
    const store = new InMemoryE2eArtifactStore();
    const legacy = (id: string, mimeType?: string): Attachment => ({
      id,
      name: id,
      mimeType,
      scope: 'pbi',
      source: 'adk',
      url: '',
    });
    await store.put('images/pbi/ws/ok.png', PNG);
    await store.put('images/pbi/ws/wrong.png', JPEG);
    await store.put('images/pbi/ws/big.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    const result = await loadImageAttachments(store, 'ws', [
      legacy('ok', 'image/png'),
      legacy('wrong', 'image/png'),
      legacy('big', 'image/png'),
      legacy('missing', 'image/png'),
      legacy('notimage'),
    ]);
    expect(result).toEqual([{ mimeType: 'image/png', data: PNG.toString('base64') }]);
  });

  it('limits the prompt to ten distinct images', async () => {
    const store = new InMemoryE2eArtifactStore();
    const items: Attachment[] = [];
    for (let n = 0; n < 12; n += 1) {
      await store.put(`images/pbi/ws/i${n}.png`, PNG);
      items.push({
        id: `i${n}`,
        name: 'x',
        mimeType: 'image/png',
        scope: 'pbi',
        source: 'adk',
        url: '',
      });
    }
    expect(await loadImageAttachments(store, 'ws', items)).toHaveLength(10);
  });

  it('downloads public https images', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(streamOf(PNG.subarray(0, 4), PNG.subarray(4)), {
          headers: { 'content-type': 'image/png; charset=binary' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = new InMemoryE2eArtifactStore();
    expect(await loadImageAttachments(store, 'ws', [urlImage()])).toEqual([
      { mimeType: 'image/png', data: PNG.toString('base64') },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/a.png',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('skips external images that are unsafe, invalid or mismatched', async () => {
    const store = new InMemoryE2eArtifactStore();
    const run = (response: Response | Error, url = 'https://example.com/a.png') => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (response instanceof Error) throw response;
          return response;
        }),
      );
      return loadImageAttachments(store, 'ws', [urlImage(url)]);
    };
    expect(await run(new Response(null, { status: 200 }))).toEqual([]);
    expect(await run(new Response('x', { status: 404 }))).toEqual([]);
    expect(
      await run(new Response(streamOf(PNG), { headers: { 'content-type': 'text/html' } })),
    ).toEqual([]);
    expect(await run(new Response(streamOf(PNG)))).toEqual([]);
    expect(
      await run(
        new Response(streamOf(PNG), {
          headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) },
        }),
      ),
    ).toEqual([]);
    expect(
      await run(
        new Response(streamOf(new Uint8Array(MAX_IMAGE_BYTES), new Uint8Array(10)), {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    ).toEqual([]);
    expect(
      await run(new Response(streamOf(JPEG), { headers: { 'content-type': 'image/png' } })),
    ).toEqual([]);
    expect(await run(new Error('network'))).toEqual([]);
    expect(await run(new Response(streamOf(PNG)), 'https://localhost/a.png')).toEqual([]);
  });
});
