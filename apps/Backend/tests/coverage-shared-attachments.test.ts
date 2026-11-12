import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  attachmentContentKey,
  attachmentKind,
  attachmentKindFromName,
  attachmentMetaKey,
  contentDisposition,
  detectAttachmentType,
  readAttachmentMeta,
  type StoredAttachmentMeta,
} from '../src/modules/shared/attachment.js';
import {
  deleteFile,
  fileOwner,
  referencedFiles,
  sweepPendingFiles,
  syncItemFiles,
  syncItemFilesSafely,
} from '../src/modules/shared/attachment-files.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}
function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
function pad(prefix: Uint8Array, length = 16): Uint8Array {
  const out = new Uint8Array(Math.max(length, prefix.length));
  out.set(prefix);
  return out;
}

describe('detectAttachmentType', () => {
  it('recognizes binary formats by their signature', () => {
    expect(detectAttachmentType(pad(bytes(0x89, 0x50, 0x4e, 0x47)), 'a.bin')).toEqual({
      mimeType: 'image/png',
      kind: 'image',
    });
    expect(detectAttachmentType(bytes(0xff, 0xd8, 0xff), 'a.bin')?.mimeType).toBe('image/jpeg');
    expect(detectAttachmentType(text('RIFF\u0000\u0000\u0000\u0000WEBP'), 'a')?.mimeType).toBe(
      'image/webp',
    );
    expect(detectAttachmentType(text('GIF89a'), 'a')?.mimeType).toBe('image/gif');
    expect(detectAttachmentType(text('GIF87a'), 'a')?.mimeType).toBe('image/gif');
    expect(detectAttachmentType(text('\u0000\u0000\u0000\u0000ftypisom'), 'a')).toEqual({
      mimeType: 'video/mp4',
      kind: 'video',
    });
    expect(detectAttachmentType(text('\u0000\u0000\u0000\u0000ftypqt  '), 'a')?.mimeType).toBe(
      'video/quicktime',
    );
    expect(detectAttachmentType(bytes(0x1a, 0x45, 0xdf, 0xa3), 'a')?.mimeType).toBe('video/webm');
    expect(detectAttachmentType(text('%PDF-1.7'), 'a')).toEqual({
      mimeType: 'application/pdf',
      kind: 'document',
    });
  });

  it('uses the extension to tell zip-based office files apart', () => {
    const zip = text('PK\u0003\u0004rest');
    expect(detectAttachmentType(zip, 'a.zip')?.mimeType).toBe('application/zip');
    expect(detectAttachmentType(zip, 'noext')?.mimeType).toBe('application/zip');
    expect(detectAttachmentType(zip, 'a.DOCX')?.mimeType).toContain('wordprocessingml');
  });

  it('accepts valid UTF-8 text with a known extension and rejects the rest', () => {
    expect(detectAttachmentType(text('a,b'), 'x.csv')?.mimeType).toBe('text/csv');
    expect(detectAttachmentType(bytes(0xff, 0xfe, 0xfd), 'x.txt')).toBeNull();
    expect(detectAttachmentType(bytes(0x61, 0x00), 'x.txt')).toBeNull();
    expect(detectAttachmentType(text('hello'), 'x.unknown')).toBeNull();
    expect(detectAttachmentType(text('hello'), 'x')).toBeNull();
    expect(detectAttachmentType(bytes(), 'x.txt')?.mimeType).toBe('text/plain');
  });

  it('does not match truncated or partial signatures', () => {
    expect(detectAttachmentType(bytes(0x89, 0x50, 0x4e, 0x47), 'a')).toBeNull();
    expect(detectAttachmentType(bytes(0xff, 0xd8), 'a')).toBeNull();
    expect(detectAttachmentType(text('RIFF'), 'a')).toBeNull();
    expect(detectAttachmentType(text('GIF'), 'a')).toBeNull();
    expect(detectAttachmentType(text('ftyp'), 'a')).toBeNull();
    expect(detectAttachmentType(bytes(0x1a, 0x45, 0xdf), 'a')).toBeNull();
    expect(detectAttachmentType(bytes(0x1a, 0x00, 0xdf, 0xa3), 'a')).toBeNull();
    expect(detectAttachmentType(bytes(0x1a, 0x45, 0x00, 0xa3), 'a')).toBeNull();
    expect(detectAttachmentType(bytes(0x1a, 0x45, 0xdf, 0x00), 'a')).toBeNull();
    expect(detectAttachmentType(text('%PDF'), 'a')).toBeNull();
    expect(detectAttachmentType(text('PK'), 'a')).toBeNull();
    expect(detectAttachmentType(pad(bytes(0x89, 0x50, 0x4e, 0x48)), 'a')).toBeNull();
    expect(detectAttachmentType(pad(bytes(0xff, 0x00, 0xff)), 'a')).toBeNull();
    expect(detectAttachmentType(pad(bytes(0xff, 0xd8, 0x00)), 'a')).toBeNull();
    expect(detectAttachmentType(text('RIFF\u0000\u0000\u0000\u0000WEBX'), 'a')).toBeNull();
    expect(detectAttachmentType(text('GIF88a'), 'a')).toBeNull();
  });
});

