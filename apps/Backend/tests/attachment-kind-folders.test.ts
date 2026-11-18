import { describe, expect, it } from 'vitest';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import {
  attachmentContentKey,
  attachmentMetaKey,
  readAttachmentContent,
  readAttachmentMeta,
  type AttachmentKind,
  type StoredAttachmentMeta,
} from '../src/modules/shared/attachment.js';
import {
  PENDING_FILE_TTL_MS,
  deleteFile,
  sweepPendingFiles,
  syncItemFiles,
} from '../src/modules/shared/attachment-files.js';

const IDS = {
  document: '11111111-1111-4111-8111-111111111111',
  image: '22222222-2222-4222-8222-222222222222',
  video: '33333333-3333-4333-8333-333333333333',
} as const;

function meta(kind: AttachmentKind, extra: Partial<StoredAttachmentMeta> = {}) {
  return {
    id: IDS[kind],
    name: `${kind}.bin`,
    kind,
    mimeType: 'application/octet-stream',
    size: 1,
    scope: 'issue',
    status: 'pending',
    createdAt: new Date(0).toISOString(),
    ...extra,
  } satisfies StoredAttachmentMeta;
}

describe('attachments by kind', () => {
  it('keeps documents, images and videos in their own folders', () => {
    expect(attachmentContentKey('ws', IDS.document, 'document')).toBe(
      `attachments/files/ws/${IDS.document}/content`,
    );
    expect(attachmentContentKey('ws', IDS.image, 'image')).toBe(
      `attachments/images/ws/${IDS.image}/content`,
    );
    expect(attachmentMetaKey('ws', IDS.video, 'video')).toBe(
      `attachments/videos/ws/${IDS.video}/meta.json`,
    );
  });

  it('finds a file by its id alone, whatever its kind', async () => {
    const store = new InMemoryE2eArtifactStore();
    for (const kind of ['document', 'image', 'video'] as const) {
      const value = meta(kind);
      await store.put(attachmentMetaKey('ws', value.id, kind), Buffer.from(JSON.stringify(value)));
      await store.put(attachmentContentKey('ws', value.id, kind), Buffer.from(kind));
    }
    for (const kind of ['document', 'image', 'video'] as const) {
      expect(await readAttachmentMeta(store, 'ws', IDS[kind])).toMatchObject({ kind });
      expect((await readAttachmentContent(store, 'ws', IDS[kind], kind))?.toString()).toBe(kind);
    }
    expect(await readAttachmentMeta(store, 'other', IDS.image)).toBeNull();
  });

  it('still reads, claims and deletes files saved before the split', async () => {
    const store = new InMemoryE2eArtifactStore();
    const flat = `attachments/ws/${IDS.image}`;
    await store.put(`${flat}/meta.json`, Buffer.from(JSON.stringify(meta('image'))));
    await store.put(`${flat}/content`, Buffer.from('old'));

    expect(await readAttachmentMeta(store, 'ws', IDS.image)).toMatchObject({ kind: 'image' });
    expect((await readAttachmentContent(store, 'ws', IDS.image, 'image'))?.toString()).toBe('old');

    // Claiming writes the record back in the old place, next to the content.
    await syncItemFiles(store, 'ws', 'issue:1', null, `/attachments/files/${IDS.image}`);
    expect(JSON.parse((await store.get(`${flat}/meta.json`))!.toString())).toMatchObject({
      status: 'committed',
      owner: 'issue:1',
    });
    expect(await store.listKeys(`attachments/images`)).toEqual([]);

    await deleteFile(store, 'ws', IDS.image);
    expect(await store.listKeys('attachments')).toEqual([]);
  });

  it('deletes a file from its kind folder', async () => {
    const store = new InMemoryE2eArtifactStore();
    await store.put(attachmentMetaKey('ws', IDS.video, 'video'), Buffer.from('{}'));
    await store.put(attachmentContentKey('ws', IDS.video, 'video'), Buffer.from('v'));
    await store.put(attachmentContentKey('ws', IDS.image, 'image'), Buffer.from('i'));
    await deleteFile(store, 'ws', IDS.video);
    expect(await store.listKeys('attachments')).toEqual([
      attachmentContentKey('ws', IDS.image, 'image'),
    ]);
  });

  it('sweeps abandoned uploads from every folder, old and new', async () => {
    const store = new InMemoryE2eArtifactStore();
    for (const kind of ['document', 'image'] as const)
      await store.put(
        attachmentMetaKey('ws', IDS[kind], kind),
        Buffer.from(JSON.stringify(meta(kind))),
      );
    await store.put(
      `attachments/ws/${IDS.video}/meta.json`,
      Buffer.from(JSON.stringify(meta('video'))),
    );
    expect(await sweepPendingFiles(store, PENDING_FILE_TTL_MS, PENDING_FILE_TTL_MS + 1)).toBe(3);
    expect(await store.listKeys('attachments')).toEqual([]);
  });
});
