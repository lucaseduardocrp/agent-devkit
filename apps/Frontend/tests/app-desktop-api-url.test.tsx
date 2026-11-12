import { afterEach, describe, expect, it, vi } from 'vitest';

// Options of every ApiClient built while the App module loads, so the default client can be read.
const created = vi.hoisted(() => [] as unknown[]);

vi.mock('../src/lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api-client.js')>();
  class RecordingApiClient extends actual.ApiClient {
    public constructor(...args: ConstructorParameters<typeof actual.ApiClient>) {
      super(...args);
      created.push(args[0]);
    }
  }
  return { ...actual, ApiClient: RecordingApiClient };
});

describe('App default API client', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'adkDesktop');
    created.length = 0;
  });

  it('talks to the API the desktop app started', async () => {
    Object.defineProperty(window, 'adkDesktop', {
      value: { apiUrl: 'http://127.0.0.1:4321' },
      configurable: true,
    });
    vi.resetModules();

    await import('../src/App.js');

    expect(created).toContainEqual({ baseUrl: 'http://127.0.0.1:4321' });
  });
});