describe('attachment helpers', () => {
  it('derives the kind from the declared kind, mime type, or defaults to image', () => {
    expect(attachmentKind({ kind: 'video' })).toBe('video');
    expect(attachmentKind({ mimeType: 'application/pdf' })).toBe('document');
    expect(attachmentKind({ mimeType: 'unknown/type' })).toBe('image');
    expect(attachmentKind({})).toBe('image');
  });

  it('derives the kind from file names', () => {
    expect(attachmentKindFromName('a.PNG')).toBe('image');
    expect(attachmentKindFromName('a.mov')).toBe('video');
    expect(attachmentKindFromName('a.pdf')).toBe('document');
    expect(attachmentKindFromName('noext')).toBe('document');
  });

  it('builds storage keys and content disposition', () => {
    expect(attachmentContentKey('ws', A)).toBe(`attachments/ws/${A}/content`);
    expect(contentDisposition('inline', 'ação "x".png')).toBe(
      `inline; filename="a__o _x_.png"; filename*=UTF-8''${encodeURIComponent('ação "x".png')}`,
    );
  });

  it('reads stored metadata, tolerating missing and corrupt entries', async () => {
    const store = new InMemoryE2eArtifactStore();
    expect(await readAttachmentMeta(store, 'ws', A)).toBeNull();
    await store.put(attachmentMetaKey('ws', A), Buffer.from('{not json'));
    expect(await readAttachmentMeta(store, 'ws', A)).toBeNull();
    await store.put(attachmentMetaKey('ws', B), Buffer.from('{"id":"b"}'));
    expect(await readAttachmentMeta(store, 'ws', B)).toEqual({ id: 'b' });
  });
});

function meta(id: string, extra: Partial<StoredAttachmentMeta> = {}): StoredAttachmentMeta {
  return {
    id,
    name: `${id}.png`,
    kind: 'image',
    mimeType: 'image/png',
    size: 1,
    scope: 'issue',
    createdAt: new Date().toISOString(),
    ...extra,
  };
}
async function put(store: InMemoryE2eArtifactStore, value: StoredAttachmentMeta) {
  await store.put(attachmentMetaKey('ws', value.id), Buffer.from(JSON.stringify(value)));
  await store.put(attachmentContentKey('ws', value.id), Buffer.from('x'));
}

