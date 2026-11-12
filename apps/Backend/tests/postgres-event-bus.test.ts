import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PostgresEventBus,
  type PostgresEventBusOptions,
} from '../src/modules/realtime/postgres-event-bus.js';

class FakeClient extends EventEmitter {
  readonly queries: { sql: string; values: readonly unknown[] | undefined }[] = [];
  ended = false;
  connectError: Error | null = null;
  queryError: Error | null = null;
  async connect() {
    if (this.connectError) throw this.connectError;
  }
  async query(sql: string, values?: readonly unknown[]) {
    this.queries.push({ sql, values });
    if (this.queryError && sql.startsWith('SELECT')) throw this.queryError;
  }
  async end() {
    this.ended = true;
  }
  notify(payload: string | undefined) {
    this.emit('notification', { payload });
  }
}

function setup(overrides: Partial<PostgresEventBusOptions> = {}) {
  const clients: FakeClient[] = [];
  const resolve = vi.fn<NonNullable<PostgresEventBusOptions['resolve']>>(async (_w, _t, key) => ({
    id: key,
  }));
  const log = vi.fn();
  const bus = new PostgresEventBus({
    createClient: () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
    resolve,
    log,
    ...overrides,
  });
  const sent = () => clients[0]!.queries.filter((query) => query.sql.startsWith('SELECT'));
  return { bus, clients, resolve, log, sent };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('PostgresEventBus', () => {
  it('listens on its channel once started', async () => {
    const { bus, clients } = setup();
    await bus.start();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.queries[0]!.sql).toBe('LISTEN adk_realtime');
    await bus.close();

    const custom = setup({ channel: 'other_channel' });
    await custom.bus.start();
    expect(custom.clients[0]!.queries[0]!.sql).toBe('LISTEN other_channel');
    await custom.bus.close();
  });

  it('tells its own subscribers at once and the other processes with a pointer', async () => {
    const { bus, sent } = setup();
    await bus.start();
    const mine = vi.fn();
    bus.subscribe('ws-1', mine);
    bus.publish('ws-1', 'run', { id: 'r1', big: 'x'.repeat(20_000) }, 'r1');

    expect(mine).toHaveBeenCalledOnce();
    expect(mine.mock.calls[0]![0].data.id).toBe('r1');
    expect(sent()).toHaveLength(1);
    const [channel, payload] = sent()[0]!.values as [string, string];
    expect(channel).toBe('adk_realtime');
    // Never the data itself: NOTIFY is limited to 8 KB.
    expect(payload.length).toBeLessThan(300);
    expect(JSON.parse(payload)).toMatchObject({ w: 'ws-1', t: 'run', k: 'r1' });
    await bus.close();
  });

  it('does not notify without a key, nor before it is connected', async () => {
    const { bus, clients } = setup();
    bus.publish('ws-1', 'run', { id: 'early' }, 'early');
    await bus.start();
    bus.publish('ws-1', 'run', { id: 'no-key' });
    expect(clients[0]!.queries.filter((query) => query.sql.startsWith('SELECT'))).toHaveLength(0);
    await bus.close();
  });

  it('hands a change of another process to its subscribers, read from the database', async () => {
    const { bus, clients, resolve } = setup();
    await bus.start();
    const mine = vi.fn();
    const elsewhere = vi.fn();
    bus.subscribe('ws-1', mine);
    bus.subscribe('ws-2', elsewhere);

    clients[0]!.notify(JSON.stringify({ o: 'another-process', w: 'ws-1', t: 'run', k: 'r9' }));
    await flush();

    expect(resolve).toHaveBeenCalledWith('ws-1', 'run', 'r9');
    expect(mine).toHaveBeenCalledOnce();
    expect(mine.mock.calls[0]![0]).toMatchObject({
      type: 'run',
      workspaceId: 'ws-1',
      data: { id: 'r9' },
    });
    expect(elsewhere).not.toHaveBeenCalled();
    await bus.close();
  });

  it('does not hear itself, and skips what it cannot use', async () => {
    const { bus, clients, resolve, log, sent } = setup();
    await bus.start();
    const mine = vi.fn();
    bus.subscribe('ws-1', mine);
    bus.publish('ws-1', 'run', { id: 'r1' }, 'r1');
    mine.mockClear();

    // Its own notification coming back is ignored.
    clients[0]!.notify((sent()[0]!.values as string[])[1]);
    clients[0]!.notify('not json');
    clients[0]!.notify(undefined);
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(mine).not.toHaveBeenCalled();

    // A change whose data no longer exists is dropped; a failed read is logged.
    resolve.mockResolvedValueOnce(null);
    clients[0]!.notify(JSON.stringify({ o: 'x', w: 'ws-1', t: 'run', k: 'gone' }));
    await flush();
    expect(mine).not.toHaveBeenCalled();
    resolve.mockRejectedValueOnce(new Error('db down'));
    clients[0]!.notify(JSON.stringify({ o: 'x', w: 'ws-1', t: 'run', k: 'broken' }));
    await flush();
    expect(log).toHaveBeenCalledWith(
      '[EventBus] Could not read a remote change:',
      expect.any(Error),
    );
    await bus.close();
  });

  it('delivers changes of the same run in order even when an earlier read is slower', async () => {
    const { bus, clients, resolve } = setup();
    await bus.start();
    const order: string[] = [];
    bus.subscribe('ws-1', (event) => order.push((event.data as { v: string }).v));
    let release!: (value: unknown) => void;
    const slow = new Promise<unknown>((resolve) => (release = resolve));
    let reads = 0;
    resolve.mockImplementation(async (_workspace, _type, key) => {
      if (key === 'r2') return { v: 'other-run' };
      reads += 1;
      return reads === 1 ? slow : { v: 'second' };
    });

    clients[0]!.notify(JSON.stringify({ o: 'x', w: 'ws-1', t: 'run', k: 'r1' }));
    clients[0]!.notify(JSON.stringify({ o: 'x', w: 'ws-1', t: 'run', k: 'r1' }));
    // A different run does not wait for the first one.
    clients[0]!.notify(JSON.stringify({ o: 'x', w: 'ws-1', t: 'run', k: 'r2' }));
    await flush();
    expect(order).toEqual(['other-run']);

    release({ v: 'first' });
    await flush();
    expect(order).toEqual(['other-run', 'first', 'second']);
    await bus.close();
  });

  it('logs a notification that could not be sent, without failing the publisher', async () => {
    const { bus, clients, log } = setup();
    await bus.start();
    clients[0]!.queryError = new Error('connection reset');
    expect(() => bus.publish('ws-1', 'run', {}, 'r1')).not.toThrow();
    await flush();
    expect(log).toHaveBeenCalledWith(
      '[EventBus] Could not notify the other processes:',
      expect.any(Error),
    );
    await bus.close();
  });

  it('falls back to the console when no logger is given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bus, clients } = setup({ log: undefined });
    await bus.start();
    clients[0]!.queryError = new Error('x');
    bus.publish('ws-1', 'run', {}, 'r1');
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    await bus.close();
  });

  it('stops delivering to a subscriber that left', async () => {
    const { bus, clients } = setup();
    await bus.start();
    const listener = vi.fn();
    const stop = bus.subscribe('ws-1', listener);
    stop();
    clients[0]!.notify(JSON.stringify({ o: 'x', w: 'ws-1', t: 'run', k: 'r1' }));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    await bus.close();
  });
});

