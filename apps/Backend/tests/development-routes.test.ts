import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp, errorMiddleware } from '../src/adapters/http/app.js';
import { createDevelopmentRouter } from '../src/adapters/http/development-routes.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  buildPipeline,
  changeFolder,
  nextChangeStatus,
  sessionDirectives,
  slugify,
  taskProgress,
  templateArtifacts,
  type DevChange,
  type DevSession,
} from '../src/modules/development/development.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';
import { DevelopmentService } from '../src/modules/development/development-service.js';
import {
  InMemoryDevelopmentStore,
  PrismaDevelopmentStore,
} from '../src/modules/development/development-store.js';

function setup() {
  return createApp({
    e2eScripts: new FakeScriptRepository(),
    requestContextResolver: (req) => ({
      requestId: 'development-test',
      ownerId: 'ws-a',
      workspaceId: req.header('x-test-workspace') ?? 'ws-a',
      ...(req.header('x-test-anonymous') ? {} : { actorId: 'user-a', actorName: 'Alice' }),
      memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
      ...(req.header('x-test-scope') ? { tokenScope: 'read' as const } : {}),
    }),
  });
}

const repository = { provider: 'github', id: 'acme/shop', name: 'shop', baseBranch: 'develop' };

async function approvedChange(app: ReturnType<typeof setup>, title = 'Add login') {
  const created = await request(app)
    .post('/development/changes')
    .send({ title, repository })
    .expect(201);
  const id = created.body.change.id as string;
  for (const action of ['propose', 'approve'])
    await request(app).post(`/development/changes/${id}/transition`).send({ action }).expect(200);
  return id;
}

async function runningSession(app: ReturnType<typeof setup>, changeId?: string) {
  const created = await request(app)
    .post('/development/sessions')
    .send({ title: 'Implement login', prompt: 'Do it', ...(changeId ? { changeId } : {}) })
    .expect(201);
  const id = created.body.session.id as string;
  await request(app)
    .post(`/development/sessions/${id}/claim`)
    .send({ runner: 'laptop', worktreePath: '/work/login' })
    .expect(200);
  return id;
}

