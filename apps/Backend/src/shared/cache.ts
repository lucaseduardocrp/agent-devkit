import { Redis } from 'ioredis';

/** Key-value storage behind {@link Cache}: Redis when configured, else this process's memory. */
export interface CacheStore {
  readonly kind: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Increments a counter that never expires; versions use it to invalidate a scope. */
  incr(key: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Process-local store, bounded by the total size of its values: the oldest entries leave first.
 * Counters live apart from the values so eviction never resets a scope's version.
 */
export class MemoryCacheStore implements CacheStore {
  readonly kind = 'memory';
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly counters = new Map<string, number>();
  private size = 0;

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Promise<string | null> {
    const counter = this.counters.get(key);
    if (counter !== undefined) return Promise.resolve(String(counter));
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return Promise.resolve(null);
    }
    // Re-inserting keeps the map in least-recently-used order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.delete(key);
    if (value.length > this.maxBytes) return Promise.resolve();
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    this.size += value.length;
    for (const oldest of this.entries.keys()) {
      if (this.size <= this.maxBytes) break;
      this.delete(oldest);
    }
    return Promise.resolve();
  }

  incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }

  close(): Promise<void> {
    this.entries.clear();
    this.size = 0;
    return Promise.resolve();
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.size -= entry.value.length;
    this.entries.delete(key);
  }
}

/** Redis store; commands fail fast instead of queueing while Redis is unreachable. */
export class RedisCacheStore implements CacheStore {
  readonly kind = 'redis';
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      // Looks up IPv4 and IPv6: Railway's private network (redis.railway.internal) is IPv6 only,
      // and ioredis would otherwise resolve IPv4 alone.
      family: 0,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    // Connection errors surface on each command; this keeps them from crashing the process.
    this.client.on('error', () => undefined);
  }

  async get(key: string): Promise<string | null> {
    await this.ready();
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.ready();
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async incr(key: string): Promise<number> {
    await this.ready();
    return this.client.incr(key);
  }

  /**
   * Waits briefly for the first connection, which is still opening when the API starts serving.
   * While Redis is down (reconnecting) commands fail at once, so requests do not wait for it.
   */
  private async ready(): Promise<void> {
    if (this.client.status !== 'connecting' && this.client.status !== 'connect') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 500);
      this.client.once('ready', done);
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** JSON reviver that restores the Date fields of entities by name. */
export function reviveDates(...keys: string[]): (key: string, value: unknown) => unknown {
  const names = new Set(keys);
  return (key, value) =>
    names.has(key) && typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value;
}

/**
 * Read-through cache. Values live under a scope (e.g. one workspace's PBIs) and a version:
 * invalidating a scope bumps its version, so every value cached for it is skipped at once, on
 * every API instance sharing the store. A failing store never fails a request: the value is
 * loaded from its source instead. Concurrent misses of one key share a single load.
 */
export class Cache {
  private readonly loading = new Map<string, Promise<string>>();
  private warnedAt = 0;

  constructor(
    readonly store: CacheStore,
    private readonly prefix = 'adk',
  ) {}

  /** Cached text of `key` in `scope`, produced by `load` on a miss. */
  async text(
    scope: string,
    key: string,
    ttlSeconds: number,
    load: () => Promise<string>,
  ): Promise<string> {
    const version = await this.attempt(() => this.store.get(this.versionKey(scope)));
    // The store is unreachable: serve from the source, unshared.
    if (version === undefined) return load();
    const fullKey = `${this.prefix}:${scope}:${version ?? '0'}:${key}`;
    const cached = await this.attempt(() => this.store.get(fullKey));
    if (typeof cached === 'string') return cached;
    const pending = this.loading.get(fullKey);
    if (pending) return pending;
    const loaded = load().then(async (value) => {
      await this.attempt(() => this.store.set(fullKey, value, ttlSeconds));
      return value;
    });
    this.loading.set(fullKey, loaded);
    try {
      return await loaded;
    } finally {
      this.loading.delete(fullKey);
    }
  }

  /** Cached JSON value of `key` in `scope`; `reviver` restores what JSON cannot carry (Dates). */
  async json<T>(
    scope: string,
    key: string,
    ttlSeconds: number,
    load: () => Promise<T>,
    reviver?: (key: string, value: unknown) => unknown,
  ): Promise<T> {
    let loaded: { value: T } | null = null;
    const text = await this.text(scope, key, ttlSeconds, async () => {
      const value = await load();
      loaded = { value };
      return JSON.stringify(value) ?? 'null';
    });
    // A fresh load is returned as is; only values read back from the store are parsed.
    return loaded ? (loaded as { value: T }).value : (JSON.parse(text, reviver) as T);
  }

  /** Drops everything cached in `scope`. */
  async invalidate(scope: string): Promise<void> {
    await this.attempt(() => this.store.incr(this.versionKey(scope)));
  }

  close(): Promise<void> {
    return this.store.close();
  }

  private versionKey(scope: string): string {
    return `${this.prefix}:v:${scope}`;
  }

  private async attempt<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      // One warning a minute is enough to show the cache is degraded without flooding logs.
      if (Date.now() - this.warnedAt > 60_000) {
        this.warnedAt = Date.now();
        console.warn(
          `[Cache] ${this.store.kind} store unavailable, reading from the source:`,
          error instanceof Error ? error.message : error,
        );
      }
      return undefined;
    }
  }
}

/** A cache that keeps nothing: every read goes to the source. */
export function noCache(): Cache {
  return new Cache(new MemoryCacheStore(0));
}

/** Redis when REDIS_URL is set, else a cache in this process's memory. */
export function createCache(env: NodeJS.ProcessEnv = process.env): Cache {
  const url = env['REDIS_URL']?.trim();
  return new Cache(url ? new RedisCacheStore(url) : new MemoryCacheStore());
}
