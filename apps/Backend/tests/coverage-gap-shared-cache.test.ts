import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const clients: FakeRedis[] = [];

class FakeRedis extends EventEmitter {
  status = 'connecting';
  readonly values = new Map<string, string>();
  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    super();
    clients.push(this);
  }
  get(key: string) {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }
  incr(key: string) {
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(next));
    return Promise.resolve(next);
  }
  quit() {
    return Promise.resolve('OK');
  }
  disconnect() {}
}

vi.mock('ioredis', () => ({ Redis: FakeRedis }));

const { Cache, MemoryCacheStore, RedisCacheStore } = await import('../src/shared/cache.js');

describe('Redis cache store', () => {
  it('waits for the first connection, then runs commands at once', async () => {
    vi.useFakeTimers();
    try {
      const store = new RedisCacheStore('redis://cache:6379');
      const client = clients.at(-1)!;
      expect(client.listenerCount('error')).toBe(1);
      client.emit('error', new Error('ignored'));
      // Still connecting: the command waits until the connection is ready.
      const pending = store.set('k', 'v', 10);
      client.status = 'ready';
      client.emit('ready');
      await pending;
      expect(await store.get('k')).toBe('v');
      // Connecting again: waits at most half a second.
      client.status = 'connect';
      const counter = store.incr('n');
      await vi.advanceTimersByTimeAsync(500);
      expect(await counter).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Cache edges', () => {
  it('caches undefined values as JSON null', async () => {
    const cache = new Cache(new MemoryCacheStore());
    expect(await cache.json('s', 'k', 60, async () => undefined)).toBeUndefined();
    expect(await cache.json('s', 'k', 60, async () => 'unused')).toBeNull();
  });

  it('warns with whatever a failing store throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryCacheStore();
    vi.spyOn(store, 'get').mockRejectedValue('offline');
    const cache = new Cache(store);
    expect(await cache.text('s', 'k', 60, async () => 'fresh')).toBe('fresh');
    expect(warn).toHaveBeenCalledWith(
      '[Cache] memory store unavailable, reading from the source:',
      'offline',
    );
    warn.mockRestore();
  });
});