describe('development changes', () => {
  it('creates a change with the artifacts of its framework and edits them', async () => {
    const app = setup();
    const created = await request(app)
      .post('/development/changes')
      .send({ title: 'Adicionar Login Único' })
      .expect(201);
    const change = created.body.change;
    expect(change).toMatchObject({
      slug: 'adicionar-login-unico',
      framework: 'openspec',
      status: 'draft',
      summary: '',
      repository: null,
      specificationId: null,
      createdBy: 'user-a',
    });
    expect(change.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual([
      'openspec/changes/adicionar-login-unico/proposal.md',
      'openspec/changes/adicionar-login-unico/design.md',
      'openspec/changes/adicionar-login-unico/tasks.md',
      'openspec/changes/adicionar-login-unico/specs/adicionar-login-unico/spec.md',
    ]);

    await request(app)
      .post('/development/changes')
      .send({ title: 'Other', slug: 'Adicionar login único' })
      .expect(409);
    await request(app).post('/development/changes').send({ title: '' }).expect(400);
    for (const path of [
      '../outside.md',
      '/etc/passwd',
      'C:/temp/x.md',
      '..\\up.md',
      'a/../../b.md',
    ])
      await request(app)
        .post('/development/changes')
        .send({ title: 'Escape', artifacts: [{ kind: 'other', path, content: '' }] })
        .expect(400);

    const kept = change.artifacts[0];
    const updated = await request(app)
      .put(`/development/changes/${change.id}`)
      .send({
        summary: 'SSO',
        artifacts: [kept, { kind: 'tasks', path: 'tasks.md', content: '- [x] a\n- [ ] b' }],
      })
      .expect(200);
    expect(updated.body.change.summary).toBe('SSO');
    expect(updated.body.change.artifacts[0].id).toBe(kept.id);
    expect(updated.body.change.artifacts[1].id).toEqual(expect.any(String));
    const renamed = await request(app)
      .put(`/development/changes/${change.id}`)
      .send({ title: 'SSO login' })
      .expect(200);
    expect(renamed.body.change.artifacts).toHaveLength(2);
    await request(app).put(`/development/changes/${change.id}`).send({}).expect(400);

    await request(app)
      .get(`/development/changes/${change.id}`)
      .set('x-test-workspace', 'ws-b')
      .expect(404);
    await request(app).get(`/development/changes/${change.id}`).expect(200);
    expect((await request(app).get('/development/changes').expect(200)).body.changes).toHaveLength(
      1,
    );
    const custom = await request(app)
      .post('/development/changes')
      .set('x-test-anonymous', '1')
      .send({
        title: 'Custom',
        framework: 'custom',
        summary: 's',
        specificationId: 'spec-1',
        artifacts: [{ kind: 'other', path: 'notes.md', content: '' }],
      })
      .expect(201);
    expect(custom.body.change).toMatchObject({ createdBy: null, specificationId: 'spec-1' });
  });

  it('moves a change through propose, approve, reject, reopen and archive', async () => {
    const app = setup();
    const created = await request(app).post('/development/changes').send({ title: 'Flow' });
    const id = created.body.change.id as string;
    const move = (action: string) =>
      request(app).post(`/development/changes/${id}/transition`).send({ action });

    await move('approve').expect(409);
    await move('propose').expect(200);
    const rejected = await move('reject').expect(200);
    expect(rejected.body.change).toMatchObject({ status: 'rejected', decidedBy: 'user-a' });
    await request(app).put(`/development/changes/${id}`).send({ title: 'x' }).expect(409);
    const reopened = await move('reopen').expect(200);
    expect(reopened.body.change).toMatchObject({ status: 'draft', decidedBy: null });
    await move('propose').expect(200);
    const approved = await move('approve').expect(200);
    expect(approved.body.change.decidedAt).toEqual(expect.any(String));

    const sessionId = await runningSession(app, id);
    await move('archive').expect(409);
    await request(app).delete(`/development/changes/${id}`).expect(409);
    await request(app).post(`/development/sessions/${sessionId}/cancel`).expect(200);
    const archived = await move('archive').expect(200);
    expect(archived.body.change).toMatchObject({ status: 'archived', decidedBy: 'user-a' });
    await request(app).delete(`/development/sessions/${sessionId}`).expect(204);
    await request(app).delete(`/development/changes/${id}`).expect(204);
    await request(app).delete(`/development/changes/${id}`).expect(404);
  });

  it('enforces module permissions, read-only tokens and the workspace', async () => {
    const app = setup();
    await request(app)
      .post('/development/changes')
      .set('x-test-role', 'VIEWER')
      .send({ title: 'Denied' })
      .expect(403);
    await request(app).get('/development/changes').set('x-test-role', 'VIEWER').expect(200);
    await request(app)
      .post('/development/changes')
      .set('x-test-scope', 'read')
      .send({ title: 'Denied' })
      .expect(403);

    const standalone = express();
    standalone.use(express.json());
    standalone.use(createDevelopmentRouter(new DevelopmentService(new InMemoryDevelopmentStore())));
    standalone.use(errorMiddleware);
    await request(standalone).get('/development/changes').expect(401);

    // A signed-in request that never got a context has no workspace to act on.
    const signedIn = express();
    signedIn.use(express.json());
    signedIn.use((req, _res, next) => {
      (req as unknown as { user: object }).user = { id: 'u1' };
      next();
    });
    signedIn.use(createDevelopmentRouter(new DevelopmentService(new InMemoryDevelopmentStore())));
    signedIn.use(errorMiddleware);
    await request(signedIn).get('/development/changes').expect(400);
    await request(signedIn).post('/development/changes').send({ title: 'x' }).expect(400);

    const noWorkspace = express();
    noWorkspace.use(express.json());
    noWorkspace.use(
      createDevelopmentRouter(new DevelopmentService(new InMemoryDevelopmentStore()), async () => ({
        requestId: 'r',
        ownerId: 'user-a',
      })),
    );
    noWorkspace.use(errorMiddleware);
    await request(noWorkspace).get('/development/changes').expect(400);
    await request(noWorkspace).post('/development/changes').send({ title: 'x' }).expect(400);

    const readOnly = express();
    readOnly.use(express.json());
    readOnly.use(
      createDevelopmentRouter(new DevelopmentService(new InMemoryDevelopmentStore()), async () => ({
        requestId: 'r',
        ownerId: 'user-a',
        workspaceId: 'ws-a',
        tokenScope: 'read' as const,
      })),
    );
    readOnly.use(errorMiddleware);
    await request(readOnly).post('/development/changes').send({ title: 'x' }).expect(403);

    const failing = express();
    failing.use(
      createDevelopmentRouter(new DevelopmentService(new InMemoryDevelopmentStore()), async () => {
        throw new Error('resolver down');
      }),
    );
    failing.use(errorMiddleware);
    await request(failing).get('/development/changes').expect(500);
  });
});

describe('development repositories', () => {
  it('lists the repositories and branches of the connected Git providers', async () => {
    const app = setup();
    const repositories = await request(app).get('/development/repositories').expect(200);
    expect(repositories.body).toEqual({
      repositories: [
        { id: '42', provider: 'github', name: 'acme/demo-app', defaultBranch: 'main' },
        { id: 'guid-1', provider: 'azure_devops', name: 'Finance/app', defaultBranch: 'develop' },
      ],
      warnings: [],
    });
    const branches = await request(app)
      .get('/development/repositories/branches')
      .query({ provider: 'azure_devops', repositoryId: 'guid-1' })
      .expect(200);
    expect(branches.body.branches).toEqual([
      { name: 'develop', isDefault: true },
      { name: 'feature/e2e', isDefault: false },
    ]);
    await request(app)
      .get('/development/repositories/branches')
      .query({ provider: 'gitlab', repositoryId: 'x' })
      .expect(400);
    await request(app).get('/development/repositories/branches').expect(400);
  });

  it('only offers the providers a session can work in, and nothing without a browser', async () => {
    const browser = {
      listRepositories: () =>
        Promise.resolve({
          repositories: [
            { id: '1', provider: 'github', name: 'acme/a', defaultBranch: 'main' },
            { id: '2', provider: 'bitbucket', name: 'acme/b', defaultBranch: 'main' },
          ],
          warnings: [
            { provider: 'azure_devops', code: 'CREDENTIALS_MISSING' },
            { provider: 'bitbucket', code: 'NOT_CONFIGURED' },
          ],
        }),
      listBranches: () => Promise.resolve([]),
    };
    expect(
      await new DevelopmentService(new InMemoryDevelopmentStore(), browser).listRepositories('w'),
    ).toEqual({
      repositories: [{ id: '1', provider: 'github', name: 'acme/a', defaultBranch: 'main' }],
      warnings: [{ provider: 'azure_devops', code: 'CREDENTIALS_MISSING' }],
    });
    const alone = new DevelopmentService(new InMemoryDevelopmentStore());
    expect(await alone.listRepositories('w')).toEqual({ repositories: [], warnings: [] });
    expect(await alone.listBranches('w', 'github', '1')).toEqual([]);
  });

  it('queues a session in the repository and branch that were picked', async () => {
    const app = setup();
    const created = await request(app)
      .post('/development/sessions')
      .send({
        title: 'Fix',
        prompt: 'go',
        repository: { ...repository, baseBranch: 'feature/e2e' },
        baseBranch: 'feature/e2e',
      })
      .expect(201);
    expect(created.body.session.repository).toMatchObject({ id: 'acme/shop' });
    expect(created.body.session.worktree.baseBranch).toBe('feature/e2e');
  });
});

describe('development sessions', () => {
  it('queues a session of an approved change in its own worktree', async () => {
    const app = setup();
    const draft = await request(app).post('/development/changes').send({ title: 'Draft' });
    await request(app)
      .post('/development/sessions')
      .send({ title: 'Too early', prompt: 'go', changeId: draft.body.change.id })
      .expect(409);
    await request(app)
      .post('/development/sessions')
      .send({ title: 'Ghost', prompt: 'go', changeId: 'missing' })
      .expect(404);

    const changeId = await approvedChange(app);
    const created = await request(app)
      .post('/development/sessions')
      .send({ title: 'Implement login', prompt: 'Follow the tasks', changeId })
      .expect(201);
    const session = created.body.session;
    expect(session).toMatchObject({
      changeId,
      cli: 'claude',
      status: 'queued',
      attempt: 1,
      repository,
      context: { windowTokens: 200000, usedTokens: 0, compactAtPercent: 80, compactions: 0 },
      maxSubagents: 3,
      createdBy: 'user-a',
    });
    expect(session.worktree).toMatchObject({ baseBranch: 'develop', path: null });
    expect(session.worktree.branch).toMatch(/^adk\/add-login-[0-9a-f]{8}$/);
    expect(session.events).toHaveLength(1);

    const adhoc = await request(app)
      .post('/development/sessions')
      .send({
        title: 'Fix typo',
        prompt: 'Fix it',
        cli: 'codex',
        agentId: 'agent-1',
        repository: { ...repository, baseBranch: 'main' },
        baseBranch: 'release',
        windowTokens: 100000,
        compactAtPercent: 50,
        maxSubagents: 0,
      })
      .expect(201);
    expect(adhoc.body.session).toMatchObject({
      changeId: null,
      cli: 'codex',
      agentId: 'agent-1',
      worktree: { baseBranch: 'release' },
      maxSubagents: 0,
    });
    const plain = await request(app)
      .post('/development/sessions')
      .send({ title: 'No repo', prompt: 'go' })
      .expect(201);
    expect(plain.body.session.worktree.baseBranch).toBe('main');
    expect(plain.body.session).toMatchObject({ pbiItemId: null, issueId: null });
    const linked = await request(app)
      .post('/development/sessions')
      .send({ title: 'Linked', prompt: 'go', pbiItemId: 'pbi-1', issueId: 'issue-1' })
      .expect(201);
    expect(linked.body.session).toMatchObject({ pbiItemId: 'pbi-1', issueId: 'issue-1' });
    await request(app)
      .delete(`/development/sessions/${linked.body.session.id as string}`)
      .expect(204);

    const queued = await request(app).get('/development/sessions?status=queued').expect(200);
    expect(queued.body.sessions).toHaveLength(3);
    const running = await request(app).get('/development/sessions?status=running').expect(200);
    expect(running.body.sessions).toHaveLength(0);
    expect((await request(app).get('/development/sessions')).body.sessions).toHaveLength(3);
    await request(app).get('/development/sessions?status=nope').expect(400);
    // A runner only sees what its own user queued.
    const mine = await request(app).get('/development/sessions?status=queued&mine=true');
    expect(mine.body.sessions).toHaveLength(3);
    const others = await request(app)
      .get('/development/sessions?mine=true')
      .set('x-test-anonymous', '1');
    expect(others.body.sessions).toHaveLength(0);
    expect((await request(app).get('/development/sessions?mine=false')).body.sessions).toHaveLength(
      3,
    );
    for (const baseBranch of ['-x', 'a..b', 'has space'])
      await request(app)
        .post('/development/sessions')
        .send({ title: 'Bad base', prompt: 'go', baseBranch })
        .expect(400);
    await request(app).get(`/development/sessions/${session.id}`).expect(200);
    await request(app).get('/development/sessions/missing').expect(404);

    const brief = await request(app).get(`/development/sessions/${session.id}/brief`).expect(200);
    expect(brief.body.change.id).toBe(changeId);
    expect(brief.body.worktree.command).toBe(
      `git worktree add -b ${session.worktree.branch} ../${session.worktree.branch.replace('/', '-')} develop`,
    );
    expect(brief.body.instructions).toHaveLength(7);
    const adhocBrief = await request(app).get(
      `/development/sessions/${adhoc.body.session.id}/brief`,
    );
    expect(adhocBrief.body.change).toBeNull();
  });

  it('follows the runner: claim, report with directives, diff and completion', async () => {
    const app = setup();
    const id = await runningSession(app);
    await request(app).post(`/development/sessions/${id}/claim`).send({ runner: 'x' }).expect(409);

    const first = await request(app)
      .post(`/development/sessions/${id}/report`)
      .send({
        usedTokens: 170000,
        worktreePath: '/work/moved',
        subagents: [
          { id: 's1', name: 'Tests', role: 'qa', status: 'running', summary: '', usedTokens: 10 },
          { id: 's2', name: 'Docs', role: 'docs', status: 'running', summary: '', usedTokens: 5 },
          { id: 's3', name: 'Api', role: 'dev', status: 'running', summary: '', usedTokens: 5 },
        ],
        events: [
          { kind: 'message', text: 'Reading the code' },
          { kind: 'subagent', text: 'Started', subagentId: 's1' },
        ],
      })
      .expect(200);
    expect(first.body.directives).toEqual({ compact: true, cancel: false, spawnSubagents: false });
    expect(first.body.session.worktree.path).toBe('/work/moved');
    expect(first.body.session.events.at(-1)).toMatchObject({ kind: 'subagent', subagentId: 's1' });

    const second = await request(app)
      .post(`/development/sessions/${id}/report`)
      .send({ usedTokens: 40000, events: [{ kind: 'compaction', text: 'Summarized' }] })
      .expect(200);
    expect(second.body.directives.compact).toBe(false);
    expect(second.body.session.context).toMatchObject({ usedTokens: 40000, compactions: 1 });
    expect(second.body.session.subagents).toHaveLength(3);
    const idle = await request(app).post(`/development/sessions/${id}/report`).send({}).expect(200);
    expect(idle.body.session.context.usedTokens).toBe(40000);

    const files = [
      { path: 'src/login.ts', status: 'added', additions: 2, deletions: 0, patch: '+a\n+b' },
    ];
    const withDiff = await request(app)
      .put(`/development/sessions/${id}/diff`)
      .send({ files })
      .expect(200);
    expect(withDiff.body.session.diff).toEqual(files);
    await request(app).delete(`/development/sessions/${id}`).expect(409);

    const done = await request(app)
      .post(`/development/sessions/${id}/complete`)
      .send({ outcome: 'succeeded', summary: 'Login added' })
      .expect(200);
    expect(done.body.session).toMatchObject({
      status: 'waiting_review',
      summary: 'Login added',
      error: null,
    });
    await request(app).post(`/development/sessions/${id}/report`).send({}).expect(409);
    await request(app).put(`/development/sessions/${id}/diff`).send({ files }).expect(409);

    const failingId = await runningSession(app);
    const failed = await request(app)
      .post(`/development/sessions/${failingId}/complete`)
      .send({ outcome: 'failed' })
      .expect(200);
    expect(failed.body.session).toMatchObject({
      status: 'failed',
      error: 'The runner reported a failure.',
    });
    const retried = await request(app).post(`/development/sessions/${failingId}/retry`).expect(200);
    expect(retried.body.session).toMatchObject({ status: 'queued', attempt: 2, runner: null });
    await request(app).post(`/development/sessions/${failingId}/retry`).expect(409);
    await request(app)
      .post(`/development/sessions/${failingId}/claim`)
      .send({ runner: 'laptop' })
      .expect(200);
    const explained = await request(app)
      .post(`/development/sessions/${failingId}/complete`)
      .send({ outcome: 'failed', error: 'Tests are red' })
      .expect(200);
    expect(explained.body.session.error).toBe('Tests are red');
  });

  it('tells the runner to stop when a person cancels the session', async () => {
    const app = setup();
    const id = await runningSession(app);
    const cancelled = await request(app)
      .post(`/development/sessions/${id}/cancel`)
      .set('x-test-anonymous', '1')
      .expect(200);
    expect(cancelled.body.session.events.at(-1).text).toBe('Cancelled by Unknown.');
    const reported = await request(app)
      .post(`/development/sessions/${id}/report`)
      .send({ usedTokens: 5 })
      .expect(200);
    expect(reported.body.directives.cancel).toBe(true);
    expect(reported.body.session.context.usedTokens).toBe(0);
    await request(app).post(`/development/sessions/${id}/cancel`).expect(409);
  });

  it('records chat messages and MCP calls in the events of the session worktree', async () => {
    const app = setup();
    const id = await runningSession(app);
    const post = (body: object) =>
      request(app).post(`/development/sessions/${id}/comments`).send(body).expect(201);
    const lastEvent = (session: { events: object[] }) => session.events.at(-1);

    // The agent's answer (through MCP) shows up as a message; one on a file as a tool call.
    expect(lastEvent((await post({ body: 'Done', author: 'agent' })).body.session)).toMatchObject({
      kind: 'message',
      text: 'Done',
    });
    expect(
      lastEvent(
        (await post({ body: 'Why?', author: 'agent', path: 'a.ts', line: 3 })).body.session,
      ),
    ).toMatchObject({ kind: 'tool', text: 'Commented on a.ts:3: Why?' });
    expect(lastEvent((await post({ body: 'Rename', path: 'b.ts' })).body.session)).toMatchObject({
      kind: 'tool',
      text: 'Alice commented on b.ts.',
    });

    // A chat message while the agent works is kept for its next look at the brief.
    expect(lastEvent((await post({ body: 'Ola' })).body.session)).toMatchObject({
      kind: 'feedback',
      text: expect.stringContaining('next checks the session brief'),
    });
    const diffed = await request(app)
      .put(`/development/sessions/${id}/diff`)
      .send({ files: [{ path: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '+a' }] })
      .expect(200);
    expect(lastEvent(diffed.body.session)).toMatchObject({
      kind: 'tool',
      text: 'Diff submitted: 1 file(s).',
    });
    const commentId = diffed.body.session.comments[0].id;
    const resolved = await request(app)
      .put(`/development/sessions/${id}/comments/${commentId}`)
      .send({ resolved: false })
      .expect(200);
    expect(lastEvent(resolved.body.session)).toMatchObject({ text: 'Review comment reopened.' });

    // Once the work is waiting for review, a chat message queues it again.
    await request(app)
      .post(`/development/sessions/${id}/complete`)
      .send({ outcome: 'succeeded' })
      .expect(200);
    const queued = await post({ body: 'One more thing' });
    expect(queued.body.session).toMatchObject({ status: 'queued', attempt: 2 });
    expect(lastEvent(queued.body.session)).toMatchObject({
      kind: 'feedback',
      text: expect.stringContaining('queued again'),
    });
    // Still queued: the agent reads it when it claims the session.
    expect(lastEvent((await post({ body: 'Again' })).body.session)).toMatchObject({
      text: expect.stringContaining('when it claims the session'),
    });

    // An approved session no longer reads messages, and the person is told so.
    await request(app).post(`/development/sessions/${id}/claim`).send({ runner: 'l' }).expect(200);
    await request(app)
      .post(`/development/sessions/${id}/complete`)
      .send({ outcome: 'succeeded' })
      .expect(200);
    await request(app)
      .post(`/development/sessions/${id}/review`)
      .send({ verdict: 'approve' })
      .expect(200);
    expect(lastEvent((await post({ body: 'Thanks' })).body.session)).toMatchObject({
      text: expect.stringContaining('already approved'),
    });
  });

  it('reviews the diff: comments, changes requested and approval', async () => {
    const app = setup();
    const id = await runningSession(app);
    await request(app)
      .post(`/development/sessions/${id}/review`)
      .send({ verdict: 'approve' })
      .expect(409);
    await request(app)
      .post(`/development/sessions/${id}/complete`)
      .send({ outcome: 'succeeded' })
      .expect(200);

    const commented = await request(app)
      .post(`/development/sessions/${id}/comments`)
      .send({ body: 'Handle the empty password', path: 'src/login.ts', line: 12 })
      .expect(201);
    const first = commented.body.session.comments[0];
    expect(first).toMatchObject({
      author: 'user',
      authorName: 'Alice',
      path: 'src/login.ts',
      line: 12,
      resolved: false,
    });
    const general = await request(app)
      .post(`/development/sessions/${id}/comments`)
      .send({ body: 'I covered it with a test', author: 'agent' })
      .expect(201);
    expect(general.body.session.comments[1]).toMatchObject({
      author: 'agent',
      path: null,
      line: null,
    });
    const resolved = await request(app)
      .put(`/development/sessions/${id}/comments/${general.body.session.comments[1].id}`)
      .send({ resolved: true })
      .expect(200);
    expect(
      resolved.body.session.comments.map((item: { resolved: boolean }) => item.resolved),
    ).toEqual([false, true]);
    await request(app)
      .put(`/development/sessions/${id}/comments/missing`)
      .send({ resolved: true })
      .expect(404);

    const sentBack = await request(app)
      .post(`/development/sessions/${id}/review`)
      .send({ verdict: 'request_changes', note: 'See the comment' })
      .expect(200);
    expect(sentBack.body.session).toMatchObject({
      status: 'queued',
      attempt: 2,
      reviewedBy: 'user-a',
    });
    expect(sentBack.body.session.events.at(-1)).toMatchObject({
      kind: 'feedback',
      text: 'Changes requested by Alice: See the comment',
    });
    const brief = await request(app).get(`/development/sessions/${id}/brief`).expect(200);
    expect(brief.body.feedback.map((item: { id: string }) => item.id)).toEqual([first.id]);

    for (const body of [{ runner: 'laptop' }])
      await request(app).post(`/development/sessions/${id}/claim`).send(body).expect(200);
    await request(app)
      .post(`/development/sessions/${id}/complete`)
      .send({ outcome: 'succeeded' })
      .expect(200);
    const again = await request(app)
      .post(`/development/sessions/${id}/review`)
      .send({ verdict: 'request_changes' })
      .expect(200);
    expect(again.body.session.events.at(-1).text).toBe('Changes requested by Alice.');
    await request(app).post(`/development/sessions/${id}/claim`).send({ runner: 'l' }).expect(200);
    await request(app)
      .post(`/development/sessions/${id}/complete`)
      .send({ outcome: 'succeeded' })
      .expect(200);
    const approved = await request(app)
      .post(`/development/sessions/${id}/review`)
      .send({ verdict: 'approve' })
      .expect(200);
    expect(approved.body.session).toMatchObject({ status: 'approved', reviewedBy: 'user-a' });
  });

  it('places every open change in its pipeline stage', async () => {
    const app = setup();
    await request(app).post('/development/changes').send({ title: 'Idea' }).expect(201);
    const proposed = await request(app).post('/development/changes').send({ title: 'Proposed' });
    await request(app)
      .post(`/development/changes/${proposed.body.change.id}/transition`)
      .send({ action: 'propose' });
    const waiting = await approvedChange(app, 'Waiting');
    const inReview = await approvedChange(app, 'In review');
    const reviewId = await runningSession(app, inReview);
    await request(app)
      .post(`/development/sessions/${reviewId}/complete`)
      .send({ outcome: 'succeeded' });
    const finished = await approvedChange(app, 'Finished');
    const finishedId = await runningSession(app, finished);
    await request(app)
      .post(`/development/sessions/${finishedId}/complete`)
      .send({ outcome: 'succeeded' });
    await request(app)
      .post(`/development/sessions/${finishedId}/review`)
      .send({ verdict: 'approve' });
    const rejected = await request(app).post('/development/changes').send({ title: 'Rejected' });
    for (const action of ['propose', 'reject'])
      await request(app)
        .post(`/development/changes/${rejected.body.change.id}/transition`)
        .send({ action });

    const { stages } = (await request(app).get('/development/pipeline').expect(200)).body;
    const titles = (stage: string) =>
      (stages[stage] as { title: string }[]).map((item) => item.title);
    expect(titles('spec')).toEqual(['Idea']);
    expect(titles('approval')).toEqual(['Proposed']);
    expect(titles('code')).toEqual(['Waiting']);
    expect(titles('review')).toEqual(['In review']);
    expect(titles('done')).toEqual(['Finished']);
    expect(stages.code[0]).toMatchObject({ changeId: waiting, session: null });
    expect(stages.review[0].session).toMatchObject({ id: reviewId, status: 'waiting_review' });
  });
});

describe('development domain', () => {
  const change = (fields: Partial<DevChange>): DevChange =>
    ({
      id: 'c1',
      slug: 'c',
      title: 'C',
      status: 'approved',
      artifacts: [],
      ...fields,
    }) as DevChange;
  const session = (fields: Partial<DevSession>): DevSession =>
    ({
      id: 's1',
      changeId: 'c1',
      status: 'running',
      attempt: 1,
      worktree: { branch: 'adk/c', baseBranch: 'main', path: null },
      createdAt: new Date(1),
      ...fields,
    }) as DevSession;

  it('builds slugs, folders, templates and task progress', () => {
    expect(slugify('  Olá, Mundo!  ')).toBe('ola-mundo');
    expect(slugify('!!!')).toBe('change');
    expect(changeFolder('openspec', 'a')).toBe('openspec/changes/a');
    expect(changeFolder('speckit', 'a')).toBe('specs/a');
    expect(changeFolder('custom', 'a')).toBe('changes/a');
    expect(templateArtifacts('speckit', 'a').map((artifact) => artifact.path)).toEqual([
      'specs/a/spec.md',
      'specs/a/plan.md',
      'specs/a/tasks.md',
    ]);
    expect(templateArtifacts('custom', 'a')).toEqual([]);
    expect(
      taskProgress([
        { id: '1', kind: 'tasks', path: 't', content: '- [x] a\n  * [X] b\n- [ ] c\ntext' },
        { id: '2', kind: 'proposal', path: 'p', content: '- [x] not a task' },
      ]),
    ).toEqual({ done: 2, total: 3 });
  });

  it('knows the allowed transitions and the directives of a session', () => {
    expect(nextChangeStatus('draft', 'propose')).toBe('proposed');
    expect(nextChangeStatus('archived', 'reopen')).toBeNull();
    const base = session({
      context: { windowTokens: 100, usedTokens: 79, compactAtPercent: 80, compactions: 0 },
      maxSubagents: 1,
      subagents: [{ id: 'a', name: 'A', role: '', status: 'done', summary: '', usedTokens: 0 }],
    });
    expect(sessionDirectives(base)).toEqual({
      compact: false,
      cancel: false,
      spawnSubagents: true,
    });
    expect(
      sessionDirectives({
        ...base,
        status: 'cancelled',
        context: { ...base.context, usedTokens: 80 },
      }),
    ).toMatchObject({ compact: true, cancel: true });
  });

  it('uses the latest session of a change for its stage', () => {
    const stages = buildPipeline(
      [change({}), change({ id: 'c2', title: 'Archived', status: 'archived' })],
      [
        session({ id: 'old', status: 'failed', createdAt: new Date(1) }),
        session({ id: 'new', status: 'waiting_review', attempt: 2, createdAt: new Date(2) }),
        session({ id: 'other', changeId: 'c9' }),
      ],
    );
    expect(stages.review).toEqual([
      expect.objectContaining({
        changeId: 'c1',
        session: { id: 'new', status: 'waiting_review', attempt: 2, branch: 'adk/c' },
      }),
    ]);
    expect(stages.code).toEqual([]);
  });
});

describe('development stores', () => {
  it('keeps the in-memory collections per workspace', async () => {
    const store = new InMemoryDevelopmentStore();
    const body = change();
    const created = await store.createChange('ws-1', body);
    await store.createChange('ws-2', body);
    expect(await store.listChanges('ws-1')).toHaveLength(1);
    await expect(store.getChange('ws-2', created.id)).resolves.toBeNull();
    await expect(store.updateChange('ws-2', created.id, body)).resolves.toBeNull();
    await expect(
      store.updateChange('ws-1', created.id, { ...body, title: 'New' }),
    ).resolves.toMatchObject({ title: 'New' });
    await expect(store.removeChange('ws-2', created.id)).resolves.toBe(false);
    await expect(store.removeChange('ws-1', created.id)).resolves.toBe(true);
    const second = await store.createSession('ws-1', sessionBody());
    await store.createSession('ws-1', sessionBody());
    expect(await store.listSessions('ws-1')).toHaveLength(2);
    await expect(store.getSession('ws-1', second.id)).resolves.toMatchObject({ id: second.id });
    await expect(store.updateSession('ws-1', 'missing', sessionBody())).resolves.toBeNull();
    await expect(store.removeSession('ws-1', second.id)).resolves.toBe(true);
  });

  it('maps Prisma rows and scopes every query by workspace', async () => {
    const stamp = { createdAt: new Date(1), updatedAt: new Date(2) };
    const changeRow = {
      id: 'c1',
      workspaceId: 'ws-1',
      slug: 'c',
      title: 'C',
      status: 'draft',
      data: change(),
      ...stamp,
    };
    const sessionRow = {
      id: 's1',
      workspaceId: 'ws-1',
      changeId: null,
      title: 'S',
      status: 'queued',
      data: sessionBody(),
      ...stamp,
    };
    const table = (row: object) => ({
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null),
      create: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
    });
    const developmentChangeRecord = table(changeRow);
    const developmentSessionRecord = table(sessionRow);
    const store = new PrismaDevelopmentStore({
      developmentChangeRecord,
      developmentSessionRecord,
    } as unknown as PrismaClient);

    expect(await store.listChanges('ws-1')).toEqual([
      expect.objectContaining({ id: 'c1', slug: 'c', framework: 'openspec', ...stamp }),
    ]);
    expect(developmentChangeRecord.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { updatedAt: 'desc' },
    });
    await store.createChange('ws-1', change());
    expect(developmentChangeRecord.create).toHaveBeenCalledWith({
      data: { workspaceId: 'ws-1', slug: 'c', title: 'C', status: 'draft', data: change() },
    });
    await expect(store.updateChange('ws-1', 'c1', change())).resolves.toMatchObject({ id: 'c1' });
    expect(developmentChangeRecord.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', id: 'c1' },
      data: { slug: 'c', title: 'C', status: 'draft', data: change() },
    });
    await expect(store.getChange('ws-1', 'missing')).resolves.toBeNull();
    await expect(store.updateChange('ws-1', 'missing', change())).resolves.toBeNull();
    await expect(store.removeChange('ws-1', 'c1')).resolves.toBe(true);
    await expect(store.removeChange('ws-1', 'missing')).resolves.toBe(false);

    expect(await store.listSessions('ws-1')).toEqual([
      expect.objectContaining({ id: 's1', changeId: null, cli: 'claude', ...stamp }),
    ]);
    await store.createSession('ws-1', sessionBody());
    expect(developmentSessionRecord.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        changeId: null,
        title: 'S',
        status: 'queued',
        data: sessionBody(),
      },
    });
    await expect(store.updateSession('ws-1', 's1', sessionBody())).resolves.toMatchObject({
      id: 's1',
    });
    await expect(store.getSession('ws-1', 'missing')).resolves.toBeNull();
    await expect(store.updateSession('ws-1', 'missing', sessionBody())).resolves.toBeNull();
    await expect(store.removeSession('ws-1', 's1')).resolves.toBe(true);
    await expect(store.removeSession('ws-1', 'missing')).resolves.toBe(false);
  });
});

function change() {
  return {
    slug: 'c',
    title: 'C',
    summary: '',
    framework: 'openspec' as const,
    status: 'draft' as const,
    artifacts: [],
    repository: null,
    specificationId: null,
    createdBy: null,
    decidedBy: null,
    decidedAt: null,
  };
}

function sessionBody() {
  return {
    changeId: null,
    pbiItemId: null,
    issueId: null,
    title: 'S',
    prompt: 'p',
    cli: 'claude' as const,
    agentId: null,
    agentIds: [],
    status: 'queued' as const,
    attempt: 1,
    repository: null,
    worktree: { branch: 'adk/s', baseBranch: 'main', path: null },
    context: { windowTokens: 1000, usedTokens: 0, compactAtPercent: 80, compactions: 0 },
    maxSubagents: 3,
    subagents: [],
    events: [],
    diff: [],
    comments: [],
    summary: '',
    error: null,
    runner: null,
    createdBy: null,
    reviewedBy: null,
  };
}
