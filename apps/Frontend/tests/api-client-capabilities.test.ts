import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';

const answer = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

describe('ApiClient.getCapabilities', () => {
  it('reads what the server can do and where runs execute by default', async () => {
    const fetcher = answer(200, { workersReachLocalhost: true, defaultExecutionTarget: 'local' });
    const client = new ApiClient({ fetcher, baseUrl: 'http://adk.test' });
    expect(await client.getCapabilities()).toEqual({
      workersReachLocalhost: true,
      defaultExecutionTarget: 'local',
    });
    expect(fetcher.mock.calls[0]![0]).toBe('http://adk.test/capabilities');
  });

  it('falls back to the safe values for a server that does not say', async () => {
    expect(await new ApiClient({ fetcher: answer(200, {}) }).getCapabilities()).toEqual({
      workersReachLocalhost: false,
      defaultExecutionTarget: 'remote',
    });
    expect(
      await new ApiClient({
        fetcher: answer(200, { defaultExecutionTarget: 'something-else' }),
      }).getCapabilities(),
    ).toMatchObject({ defaultExecutionTarget: 'remote' });
    // An older server answers 404: it has none of the capabilities.
    expect(await new ApiClient({ fetcher: answer(404) }).getCapabilities()).toEqual({
      workersReachLocalhost: false,
      defaultExecutionTarget: 'remote',
    });
  });
});
