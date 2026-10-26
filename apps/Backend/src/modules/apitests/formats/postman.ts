import { randomUUID } from 'node:crypto';
import type { CollectionInput } from '../domain/api-test.js';
import type {
  ApiItem,
  ApiRequestSpec,
  Assertion,
  Capture,
  HttpMethod,
  KeyValue,
  RequestAuth,
  RequestBody,
} from '../engine/types.js';
import { HTTP_METHODS } from '../engine/types.js';

// Postman Collection v2.1 (https://schema.postman.com/collection/json/v2.1.0/). Bruno and
// Insomnia import this format too. Test scripts cannot be translated in general; the common
// `pm.test` status checks and `pm.*.set(..., pm.response.json()...)` captures are recognised on
// import and generated on export.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function isPostmanCollection(document: unknown): boolean {
  return (
    isObject(document) &&
    isObject(document['info']) &&
    /schema\.(getpostman|postman)\.com\/json\/collection/.test(str(document['info']['schema']))
  );
}

function keyValues(value: unknown): KeyValue[] {
  return list(value)
    .filter(isObject)
    .map((entry) => ({
      key: str(entry['key']),
      value: str(entry['value']),
      ...(entry['disabled'] ? { enabled: false } : {}),
    }));
}

function authFrom(value: unknown): RequestAuth | undefined {
  if (!isObject(value)) return undefined;
  const type = str(value['type']);
  const field = (name: string) =>
    str(
      list(value[type])
        .filter(isObject)
        .find((entry) => entry['key'] === name)?.['value'],
    );
  switch (type) {
    case 'noauth':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: field('token') };
    case 'basic':
      return { type: 'basic', username: field('username'), password: field('password') };
    case 'apikey':
      return {
        type: 'apikey',
        key: field('key') || 'X-API-Key',
        value: field('value'),
        in: field('in') === 'query' ? 'query' : 'header',
      };
    default:
      return undefined;
  }
}

function bodyFrom(value: unknown, headers: KeyValue[]): RequestBody {
  if (!isObject(value)) return { mode: 'none' };
  switch (str(value['mode'])) {
    case 'raw': {
      const language =
        isObject(value['options']) && isObject(value['options']['raw'])
          ? str(value['options']['raw']['language'])
          : '';
      const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
      const mode =
        language === 'json' || contentType.includes('json')
          ? 'json'
          : language === 'xml' || contentType.includes('xml')
            ? 'xml'
            : 'text';
      return { mode, content: str(value['raw']) };
    }
    case 'urlencoded':
      return { mode: 'urlencoded', fields: keyValues(value['urlencoded']) };
    case 'formdata':
      return {
        mode: 'form',
        fields: keyValues(
          list(value['formdata']).filter((entry) => !isObject(entry) || entry['type'] !== 'file'),
        ),
      };
    case 'graphql': {
      const graphql = isObject(value['graphql']) ? value['graphql'] : {};
      return {
        mode: 'json',
        content: JSON.stringify({
          query: str(graphql['query']),
          variables: str(graphql['variables']) || undefined,
        }),
      };
    }
    default:
      return { mode: 'none' };
  }
}

function urlFrom(value: unknown): { url: string; query: KeyValue[]; pathParams: KeyValue[] } {
  if (typeof value === 'string') return { url: value, query: [], pathParams: [] };
  if (!isObject(value)) return { url: '', query: [], pathParams: [] };
  const raw = str(value['raw']);
  const query = keyValues(value['query']);
  // The query is kept in `query` so it can be edited; the URL keeps only the path.
  return {
    url: query.length ? raw.split('?')[0]! : raw,
    query,
    pathParams: keyValues(value['variable']),
  };
}

/** `pm.test("...", () => pm.response.to.have.status(201))` and friends. */
export function assertionsFromScript(script: string): Assertion[] {
  const found: Assertion[] = [];
  const add = (assertion: Omit<Assertion, 'id'>) => found.push({ id: randomUUID(), ...assertion });
  for (const match of script.matchAll(/to\.have\.status\((\d{3})\)/g)) {
    add({ source: 'status', operator: 'eq', expected: match[1]! });
  }
  for (const match of script.matchAll(/pm\.response\.code\)\.to\.(?:eql|equal)\((\d{3})\)/g)) {
    add({ source: 'status', operator: 'eq', expected: match[1]! });
  }
  for (const match of script.matchAll(/responseTime\)\.to\.be\.below\((\d+)\)/g)) {
    add({ source: 'duration', operator: 'lt', expected: match[1]! });
  }
  for (const match of script.matchAll(/to\.have\.header\(\s*["']([^"']+)["']\s*\)/g)) {
    add({ source: 'header', path: match[1]!, operator: 'exists' });
  }
  return found;
}

