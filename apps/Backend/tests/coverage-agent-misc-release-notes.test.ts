import { inflateRawSync } from 'node:zlib';
import express from 'express';
import PDFDocument from 'pdfkit';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createReleaseNoteRouter } from '../src/adapters/http/release-note-routes.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { EntityAuditLog } from '../src/modules/audit/entity-audit.js';
import type { PbiItem, PbiStore } from '../src/modules/pbi/pbi-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  fileName,
  parseBlocks,
  parseInline,
  toDocx,
  toMarkdown,
  toPdf,
} from '../src/modules/release-notes/release-note-export.js';
import { ReleaseNoteService } from '../src/modules/release-notes/release-note-service.js';
import {
  InMemoryReleaseNoteStore,
  PrismaReleaseNoteStore,
  type ReleaseNote,
} from '../src/modules/release-notes/release-note-store.js';
import type { RequestContext } from '../src/shared/context.js';
import { ApplicationError } from '../src/shared/errors.js';

function note(overrides: Partial<ReleaseNote> = {}): ReleaseNote {
  return {
    id: 'note-1',
    workspaceId: 'ws-1',
    title: 'Release',
    version: '1.0',
    content: '# Release',
    agentId: null,
    itemIds: [],
    createdBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function pbi(overrides: Partial<PbiItem> = {}): PbiItem {
  return {
    id: 'item-1',
    workspaceId: 'ws-1',
    parentId: null,
    kind: 'card',
    title: 'Item',
    description: '',
    status: 'done',
    position: 0,
    sourceData: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    links: [],
    ...overrides,
  };
}

/** Reads one entry of a ZIP buffer through its central directory. */
function zipEntry(buffer: Buffer, name: string): string {
  for (let offset = 0; offset < buffer.length - 46; offset++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(offset + 28);
    if (buffer.toString('utf8', offset + 46, offset + 46 + nameLength) !== name) continue;
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const local = buffer.readUInt32LE(offset + 42);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
  }
  throw new Error(`Missing ZIP entry ${name}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('release note export', () => {
  it('parses fenced code, item continuations and empty inline text', () => {
    expect(
      parseBlocks(
        'Intro\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n- item\n  continued here\n```\nopen',
      ),
    ).toEqual([
      { type: 'paragraph', text: 'Intro' },
      { type: 'code', text: 'const a = 1;\n\nconst b = 2;' },
      { type: 'item', ordered: false, level: 0, text: 'item continued here' },
      { type: 'code', text: 'open' },
    ]);
    expect(parseBlocks('text\n  indented after paragraph')).toEqual([
      { type: 'paragraph', text: 'text indented after paragraph' },
    ]);
    expect(parseBlocks('- item\nplain\n  indented')).toEqual([
      { type: 'item', ordered: false, level: 0, text: 'item' },
      { type: 'paragraph', text: 'plain indented' },
    ]);
    expect(parseInline('')).toEqual([{ text: '' }]);
    expect(parseInline('**bold** tail')).toEqual([{ text: 'bold', bold: true }, { text: ' tail' }]);
  });

  it('builds safe file names and normalises the Markdown ending', () => {
    expect(fileName(note({ title: '', version: '' }), 'pdf')).toBe('release-note.pdf');
    expect(fileName(note({ title: '***', version: '' }), 'md')).toBe('release-note.md');
    expect(toMarkdown(note({ content: '# Done\n' }))).toBe('# Done\n');
    expect(toMarkdown(note({ content: '# Done' }))).toBe('# Done\n');
  });

  it('renders every block type into the DOCX document', async () => {
    const buffer = await toDocx(
      note({
        content:
          '# Title\n\nPlain *italic* text\n\n> Quoted\n\n```\nline 1\nline 2\n```\n\n---\n\n1. First\n- Bullet',
      }),
    );
    const xml = zipEntry(buffer, 'word/document.xml');
    expect(xml).toContain('Plain ');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('w:left="720"');
    expect(xml).toContain('Quoted');
    expect(xml).toMatch(/Consolas[\s\S]*line 1[\s\S]*<w:br\/>[\s\S]*line 2/);
    expect(xml).toContain('<w:pBdr>');
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('Bullet');
  });

  it('writes every block type into the PDF with WinAnsi-safe text', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const font = vi.spyOn(PDFDocument.prototype, 'font');
    const fill = vi.spyOn(PDFDocument.prototype, 'fillColor');
    const stroke = vi.spyOn(PDFDocument.prototype, 'stroke');
    const buffer = await toPdf(
      note({
        content: [
          '## Heading → *x*',
          '- one',
          '  - nested',
          '1. ordered',
          '- back to bullets',
          'After the list 🚀 costs €5 ✅',
          '> Quote with _style_',
          '```',
          'code → here',
          '```',
          '---',
        ].join('\n'),
      }),
    );
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const written = text.mock.calls.map((call) => call[0]);
    expect(written).toEqual(
      expect.arrayContaining([
        'Heading -> x',
        '•',
        '1.',
        'After the list  costs €5 ',
        'Quote with ',
        'style',
        'code -> here',
      ]),
    );
    expect(written.filter((value) => value === '1.')).toHaveLength(1);
    expect(font).toHaveBeenCalledWith('Helvetica-Oblique');
    expect(font).toHaveBeenCalledWith('Courier');
    expect(fill).toHaveBeenCalledWith('#555555');
    expect(stroke).toHaveBeenCalledOnce();
  });
});

