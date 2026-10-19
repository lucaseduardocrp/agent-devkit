import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { KnowledgeChunkRepository } from '../src/modules/knowledge/application/knowledge-provider.js';
import { ApplicationError } from '../src/shared/errors.js';

const context = { ownerId: 'ws-knowledge', workspaceId: 'ws-knowledge', requestId: 'knowledge' };

function chunk(pageId: string, source: string, content = 'Body') {
  return {
    id: `${pageId}-0`,
    ownerId: context.ownerId,
    pageId,
    source,
    chunkIndex: 0,
    content,
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function setup(
  factory: Partial<Record<keyof DynamicProviderFactory, unknown>>,
  chunks: ReturnType<typeof chunk>[] = [],
) {
  const knowledgeRepository = {
    all: vi.fn(async () => chunks),
  } as unknown as KnowledgeChunkRepository;
  return createApp({
    requestContextResolver: async () => context,
    knowledgeRepository,
    dynamicProviderFactory: factory as unknown as DynamicProviderFactory,
  });
}

describe('knowledge push destinations', () => {
  it('lists unique Azure Wiki page paths in alphabetical order', async () => {
    const app = setup({}, [
      chunk('p1', 'https://dev.azure.com/wiki?pagePath=%2FZeta'),
      chunk('p2', 'https://dev.azure.com/wiki?pagePath=%2FAlpha'),
      chunk('p3', 'https://dev.azure.com/wiki?pagePath=%2FAlpha'),
      chunk('p4', 'app://local?title=Native'),
      chunk('p5', 'not a url'),
    ]);
    const response = await request(app).get('/knowledge/push-destinations/azure_devops_wiki');
    expect(response.status).toBe(200);
    expect(response.body.destinations).toEqual([
      { id: '/Alpha', label: '/Alpha' },
      { id: '/Zeta', label: '/Zeta' },
    ]);
  });

  it('keeps non-Trello destinations and reports unconfigured or failing providers', async () => {
    const resolveBrainBoardPushProvider = vi
      .fn()
      .mockResolvedValueOnce({
        pull: async () => [
          { externalId: 'PROJ-1', title: 'Epic', sourceData: {} },
          { externalId: 'PROJ-2', title: 'Story', sourceData: { trelloType: 'card' } },
        ],
      })
      .mockResolvedValueOnce(null);
    const app = setup({
      resolveBrainBoardPushProvider,
      listBrainPushProviders: vi.fn().mockRejectedValue(new ApplicationError('BOOM', 'Boom', 409)),
    });
    expect((await request(app).get('/knowledge/push-destinations/jira')).body.destinations).toEqual(
      [
        { id: 'PROJ-1', label: 'Epic' },
        { id: 'PROJ-2', label: 'Story' },
      ],
    );
    const missing = await request(app).get('/knowledge/push-destinations/jira');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('PUSH_PROVIDER_NOT_CONFIGURED');
    const failing = await request(app).get('/knowledge/push-providers');
    expect(failing.status).toBe(409);
    expect(failing.body.code).toBe('BOOM');
  });
});

describe('knowledge document push validation', () => {
  const native = (title: string) =>
    chunk('doc-1', `app://local?title=${encodeURIComponent(title)}`, 'Content');

  it('rejects Wiki titles and parent paths that cannot become Wiki pages', async () => {
    const pushPage = vi.fn();
    const resolveAzureDevOpsWikiProvider = vi.fn(async () => ({ pushPage }));
    for (const [title, parentPath] of [
      ['..', ''],
      ['.', ''],
      ['Bad\u0001Title', ''],
      ['Slash/Title', ''],
      ['Valid', '/Docs/../Secret'],
      ['Valid', '/Docs/./Here'],
      ['Valid', '/Docs/Que?ry'],
      ['Valid', '/Docs/Ctrl\u0002'],
    ] as const) {
      const app = setup({ resolveAzureDevOpsWikiProvider }, [native(title)]);
      const response = await request(app)
        .post('/knowledge/documents/doc-1/push')
        .send({ providerId: 'azure_devops_wiki', destination: { parentPath } });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_WIKI_PATH');
    }
    expect(pushPage).not.toHaveBeenCalled();
  });

  it('publishes at the Wiki root when no destination object is sent', async () => {
    const pushPage = vi.fn(async () => ({ source: 'https://wiki/page' }));
    const resolveAzureDevOpsWikiProvider = vi.fn(async () => ({ pushPage }));
    const app = setup({ resolveAzureDevOpsWikiProvider }, [native('Root page')]);
    const response = await request(app)
      .post('/knowledge/documents/doc-1/push')
      .send({ providerId: 'azure_devops_wiki', destination: 'invalid' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, remoteUrl: 'https://wiki/page', published: [] });
    expect(resolveAzureDevOpsWikiProvider).toHaveBeenCalledWith(context.ownerId, undefined, '');
    expect(pushPage).toHaveBeenCalledWith({ id: 'doc-1', content: 'Content', path: '/Root page' });
  });

  it('reports a missing Wiki provider and invalid destinations', async () => {
    const app = setup({ resolveAzureDevOpsWikiProvider: vi.fn(async () => null) }, [native('Doc')]);
    const missing = await request(app)
      .post('/knowledge/documents/doc-1/push')
      .send({ providerId: 'azure_devops_wiki', destination: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('PUSH_PROVIDER_NOT_CONFIGURED');
    for (const wikiIdentifier of [42, 'w'.repeat(501)]) {
      const invalid = await request(app)
        .post('/knowledge/documents/doc-1/push')
        .send({ providerId: 'azure_devops_wiki', destination: { wikiIdentifier } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('INVALID_PUSH_DESTINATION');
    }
  });

  it('validates board providers and forwards every destination field', async () => {
    const push = vi.fn(async () => ({ externalUrl: 'https://jira/PROJ-9' }));
    const resolveBrainBoardPushProvider = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ push });
    const app = setup({ resolveBrainBoardPushProvider }, [native('Board doc')]);

    const invalidProvider = await request(app)
      .post('/knowledge/documents/doc-1/push')
      .send({ providerId: 7 });
    expect(invalidProvider.status).toBe(400);
    expect(invalidProvider.body.code).toBe('INVALID_PUSH_PROVIDER');

    const unconfigured = await request(app)
      .post('/knowledge/documents/doc-1/push')
      .send({ providerId: 'jira' });
    expect(unconfigured.status).toBe(400);
    expect(unconfigured.body.code).toBe('PUSH_PROVIDER_NOT_CONFIGURED');
    expect(push).not.toHaveBeenCalled();

    const full = await request(app)
      .post('/knowledge/documents/doc-1/push')
      .send({
        providerId: 'jira',
        destination: {
          parentExternalId: ' PROJ-1 ',
          issueType: 'Story',
          externalId: 'PROJ-9',
          listId: null,
        },
      });
    expect(full.status).toBe(200);
    expect(full.body.remoteUrl).toBe('https://jira/PROJ-9');
    expect(push).toHaveBeenLastCalledWith(
      { kind: 'card', title: 'Board doc', description: 'Content', status: 'backlog' },
      { parentExternalId: 'PROJ-1', issueType: 'Story', externalId: 'PROJ-9' },
    );

    await request(app).post('/knowledge/documents/doc-1/push').send({ providerId: 'jira' });
    expect(push).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Board doc' }), {});
  });
});
