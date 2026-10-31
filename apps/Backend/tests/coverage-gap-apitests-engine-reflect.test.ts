import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun } from '../src/modules/apitests/engine/run-executor.js';
import type {
  ApiRequestSpec,
  CollectionSpec,
  GrpcServiceList,
  RunPayload,
} from '../src/modules/apitests/engine/types.js';
import { GREETER_PROTO, echoServer } from './apitests-stream-servers.js';

const request = (
  overrides: Partial<ApiRequestSpec> & Pick<ApiRequestSpec, 'id' | 'url'>,
): ApiRequestSpec => ({
  type: 'request',
  name: overrides.id,
  method: 'GET',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

const hooks = () => ({ report: async () => 'running' as const, heartbeatMs: 60_000 });

const grpcCollection = (grpc: ApiRequestSpec['grpc']): CollectionSpec => ({
  name: 'Grpc',
  variables: [],
  auth: { type: 'none' },
  protoFiles: [{ name: 'demo.proto', content: GREETER_PROTO }],
  items: [{ ...request({ id: 'r', url: 'grpc://127.0.0.1:1' }), kind: 'grpc', ...(grpc ? { grpc } : {}) }],
});

describe('describing a gRPC request through a run', () => {
  it('answers the service list as the result body', async () => {
    const outcome = await executeRun(
      {
        kind: 'integration',
        collection: grpcCollection({
          method: 'demo.v1.Greeter/Say',
          message: '{}',
          protoFile: 'demo.proto',
        }),
        environment: [{ key: 'a', value: '1' }],
        itemIds: ['r'],
        bail: false,
        mode: 'grpc-reflect',
        runtime: { variables: [], cookies: [] },
      },
      hooks(),
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.result?.passed).toBe(1);
    const body = outcome.result && 'results' in outcome.result
      ? outcome.result.results[0]?.response?.bodyPreview
      : undefined;
    const list = JSON.parse(String(body)) as GrpcServiceList;
    expect(list.services.map((service) => service.name)).toContain('demo.v1.Greeter');
  });

  it('reports a description that failed as a failed run', async () => {
    const outcome = await executeRun(
      {
        kind: 'integration',
        collection: {
          name: 'Plain',
          variables: [],
          auth: { type: 'none' },
          items: [request({ id: 'r', url: 'http://api.test/' })],
        },
        environment: [],
        itemIds: ['r'],
        bail: false,
        mode: 'grpc-reflect',
      },
      hooks(),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.result && 'results' in outcome.result ? outcome.result.results[0]?.error : '').toBe(
      'Choose a gRPC request.',
    );
  });

  it('reports a guard rejection as the error text', async () => {
    // No protoFile: the request asks the server itself (reflection), so describing it connects
    // and the guard runs before anything is sent.
    const outcome = await executeRun(
      {
        kind: 'integration',
        collection: grpcCollection({ method: 'demo.v1.Greeter/Say', message: '{}' }),
        environment: [],
        itemIds: ['r'],
        bail: false,
        mode: 'grpc-reflect',
      },
      {
        report: async () => 'running' as const,
        heartbeatMs: 60_000,
        guard: () => Promise.reject('blocked by policy'),
      },
    );
    expect(outcome.status).toBe('failed');
    expect(
      outcome.result && 'results' in outcome.result ? outcome.result.results[0]?.error : undefined,
    ).toBe('blocked by policy');
  });

  it('reports a selection with no request at all as an error', async () => {
    const outcome = await executeRun(
      {
        kind: 'integration',
        collection: { name: 'Empty', variables: [], auth: { type: 'none' }, items: [] },
        environment: [],
        itemIds: [],
        bail: false,
        mode: 'grpc-reflect',
      },
      hooks(),
    );
    expect(outcome.status).toBe('error');
    expect(outcome.error).toBe('There is no gRPC request to describe.');
  });
});

describe('the options a run carries through', () => {
  let server: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    server = await echoServer();
  });
  afterAll(() => server.close());

  const payload = (extra: Partial<Extract<RunPayload, { kind: 'integration' }>>) =>
    ({
      kind: 'integration',
      collection: {
        name: 'Run',
        variables: [],
        auth: { type: 'none' },
        items: [request({ id: 'r', url: server.url })],
      },
      environment: [],
      itemIds: ['r'],
      bail: false,
      ...extra,
    }) satisfies RunPayload;

  it('passes the environment name, the iterations, the rows, the delay and the preview size', async () => {
    const outcome = await executeRun(
      payload({
        environmentName: 'Local',
        iterations: 2,
        data: [{ who: 'a' }, { who: 'b' }],
        delayMs: 1,
        previewBytes: 8,
        runtime: { variables: [], cookies: [] },
      }),
      hooks(),
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.result && 'results' in outcome.result ? outcome.result.results.length : 0).toBe(2);
  });

  it('runs with none of the optional settings', async () => {
    const outcome = await executeRun(payload({}), hooks());
    expect(outcome.status).toBe('passed');
  });

  it('stops the run when the heartbeat answers that it was stopped', async () => {
    const outcome = await executeRun(payload({ iterations: 1 }), {
      report: async () => 'stopped' as const,
      heartbeatMs: 1,
    });
    expect(['passed', 'failed', 'error']).toContain(outcome.status);
  });

  it('counts a skipped request in the heartbeat progress', async () => {
    let slow: http.Server | undefined;
    const slowPort = await new Promise<number>((resolve) => {
      slow = http.createServer((_request, response) => {
        setTimeout(() => {
          response.writeHead(200);
          response.end();
        }, 100);
      });
      slow.listen(0, '127.0.0.1', () => resolve((slow!.address() as AddressInfo).port));
    });
    try {
      const reports: unknown[] = [];
      const outcome = await executeRun(
        {
          kind: 'integration',
          collection: {
            name: 'Skip',
            variables: [],
            auth: { type: 'none' },
            items: [
              request({
                id: 'skipped',
                url: server.url,
                scripts: { preRequest: 'adk.runner.skipRequest();' },
              }),
              request({ id: 'slow', url: `http://127.0.0.1:${slowPort}/` }),
            ],
          },
          environment: [],
          itemIds: ['skipped', 'slow'],
          bail: false,
        },
        {
          report: async (partial) => {
            reports.push(partial);
            return 'running' as const;
          },
          heartbeatMs: 10,
        },
      );
      expect(outcome.status).toBe('passed');
      const withSkip = reports.find(
        (partial): partial is { skipped?: number } =>
          Boolean(partial) && typeof partial === 'object' && 'skipped' in (partial as object),
      );
      expect(withSkip).toMatchObject({ skipped: 1 });
    } finally {
      await new Promise<void>((resolve) => slow?.close(() => resolve()));
    }
  });
});
