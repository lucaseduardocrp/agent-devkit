import { randomUUID } from 'node:crypto';
import type { CollectionInput } from '../domain/api-test.js';
import type {
  ApiItem,
  ApiRequestSpec,
  Assertion,
  Capture,
  FormField,
  HttpMethod,
  KeyValue,
  RequestAuth,
  RequestBody,
  RequestSettings,
  Scripts,
  Variable,
} from '../engine/types.js';
import { HTTP_METHODS } from '../engine/types.js';
import { fromAdkScripts, toAdkScript } from './script-api.js';

// Postman Collection v2.1 (https://schema.postman.com/collection/json/v2.1.0/). Bruno and
// Insomnia import this format too. Scripts only swap `pm` and `adk` (see script-api.ts):
// `prerequest` events are pre-request scripts and `test` events post-response scripts. ADK checks
// and captures are written after a marker in the test script, so they come back as checks and
// captures. gRPC, WebSocket and socket requests have no v2.1 form and are left out.

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
  const optional = (name: string, key: string = name) =>
    field(name) ? { [key]: field(name) } : {};
  switch (type) {
    case 'noauth':
    case 'ntlm':
      return { type: 'none' };
    case 'digest':
      return { type: 'digest', username: field('username'), password: field('password') };
    case 'awsv4':
      return {
        type: 'awsv4',
        accessKeyId: field('accessKey'),
        secretAccessKey: field('secretKey'),
        ...optional('sessionToken'),
        service: field('service'),
        region: field('region'),
      };
    case 'oauth1': {
      const method = field('signatureMethod');
      return {
        type: 'oauth1',
        consumerKey: field('consumerKey'),
        consumerSecret: field('consumerSecret'),
        ...optional('token'),
        ...optional('tokenSecret'),
        // RSA and SHA-512 signatures are not supported: HMAC-SHA1 is the closest.
        signatureMethod: method === 'HMAC-SHA256' || method === 'PLAINTEXT' ? method : 'HMAC-SHA1',
        ...optional('realm'),
        addTo: field('addParamsToHeader') === 'false' ? 'query' : 'header',
      };
    }
    case 'oauth2':
      return oauth2From(field);
    case 'edgegrid': {
      const maxBodySize = Number.parseInt(field('maxBodySize'), 10);
      return {
        type: 'edgegrid',
        accessToken: field('accessToken'),
        clientToken: field('clientToken'),
        clientSecret: field('clientSecret'),
        ...optional('headersToSign'),
        ...(Number.isFinite(maxBodySize) ? { maxBodySize } : {}),
      };
    }
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

function oauth2From(field: (name: string) => string): RequestAuth {
  const grant = field('grant_type') || 'client_credentials';
  // Authorization code and implicit grants need a browser: not supported by the runner.
  if (grant !== 'client_credentials' && grant !== 'password_credentials') return { type: 'none' };
  const query = field('addTokenTo') === 'queryParams';
  return {
    type: 'oauth2',
    grantType: grant === 'password_credentials' ? 'password' : 'client_credentials',
    accessTokenUrl: field('accessTokenUrl'),
    clientId: field('clientId'),
    clientSecret: field('clientSecret'),
    ...(grant === 'password_credentials'
      ? { username: field('username'), password: field('password') }
      : {}),
    ...(field('scope') ? { scope: field('scope') } : {}),
    // Postman sends the client credentials as a Basic header unless told otherwise.
    credentialsPlacement: field('client_authentication') === 'body' ? 'body' : 'basic',
    tokenPlacement: query ? 'query' : 'header',
    ...(!query && field('headerPrefix') ? { tokenPrefix: field('headerPrefix') } : {}),
  };
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
      const mode: 'json' | 'xml' | 'text' =
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
        fields: list(value['formdata'])
          .filter(isObject)
          .map((entry): FormField => {
            // Files stay on the Postman user's disk: only their names travel.
            const isFile = entry['type'] === 'file';
            const sources = Array.isArray(entry['src']) ? entry['src'] : [entry['src']];
            return {
              key: str(entry['key']),
              value: isFile
                ? sources.map(str).filter(Boolean).map(baseName).join(', ')
                : str(entry['value']),
              type: 'text',
              ...(entry['disabled'] ? { enabled: false } : {}),
              ...(!isFile && str(entry['contentType'])
                ? { contentType: str(entry['contentType']) }
                : {}),
            };
          }),
      };
    case 'file':
      return { mode: 'binary', file: null };
    default:
      return { mode: 'none' };
  }
}