describe('PostgresEventBus connection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconnects with a growing delay and listens again', async () => {
    const { bus, clients, log } = setup();
    await bus.start();
    expect(clients).toHaveLength(1);

    clients[0]!.emit('error', new Error('terminated'));
    // error and end of the same connection reconnect only once
    clients[0]!.emit('end');
    expect(clients[0]!.ended).toBe(true);
    expect(log).toHaveBeenCalledWith(
      '[EventBus] Lost the connection to Postgres:',
      expect.any(Error),
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.queries[0]!.sql).toBe('LISTEN adk_realtime');

    // Heard again, and the delay starts over after a good connection.
    const mine = vi.fn();
    bus.subscribe('ws-1', mine);
    clients[1]!.notify(JSON.stringify({ o: 'x', w: 'ws-1', t: 'run', k: 'r1' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mine).toHaveBeenCalledOnce();
    clients[1]!.emit('end');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(3);
    await bus.close();
  });

  it('keeps retrying when the first connection fails, never waiting beyond the limit', async () => {
    const attempts: FakeClient[] = [];
    const { bus } = setup({
      retryMs: 100,
      maxRetryMs: 250,
      createClient: () => {
        const client = new FakeClient();
        client.connectError = new Error('refused');
        attempts.push(client);
        return client;
      },
    });
    await bus.start();
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toHaveLength(3);
    // 400 would be next, but the limit is 250.
    await vi.advanceTimersByTimeAsync(249);
    expect(attempts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(4);
    await bus.close();
  });

  it('stops for good when closed, even in the middle of connecting', async () => {
    const { bus, clients } = setup();
    await bus.start();
    await bus.close();
    expect(clients[0]!.ended).toBe(true);
    await bus.close();

    // Closed while the connection was being made: that connection is dropped.
    const late = setup();
    const connecting = late.bus.start();
    await late.bus.close();
    await connecting;
    expect(late.clients[0]!.ended).toBe(true);
    late.clients[0]!.emit('end');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late.clients).toHaveLength(1);
    // And a closed bus does not start again.
    await late.bus.start();
    expect(late.clients).toHaveLength(1);
  });
});