/** `pm.environment.set("token", pm.response.json().data.token)` and `jsonData.x` variants. */
export function capturesFromScript(script: string): Capture[] {
  const found: Capture[] = [];
  const pattern =
    /pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*["']([^"']+)["']\s*,\s*(?:pm\.response\.json\(\)|jsonData|json|response|data|body)((?:\.[\w$]+|\[\d+\]|\[["'][^"']+["']\])+)\s*\)/g;
  for (const match of script.matchAll(pattern)) {
    const path = match[2]!.replace(/\[["']([^"']+)["']\]/g, '.$1').replace(/^\./, '');
    found.push({ variable: match[1]!, source: 'json', path });
  }
  return found;
}

function scriptOf(events: unknown, listen: string): string {
  return list(events)
    .filter(isObject)
    .filter((event) => event['listen'] === listen && isObject(event['script']))
    .map((event) => {
      const exec = (event['script'] as Json)['exec'];
      return Array.isArray(exec) ? exec.map(str).join('\n') : str(exec);
    })
    .join('\n');
}

function itemFrom(value: Json): ApiItem {
  const name = str(value['name']) || 'Untitled';
  if (Array.isArray(value['item'])) {
    const auth = authFrom(value['auth']);
    return {
      id: randomUUID(),
      type: 'folder',
      name,
      ...(str(value['description']) ? { description: str(value['description']) } : {}),
      ...(auth ? { auth } : {}),
      items: list(value['item']).filter(isObject).map(itemFrom),
    };
  }
  const request = isObject(value['request']) ? value['request'] : { url: value['request'] };
  const headers = keyValues(request['header']);
  const { url, query, pathParams } = urlFrom(request['url']);
  const method = str(request['method']).toUpperCase();
  const tests = scriptOf(value['event'], 'test');
  const description = str(
    isObject(request['description']) ? request['description']['content'] : request['description'],
  );
  return {
    id: randomUUID(),
    type: 'request',
    name,
    ...(description ? { description } : {}),
    method: (HTTP_METHODS as readonly string[]).includes(method) ? (method as HttpMethod) : 'GET',
    url,
    ...(pathParams.length ? { pathParams } : {}),
    headers,
    query,
    body: bodyFrom(request['body'], headers),
    auth: authFrom(request['auth']) ?? { type: 'inherit' },
    assertions: assertionsFromScript(tests),
    captures: capturesFromScript(tests),
  };
}

export function importPostman(document: Json): CollectionInput {
  const info = isObject(document['info']) ? document['info'] : {};
  const description = str(
    isObject(info['description']) ? info['description']['content'] : info['description'],
  );
  return {
    name: str(info['name']) || 'Postman collection',
    ...(description ? { description } : {}),
    variables: keyValues(document['variable']),
    auth: authFrom(document['auth']) ?? { type: 'none' },
    items: list(document['item']).filter(isObject).map(itemFrom),
  };
}

function authTo(auth: RequestAuth | undefined): Json | undefined {
  if (!auth || auth.type === 'inherit') return undefined;
  switch (auth.type) {
    case 'none':
      return { type: 'noauth' };
    case 'bearer':
      return { type: 'bearer', bearer: [{ key: 'token', value: auth.token, type: 'string' }] };
    case 'basic':
      return {
        type: 'basic',
        basic: [
          { key: 'username', value: auth.username, type: 'string' },
          { key: 'password', value: auth.password, type: 'string' },
        ],
      };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: auth.key, type: 'string' },
          { key: 'value', value: auth.value, type: 'string' },
          { key: 'in', value: auth.in, type: 'string' },
        ],
      };
  }
}

const js = (value: string) => JSON.stringify(value);