const baseName = (path: string) => path.split(/[\\/]/).pop()!;

function graphqlFrom(value: unknown): ApiRequestSpec['graphql'] {
  if (!isObject(value) || value['mode'] !== 'graphql') return undefined;
  const graphql = isObject(value['graphql']) ? value['graphql'] : {};
  const variables = graphql['variables'];
  const text =
    typeof variables === 'string' ? variables : variables ? JSON.stringify(variables, null, 2) : '';
  return { query: str(graphql['query']), ...(text.trim() ? { variables: text } : {}) };
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

/** Marks where the lines ADK generates from checks and captures start in a test script. */
export const ADK_CHECKS_MARKER = '// --- ADK checks and captures ---';

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

/**
 * Pre-request and test events as scripts, with Postman's `pm` renamed to `adk`. The ADK part of a
 * test script (after the marker) becomes checks and captures again instead of script lines.
 */
function eventsFrom(events: unknown): {
  scripts?: Scripts;
  assertions: Assertion[];
  captures: Capture[];
} {
  const preRequest = toAdkScript(scriptOf(events, 'prerequest').trim());
  const test = scriptOf(events, 'test');
  const marker = test.indexOf(ADK_CHECKS_MARKER);
  const postResponse = toAdkScript((marker < 0 ? test : test.slice(0, marker)).trim());
  const generated = marker < 0 ? '' : test.slice(marker);
  const scripts: Scripts = {
    ...(preRequest ? { preRequest } : {}),
    ...(postResponse ? { postResponse } : {}),
  };
  return {
    ...(Object.keys(scripts).length ? { scripts } : {}),
    assertions: assertionsFromScript(generated),
    captures: capturesFromScript(generated),
  };
}

function settingsFrom(value: unknown): RequestSettings | undefined {
  if (!isObject(value)) return undefined;
  const settings = {
    ...(typeof value['followRedirects'] === 'boolean'
      ? { followRedirects: value['followRedirects'] }
      : {}),
    ...(typeof value['maxRedirects'] === 'number' ? { maxRedirects: value['maxRedirects'] } : {}),
    ...(value['disableUrlEncoding'] === true ? { encodeUrl: false } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}

const descriptionOf = (value: unknown) => str(isObject(value) ? value['content'] : value);

function itemFrom(value: Json): ApiItem {
  const name = str(value['name']) || 'Untitled';
  const events = eventsFrom(value['event']);
  const vars = keyValues(value['variable']);
  if (Array.isArray(value['item'])) {
    const auth = authFrom(value['auth']);
    const description = descriptionOf(value['description']);
    return {
      id: randomUUID(),
      type: 'folder',
      name,
      ...(description ? { description } : {}),
      ...(auth ? { auth } : {}),
      ...(vars.length ? { vars } : {}),
      ...(events.scripts ? { scripts: events.scripts } : {}),
      items: list(value['item']).filter(isObject).map(itemFrom),
    };
  }
  const request = isObject(value['request']) ? value['request'] : { url: value['request'] };
  const headers = keyValues(request['header']);
  const { url, query, pathParams } = urlFrom(request['url']);
  const method = str(request['method']).toUpperCase();
  const description = descriptionOf(request['description']) || descriptionOf(value['description']);
  const graphql = graphqlFrom(request['body']);
  const settings = settingsFrom(value['protocolProfileBehavior']);
  return {
    id: randomUUID(),
    type: 'request',
    ...(graphql ? { kind: 'graphql' as const, graphql } : {}),
    name,
    ...(description ? { description } : {}),
    method: (HTTP_METHODS as readonly string[]).includes(method) ? (method as HttpMethod) : 'GET',
    url,
    ...(pathParams.length ? { pathParams } : {}),
    headers,
    query,
    body: graphql ? { mode: 'none' } : bodyFrom(request['body'], headers),
    auth: authFrom(request['auth']) ?? { type: 'inherit' },
    assertions: events.assertions,
    captures: events.captures,
    ...(vars.length ? { vars } : {}),
    ...(events.scripts ? { scripts: events.scripts } : {}),
    ...(settings ? { settings } : {}),
  };
}

export function importPostman(document: Json): CollectionInput {
  const info = isObject(document['info']) ? document['info'] : {};
  const description = descriptionOf(info['description']);
  const events = eventsFrom(document['event']);
  return {
    name: str(info['name']) || 'Postman collection',
    ...(description ? { description } : {}),
    variables: keyValues(document['variable']),
    auth: authFrom(document['auth']) ?? { type: 'none' },
    items: list(document['item']).filter(isObject).map(itemFrom),
    ...(events.scripts ? { scripts: events.scripts } : {}),
  };
}

const authParams = (entries: Record<string, string | boolean | number | undefined>) =>
  Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value, type: typeof value === 'string' ? 'string' : 'any' }));

