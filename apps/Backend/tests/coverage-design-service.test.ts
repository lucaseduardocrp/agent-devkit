import { describe, expect, it, vi } from 'vitest';
import {
  DesignService,
  isSafeDesignFileName,
  type DesignProject,
  type DesignRemoteStore,
  type DesignSystem,
} from '../src/modules/design/application/design-service.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';

function setup(result: unknown = { files: [{ name: 'index.html', content: '<main />' }] }) {
  const records = new Map<string, DesignProject>();
  const saveDesignSystem = vi.fn(
    async (_ws: string, _provider: string, system: DesignSystem) => system,
  );
  const deleteDesignSystem = vi.fn().mockResolvedValue(true);
  const store: DesignRemoteStore = {
    configuredProviders: vi.fn().mockResolvedValue(['github', 'azure']),
    list: vi.fn().mockResolvedValue([]),
    find: vi.fn(async (_ws, _provider, id: string) => records.get(id) ?? null),
    save: vi.fn(async (_ws, project: DesignProject) => {
      records.set(project.id, project);
      return project;
    }),
    delete: vi.fn().mockResolvedValue(true),
    listDesignSystems: vi.fn().mockResolvedValue([]),
    saveDesignSystem,
    deleteDesignSystem,
  };
  const executeAgent = vi.fn().mockResolvedValue({
    result: typeof result === 'string' ? result : JSON.stringify(result),
  });
  const service = new DesignService(store, { executeAgent } as unknown as AgentService);
  return { service, executeAgent, saveDesignSystem, deleteDesignSystem };
}

const createInput = {
  title: 'Page',
  agentId: 'agent',
  prompt: 'Build',
  provider: 'github' as const,
};

describe('isSafeDesignFileName', () => {
  it('accepts nested files and rejects empty, oversized, traversal and metadata paths', () => {
    expect(isSafeDesignFileName('components\\Card.jsx')).toBe(true);
    expect(isSafeDesignFileName('/')).toBe(false);
    expect(isSafeDesignFileName('a'.repeat(161))).toBe(false);
    expect(isSafeDesignFileName('assets/../secret.txt')).toBe(false);
    expect(isSafeDesignFileName('.DESIGN/project.json')).toBe(false);
  });
});