describe('release note stores', () => {
  it('keeps in-memory notes per workspace, newest first, with defaults', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new InMemoryReleaseNoteStore();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const older = await store.create('ws-1', { title: 'Older' });
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    const newer = await store.create('ws-1', {
      title: 'Newer',
      version: '2',
      content: 'x',
      agentId: 'agent',
      itemIds: ['i'],
      createdBy: 'user',
    });
    await store.create('ws-2', { title: 'Other workspace' });
    expect(older).toMatchObject({
      version: '',
      content: '',
      agentId: null,
      itemIds: [],
      createdBy: null,
    });
    expect((await store.list('ws-1')).map((item) => item.id)).toEqual([newer.id, older.id]);
    await expect(store.update('ws-2', older.id, { title: 'x' })).resolves.toBeNull();
    await expect(store.remove('ws-2', older.id)).resolves.toBe(false);
    await expect(store.remove('ws-1', older.id)).resolves.toBe(true);
  });

  it('maps Prisma rows and scopes every query by workspace', async () => {
    const row = {
      ...note(),
      itemIds: ['a', 1, 'b'] as unknown as string[],
    };
    const releaseNoteRecord = {
      findMany: vi.fn().mockResolvedValue([row, { ...row, id: 'note-2', itemIds: null }]),
      findFirst: vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null),
      create: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
    };
    const store = new PrismaReleaseNoteStore({ releaseNoteRecord } as unknown as PrismaClient);

    const listed = await store.list('ws-1');
    expect(listed.map((item) => item.itemIds)).toEqual([['a', 'b'], []]);
    expect(releaseNoteRecord.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { updatedAt: 'desc' },
    });

    await store.create('ws-1', { title: 'Release' });
    expect(releaseNoteRecord.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        title: 'Release',
        version: '',
        content: '',
        agentId: null,
        itemIds: [],
        createdBy: null,
      },
    });
    await store.create('ws-1', {
      title: 'Full',
      version: '2',
      content: 'c',
      agentId: 'a',
      itemIds: ['i'],
      createdBy: 'u',
    });
    expect(releaseNoteRecord.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ version: '2', agentId: 'a', createdBy: 'u' }),
    });

    await expect(store.update('ws-1', 'note-1', { title: 'New' })).resolves.toMatchObject({
      id: 'note-1',
      itemIds: ['a', 'b'],
    });
    expect(releaseNoteRecord.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', id: 'note-1' },
      data: { title: 'New' },
    });
    await expect(store.get('ws-1', 'missing')).resolves.toBeNull();
    await expect(store.update('ws-1', 'missing', { title: 'x' })).resolves.toBeNull();
    await expect(store.remove('ws-1', 'note-1')).resolves.toBe(true);
    await expect(store.remove('ws-1', 'missing')).resolves.toBe(false);
  });
});

