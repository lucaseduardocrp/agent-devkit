import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { testCaseHistory, type AuditEvent } from '../src/modules/audit/audit.js';
import { withCaseIds } from '../src/modules/testplans/application/saved-test-plans.js';
import { InMemoryTestSuiteStore } from '../src/modules/testplans/application/test-suites.js';
import { resolveEffectiveAccess } from '../src/modules/workspaces/domain/permissions.js';

const step = { order: 1, action: 'Open', expectedResult: 'Opened' };
const testCase = (title: string, caseId?: string) => ({
  title,
  description: `Description of ${title}`,
  steps: [step],
  ...(caseId ? { metadata: { caseId, formattedDescription: 'x' } } : {}),
});

describe('test case IDs', () => {
  it('keeps unique IDs and replaces missing or duplicated ones', () => {
    const [first, second, third] = withCaseIds([
      testCase('A', 'a'),
      testCase('B', 'a'),
      testCase('C'),
    ]);
    expect(first?.metadata?.['caseId']).toBe('a');
    expect(second?.metadata?.['caseId']).toEqual(expect.any(String));
    expect(second?.metadata?.['caseId']).not.toBe('a');
    expect(third?.metadata).toEqual({ caseId: expect.any(String) });
  });
});

describe('test case history', () => {
  const event = (before: unknown, after: unknown): AuditEvent => ({
    id: 'e',
    workspaceId: 'ws',
    entityType: 'testplan',
    entityId: 'plan',
    action: 'update',
    actorId: 'alice',
    requestId: 'r',
    operation: 'PUT /TestPlan/plan',
    occurredAt: new Date().toISOString(),
    before,
    after,
  });

  it('keeps only events that changed the case and strips its metadata', () => {
    const plan = (...cases: unknown[]) => ({ title: 'Plan', plans: cases });
    const history = testCaseHistory(
      [
        event(plan(testCase('A2', 'a')), null),
        event(plan(testCase('A', 'a'), testCase('B', 'b')), plan(testCase('A2', 'a'))),
        event(plan(testCase('A', 'a')), plan(testCase('A', 'a'), testCase('B', 'b'))),
        event(null, plan(testCase('A', 'a'))),
        event({ plans: 'invalid' }, { plans: [null, 'x'] }),
      ],
      'a',
    );
    expect(history.map((item) => item.action)).toEqual(['delete', 'update', 'create']);
    expect(history[1]).toMatchObject({
      entityType: 'testcase',
      entityId: 'plan:a',
      before: { title: 'A' },
      after: { title: 'A2' },
    });
    expect(history[1]?.after).not.toHaveProperty('metadata');
  });

  it('serves the history of one case through the audit endpoint', async () => {
    const suites = new InMemoryTestSuiteStore();
    const suite = await suites.save({
      id: 'suite',
      workspaceId: 'ws',
      name: 'Suite',
      createdAt: '',
      updatedAt: '',
    });
    let context: Record<string, unknown> = {
      requestId: 'r',
      ownerId: 'ws',
      workspaceId: 'ws',
      actorId: 'alice',
    };
    const app = createApp({ testSuites: suites, requestContextResolver: () => context as never });
    const created = await request(app)
      .post('/TestPlan')
      .send({ title: 'Plan', suiteId: suite.id, plans: [testCase('Login'), testCase('Logout')] })
      .expect(201);
    const plan = created.body.savedPlan as {
      id: string;
      plans: { title: string; metadata: { caseId: string } }[];
    };
    const [login, logout] = plan.plans;
    await request(app)
      .put(`/TestPlan/${plan.id}`)
      .send({ plans: [{ ...login, title: 'Login v2' }, logout] })
      .expect(200);

    const history = await request(app)
      .get(`/audit/history?entityType=testcase&entityId=${plan.id}:${login!.metadata.caseId}`)
      .expect(200);
    expect(history.body.total).toBe(2);
    expect(history.body.items.map((item: AuditEvent) => item.action)).toEqual(['update', 'create']);
    expect(history.body.items[0].after.title).toBe('Login v2');
    const untouched = await request(app)
      .get(`/audit/history?entityType=testcase&entityId=${plan.id}:${logout!.metadata.caseId}`)
      .expect(200);
    expect(untouched.body.total).toBe(1);

    await request(app).get('/audit/history?entityType=testcase&entityId=only-plan').expect(400);
    await request(app).get('/audit/history?entityType=testcase').expect(400);

    context = {
      ...context,
      memberRole: 'MEMBER',
      access: resolveEffectiveAccess('MEMBER', {}, [{ modules: { pbis: 'view' } }]),
    };
    const denied = await request(app)
      .get(`/audit/history?entityType=testcase&entityId=${plan.id}:${logout!.metadata.caseId}`)
      .expect(403);
    expect(denied.body.code).toBe('MODULE_PERMISSION_DENIED');
  });
});
