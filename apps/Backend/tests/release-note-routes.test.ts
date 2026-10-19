import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import { parseBlocks, parseInline } from '../src/modules/release-notes/release-note-export.js';

function setup(text = '# Release 1.2\n\n## Novidades\n- **Filtros salvos** no board') {
  const complete = vi.fn(async () => ({
    provider: 'OpenAI',
    text: `\`\`\`markdown\n${text}\n\`\`\``,
    model: 'demo',
  }));
  const llm = { provider: 'OpenAI', complete } as unknown as LlmPort;
  const app = createApp({
    defaultLlm: llm,
    requestContextResolver: (req) => ({
      requestId: 'release-notes-test',
      ownerId: req.header('x-test-workspace') ?? 'ws-a',
      workspaceId: req.header('x-test-workspace') ?? 'ws-a',
      actorId: 'user-a',
      actorName: 'Alice',
      memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
    }),
  });
  return { app, complete };
}

describe('release note routes', () => {
  it('creates, edits and deletes release notes manually and audits every change', async () => {
    const { app } = setup();
    const created = await request(app)
      .post('/release-notes')
      .send({ title: 'Sprint 190', version: '1.2.0', content: '# Sprint 190' })
      .expect(201);
    const id = created.body.releaseNote.id as string;
    expect(created.body.releaseNote).toMatchObject({ createdBy: 'user-a', itemIds: [] });
    await request(app)
      .patch(`/release-notes/${id}`)
      .send({ content: '# Sprint 190\n\n- Fix' })
      .expect(200);
    await request(app)
      .patch(`/release-notes/${id}`)
      .set('x-test-role', 'VIEWER')
      .send({ title: 'Denied' })
      .expect(403);
    await request(app).get(`/release-notes/${id}`).set('x-test-workspace', 'ws-b').expect(404);
    expect((await request(app).get('/release-notes').expect(200)).body.releaseNotes).toHaveLength(
      1,
    );
    await request(app).delete(`/release-notes/${id}`).expect(204);
    await request(app).get(`/release-notes/${id}`).expect(404);

    const history = await request(app)
      .get('/audit/history')
      .query({ entityType: 'release_note', entityId: id })
      .expect(200);
    expect(history.body.items.map((event: { action: string }) => event.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
    expect(history.body.items[1]).toMatchObject({
      actorId: 'user-a',
      before: { title: 'Sprint 190', content: '# Sprint 190' },
      after: { title: 'Sprint 190', content: '# Sprint 190\n\n- Fix' },
    });
  });

  it('generates a release note from selected items with the chosen agent and the Brain', async () => {
    const { app, complete } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'Writer', instructions: 'Write release notes.' })
      .expect(201);
    const pbi = await request(app)
      .post('/pbi/items')
      .send({ kind: 'pbi', title: 'Saved filters', description: '<p>Save <b>filters</b></p>' })
      .expect(201);
    const bug = await request(app)
      .post('/pbi/items')
      .send({
        kind: 'card',
        title: 'Fix slow search',
        parentId: pbi.body.item.id,
        sourceData: { adkCardType: 'Bug' },
      })
      .expect(201);
    await request(app)
      .post('/release-notes/generate')
      .send({ title: 'Empty', agentId: agent.body.agent.id, itemIds: [] })
      .expect(400);
    const generated = await request(app)
      .post('/release-notes/generate')
      .send({
        title: 'Release 1.2',
        version: '1.2.0',
        agentId: agent.body.agent.id,
        itemIds: [pbi.body.item.id, bug.body.item.id],
        instructions: 'Mention the board.',
      })
      .expect(201);
    expect(generated.body.releaseNote).toMatchObject({
      title: 'Release 1.2',
      version: '1.2.0',
      agentId: agent.body.agent.id,
      content: '# Release 1.2\n\n## Novidades\n- **Filtros salvos** no board',
    });
    expect(generated.body.releaseNote.itemIds).toHaveLength(2);
    const prompt = JSON.stringify(complete.mock.calls);
    expect(prompt).toContain('[Bug] Fix slow search');
    expect(prompt).toContain('Parent: Saved filters');
    expect(prompt).toContain('Save filters');
    expect(prompt).toContain('Mention the board.');
    const history = await request(app)
      .get('/audit/history')
      .query({ entityType: 'release_note', entityId: generated.body.releaseNote.id })
      .expect(200);
    expect(history.body.items[0]).toMatchObject({
      action: 'create',
      operation: 'POST /release-notes/generate',
    });
  });

  it('exports Markdown, PDF and DOCX files', async () => {
    const { app } = setup();
    const created = await request(app)
      .post('/release-notes')
      .send({
        title: 'Versão 2',
        version: '2.0',
        content: '# Versão 2\n\n1. Primeiro → item\n2. Segundo\n\n- **Negrito** e `código`',
      })
      .expect(201);
    const id = created.body.releaseNote.id as string;
    const markdown = await request(app)
      .get(`/release-notes/${id}/export`)
      .query({ format: 'markdown' })
      .expect(200);
    expect(markdown.headers['content-type']).toContain('text/markdown');
    expect(markdown.headers['content-disposition']).toContain('Versao-2-2.0.md');
    expect(markdown.text).toContain('# Versão 2');
    const binary = (req: request.Test) =>
      req.buffer(true).parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const pdf = await binary(
      request(app).get(`/release-notes/${id}/export`).query({ format: 'pdf' }),
    ).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const docx = await binary(
      request(app).get(`/release-notes/${id}/export`).query({ format: 'docx' }),
    ).expect(200);
    expect(docx.headers['content-disposition']).toContain('.docx');
    expect((docx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    await request(app).get(`/release-notes/${id}/export`).query({ format: 'html' }).expect(400);
  });

  it('parses the Markdown used by the exporters', () => {
    expect(parseBlocks('# Title\ntext\nmore\n\n- a\n  - b\n1. c\n---\n> q')).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', text: 'text more' },
      { type: 'item', ordered: false, level: 0, text: 'a' },
      { type: 'item', ordered: false, level: 1, text: 'b' },
      { type: 'item', ordered: true, level: 0, text: 'c' },
      { type: 'rule' },
      { type: 'quote', text: 'q' },
    ]);
    expect(parseInline('a **b** *c* `d` [e](https://x.test)')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', code: true },
      { text: ' ' },
      { text: 'e (https://x.test)' },
    ]);
  });
});
