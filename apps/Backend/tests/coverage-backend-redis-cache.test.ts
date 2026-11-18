import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const instances: FakeRedis[] = [];

class FakeRedis extends EventEmitter {
  status = 'ready';
  readonly store = new Map<string, string>();
  readonly options: Record<string, unknown>;
  quit = vi.fn().mockResolvedValue('OK');
  disconnect = vi.fn();
  get = vi.fn(async (key: string) => this.store.get(key) ?? null);
  set = vi.fn(async (key: string, value: string) => {
    this.store.set(key, value);
    return 'OK';
  });
  incr = vi.fn(async (key: string) => {
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(next));
    return next;
  });

  constructor(
    readonly url: string,
    options: Record<string, unknown>,
  ) {
    super();
    this.options = options;
    instances.push(this);
  }
}

vi.mock('ioredis', () => ({ Redis: FakeRedis }));

const { RedisCacheStore } = await import('../src/shared/cache.js');

describe('RedisCacheStore', () => {
  beforeEach(() => {
    instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects with fail-fast options and swallows connection errors', () => {
    new RedisCacheStore('redis://cache:6379');
    const [client] = instances;
    expect(client?.url).toBe('redis://cache:6379');
    expect(client?.options).toMatchObject({
      family: 0,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    expect(() => client?.emit('error', new Error('down'))).not.toThrow();
  });

  it('reads, writes with an expiry and counts through the client', async () => {
    const store = new RedisCacheStore('redis://cache');
    const client = instances[0]!;
    expect(store.kind).toBe('redis');
    expect(await store.get('missing')).toBeNull();
    await store.set('k', 'v', 30);
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 30);
    expect(await store.get('k')).toBe('v');
    expect(await store.incr('counter')).toBe(1);
    expect(await store.incr('counter')).toBe(2);
  });

  it('waits for the first connection and goes on once Redis is ready', async () => {
    const store = new RedisCacheStore('redis://cache');
    const client = instances[0]!;
    client.status = 'connecting';
    const pending = store.get('k');
    await Promise.resolve();
    expect(client.get).not.toHaveBeenCalled();
    client.emit('ready');
    await pending;
    expect(client.get).toHaveBeenCalledWith('k');
  });

  it('stops waiting for the first connection after half a second', async () => {
    vi.useFakeTimers();
    const store = new RedisCacheStore('redis://cache');
    const client = instances[0]!;
    client.status = 'connect';
    const pending = store.set('k', 'v', 5);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 5);
  });

  it('does not wait while Redis is reconnecting', async () => {
    const store = new RedisCacheStore('redis://cache');
    const client = instances[0]!;
    client.status = 'reconnecting';
    await store.get('k');
    expect(client.get).toHaveBeenCalled();
  });

  it('quits on close and disconnects when quitting fails', async () => {
    const store = new RedisCacheStore('redis://cache');
    const client = instances[0]!;
    await store.close();
    expect(client.quit).toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    client.quit.mockRejectedValueOnce(new Error('closed'));
    await store.close();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
