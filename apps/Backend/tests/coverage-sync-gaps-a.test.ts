import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { GeminiLlmProvider } from '../src/modules/agents/adapters/gemini-llm.js';
import { OllamaLlmProvider } from '../src/modules/agents/adapters/ollama-llm.js';
import { auditedIssueStore, EntityAuditLog } from '../src/modules/audit/entity-audit.js';
import type { AuditPersistence } from '../src/modules/audit/audit.js';
import { FfmpegVideoTranscoder } from '../src/modules/e2e/adapters/ffmpeg-transcoder.js';
import type { IssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryEventBus } from '../src/modules/realtime/event-bus.js';
import { PostgresEventBus } from '../src/modules/realtime/postgres-event-bus.js';

describe('LLM providers with a request that was already cancelled', () => {
  const ok = (body: unknown) => async () => ({ ok: true, json: async () => body }) as Response;

  it('still answers through the fetcher, which decides what an aborted signal does', async () => {
    const ollama = new OllamaLlmProvider({ fetcher: ok({ response: 'from ollama' }) });
    expect((await ollama.complete({ prompt: 'p' }, AbortSignal.abort())).text).toBe('from ollama');

    const gemini = new GeminiLlmProvider({
      apiKey: 'key',
      fetcher: ok({ candidates: [{ content: { parts: [{ text: 'from gemini' }] } }] }),
    });
    expect((await gemini.complete({ prompt: 'p' }, AbortSignal.abort())).text).toBe('from gemini');
  });
});

describe('auditedIssueStore search', () => {
  it('hands the search to the wrapped store', async () => {
    const search = vi.fn(async () => ({ items: [], total: 0 }));
    const inner = { search } as unknown as IssueStore;
    const store = auditedIssueStore(
      inner,
      new EntityAuditLog({ run: vi.fn() } as unknown as AuditPersistence),
    );
    await store.search('ws', { query: 'x' } as never);
    expect(search).toHaveBeenCalledWith('ws', { query: 'x' });
  });
});

describe('FfmpegVideoTranscoder defaults', () => {
  it('builds without an executor, work folder or timeout', () => {
    expect(new FfmpegVideoTranscoder({ ffmpegPath: 'ffmpeg' })).toBeInstanceOf(
      FfmpegVideoTranscoder,
    );
  });
});

describe('InMemoryEventBus subscriptions', () => {
  it('keeps a workspace while another subscriber is left', () => {
    const bus = new InMemoryEventBus();
    const first = bus.subscribe('ws', vi.fn());
    const second = bus.subscribe('ws', vi.fn());
    first();
    expect(bus.subscriberCount('ws')).toBe(1);
    second();
    expect(bus.subscriberCount('ws')).toBe(0);
  });
});

describe('PostgresEventBus when closing the connection fails', () => {
  class Client extends EventEmitter {
    unblock: (() => void) | null = null;
    blockConnect = false;
    async connect() {
      if (this.blockConnect) await new Promise<void>((resolve) => (this.unblock = resolve));
    }
    async query() {}
    end(): Promise<void> {
      return Promise.reject(new Error('already closed'));
    }
  }
  const make = (client: Client) =>
    new PostgresEventBus({ createClient: () => client, resolve: async () => null, log: vi.fn() });

  it('closes quietly when ending the client fails', async () => {
    const bus = make(new Client());
    await bus.start();
    await expect(bus.close()).resolves.toBeUndefined();
  });

  it('drops a lost connection even when ending the client fails', async () => {
    const client = new Client();
    const bus = make(client);
    await bus.start();
    client.emit('error', new Error('reset'));
    await new Promise((resolve) => setImmediate(resolve));
    await bus.close();
  });

  it('ends a client that connected after the bus was closed', async () => {
    const client = new Client();
    client.blockConnect = true;
    const bus = make(client);
    const starting = bus.start();
    await new Promise((resolve) => setImmediate(resolve));
    const closing = bus.close();
    client.unblock?.();
    await starting;
    await closing;
  });
});
