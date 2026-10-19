import { describe, expect, it, vi } from 'vitest';
import {
  DesignService,
  type DesignProject,
  type DesignRemoteStore,
} from '../src/modules/design/application/design-service.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';

function setup() {
  const records = new Map<string, DesignProject>();
  const store: DesignRemoteStore = {
    configuredProviders: vi.fn().mockResolvedValue(['github']),
    list: vi.fn(async (_workspaceId, provider) =>
      [...records.values()].filter((item) => item.provider === provider),
    ),
    find: vi.fn(async (_workspaceId, provider, id) => {
      const item = records.get(id);
      return item && item.provider === provider ? item : null;
    }),
    save: vi.fn(async (_workspaceId, project) => {
      records.set(project.id, project);
      return project;
    }),
    delete: vi.fn(async (_workspaceId, provider, id) => {
      const item = records.get(id);
      return item?.provider === provider ? records.delete(id) : false;
    }),
    listDesignSystems: vi.fn().mockResolvedValue([]),
    saveDesignSystem: vi.fn(async (_workspaceId, _provider, system) => system),
    deleteDesignSystem: vi.fn().mockResolvedValue(true),
  };
  const executeAgent = vi.fn().mockResolvedValue({
    result: JSON.stringify({
      summary: 'Página criada',
      files: [
        { name: 'index.html', language: 'html', content: '<main>Olá</main>' },
        { name: 'styles.css', language: 'css', content: 'main{}' },
        { name: 'script.js', language: 'javascript', content: '' },
      ],
    }),
  });
  const service = new DesignService(store, { executeAgent } as unknown as AgentService);
  return { service, store, executeAgent };
}

describe('DesignService', () => {
  it('loads a large design system separately from the user prompt', async () => {
    const { service, store, executeAgent } = setup();
    const content = `<html>${'x'.repeat(25000)}</html>`;
    vi.mocked(store.listDesignSystems).mockResolvedValue([
      { id: 'aurora', name: 'Aurora', content, updatedAt: '' },
    ]);
    const created = await service.create('ws', {
      title: 'Auth',
      agentId: 'agent',
      prompt: 'Login',
      provider: 'github',
      designSystemId: 'aurora',
    });
    expect(store.listDesignSystems).toHaveBeenCalledWith('ws', 'github');
    expect(executeAgent.mock.calls[0]![2].prompt).toContain(content);
    expect(created.messages[0]!.content).toContain(content);
  });

  it('forwards transient reference images without persisting them', async () => {
    const { service, executeAgent } = setup();
    const images = [{ mimeType: 'image/png' as const, data: 'aGVsbG8=' }];
    const created = await service.create('ws', {
      title: 'Visual reference',
      agentId: 'agent',
      prompt: 'Follow this layout',
      provider: 'github',
      images,
    });
    expect(executeAgent.mock.calls[0]![2].images).toEqual(images);
    expect(created.messages[0]!.content).toBe('Follow this layout');
    expect(JSON.stringify(created)).not.toContain('aGVsbG8=');
  });

  it('rejects a missing design system before invoking the agent', async () => {
    const { service, executeAgent } = setup();
    await expect(
      service.create('ws', {
        title: 'Auth',
        agentId: 'agent',
        prompt: 'Login',
        provider: 'github',
        designSystemId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'DESIGN_SYSTEM_NOT_FOUND' });
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('creates, continues, edits and deletes a repository-backed prototype', async () => {
    const { service, executeAgent } = setup();
    expect(await service.providers('ws')).toEqual(['github']);
    const created = await service.create('ws', {
      title: 'Área do Cliente',
      agentId: 'agent',
      prompt: 'Crie uma página',
      provider: 'github',
    });
    expect(created.id).toMatch(/^area-do-cliente-/);
    expect(created.messages).toHaveLength(2);
    const updated = await service.chat('ws', 'github', created.id, 'Adicione um botão', undefined);
    expect(updated.messages).toHaveLength(4);
    expect(executeAgent.mock.calls[1]![2].prompt).toContain('Contexto anterior');
    const edited = await service.updateFiles('ws', 'github', created.id, [
      { name: 'index.html', language: 'html', content: '<main>Editado</main>' },
    ]);
    expect(edited.files[0]!.content).toContain('Editado');
    expect(await service.list('ws', 'github')).toHaveLength(1);
    await service.delete('ws', 'github', created.id);
    await expect(service.get('ws', 'github', created.id)).rejects.toMatchObject({
      code: 'DESIGN_NOT_FOUND',
    });
  });

  it('rejects malformed agent output and missing prototypes', async () => {
    const { service, executeAgent } = setup();
    executeAgent.mockResolvedValueOnce({ result: 'not-json' });
    await expect(
      service.create('ws', { title: 'X', agentId: 'agent', prompt: 'X', provider: 'github' }),
    ).rejects.toMatchObject({ code: 'INVALID_AGENT_RESPONSE' });
    await expect(service.delete('ws', 'azure', 'missing')).rejects.toMatchObject({
      code: 'DESIGN_NOT_FOUND',
    });
  });

  it('rejects an unconfigured repository before invoking the agent', async () => {
    const { service, executeAgent } = setup();
    await expect(
      service.create('ws', { title: 'X', agentId: 'agent', prompt: 'X', provider: 'azure' }),
    ).rejects.toMatchObject({ code: 'DESIGN_REPOSITORY_NOT_CONFIGURED' });
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('rejects internal metadata paths returned by an agent', async () => {
    const { service, executeAgent } = setup();
    executeAgent.mockResolvedValueOnce({
      result: JSON.stringify({
        files: [
          { name: 'index.html', language: 'html', content: '<main />' },
          { name: '.design/project.json', language: 'json', content: '{}' },
        ],
      }),
    });
    const created = await service.create('ws', {
      title: 'Safe',
      agentId: 'agent',
      prompt: 'Create',
      provider: 'github',
    });
    expect(created.files.map((file) => file.name)).toEqual(['index.html']);
  });
});