describe('attachment files lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('collects referenced file ids, lowercased', () => {
    const ids = referencedFiles({ a: `/attachments/files/${A.toUpperCase()}` }, [
      `x /attachments/files/${B} y`,
    ]);
    expect([...ids].sort()).toEqual([A, B]);
    expect(referencedFiles(undefined).size).toBe(0);
    expect(fileOwner('issue', '7')).toBe('issue:7');
  });

  it('does nothing without a store', async () => {
    await expect(syncItemFiles(undefined, 'ws', 'issue:1', null, null)).resolves.toBeUndefined();
  });

  it('claims referenced files and releases the ones no longer referenced', async () => {
    const store = new InMemoryE2eArtifactStore();
    await put(store, meta(A, { status: 'pending' }));
    await put(store, meta(B, { status: 'committed', owner: 'issue:1' }));
    await put(store, meta(C, { status: 'committed', owner: 'issue:other' }));
    await syncItemFiles(
      store,
      'ws',
      'issue:1',
      [`/attachments/files/${B}`, `/attachments/files/${C}`],
      `/attachments/files/${A} /attachments/files/${A}`,
    );
    expect((await readAttachmentMeta(store, 'ws', A))?.owner).toBe('issue:1');
    expect((await readAttachmentMeta(store, 'ws', A))?.status).toBe('committed');
    expect(await readAttachmentMeta(store, 'ws', B)).toBeNull();
    expect(await readAttachmentMeta(store, 'ws', C)).not.toBeNull();
  });

  it('skips claimed or missing files and claims legacy files without owner', async () => {
    const store = new InMemoryE2eArtifactStore();
    await put(store, meta(A, { status: 'committed', owner: 'issue:2' }));
    await put(store, meta(B, { status: 'committed' }));
    await syncItemFiles(
      store,
      'ws',
      'issue:1',
      undefined,
      `/attachments/files/${A} /attachments/files/${B} /attachments/files/${C}`,
    );
    expect((await readAttachmentMeta(store, 'ws', A))?.owner).toBe('issue:2');
    expect((await readAttachmentMeta(store, 'ws', B))?.owner).toBe('issue:1');
    expect(await readAttachmentMeta(store, 'ws', C)).toBeNull();
  });

  it('deletes the files of a deleted item', async () => {
    const store = new InMemoryE2eArtifactStore();
    await put(store, meta(A, { status: 'committed', owner: 'issue:1' }));
    await syncItemFiles(store, 'ws', 'issue:1', `/attachments/files/${A}`, null);
    expect(await store.get(attachmentContentKey('ws', A))).toBeNull();
    await put(store, meta(B));
    await deleteFile(store, 'ws', B);
    expect(await store.get(attachmentContentKey('ws', B))).toBeNull();
  });

  it('logs instead of failing in the safe variant', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = {
      get: () => Promise.reject(new Error('boom')),
    } as unknown as InMemoryE2eArtifactStore;
    await syncItemFilesSafely(store, 'ws', 'issue:1', null, `/attachments/files/${A}`);
    expect(error).toHaveBeenCalled();
    await expect(
      syncItemFilesSafely(new InMemoryE2eArtifactStore(), 'ws', 'issue:1', null, null),
    ).resolves.toBeUndefined();
  });

  it('sweeps only old pending uploads', async () => {
    const store = new InMemoryE2eArtifactStore();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await put(store, meta(A, { status: 'pending', createdAt: old }));
    await put(store, meta(B, { status: 'pending' }));
    await put(store, meta(C, { status: 'committed', createdAt: old }));
    await store.put('attachments/ws/not-a-file/meta.json', Buffer.from('{}'));
    expect(await sweepPendingFiles(store)).toBe(1);
    expect(await readAttachmentMeta(store, 'ws', A)).toBeNull();
    expect(await readAttachmentMeta(store, 'ws', B)).not.toBeNull();
    expect(await readAttachmentMeta(store, 'ws', C)).not.toBeNull();
    expect(await sweepPendingFiles(store, 0, Date.now() + 1000)).toBe(1);
  });

  it('sweeps nothing when the store cannot list keys', async () => {
    const store = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      removePrefix: () => Promise.resolve(),
    };
    expect(await sweepPendingFiles(store)).toBe(0);
  });
});
