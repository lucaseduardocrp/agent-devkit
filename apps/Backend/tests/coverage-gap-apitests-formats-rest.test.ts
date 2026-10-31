import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import type { ApiRequestSpec } from '../src/modules/apitests/engine/types.js';
import { exportK6 } from '../src/modules/apitests/formats/k6.js';
import { exportPostman, importPostman } from '../src/modules/apitests/formats/postman.js';
import { fromAdkScripts, toAdkScripts } from '../src/modules/apitests/formats/script-api.js';

const request = (overrides: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  id: 'r',
  type: 'request',
  name: 'Req',
  method: 'GET',
  url: 'https://api.test/x',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

const collection = (
  items: CollectionInput['items'],
  extra: Partial<CollectionInput> = {},
): CollectionInput => ({ name: 'All', variables: [], auth: { type: 'none' }, items, ...extra });

/** A Postman v2.1 document holding one request. */
const postman = (item: Record<string, unknown>) => ({
  info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [item],
});

const first = (document: ReturnType<typeof postman>) =>
  importPostman(document as never).items[0] as ApiRequestSpec;

describe('importPostman reads the shapes a collection may carry', () => {
  it('reads an edgegrid auth with a body size that is not a number', () => {
    const auth = (maxBodySize: string) =>
      first(
        postman({
          name: 'R',
          request: {
            method: 'GET',
            url: 'https://a.test/',
            auth: {
              type: 'edgegrid',
              edgegrid: [
                { key: 'accessToken', value: 'at' },
                { key: 'clientToken', value: 'ct' },
                { key: 'clientSecret', value: 'cs' },
                { key: 'headersToSign', value: 'x-a' },
                { key: 'maxBodySize', value: maxBodySize },
              ],
            },
          },
        }),
      ).auth;
    expect(auth('2048')).toMatchObject({ maxBodySize: 2048, headersToSign: 'x-a' });
    expect(auth('plenty')).not.toHaveProperty('maxBodySize');
  });

  it('defaults an oauth2 grant that the collection leaves out, and keeps the scope', () => {
    const auth = (rows: readonly { key: string; value: string }[]) =>
      first(
        postman({
          name: 'R',
          request: {
            method: 'GET',
            url: 'https://a.test/',
            auth: { type: 'oauth2', oauth2: rows },
          },
        }),
      ).auth;
    expect(auth([{ key: 'scope', value: 'read' }])).toMatchObject({
      grantType: 'client_credentials',
      scope: 'read',
    });
    expect(auth([{ key: 'grant_type', value: 'authorization_code' }])).toEqual({ type: 'none' });
    expect(auth([])).not.toHaveProperty('scope');
  });

  it('reads a disabled form field and a body mode it does not know', () => {
    const form = first(
      postman({
        name: 'R',
        request: {
          method: 'POST',
          url: 'https://a.test/',
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'f', type: 'file', src: ['C:\\tmp\\a.txt', '/var/b.txt'] },
              { key: 'off', value: 'no', disabled: true },
            ],
          },
        },
      }),
    );
    const fields = form.body.mode === 'form' ? form.body.fields : [];
    expect(fields[0]?.value).toBe('a.txt, b.txt');
    expect(fields[1]?.enabled).toBe(false);

    const unknown = first(
      postman({
        name: 'R',
        request: { method: 'POST', url: 'https://a.test/', body: { mode: 'nonsense' } },
      }),
    );
    expect(unknown.body).toEqual({ mode: 'none' });
  });

  it('reads the redirect limit and the url-encoding switch of a protocol profile', () => {
    const spec = first(
      postman({
        name: 'R',
        request: { method: 'GET', url: 'https://a.test/' },
        protocolProfileBehavior: {
          followRedirects: true,
          maxRedirects: 3,
          disableUrlEncoding: true,
        },
      }),
    );
    expect(spec.settings).toEqual({ followRedirects: true, maxRedirects: 3, encodeUrl: false });

    const none = first(
      postman({
        name: 'R',
        request: { method: 'GET', url: 'https://a.test/' },
        protocolProfileBehavior: {},
      }),
    );
    expect(none.settings).toBeUndefined();
  });
});

describe('exportPostman writes the files and bodies a request may carry', () => {
  const itemsOf = (input: CollectionInput) =>
    (exportPostman(input) as { item: Record<string, unknown>[] }).item;

  it('writes a form file by name and a binary body with no file', () => {
    const items = itemsOf(
      collection([
        request({
          id: 'form',
          name: 'Form',
          method: 'POST',
          body: {
            mode: 'form',
            fields: [
              { key: 'a', value: 'fallback.txt', type: 'file' },
              {
                key: 'b',
                value: '',
                type: 'file',
                file: { fileName: 'b.bin', contentType: '', data: '' },
              },
            ],
          },
        }),
        request({ id: 'bin', name: 'Bin', method: 'POST', body: { mode: 'binary', file: null } }),
      ]),
    );
    const body = (name: string) =>
      (items.find((item) => item['name'] === name)?.['request'] as Record<string, unknown>)['body'] as Record<
        string,
        unknown
      >;
    const formdata = body('Form')['formdata'] as Record<string, unknown>[];
    expect(formdata[0]?.['src']).toBe('fallback.txt');
    expect(formdata[1]?.['src']).toBe('b.bin');
    expect((body('Bin')['file'] as Record<string, unknown>)['src']).toBe('');
  });

  it('writes a graphql request whose variables are left out', () => {
    const items = itemsOf(
      collection([
        { ...request({ id: 'g', name: 'Gql' }), kind: 'graphql', graphql: { query: '{ a }' } },
      ]),
    );
    const body = (items[0]?.['request'] as Record<string, unknown>)['body'] as Record<string, unknown>;
    expect(body['graphql']).toEqual({ query: '{ a }', variables: '' });
  });
});

describe('exportK6 writes graphql requests', () => {
  it('writes a request with variables, with none and with an operation name', () => {
    const script = exportK6(
      collection([
        {
          ...request({ id: 'a', name: 'WithVars' }),
          kind: 'graphql',
          graphql: { query: '{ a }', variables: '{"id":1}', operationName: 'Q' },
        },
        { ...request({ id: 'b', name: 'NoVars' }), kind: 'graphql', graphql: { query: '{ b }', variables: '  ' } },
        { ...request({ id: 'c', name: 'Bare' }), kind: 'graphql' },
      ]),
      {
        name: 'Gql',
        requests: [
          { requestId: 'a', weight: 1 },
          { requestId: 'b', weight: 1 },
          { requestId: 'c', weight: 1 },
        ],
        stages: [{ durationSec: 1, targetVus: 1 }],
        thinkTimeMs: 0,
        thresholds: [],
      },
    );
    expect(script).toContain('operationName');
    expect(script).toContain('{ b }');
    expect(script).toContain('{\\"query\\":\\"\\"}');
  });
});

describe('renaming the script api', () => {
  it('leaves a phase that holds no script alone in both directions', () => {
    expect(toAdkScripts({ preRequest: 'pm.test("a", () => {});', postResponse: undefined })).toEqual({
      preRequest: 'adk.test("a", () => {});',
      postResponse: undefined,
    });
    expect(fromAdkScripts({ preRequest: 'adk.test("a", () => {});' }, 'pm')).toEqual({
      preRequest: 'pm.test("a", () => {});',
    });
    expect(toAdkScripts(undefined)).toBeUndefined();
  });
});
