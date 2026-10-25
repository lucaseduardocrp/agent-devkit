import { describe, expect, it, vi } from 'vitest';
import {
  assertionLabel,
  executeRequest,
  maskSecrets,
  prepareRequest,
  scopeOf,
} from '../src/modules/apitests/engine/http-request.js';
import type { ApiRequestSpec, Assertion } from '../src/modules/apitests/engine/types.js';

const request = (
  overrides: Partial<ApiRequestSpec> & Pick<ApiRequestSpec, 'id' | 'url'>,
): ApiRequestSpec => ({
  type: 'request',
  name: overrides.id,
  method: 'GET',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

const fetchReturning =
  (body: string | null, init: ResponseInit = {}): typeof fetch =>
  async () =>
    new Response(body, init);

describe('prepareRequest', () => {
  it('applies basic and api key auth, headers and every body mode', () => {
    const scope = scopeOf([
      { key: 'user', value: 'ana' },
      { key: 'pass', value: 'pw' },
      { key: 'k', value: 'x-key' },
    ]);
    const basic = prepareRequest(
      request({
        id: 'b',
        url: 'http://api.test/',
        method: 'POST',
        headers: [
          { key: 'X-Who', value: '{{user}}' },
          { key: 'off', value: '1', enabled: false },
        ],
        body: { mode: 'text', content: 'hi {{user}}' },
      }),
      { type: 'basic', username: '{{user}}', password: '{{pass}}' },
      scope,
    );
    expect(basic.init.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('ana:pw').toString('base64')}`,
    );
    expect(basic.init.headers.get('x-who')).toBe('ana');
    expect(basic.init.headers.has('off')).toBe(false);
    expect(basic.init.headers.get('content-type')).toBe('text/plain');
    expect(basic.init.body).toBe('hi ana');

    const query = prepareRequest(
      request({ id: 'q', url: 'http://api.test/', body: { mode: 'xml', content: '<a/>' } }),
      { type: 'apikey', key: '{{k}}', value: 'v', in: 'query' },
      scope,
    );
    expect(query.url.searchParams.get('x-key')).toBe('v');
    // GET never sends a body, but the content type is still set.
    expect(query.init.body).toBeUndefined();
    expect(query.init.headers.get('content-type')).toBe('application/xml');

    const header = prepareRequest(
      request({
        id: 'h',
        url: 'http://api.test/',
        method: 'PUT',
        headers: [{ key: 'content-type', value: 'application/vnd+json' }],
        body: { mode: 'json', content: '{}' },
      }),
      { type: 'apikey', key: 'X-Api', value: '{{pass}}', in: 'header' },
      scope,
    );
    expect(header.init.headers.get('x-api')).toBe('pw');
    expect(header.init.headers.get('content-type')).toBe('application/vnd+json');

    const form = prepareRequest(
      request({
        id: 'f',
        url: 'http://api.test/',
        method: 'POST',
        body: {
          mode: 'urlencoded',
          fields: [
            { key: 'name', value: '{{user}}' },
            { key: 'skip', value: 'x', enabled: false },
          ],
        },
      }),
      { type: 'none' },
      scope,
    );
    expect(form.init.body).toBe('name=ana');
    expect(form.init.headers.get('content-type')).toBe('application/x-www-form-urlencoded');

    const formTyped = prepareRequest(
      request({
        id: 'f2',
        url: 'http://api.test/',
        method: 'HEAD',
        headers: [{ key: 'Content-Type', value: 'multipart/x' }],
        body: { mode: 'form', fields: [] },
      }),
      { type: 'none' },
      scope,
    );
    expect(formTyped.init.headers.get('content-type')).toBe('multipart/x');
    expect(formTyped.init.body).toBeUndefined();
  });

  it('masks only secrets of four characters or more', () => {
    const scope = scopeOf([
      { key: 'a', value: 'abc', secret: true },
      { key: 'b', value: 'longsecret', secret: true },
      { key: 'c', value: 'visible' },
    ]);
    expect(maskSecrets('abc longsecret visible', scope)).toBe('abc •••••• visible');
  });

  it('labels assertions without empty parts', () => {
    expect(assertionLabel({ id: 'x', source: 'json', path: '', operator: 'exists' })).toBe(
      'json exists',
    );
  });
});

describe('assertions and captures', () => {
  const op = (operator: Assertion['operator'], expected?: string, extra?: Partial<Assertion>) =>
    ({
      id: `${operator}-${expected ?? ''}-${extra?.source ?? 'status'}-${extra?.path ?? ''}`,
      source: 'status',
      operator,
      ...(expected !== undefined ? { expected } : {}),
      ...extra,
    }) as Assertion;

  it('evaluates every operator against status, body, json and headers', async () => {
    const scope = scopeOf([{ key: 'tok', value: 'secret-value', secret: true }]);
    const body = JSON.stringify({ n: null, list: [1], name: 'ana', obj: { a: 1 } });
    const result = await executeRequest(
      request({
        id: 'all',
        url: 'http://api.test/',
        assertions: [
          op('eq', '201'),
          op('neq', '200'),
          op('eq', 'ana', { source: 'json', path: 'name' }),
          op('neq', 'bob', { source: 'json', path: 'name' }),
          op('contains', 'ana', { source: 'body' }),
          op('notContains', 'zzz', { source: 'body' }),
          op('exists', undefined, { source: 'header', path: 'x-id' }),
          op('notExists', undefined, { source: 'header', path: 'x-missing' }),
          op('notExists', undefined, { source: 'header' }),
          op('lt', '300'),
          op('lte', '201'),
          op('gt', '200'),
          op('gte', '201'),
          op('gt', 'abc'),
          op('matches', '^2\\d\\d$'),
          op('matches', '('),
          op('isType', 'NULL', { source: 'json', path: 'n' }),
          op('isType', 'array', { source: 'json', path: 'list' }),
          op('isType', 'object', { source: 'json', path: 'obj' }),
          op('eq', '{"a":1}', { source: 'json', path: 'obj' }),
          op('notExists', undefined, { source: 'json', path: 'nope' }),
          op('lt', '100000', { source: 'duration' }),
          op('eq', '{{tok}}', { source: 'json', path: 'name' }),
        ],
        captures: [
          { variable: 'code', source: 'status' },
          { variable: 'rid', source: 'header', path: 'x-id' },
          { variable: 'noHeader', source: 'header' },
          { variable: 'raw', source: 'body' },
          { variable: 'name', source: 'json', path: 'name' },
          { variable: 'missing', source: 'json', path: 'nope' },
          { variable: '  ', source: 'status' },
          { variable: 'tok', source: 'json', path: 'name' },
        ],
      }),
      scope,
      {
        auth: { type: 'none' },
        fetch: fetchReturning(body, { status: 201, headers: { 'x-id': 'r-9' } }),
      },
    );
    expect(result.path).toEqual([]);
    expect(result.response).toBeUndefined();
    expect(result.assertions.map((assertion) => assertion.passed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    // The failing assertion compared against a secret, which never shows up as is.
    expect(result.assertions.at(-1)!.actual).toBe('ana');
    expect(scope.get('code')?.value).toBe('201');
    expect(scope.get('rid')?.value).toBe('r-9');
    expect(scope.has('noHeader')).toBe(false);
    expect(scope.get('raw')?.value).toBe(body);
    expect(scope.get('name')?.value).toBe('ana');
    expect(scope.has('missing')).toBe(false);
    // A capture into a secret variable keeps it secret.
    expect(scope.get('tok')).toEqual({ value: 'ana', secret: true });
  });

  it('handles bodies that are not JSON and empty responses', async () => {
    const scope = scopeOf();
    const text = await executeRequest(
      request({
        id: 't',
        url: 'http://api.test/',
        assertions: [op('exists', undefined, { source: 'json', path: 'a' })],
        captures: [{ variable: 'a', source: 'json', path: 'a' }],
      }),
      scope,
      { auth: { type: 'none' }, fetch: fetchReturning('not json'), path: ['F'] },
    );
    expect(text.assertions[0]!.passed).toBe(false);
    expect(scope.has('a')).toBe(false);
    expect(text.path).toEqual(['F']);

    const empty = await executeRequest(
      request({
        id: 'e',
        url: 'http://api.test/',
        assertions: [op('eq', '', { source: 'body' })],
      }),
      scope,
      { auth: { type: 'none' }, fetch: fetchReturning(null, { status: 204 }), keepResponse: true },
    );
    expect(empty).toMatchObject({ status: 204, sizeBytes: 0, passed: true });
    expect(empty.response).toEqual({ headers: {}, bodyPreview: '' });
  });

  it('keeps reading big bodies only up to the limit while counting every byte', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 3; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const result = await executeRequest(request({ id: 'big', url: 'http://api.test/' }), scopeOf(), {
      auth: { type: 'none' },
      fetch: async () => new Response(stream),
      keepResponse: true,
    });
    expect(result.sizeBytes).toBe(3 * 1024 * 1024);
    expect(result.response!.bodyPreview).toHaveLength(4 * 1024);
  });
});

describe('request errors', () => {
  it('reports the cause of network errors and non-Error failures', async () => {
    const withCause = await executeRequest(request({ id: 'c', url: 'http://api.test/' }), scopeOf(), {
      auth: { type: 'none' },
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      },
    });
    expect(withCause.error).toBe('fetch failed: ECONNREFUSED');

    const plain = await executeRequest(request({ id: 'p', url: 'http://api.test/' }), scopeOf(), {
      auth: { type: 'none' },
      fetch: async () => {
        throw new Error('plain');
      },
    });
    expect(plain.error).toBe('plain');

    const odd = await executeRequest(request({ id: 'o', url: 'http://api.test/' }), scopeOf(), {
      auth: { type: 'none' },
      guard: () => Promise.reject('refused target'),
    });
    expect(odd).toMatchObject({ status: null, passed: false, error: 'refused target' });
  });

  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error));
    });

  it('names the timeout from the options or the default', async () => {
    const fromOptions = await executeRequest(
      request({ id: 'to', url: 'http://api.test/' }),
      scopeOf(),
      { auth: { type: 'none' }, fetch: hanging, timeoutMs: 20 },
    );
    expect(fromOptions.error).toBe('Timed out after 20 ms');
  });

  it('reports a cancel, not a timeout, when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const result = await executeRequest(request({ id: 'x', url: 'http://api.test/' }), scopeOf(), {
      auth: { type: 'none' },
      fetch: hanging,
      signal: controller.signal,
      timeoutMs: 1,
    });
    expect(result.error).toBe('cancelled');
  });

  it('uses the 30 s default in the timeout message', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
    try {
      const result = await executeRequest(
        request({ id: 'd', url: 'http://api.test/' }),
        scopeOf(),
        { auth: { type: 'none' }, fetch: hanging },
      );
      expect(result.error).toBe('Timed out after 30000 ms');
    } finally {
      spy.mockRestore();
    }
  });
});
