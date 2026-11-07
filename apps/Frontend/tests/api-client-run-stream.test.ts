import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';
import type { AgentRunEvent } from '../src/features/issues/issue-types.js';

const encoder = new TextEncoder();

/** A response whose body delivers the given chunks, like a server writing to an open stream. */
function stream(chunks: readonly string[], init: { ok?: boolean; status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: init.ok ?? true, status: init.status ?? 200, body } as Response;
}

function handlers() {
  return { onReady: vi.fn(), onRun: vi.fn<(run: AgentRunEvent) => void>() };
}

describe('ApiClient.streamRunEvents', () => {
  it('opens the stream with the session and the workspace, and reports ready and runs', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      stream([
        'retry: 3000\n\nevent: ready\ndata: {}\n\n',
        'event: run\ndata: {"id":"r1","status":"queued"}\n\n',
        ': keep-alive\n\nevent: run\ndata: {"id":"r1","sta',
        'tus":"running"}\n\n',
      ]),
    );
    const client = new ApiClient({ fetcher, baseUrl: 'http://adk.test', token: 'secret' });
    client.setWorkspaceId('ws-1');
    const given = handlers();
    const controller = new AbortController();

    await client.streamRunEvents(given, controller.signal);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://adk.test/runs/stream');
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer secret',
      'x-workspace-id': 'ws-1',
    });
    expect(given.onReady).toHaveBeenCalledOnce();
    expect(given.onRun.mock.calls.map(([run]) => run.status)).toEqual(['queued', 'running']);
  });

  it('skips a malformed event and events it does not know', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        stream([
          'event: run\ndata: not json\n\nevent: other\ndata: {"id":"x"}\n\nevent: run\ndata: {"id":"ok"}\n\n',
        ]),
      );
    const given = handlers();
    await new ApiClient({ fetcher }).streamRunEvents(given, new AbortController().signal);
    expect(given.onRun.mock.calls.map(([run]) => run.id)).toEqual(['ok']);
    expect(given.onReady).not.toHaveBeenCalled();
  });

  it('rejects when the server refuses the stream', async () => {
    const refused = {
      ok: false,
      status: 403,
      json: async () => ({ message: 'No access to issues.' }),
    } as Response;
    const client = new ApiClient({ fetcher: vi.fn().mockResolvedValue(refused) });
    await expect(
      client.streamRunEvents(handlers(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it('rejects when the response has no body to read', async () => {
    const client = new ApiClient({
      fetcher: vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }),
    });
    await expect(client.streamRunEvents(handlers(), new AbortController().signal)).rejects.toThrow();
  });
});
