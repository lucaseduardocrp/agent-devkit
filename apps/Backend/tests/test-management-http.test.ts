import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderHttp,
  basicAuth,
  parsePositiveId,
  requireText,
} from '../src/modules/test-management/adapters/provider-http.js';

function response(body: string | null, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

function fakeFetch(...answers: (Response | Error)[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = answers.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return next;
  });
}

function init(fetcher: ReturnType<typeof fakeFetch>, call = 0): RequestInit {
  return fetcher.mock.calls[call]![1]!;
}

describe('ProviderHttp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends JSON requests and parses the answer with its headers', async () => {
    const fetcher = fakeFetch(response('{"ok":true}', 200, { 'x-page': '2' }));
    const http = new ProviderHttp('Demo', fetcher, { timeoutMs: 5_000, retryDelayMs: 0 });
    const result = await http.request<{ ok: boolean }>('https://demo.test/api', {
      method: 'POST',
      body: { name: 'run' },
      headers: { authorization: 'Bearer abc' },
      stage: 'create',
    });
    expect(result.data).toEqual({ ok: true });
    expect(result.headers.get('x-page')).toBe('2');
    const sent = init(fetcher);
    expect(sent.method).toBe('POST');
    expect(sent.body).toBe('{"name":"run"}');
    expect(sent.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer abc',
    });
    expect(sent.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to GET without a body and returns plain data from json()', async () => {
    const fetcher = fakeFetch(response('[1,2]'));
    const http = new ProviderHttp('Demo', fetcher);
    await expect(
      http.json<number[]>(new URL('https://demo.test/list'), { stage: 'list' }),
    ).resolves.toEqual([1, 2]);
    const sent = init(fetcher);
    expect(sent.method).toBe('GET');
    expect(sent).not.toHaveProperty('body');
    expect(sent.headers).toEqual({ accept: 'application/json' });
  });

  it('sends FormData as is, without a JSON content type', async () => {
    const fetcher = fakeFetch(response('{}'));
    const form = new FormData();
    form.append('file', new Blob(['abc']), 'a.txt');
    await new ProviderHttp('Demo', fetcher).request('https://demo.test/upload', {
      method: 'POST',
      body: form,
      stage: 'upload',
    });
    const sent = init(fetcher);
    expect(sent.body).toBe(form);
    expect(sent.headers).toEqual({ accept: 'application/json' });
  });

  it('answers empty data for 204 and blank bodies', async () => {
    const fetcher = fakeFetch(response(null, 204), response('  \n '), response(''));
    const http = new ProviderHttp('Demo', fetcher);
    await expect(http.json('https://demo.test', { stage: 'a' })).resolves.toEqual({});
    await expect(http.json('https://demo.test', { stage: 'b' })).resolves.toEqual({});
    await expect(http.json('https://demo.test', { stage: 'c' })).resolves.toEqual({});
  });

  it('rejects invalid JSON without echoing the body', async () => {
    const fetcher = fakeFetch(response('<html>secret</html>'));
    const error = await new ProviderHttp('Demo', fetcher)
      .json('https://demo.test', { stage: 'parse' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      technicalMessage: 'Demo returned HTTP 200 (parse).',
      statusCode: 502,
      details: [{ provider: 'Demo', stage: 'parse', status: 200 }],
    });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('reports network failures without a status', async () => {
    const fetcher = fakeFetch(new Error('ECONNREFUSED https://demo.test?token=abc'));
    await expect(
      new ProviderHttp('Demo', fetcher).json('https://demo.test', { stage: 'connect' }),
    ).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      technicalMessage: 'Could not reach Demo (connect).',
      statusCode: 502,
      details: [{ provider: 'Demo', stage: 'connect' }],
    });
  });

  it('retries once on throttling and server errors', async () => {
    const fetcher = fakeFetch(response('busy', 429), response('{"n":1}'));
    const http = new ProviderHttp('Demo', fetcher, { retryDelayMs: 0 });
    await expect(http.json('https://demo.test', { stage: 'retry' })).resolves.toEqual({ n: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const failing = fakeFetch(response('down', 503), response('still down', 500));
    await expect(
      new ProviderHttp('Demo', failing, { retryDelayMs: 0 }).json('https://demo.test', {
        stage: 'retry',
      }),
    ).rejects.toMatchObject({ statusCode: 502, details: [{ status: 500 }] });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('waits for Retry-After, capped at ten seconds, or the configured delay', async () => {
    vi.useFakeTimers();
    const run = async (
      retryAfter: string | undefined,
      options: { retryDelayMs?: number },
      expectedDelay: number,
    ) => {
      const fetcher = fakeFetch(
        response('', 429, retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
        response('{"done":true}'),
      );
      const pending = new ProviderHttp('Demo', fetcher, options).json('https://demo.test', {
        stage: 'wait',
      });
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ done: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    };
    await run('2', { retryDelayMs: 50 }, 2_000);
    await run('120', {}, 10_000);
    await run('soon', { retryDelayMs: 50 }, 50);
    await run('0', {}, 1_000);
    await run(undefined, { retryDelayMs: 30_000 }, 10_000);
  });

  it('maps HTTP errors to client or gateway errors', async () => {
    const statusOf = async (status: number) =>
      new ProviderHttp('Demo', fakeFetch(response('nope', status)))
        .json('https://demo.test', { stage: 'check' })
        .catch((error: { statusCode: number; details: unknown[] }) => error);
    for (const status of [401, 403, 404])
      await expect(statusOf(status)).resolves.toMatchObject({
        statusCode: 400,
        details: [{ provider: 'Demo', stage: 'check', status }],
      });
    for (const status of [400, 409, 422])
      await expect(statusOf(status)).resolves.toMatchObject({ statusCode: 502 });
  });

  it('treats 203 (Azure sign-in page) as a failure', async () => {
    await expect(
      new ProviderHttp('Azure', fakeFetch(response('<html>sign in</html>', 203))).json(
        'https://demo.test',
        { stage: 'auth' },
      ),
    ).rejects.toMatchObject({
      technicalMessage: 'Azure returned HTTP 203 (auth).',
      statusCode: 502,
    });
  });

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('{"global":1}'));
    try {
      await expect(
        new ProviderHttp('Demo').json('https://demo.test', { stage: 'global' }),
      ).resolves.toEqual({ global: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('provider http helpers', () => {
  it('builds basic authentication headers', () => {
    expect(basicAuth('user@acme.com', 'key:1')).toBe(
      `Basic ${Buffer.from('user@acme.com:key:1').toString('base64')}`,
    );
  });

  it('parses positive ids', () => {
    expect(parsePositiveId('42', 'planId')).toBe(42);
    for (const value of [undefined, '', '0', '-1', '01', '1.5', 'abc', '99999999999999999999'])
      expect(() => parsePositiveId(value, 'planId')).toThrow(
        expect.objectContaining({
          code: 'TEST_MANAGEMENT_INVALID_ID',
          technicalMessage: 'Invalid planId.',
          statusCode: 400,
          details: [{ field: 'planId' }],
        }),
      );
  });

  it('requires non-blank text', () => {
    expect(requireText('  QA-1 ', 'caseId')).toBe('QA-1');
    for (const value of [undefined, '', '   '])
      expect(() => requireText(value, 'caseId')).toThrow(
        expect.objectContaining({
          code: 'TEST_MANAGEMENT_INVALID_ID',
          technicalMessage: 'Missing caseId.',
          details: [{ field: 'caseId' }],
        }),
      );
  });
});
