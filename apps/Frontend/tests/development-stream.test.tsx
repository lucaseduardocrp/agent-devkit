import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';
import type { DevChange } from '../src/features/development/development-types.js';
import { click, mockClient, renderView, session, show } from './helpers/development.js';

const encoder = new TextEncoder();

/** A response whose body delivers the given chunks, like a server writing to an open stream. */
function stream(chunks: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as Response;
}

const change = (fields: Partial<DevChange> = {}): DevChange => ({
  id: 'c1',
  slug: 'add-login',
  title: 'Add login',
  summary: '',
  framework: 'openspec',
  status: 'draft',
  artifacts: [],
  repository: null,
  specificationId: null,
  updatedAt: '2026-11-10T10:00:00.000Z',
  ...fields,
});

describe('ApiClient development stream', () => {
  it('follows the changes and sessions of the workspace and reads them by id', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        stream([
          'retry: 3000\n\nevent: ready\ndata: {}\n\n',
          'event: development\ndata: {"kind":"session","id":"s1"}\n\n',
          ': keep-alive\n\nevent: development\ndata: {"kind":"change","id":"c1","dele',
          'ted":true}\n\nevent: development\ndata: not json\n\nevent: run\ndata: {"id":"x"}\n\n',
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session: { id: 's/1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ change: { id: 'c1' } }),
      });
    const client = new ApiClient({ fetcher, baseUrl: 'http://adk.test', token: 'secret' });
    client.setWorkspaceId('ws-1');
    const handlers = { onReady: vi.fn(), onRun: vi.fn() };
    const controller = new AbortController();

    await client.streamDevelopmentEvents(handlers, controller.signal);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://adk.test/development/stream');
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer secret',
      'x-workspace-id': 'ws-1',
    });
    expect(handlers.onReady).toHaveBeenCalledOnce();
    expect(handlers.onRun.mock.calls.map(([event]) => event)).toEqual([
      { kind: 'session', id: 's1' },
      { kind: 'change', id: 'c1', deleted: true },
    ]);

    expect(await client.getDevelopmentSession('s/1')).toEqual({ id: 's/1' });
    expect(fetcher.mock.calls[1]![0]).toBe('http://adk.test/development/sessions/s%2F1');
    expect(await client.getDevelopmentChange('c1')).toEqual({ id: 'c1' });
    expect(fetcher.mock.calls[2]![0]).toBe('http://adk.test/development/changes/c1');
  });

  it('rejects when the stream is refused or has no body', async () => {
    const refused = {
      ok: false,
      status: 403,
      json: () => Promise.resolve({ message: 'No access to development.' }),
    } as Response;
    const handlers = { onReady: vi.fn(), onRun: vi.fn() };
    await expect(
      new ApiClient({ fetcher: vi.fn().mockResolvedValue(refused) }).streamDevelopmentEvents(
        handlers,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ApiClientError);
    await expect(
      new ApiClient({
        fetcher: vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }),
      }).streamDevelopmentEvents(handlers, new AbortController().signal),
    ).rejects.toThrow();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Development screens follow the server live', () => {
  it('opens the stream, loads on connect and shows no title or refresh in Code', async () => {
    const { api, stream: live } = mockClient([session({ status: 'running' })]);
    await show(api);
    await waitFor(() => expect(live.opened).toBe(1));
    expect(screen.queryByRole('heading', { name: 'Code' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Atualizar' })).toBeNull();

    const loads = api.getDevelopmentSessions.mock.calls.length;
    await act(async () => live.ready());
    await waitFor(() => expect(api.getDevelopmentSessions.mock.calls.length).toBe(loads + 1));
  });

  it('shows no refresh in Artifacts or Review, which follow the stream too', async () => {
    const { api, stream: live } = mockClient([], [change()]);
    await show(api, { section: 'artifacts' });
    expect(screen.queryByRole('button', { name: 'Atualizar' })).toBeNull();

    api.getDevelopmentChange.mockResolvedValue(change({ id: 'c2', title: 'Second change' }));
    await act(async () => live.event({ kind: 'change', id: 'c2' }));
    expect(await screen.findByText('Second change')).toBeInTheDocument();
    api.getDevelopmentChange.mockResolvedValue(change({ id: 'c2', title: 'Renamed change' }));
    await act(async () => live.event({ kind: 'change', id: 'c2' }));
    expect(await screen.findByText('Renamed change')).toBeInTheDocument();
    expect(screen.queryByText('Second change')).toBeNull();

    await act(async () => live.event({ kind: 'change', id: 'c2', deleted: true }));
    await waitFor(() => expect(screen.queryByText('Renamed change')).toBeNull());
    expect(screen.getByText('Add login')).toBeInTheDocument();
  });

  it('puts a session where it belongs as it moves, and takes it out when it is deleted', async () => {
    const { api, stream: live } = mockClient([session()]);
    await show(api);
    click(/Implement login/);
    expect(screen.getAllByText('Aguardando revisão').length).toBeGreaterThan(0);

    api.getDevelopmentSession.mockResolvedValue(session({ status: 'running' }));
    await act(async () => live.event({ kind: 'session', id: 's1' }));
    await waitFor(() => expect(screen.getAllByText('Em execução').length).toBeGreaterThan(0));

    api.getDevelopmentSession.mockResolvedValue(session({ id: 's2', title: 'Second session' }));
    await act(async () => live.event({ kind: 'session', id: 's2' }));
    click('Ver sessões');
    expect(await screen.findByText('Second session')).toBeInTheDocument();

    await act(async () => live.event({ kind: 'session', id: 's2', deleted: true }));
    await waitFor(() => expect(screen.queryByText('Second session')).toBeNull());
    expect(screen.getByText('Implement login')).toBeInTheDocument();
  });

  it('reads the pipeline again once a burst of events settles', async () => {
    vi.useFakeTimers();
    const { api, stream: live } = mockClient([session()]);
    api.getDevelopmentSession.mockResolvedValue(session());
    renderView(api);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const before = api.getDevelopmentPipeline.mock.calls.length;
    await act(async () => {
      live.event({ kind: 'session', id: 's1' });
      live.event({ kind: 'session', id: 's1' });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(api.getDevelopmentPipeline.mock.calls.length).toBe(before);
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(api.getDevelopmentPipeline.mock.calls.length).toBe(before + 1);

    api.getDevelopmentPipeline.mockRejectedValueOnce(new Error('busy'));
    await act(async () => {
      live.event({ kind: 'session', id: 's1' });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(api.getDevelopmentPipeline.mock.calls.length).toBe(before + 2);
  });

  it('loads everything again when an item cannot be read', async () => {
    const { api, stream: live } = mockClient([session()]);
    await show(api);
    api.getDevelopmentSession.mockRejectedValue(new Error('gone'));
    const loads = api.getDevelopmentSessions.mock.calls.length;
    await act(async () => live.event({ kind: 'session', id: 's9' }));
    await waitFor(() => expect(api.getDevelopmentSessions.mock.calls.length).toBe(loads + 1));
  });

  it('reconciles once a minute while live, and polls while offline with a runner at work', async () => {
    vi.useFakeTimers();
    const { api, stream: live } = mockClient([session({ status: 'running' })]);
    renderView(api);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    // Not live yet (the server has not said ready): the runner is polled every few seconds.
    const polled = api.getDevelopmentSessions.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.getDevelopmentSessions.mock.calls.length).toBe(polled + 1);

    await act(async () => live.ready());
    const live1 = api.getDevelopmentSessions.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.getDevelopmentSessions.mock.calls.length).toBe(live1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.getDevelopmentSessions.mock.calls.length).toBe(live1 + 1);
  });

  it('does not open the stream without a workspace, and closes it on leaving', async () => {
    const { api, stream: live } = mockClient();
    const none = await show(api, { workspaceId: null });
    expect(live.opened).toBe(0);
    none.unmount();

    const open = await show(api);
    await waitFor(() => expect(live.opened).toBe(1));
    open.unmount();
    expect(live.signal?.aborted).toBe(true);
  });
});
