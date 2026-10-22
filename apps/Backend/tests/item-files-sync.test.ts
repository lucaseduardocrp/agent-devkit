import { describe, expect, it, vi } from 'vitest';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { PbiService } from '../src/modules/pbi/pbi-service.js';
import { InMemoryPbiStore } from '../src/modules/pbi/pbi-store.js';
import {
  attachmentFileUrl,
  attachmentMetaKey,
  readAttachmentMeta,
} from '../src/modules/shared/attachment.js';
import {
  InMemorySpecRepository,
  SpecService,
} from '../src/modules/spec/application/spec-service.js';

/** A file uploaded by the browser, not yet claimed by any item. */
async function upload(store: InMemoryE2eArtifactStore, id: string) {
  await store.put(
    attachmentMetaKey('ws', id),
    Buffer.from(
      JSON.stringify({
        id,
        name: `${id}.png`,
        kind: 'image',
        mimeType: 'image/png',
        size: 1,
        scope: 'pbi',
        status: 'pending',
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  return `![shot](${attachmentFileUrl(id)})`;
}

const KEPT = '11111111-1111-4111-8111-111111111111';
const DROPPED = '22222222-2222-4222-8222-222222222222';

describe('stored files of PBIs', () => {
  it('deletes the images an imported description no longer references', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws', 'PROJECT_MANAGEMENT', 'trello', {
      isEnabled: true,
      settings: { apiKey: 'key', boardId: 'board' },
      secret: 'token',
    });
    let description = '';
    const fetcher = vi.fn(async (url: string) => {
      const body = url.includes('/lists?')
        ? [{ id: 'list', name: 'List', pos: 1 }]
        : [{ id: 'card', idList: 'list', name: 'Card', desc: description, pos: 1 }];
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const files = new InMemoryE2eArtifactStore();
    const pbis = new InMemoryPbiStore();
    const service = new PbiService(
      pbis,
      integrations,
      fetcher,
      undefined,
      undefined,
      undefined,
      undefined,
      files,
    );
    const card = (await service.pull('ws')).items.find((item) => item.title === 'Card')!;
    await service.update('ws', card.id, {
      description: `${await upload(files, KEPT)} ${await upload(files, DROPPED)}`,
    });
    expect(await readAttachmentMeta(files, 'ws', DROPPED)).toMatchObject({
      status: 'committed',
      owner: `pbi:${card.id}`,
    });

    // The provider still has one of the images; the other was removed there.
    description = `Updated ![shot](${attachmentFileUrl(KEPT)})`;
    await service.pull('ws');
    expect(await readAttachmentMeta(files, 'ws', KEPT)).not.toBeNull();
    expect(await readAttachmentMeta(files, 'ws', DROPPED)).toBeNull();

    // Deleting the list deletes the files of its cards.
    await service.remove('ws', card.parentId!);
    expect(await readAttachmentMeta(files, 'ws', KEPT)).toBeNull();
  });
});

describe('stored files of specifications', () => {
  it('deletes the images a rewritten specification no longer references', async () => {
    const files = new InMemoryE2eArtifactStore();
    const service = new SpecService(
      new InMemorySpecRepository(),
      {
        reply: async () => ({
          content: 'Rewritten',
          sections: [{ templateSectionId: 'flow', content: 'Rewritten without images' }],
        }),
      },
      files,
    );
    const spec = await service.saveSpecification('ws', {
      title: 'Spec',
      sections: [
        { templateSectionId: 'flow', title: 'Flow', content: await upload(files, DROPPED) },
        { templateSectionId: 'ui', title: 'UI', content: await upload(files, KEPT) },
      ],
    });
    const child = await service.saveSpecification('ws', {
      title: 'Child',
      parentId: spec.id,
      sections: [
        { templateSectionId: 'flow', title: 'Flow', content: `![a](/attachments/files/${KEPT})` },
      ],
    });
    expect(await readAttachmentMeta(files, 'ws', DROPPED)).toMatchObject({
      owner: `spec:${spec.id}`,
    });

    // Applying the agent proposal saves the rewritten sections.
    const { proposal } = await service.chat('ws', spec.id, 'agent', 'Rewrite the flow');
    await service.saveSpecification('ws', {
      id: spec.id,
      title: spec.title,
      sections: spec.sections.map((section) => ({
        ...section,
        content:
          proposal!.sections.find((item) => item.templateSectionId === section.templateSectionId)
            ?.content ?? section.content,
      })),
    });
    expect(await readAttachmentMeta(files, 'ws', DROPPED)).toBeNull();
    expect(await readAttachmentMeta(files, 'ws', KEPT)).not.toBeNull();

    // The child referencing the parent's image does not own it; deleting the parent does.
    expect(child.parentId).toBe(spec.id);
    await service.deleteSpecification('ws', spec.id);
    expect(await readAttachmentMeta(files, 'ws', KEPT)).toBeNull();
  });
});