function authTo(auth: RequestAuth | undefined): Json | undefined {
  if (!auth || auth.type === 'inherit') return undefined;
  switch (auth.type) {
    case 'none':
    // Postman has no WSSE auth: there the header needs a pre-request script.
    // falls through
    case 'wsse':
      return { type: 'noauth' };
    case 'bearer':
      return { type: 'bearer', bearer: authParams({ token: auth.token }) };
    case 'basic':
    case 'digest':
      return {
        type: auth.type,
        [auth.type]: authParams({ username: auth.username, password: auth.password }),
      };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: authParams({ key: auth.key, value: auth.value, in: auth.in }),
      };
    case 'awsv4':
      return {
        type: 'awsv4',
        awsv4: authParams({
          accessKey: auth.accessKeyId,
          secretKey: auth.secretAccessKey,
          sessionToken: auth.sessionToken,
          service: auth.service,
          region: auth.region,
        }),
      };
    case 'oauth1':
      return {
        type: 'oauth1',
        oauth1: authParams({
          consumerKey: auth.consumerKey,
          consumerSecret: auth.consumerSecret,
          token: auth.token,
          tokenSecret: auth.tokenSecret,
          signatureMethod: auth.signatureMethod,
          realm: auth.realm,
          version: '1.0',
          addParamsToHeader: auth.addTo !== 'query',
        }),
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: authParams({
          // Postman has no refresh_token grant: it is written as client credentials.
          grant_type: auth.grantType === 'password' ? 'password_credentials' : 'client_credentials',
          accessTokenUrl: auth.accessTokenUrl,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          username: auth.grantType === 'password' ? auth.username : undefined,
          password: auth.grantType === 'password' ? auth.password : undefined,
          scope: auth.scope,
          client_authentication: auth.credentialsPlacement === 'basic' ? 'header' : 'body',
          addTokenTo: auth.tokenPlacement === 'query' ? 'queryParams' : 'header',
          headerPrefix: auth.tokenPrefix,
        }),
      };
    case 'edgegrid':
      return {
        type: 'edgegrid',
        edgegrid: authParams({
          accessToken: auth.accessToken,
          clientToken: auth.clientToken,
          clientSecret: auth.clientSecret,
          headersToSign: auth.headersToSign,
          maxBodySize: auth.maxBodySize,
        }),
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
export function scriptFor(request: ApiRequestSpec): string[] {
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
    case 'sparql':
      return {
        mode: 'raw',
        raw: body.content,
        options: {
          raw: { language: body.mode === 'json' || body.mode === 'xml' ? body.mode : 'text' },
        },
      };
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: pairs(body.fields) };
    case 'form':
      return {
        mode: 'formdata',
        formdata: body.fields.map((f) => ({
          key: f.key,
          ...(f.type === 'file'
            ? { type: 'file', src: f.file?.fileName ?? f.value }
            : { value: f.value, type: 'text' }),
          ...(f.contentType ? { contentType: f.contentType } : {}),
          ...(f.enabled === false ? { disabled: true } : {}),
        })),
      };
    case 'binary':
      // The file stays in ADK: Postman gets its name to pick it again.
      return { mode: 'file', file: { src: body.file?.fileName ?? '' } };
  }
}