/** `data.items[0].id` → `.data.items[0].id`; names that are not identifiers are quoted. */
function jsonAccess(path: string): string {
  return path
    .replace(/^\$\.?/, '')
    .split(/\.|(?=\[)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('[')
        ? part
        : /^\d+$/.test(part)
          ? `[${part}]`
          : /^[A-Za-z_$][\w$]*$/.test(part)
            ? `.${part}`
            : `[${js(part)}]`,
    )
    .join('');
}

/** The checks and captures of a request as a Postman test script. */
function scriptFor(request: ApiRequestSpec): string[] {
  const lines: string[] = [];
  for (const assertion of request.assertions) {
    const expected = js(assertion.expected ?? '');
    let actual: string;
    switch (assertion.source) {
      case 'status':
        actual = 'pm.response.code';
        break;
      case 'duration':
        actual = 'pm.response.responseTime';
        break;
      case 'header':
        actual = `pm.response.headers.get(${js(assertion.path ?? '')})`;
        break;
      case 'body':
        actual = 'pm.response.text()';
        break;
      case 'json':
        actual = `pm.response.json()${jsonAccess(assertion.path ?? '')}`;
        break;
    }
    const check: Record<(typeof assertion)['operator'], string> = {
      eq: `pm.expect(String(${actual})).to.eql(${expected});`,
      neq: `pm.expect(String(${actual})).to.not.eql(${expected});`,
      contains: `pm.expect(String(${actual})).to.include(${expected});`,
      notContains: `pm.expect(String(${actual})).to.not.include(${expected});`,
      exists: `pm.expect(${actual}).to.not.be.oneOf([undefined, null]);`,
      notExists: `pm.expect(${actual}).to.be.oneOf([undefined, null]);`,
      lt: `pm.expect(Number(${actual})).to.be.below(Number(${expected}));`,
      lte: `pm.expect(Number(${actual})).to.be.at.most(Number(${expected}));`,
      gt: `pm.expect(Number(${actual})).to.be.above(Number(${expected}));`,
      gte: `pm.expect(Number(${actual})).to.be.at.least(Number(${expected}));`,
      matches: `pm.expect(String(${actual})).to.match(new RegExp(${expected}));`,
      isType: `pm.expect(${actual}).to.be.a(${expected});`,
    };
    const label = [assertion.source, assertion.path, assertion.operator, assertion.expected]
      .filter(Boolean)
      .join(' ');
    // Postman's own idiom for status checks, which the import recognises too.
    const line =
      assertion.source === 'status' &&
      assertion.operator === 'eq' &&
      /^\d{3}$/.test(assertion.expected ?? '')
        ? `pm.response.to.have.status(${assertion.expected});`
        : check[assertion.operator];
    lines.push(`pm.test(${js(label)}, function () {`, `  ${line}`, '});');
  }
  for (const capture of request.captures) {
    const value =
      capture.source === 'status'
        ? 'String(pm.response.code)'
        : capture.source === 'header'
          ? `pm.response.headers.get(${js(capture.path ?? '')})`
          : capture.source === 'body'
            ? 'pm.response.text()'
            : `pm.response.json()${jsonAccess(capture.path ?? '')}`;
    lines.push(`pm.collectionVariables.set(${js(capture.variable)}, ${value});`);
  }
  return lines;
}

function bodyTo(body: RequestBody): Json | undefined {
  switch (body.mode) {
    case 'none':
      return undefined;
    case 'json':
    case 'text':
    case 'xml':
      return {
        mode: 'raw',
        raw: body.content,
        options: { raw: { language: body.mode === 'text' ? 'text' : body.mode } },
      };
    case 'urlencoded':
      return {
        mode: 'urlencoded',
        urlencoded: body.fields.map((f) => ({
          key: f.key,
          value: f.value,
          ...(f.enabled === false ? { disabled: true } : {}),
        })),
      };
    case 'form':
      return {
        mode: 'formdata',
        formdata: body.fields.map((f) => ({
          key: f.key,
          value: f.value,
          type: 'text',
          ...(f.enabled === false ? { disabled: true } : {}),
        })),
      };
  }
}

const pairs = (entries: readonly KeyValue[]) =>
  entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    ...(entry.enabled === false ? { disabled: true } : {}),
  }));

function itemTo(item: ApiItem): Json {
  if (item.type === 'folder') {
    const auth = authTo(item.auth);
    return {
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      ...(auth ? { auth } : {}),
      item: item.items.map(itemTo),
    };
  }
  const enabledQuery = item.query.filter((entry) => entry.enabled !== false);
  const raw = enabledQuery.length
    ? `${item.url}?${enabledQuery.map((entry) => `${entry.key}=${entry.value}`).join('&')}`
    : item.url;
  const body = bodyTo(item.body);
  const auth = authTo(item.auth);
  const script = scriptFor(item);
  return {
    name: item.name,
    ...(script.length
      ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: script } }] }
      : {}),
    request: {
      method: item.method,
      header: pairs(item.headers),
      ...(body ? { body } : {}),
      ...(auth ? { auth } : {}),
      url: {
        raw,
        ...(item.query.length ? { query: pairs(item.query) } : {}),
        ...(item.pathParams?.length ? { variable: pairs(item.pathParams) } : {}),
      },
      ...(item.description ? { description: item.description } : {}),
    },
  };
}

export function exportPostman(collection: CollectionInput): Json {
  const auth = authTo(collection.auth);
  return {
    info: {
      _postman_id: randomUUID(),
      name: collection.name,
      ...(collection.description ? { description: collection.description } : {}),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: collection.items.map(itemTo),
    ...(auth ? { auth } : {}),
    // Secret values never leave ADK in an export; they are left empty to fill in locally.
    variable: collection.variables.map((variable) => ({
      key: variable.key,
      value: variable.secret ? '' : variable.value,
      ...(variable.enabled === false ? { disabled: true } : {}),
    })),
  };
}