describe('ReleaseNoteService.generate', () => {
  function setup(items: PbiItem[], result = '```md\n# Notes\n```') {
    const pbis = {
      getMany: vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
        items.filter((item) => ids.includes(item.id)),
      ),
    } as unknown as PbiStore;
    const executeAgent = vi.fn(async () => ({ result, agent: {}, provider: 'test' }));
    const service = new ReleaseNoteService(new InMemoryReleaseNoteStore(), pbis, {
      executeAgent,
    } as unknown as AgentService);
    return { service, executeAgent };
  }
  const prompt = (executeAgent: ReturnType<typeof setup>['executeAgent']) =>
    (executeAgent.mock.calls[0] as unknown as [string, string, { prompt: string }])[2].prompt;

  it('describes items with their type, links, tags and truncated descriptions in English', async () => {
    const { service, executeAgent } = setup([
      pbi({
        id: 'a',
        kind: 'pbi',
        title: 'Epic work',
        links: [
          {
            externalId: '42',
          } as PbiItem['links'][number],
        ],
        sourceData: { tags: 'ui; api' },
        description: `<p>${'x'.repeat(1600)}</p>`,
      }),
      pbi({ id: 'b', title: 'Typed', sourceData: { type: 'Task' }, parentId: 'gone' }),
      pbi({ id: 'c', title: 'Plain card' }),
    ]);
    const created = await service.generate(
      'ws-1',
      {
        title: 'Release',
        agentId: 'agent-1',
        itemIds: ['a', 'b', 'c', 'a'],
        instructions: ' Be brief ',
      },
      { requestId: 'r', locale: 'en-US' },
    );
    expect(created).toMatchObject({
      title: 'Release',
      version: '',
      content: '# Notes',
      agentId: 'agent-1',
      itemIds: ['a', 'b', 'c'],
      createdBy: null,
    });
    const text = prompt(executeAgent);
    expect(text).toContain('Write the release note "Release"');
    expect(text).toContain('Additional instructions: Be brief');
    expect(text).toContain('Items:\n');
    expect(text).toContain('- [PBI] #42 Epic work (done)');
    expect(text).toContain('  Tags: ui; api');
    expect(text).toContain(`  Description: ${'x'.repeat(1500)}…`);
    expect(text).toContain('- [Task] Typed (done)');
    expect(text).not.toContain('Parent:');
    expect(text).toContain('- [Card] Plain card (done)');
  });

  it('stops adding items once the prompt budget is exhausted', async () => {
    const { service, executeAgent } = setup([
      pbi({ id: 'huge', title: 'H'.repeat(60_001) }),
      pbi({ id: 'small', title: 'Small item' }),
    ]);
    await service.generate(
      'ws-1',
      { title: 'Release', version: '2.0', agentId: 'agent-1', itemIds: ['huge', 'small'] },
      { requestId: 'r', actorId: 'user-1' },
    );
    const text = prompt(executeAgent);
    expect(text).toContain('Escreva a release note "Release — 2.0"');
    expect(text).not.toContain('Instruções adicionais');
    expect(text).toMatch(/Itens:\n$/);
    expect(text).not.toContain('Small item');
  });

  it('rejects selections without items and empty agent answers', async () => {
    const { service } = setup([pbi({ id: 'a' })], '```\n\n```');
    await expect(
      service.generate(
        'ws-1',
        { title: 'R', agentId: 'agent', itemIds: ['missing'] },
        {
          requestId: 'r',
        },
      ),
    ).rejects.toMatchObject({ code: 'RELEASE_NOTE_ITEMS_REQUIRED', statusCode: 400 });
    await expect(
      service.generate(
        'ws-1',
        { title: 'R', agentId: 'agent', itemIds: ['a'] },
        { requestId: 'r' },
      ),
    ).rejects.toMatchObject({ statusCode: 502, message: 'The agent returned no release note.' });
  });
});

describe('release note router', () => {
  function setup(context: RequestContext | Error) {
    const audit = { record: vi.fn() };
    const service = new ReleaseNoteService(
      new InMemoryReleaseNoteStore(),
      { getMany: vi.fn(async () => []) } as unknown as PbiStore,
      {} as AgentService,
      audit as unknown as EntityAuditLog,
    );
    const app = express();
    app.use(express.json());
    app.use(
      createReleaseNoteRouter(service, async () => {
        if (context instanceof Error) throw context;
        return context;
      }),
    );
    app.use(errorMiddleware);
    return { app, service, audit };
  }

  it('forwards context resolver failures', async () => {
    const { app } = setup(new ApplicationError('UNAUTHORIZED', 'Nope.', 401));
    const response = await request(app).get('/release-notes').expect(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('requires a workspace and write access', async () => {
    const noWorkspace = setup({ requestId: 'r', ownerId: 'owner' });
    expect((await request(noWorkspace.app).get('/release-notes').expect(400)).body.code).toBe(
      'WORKSPACE_REQUIRED',
    );

    const readOnly = setup({
      requestId: 'r',
      ownerId: 'ws',
      workspaceId: 'ws',
      tokenScope: 'read',
    });
    expect(
      (await request(readOnly.app).post('/release-notes').send({ title: 'x' }).expect(403)).body
        .code,
    ).toBe('FORBIDDEN');
    await request(readOnly.app).patch('/release-notes/id').send({ title: 'x' }).expect(403);
    await request(readOnly.app).delete('/release-notes/id').expect(403);
  });

  it('creates notes without an actor and reports missing notes', async () => {
    const { app, audit } = setup({ requestId: 'r', ownerId: 'ws', workspaceId: 'ws' });
    const created = await request(app).post('/release-notes').send({ title: 'Anon' }).expect(201);
    expect(created.body.releaseNote).toMatchObject({ title: 'Anon', createdBy: null });
    expect(audit.record).toHaveBeenCalledOnce();

    const id = created.body.releaseNote.id as string;
    expect(
      (await request(app).get(`/release-notes/${id}`).expect(200)).body.releaseNote,
    ).toMatchObject({ id, title: 'Anon' });
    await request(app).patch(`/release-notes/${id}`).send({ title: 'Anon' }).expect(200);
    expect(audit.record).toHaveBeenCalledOnce();

    for (const response of [
      await request(app).get('/release-notes/missing'),
      await request(app).patch('/release-notes/missing').send({ title: 'x' }),
      await request(app).delete('/release-notes/missing'),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('RELEASE_NOTE_NOT_FOUND');
    }
  });
});