describe('DesignService design systems', () => {
  it('saves a design system with a generated slug id or the supplied id', async () => {
    const { service, saveDesignSystem } = setup();
    const generated = await service.saveDesignSystem('ws', 'github', {
      name: '  Aurora Ção ',
      content: '<html></html>',
    });
    expect(generated.id).toMatch(/^aurora-cao-[0-9a-f]{8}$/);
    expect(generated.name).toBe('Aurora Ção');
    const fallback = await service.saveDesignSystem('ws', 'azure', {
      id: ' ',
      name: '!!!',
      content: 'x',
    });
    expect(fallback.id).toMatch(/^prototype-[0-9a-f]{8}$/);
    const explicit = await service.saveDesignSystem('ws', 'azure', {
      id: ' kept ',
      name: 'Kept',
      content: 'x',
    });
    expect(explicit.id).toBe('kept');
    expect(saveDesignSystem).toHaveBeenLastCalledWith(
      'ws',
      'azure',
      expect.objectContaining({ id: 'kept', updatedAt: expect.any(String) }),
    );
    await expect(service.listDesignSystems('ws', 'github')).resolves.toEqual([]);
  });

  it('generates design system HTML, stripping fences and forwarding images', async () => {
    const { service, executeAgent } = setup('```html\n<!doctype html><html></html>\n```');
    const images = [{ mimeType: 'image/png' as const, data: 'aGk=' }];
    await expect(
      service.generateDesignSystem('ws', 'agent', 'Dark theme', images),
    ).resolves.toEqual({
      content: '<!doctype html><html></html>',
    });
    expect(executeAgent.mock.calls[0]![2]).toMatchObject({ images });
    expect(executeAgent.mock.calls[0]![2].prompt).toContain('Solicitação: Dark theme');

    executeAgent.mockResolvedValueOnce({ result: '<html lang="pt"></html>' });
    await service.generateDesignSystem('ws', 'agent', 'Light', []);
    expect(executeAgent.mock.calls[1]![2]).not.toHaveProperty('images');
  });

  it('rejects generated design systems that are not HTML', async () => {
    const { service } = setup('Sure! Here it is.');
    await expect(service.generateDesignSystem('ws', 'agent', 'x')).rejects.toMatchObject({
      code: 'INVALID_AGENT_RESPONSE',
      statusCode: 502,
    });
  });

  it('deletes design systems and reports missing ones', async () => {
    const { service, deleteDesignSystem } = setup();
    await expect(service.deleteDesignSystem('ws', 'github', 'aurora')).resolves.toBeUndefined();
    deleteDesignSystem.mockResolvedValueOnce(false);
    await expect(service.deleteDesignSystem('ws', 'github', 'missing')).rejects.toMatchObject({
      code: 'DESIGN_SYSTEM_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('DesignService agent output parsing', () => {
  it('accepts fenced JSON, normalizes names and defaults language and summary', async () => {
    const { service } = setup(
      '```json\n' +
        JSON.stringify({
          files: [
            null,
            'not-an-object',
            { name: 1, content: 'x' },
            { name: 'a.txt', content: 2 },
            { name: '../escape.js', content: 'x' },
            { name: 'big.js', content: 'x'.repeat(500_001) },
            { name: 'lang.js', language: 'l'.repeat(41), content: 'x' },
            { name: '\\index.html', content: '<main />' },
            { name: '/styles.css', language: 'css', content: 'main{}' },
          ],
        }) +
        '\n```',
    );
    const created = await service.create('ws', createInput);
    expect(created.files).toEqual([
      { name: 'index.html', language: 'text', content: '<main />' },
      { name: 'styles.css', language: 'css', content: 'main{}' },
    ]);
    expect(created.messages[1]!.content).toBe('Protótipo atualizado.');
    expect(created.agentId).toBe('agent');
  });

  it('rejects responses without a files array', async () => {
    const { service } = setup({ summary: 'nothing' });
    await expect(service.create('ws', createInput)).rejects.toMatchObject({
      code: 'INVALID_AGENT_RESPONSE',
      message: 'O agente não retornou arquivos válidos.',
    });
  });

  it('rejects responses with no valid files or too many files', async () => {
    const empty = setup({ files: [{ name: '..', content: 'x' }] });
    await expect(empty.service.create('ws', createInput)).rejects.toMatchObject({
      message: 'O agente retornou uma quantidade inválida de arquivos.',
    });
    const many = setup({
      files: Array.from({ length: 31 }, (_, index) => ({ name: `f${index}.js`, content: '' })),
    });
    await expect(many.service.create('ws', createInput)).rejects.toMatchObject({
      message: 'O agente retornou uma quantidade inválida de arquivos.',
    });
  });

  it('rejects responses without index.html', async () => {
    const { service } = setup({ files: [{ name: 'app.js', content: '' }] });
    await expect(service.create('ws', createInput)).rejects.toMatchObject({
      message: 'O protótipo precisa conter index.html.',
    });
  });
});

describe('DesignService chat', () => {
  it('continues with a new agent and forwards images to the agent and the message', async () => {
    const { service, executeAgent } = setup({
      summary: 'Updated',
      files: [{ name: 'index.html', language: 'html', content: '<main>v2</main>' }],
    });
    const created = await service.create('ws', createInput);
    expect(executeAgent.mock.calls[0]![2].prompt).not.toContain('Contexto anterior');
    expect(executeAgent.mock.calls[0]![2].prompt).not.toContain('Arquivos atuais');
    const images = [{ mimeType: 'image/png' as const, data: 'aGk=' }];
    const updated = await service.chat('ws', 'github', created.id, 'Add', ' other ', images);
    expect(executeAgent.mock.calls[1]![1]).toBe('other');
    expect(executeAgent.mock.calls[1]![2]).toMatchObject({ images });
    expect(executeAgent.mock.calls[1]![2].prompt).toContain('Arquivos atuais');
    expect(updated.agentId).toBe('other');
    expect(updated.messages[2]).toMatchObject({ role: 'user', content: 'Add', images });
    expect(updated.messages[3]).toMatchObject({ role: 'assistant', content: 'Updated' });
  });

  it('rejects chats and file updates for missing prototypes', async () => {
    const { service } = setup();
    await expect(service.chat('ws', 'github', 'missing', 'x', undefined)).rejects.toMatchObject({
      code: 'DESIGN_NOT_FOUND',
    });
    await expect(service.updateFiles('ws', 'github', 'missing', [])).rejects.toMatchObject({
      code: 'DESIGN_NOT_FOUND',
    });
  });
});
