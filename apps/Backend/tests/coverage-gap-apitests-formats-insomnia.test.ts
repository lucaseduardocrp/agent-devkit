import { describe, expect, it } from 'vitest';
import type { ApiRequestSpec } from '../src/modules/apitests/engine/types.js';
import {
  exportInsomnia,
  importInsomnia,
  isInsomniaExport,
} from '../src/modules/apitests/formats/insomnia.js';

const request = (overrides: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  id: 'r',
  type: 'request',
  name: 'Req',
  method: 'GET',
  url: '{{baseUrl}}/x',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

describe('importInsomnia edge cases', () => {
  it('detects exports only for objects with a resources array', () => {
    expect(isInsomniaExport(null)).toBe(false);
    expect(isInsomniaExport([])).toBe(false);
    expect(isInsomniaExport({ _type: 'export', resources: {} })).toBe(false);
    expect(isInsomniaExport({ _type: 'export', resources: [] })).toBe(true);
  });

  it('maps folders, bodies, auth types and the base environment', () => {
    const imported = importInsomnia({
      _type: 'export',
      resources: [
        { _id: 'wrk', _type: 'workspace', name: 'Shop', description: 'Workspace doc' },
        { _id: 'env', _type: 'environment', parentId: 'wrk', data: { host: '{{ _.base }}', n: 3 } },
        'not-an-object',
        { _id: 'cookie', _type: 'cookie_jar', parentId: 'wrk' },
        {
          _id: 'fld',
          _type: 'request_group',
          parentId: 'wrk',
          name: '',
          description: 'Folder doc',
          metaSortKey: 2,
          authentication: { type: 'bearer', token: '{{ _.token }}' },
        },
        {
          _id: 'fld2',
          _type: 'request_group',
          parentId: 'wrk',
          name: 'Open',
          metaSortKey: 3,
          authentication: { type: 'basic', disabled: true },
        },
        {
          _id: 'r1',
          _type: 'request',
          parentId: 'fld',
          name: '',
          description: 'Request doc',
          method: 'brew',
          url: '{{ _.host }}/a',
          headers: [{ name: 'X-On', value: 1 }, { name: 'X-Off', value: true, disabled: true }, 7],
          parameters: [{ name: 'q', value: null }],
          body: {
            mimeType: 'application/x-www-form-urlencoded',
            params: [{ name: 'a', value: 'b' }],
          },
          authentication: { type: 'basic', username: 'u', password: '{{ _.p }}' },
        },
        {
          _id: 'r2',
          _type: 'request',
          parentId: 'fld',
          name: 'Multipart',
          method: 'post',
          body: { mimeType: 'multipart/form-data', params: [{ name: 'f', value: 'v' }] },
          authentication: { type: 'apikey', addTo: 'queryParams', value: 'k' },
        },
        {
          _id: 'r3',
          _type: 'request',
          parentId: 'fld',
          name: 'Empty body',
          method: 'PUT',
          body: { mimeType: 'application/json' },
          authentication: { type: 'apikey', key: 'X-Key', value: 'k' },
        },
        {
          _id: 'r4',
          _type: 'request',
          parentId: 'fld',
          name: 'Xml',
          body: { mimeType: 'application/xml', text: '<a/>' },
          authentication: { type: 'none' },
        },
        {
          _id: 'r5',
          _type: 'request',
          parentId: 'fld',
          name: 'Text',
          body: { text: 'hi' },
          authentication: { type: 'oauth2' },
        },
        {
          _id: 'r6',
          _type: 'request',
          parentId: 'fld',
          name: 'Json',
          body: { mimeType: 'application/json', text: '{"t":"{{ _.token }}"}' },
          authentication: { token: 'no-type' },
        },
      ],
    });
    expect(imported.name).toBe('Shop');
    expect(imported.description).toBe('Workspace doc');
    expect(imported.variables).toEqual([
      { key: 'host', value: '{{base}}' },
      { key: 'n', value: '3' },
    ]);
    const [folder, open] = imported.items as any[];
    expect(folder).toMatchObject({
      type: 'folder',
      name: 'Folder',
      description: 'Folder doc',
      auth: { type: 'bearer', token: '{{token}}' },
    });
    expect(open).not.toHaveProperty('auth');
    expect(open.items).toEqual([]);
    const [r1, r2, r3, r4, r5, r6] = folder.items;
    expect(r1).toMatchObject({
      name: 'Request',
      description: 'Request doc',
      method: 'GET',
      url: '{{host}}/a',
      headers: [
        { key: 'X-On', value: '1' },
        { key: 'X-Off', value: 'true', enabled: false },
      ],
      query: [{ key: 'q', value: '' }],
      body: { mode: 'urlencoded', fields: [{ key: 'a', value: 'b' }] },
      auth: { type: 'basic', username: 'u', password: '{{p}}' },
    });
    expect(r2.method).toBe('POST');
    expect(r2.body).toEqual({ mode: 'form', fields: [{ key: 'f', value: 'v' }] });
    expect(r2.auth).toEqual({ type: 'apikey', key: 'X-API-Key', value: 'k', in: 'query' });
    expect(r3.body).toEqual({ mode: 'none' });
    expect(r3.auth).toEqual({ type: 'apikey', key: 'X-Key', value: 'k', in: 'header' });
    expect(r4.body).toEqual({ mode: 'xml', content: '<a/>' });
    expect(r4.auth).toEqual({ type: 'none' });
    expect(r5.body).toEqual({ mode: 'text', content: 'hi' });
    expect(r5.auth).toEqual({ type: 'inherit' });
    expect(r6.body).toEqual({ mode: 'json', content: '{"t":"{{token}}"}' });
    expect(r6.auth).toEqual({ type: 'inherit' });
  });

  it('defaults the name and reads top-level resources without a workspace', () => {
    const imported = importInsomnia({
      resources: [{ _id: 'r', _type: 'request', parentId: null, url: 'u', body: 'raw' }],
    });
    expect(imported.name).toBe('Insomnia collection');
    expect(imported).not.toHaveProperty('description');
    expect(imported.variables).toEqual([]);
    expect(imported.items).toHaveLength(1);
    expect((imported.items[0] as ApiRequestSpec).body).toEqual({ mode: 'none' });
  });
});

describe('exportInsomnia edge cases', () => {
  it('writes every auth and body type, folder auth and ADK checks in descriptions', () => {
    const exported = exportInsomnia({
      name: 'Out',
      variables: [
        { key: 'off', value: 'x', enabled: false },
        { key: 'secret', value: 'shh', secret: true },
      ],
      auth: { type: 'apikey', key: 'K', value: '{{v}}', in: 'query' },
      items: [
        {
          id: 'f',
          type: 'folder',
          name: 'Secured',
          description: 'Folder doc',
          auth: { type: 'basic', username: '{{u}}', password: 'p' },
          items: [request({ name: 'Inherits', body: { mode: 'xml', content: '<{{x}}/>' } })],
        },
        {
          id: 'g',
          type: 'folder',
          name: 'Plain',
          auth: { type: 'inherit' },
          items: [
            request({
              name: 'Header key',
              description: 'Own doc',
              headers: [{ key: 'H', value: '{{h}}', enabled: false }],
              query: [{ key: 'q', value: '1' }],
              body: { mode: 'text', content: 't' },
              auth: { type: 'apikey', key: 'K2', value: 'v', in: 'header' },
              assertions: [{ id: 'a', source: 'json', path: 'id', operator: 'exists' }],
              captures: [
                { variable: 'id', source: 'json', path: 'id' },
                { variable: 's', source: 'status' },
              ],
            }),
          ],
        },
        request({
          name: 'Form',
          body: { mode: 'form', fields: [{ key: 'a', value: '{{b}}', enabled: false }] },
          auth: { type: 'none' },
        }),
        request({
          name: 'Encoded',
          body: { mode: 'urlencoded', fields: [{ key: 'c', value: 'd' }] },
          auth: { type: 'bearer', token: '{{t}}' },
        }),
        request({ name: 'Root' }),
      ],
    });
    const resources = exported['resources'] as Record<string, any>[];
    expect(resources[0]!['description']).toBe('');
    expect(resources[1]!['data']).toEqual({ secret: '' });
    const byName = (name: string) => resources.find((resource) => resource['name'] === name)!;
    expect(byName('Secured')['authentication']).toEqual({
      type: 'basic',
      username: '{{ _.u }}',
      password: 'p',
    });
    expect(byName('Secured')['description']).toBe('Folder doc');
    expect(byName('Plain')).not.toHaveProperty('authentication');
    expect(byName('Plain')['description']).toBe('');
    expect(byName('Inherits')['authentication']).toEqual(byName('Secured')['authentication']);
    expect(byName('Inherits')['body']).toEqual({
      mimeType: 'application/xml',
      text: '<{{ _.x }}/>',
    });
    expect(byName('Inherits')['description']).toBe('');
    const header = byName('Header key');
    expect(header['authentication']).toEqual({
      type: 'apikey',
      key: 'K2',
      value: 'v',
      addTo: 'header',
    });
    expect(header['body']).toEqual({ mimeType: 'text/plain', text: 't' });
    expect(header['headers']).toEqual([{ name: 'H', value: '{{ _.h }}', disabled: true }]);
    expect(header['parameters']).toEqual([{ name: 'q', value: '1', disabled: false }]);
    expect(header['description']).toBe(
      'Own doc\n\nChecks (ADK):\n- json id exists\n\nCaptures (ADK):\n- id ← json id\n- s ← status',
    );
    expect(byName('Form')['body']).toEqual({
      mimeType: 'multipart/form-data',
      params: [{ name: 'a', value: '{{ _.b }}', disabled: true }],
    });
    expect(byName('Form')['authentication']).toEqual({ type: 'none' });
    expect(byName('Encoded')['body']).toEqual({
      mimeType: 'application/x-www-form-urlencoded',
      params: [{ name: 'c', value: 'd', disabled: false }],
    });
    expect(byName('Encoded')['authentication']).toEqual({ type: 'bearer', token: '{{ _.t }}' });
    expect(byName('Root')['authentication']).toEqual({
      type: 'apikey',
      key: 'K',
      value: '{{ _.v }}',
      addTo: 'queryParams',
    });
  });

  it('writes an empty authentication when nothing is inherited', () => {
    const exported = exportInsomnia({
      name: 'Bare',
      variables: [],
      auth: { type: 'inherit' },
      items: [request()],
    });
    const resources = exported['resources'] as Record<string, unknown>[];
    expect(resources[2]!['authentication']).toEqual({});
    expect(resources[2]!['body']).toEqual({});
  });
});