const pairs = (entries: readonly KeyValue[]) =>
  entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    ...(entry.enabled === false ? { disabled: true } : {}),
  }));

const event = (listen: string, lines: readonly string[]) => ({
  listen,
  script: { type: 'text/javascript', exec: lines },
});

/**
 * Postman runs `test` scripts after the response: post-response scripts and tests go there,
 * calling Postman's `pm` instead of `adk`.
 */
function eventsTo(adkScripts: Scripts | undefined, generated: readonly string[] = []): Json {
  const scripts = fromAdkScripts(adkScripts, 'pm');
  const test = [scripts?.postResponse, scripts?.tests].filter((part) => part?.trim()).join('\n');
  const testLines = [
    ...(test ? test.split('\n') : []),
    ...(generated.length ? [ADK_CHECKS_MARKER, ...generated] : []),
  ];
  const preRequest = scripts?.preRequest?.trim() ? scripts.preRequest.split('\n') : [];
  const events = [
    ...(preRequest.length ? [event('prerequest', preRequest)] : []),
    ...(testLines.length ? [event('test', testLines)] : []),
  ];
  return events.length ? { event: events } : {};
}

function behaviorTo(settings: RequestSettings | undefined): Json {
  const behavior = {
    ...(settings?.followRedirects !== undefined
      ? { followRedirects: settings.followRedirects }
      : {}),
    ...(settings?.maxRedirects !== undefined ? { maxRedirects: settings.maxRedirects } : {}),
    ...(settings?.encodeUrl === false ? { disableUrlEncoding: true } : {}),
  };
  return Object.keys(behavior).length ? { protocolProfileBehavior: behavior } : {};
}

/** Postman v2.1 has no gRPC, WebSocket or raw socket requests. */
const exportable = (item: ApiItem) =>
  item.type === 'folder' || !['grpc', 'websocket', 'socket'].includes(item.kind ?? 'http');

function itemTo(item: ApiItem): Json {
  if (item.type === 'folder') {
    const auth = authTo(item.auth);
    return {
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      ...(auth ? { auth } : {}),
      ...(item.vars?.length ? { variable: pairs(item.vars) } : {}),
      ...eventsTo(item.scripts),
      item: item.items.filter(exportable).map(itemTo),
    };
  }
  const enabledQuery = item.query.filter((entry) => entry.enabled !== false);
  const raw = enabledQuery.length
    ? `${item.url}?${enabledQuery.map((entry) => `${entry.key}=${entry.value}`).join('&')}`
    : item.url;
  const body =
    item.kind === 'graphql' && item.graphql
      ? {
          mode: 'graphql',
          graphql: { query: item.graphql.query, variables: item.graphql.variables ?? '' },
        }
      : bodyTo(item.body);
  const auth = authTo(item.auth);
  return {
    name: item.name,
    ...eventsTo(item.scripts, scriptFor(item)),
    ...(item.vars?.length ? { variable: pairs(item.vars) } : {}),
    ...behaviorTo(item.settings),
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

/** A Postman environment file (what Newman reads with `-e`); secret values are left empty. */
export function exportPostmanEnvironment(environment: {
  readonly name: string;
  readonly variables: readonly Variable[];
}): Json {
  return {
    id: randomUUID(),
    name: environment.name,
    values: environment.variables.map((variable) => ({
      key: variable.key,
      value: variable.secret ? '' : variable.value,
      type: variable.secret ? 'secret' : 'default',
      enabled: variable.enabled !== false,
    })),
    _postman_variable_scope: 'environment',
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
    item: collection.items.filter(exportable).map(itemTo),
    ...eventsTo(collection.scripts),
    ...(auth ? { auth } : {}),
    // Secret values never leave ADK in an export; they are left empty to fill in locally.
    variable: collection.variables.map((variable) => ({
      key: variable.key,
      value: variable.secret ? '' : variable.value,
      ...(variable.enabled === false ? { disabled: true } : {}),
    })),
  };
}
