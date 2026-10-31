import { randomUUID } from 'node:crypto';
import type { CollectionInput } from '../domain/api-test.js';
import type {
  ApiItem,
  ApiRequestSpec,
  FormField,
  HttpMethod,
  KeyValue,
  RequestAuth,
  RequestBody,
  Scripts,
  Variable,
} from '../engine/types.js';
import { HTTP_METHODS } from '../engine/types.js';
import { scriptFor } from './postman.js';
import { fromAdkScript, fromAdkScripts, toAdkScript } from './script-api.js';

// Insomnia export format v4 (`__export_format: 4`), still imported by current Insomnia releases.
// Insomnia writes variables as `{{ _.name }}`; ADK, Postman and Bruno use `{{name}}`. Insomnia v4
// has no declarative assertions, so they are listed in the request description on export.
// Insomnia scripts call `insomnia.*`: imports rename it to `adk` and exports back, with a note.
// gRPC and WebSocket requests are not exported (v4 keeps them as separate resource types).

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

export const INSOMNIA_SCRIPT_NOTE =
  'Imported from Insomnia: its scripts now call `adk` instead of `insomnia`. ADK answers the Postman-style calls Insomnia shares; adapt calls that are Insomnia-only.';

export function isInsomniaExport(document: unknown): boolean {
  return (
    isObject(document) && document['_type'] === 'export' && Array.isArray(document['resources'])
  );
}

/** `{{ _.base_url }}` → `{{base_url}}`. */
const fromInsomnia = (text: string) => text.replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}');
/** `{{base_url}}` → `{{ _.base_url }}`; dynamic helpers (`{{$guid}}`) stay as they are. */
const toInsomnia = (text: string) => text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '{{ _.$1 }}');

function pairsFrom(value: unknown, key = 'name'): KeyValue[] {
  return list(value)
    .filter(isObject)
    .map((entry) => ({
      key: fromInsomnia(str(entry[key])),
      value: fromInsomnia(str(entry['value'])),
      ...(entry['disabled'] ? { enabled: false } : {}),
    }));
}

function authFrom(value: unknown): RequestAuth {
  if (!isObject(value) || !value['type'] || value['disabled']) return { type: 'inherit' };
  const field = (name: string) => fromInsomnia(str(value[name]));
  const optional = (name: string, key: string = name) =>
    field(name) ? { [key]: field(name) } : {};
  switch (str(value['type'])) {
    case 'bearer':
      return { type: 'bearer', token: field('token') };
    case 'basic':
    case 'digest':
      return {
        type: value['type'] === 'digest' ? 'digest' : 'basic',
        username: field('username'),
        password: field('password'),
      };
    case 'apikey':
      return {
        type: 'apikey',
        key: str(value['key']) || 'X-API-Key',
        value: field('value'),
        in: value['addTo'] === 'queryParams' ? 'query' : 'header',
      };
    case 'oauth2':
      return oauth2From(value, field);
    case 'iam':
      return {
        type: 'awsv4',
        accessKeyId: field('accessKeyId'),
        secretAccessKey: field('secretAccessKey'),
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
        ...optional('tokenKey', 'token'),
        ...optional('tokenSecret'),
        // RSA signatures are not supported: HMAC-SHA1 is the closest.
        signatureMethod: method === 'HMAC-SHA256' || method === 'PLAINTEXT' ? method : 'HMAC-SHA1',
        ...optional('realm'),
      };
    }
    // Hawk, NTLM, ASAP and netrc have no ADK equivalent.
    default:
      return { type: 'none' };
  }
}

function oauth2From(value: Json, field: (name: string) => string): RequestAuth {
  const grant = str(value['grantType']);
  // Authorization code and implicit grants need a browser: not supported by the runner.
  if (grant !== 'client_credentials' && grant !== 'password' && grant !== 'refresh_token') {
    return { type: 'none' };
  }
  return {
    type: 'oauth2',
    grantType: grant,
    accessTokenUrl: field('accessTokenUrl'),
    clientId: field('clientId'),
    clientSecret: field('clientSecret'),
    ...(grant === 'password' ? { username: field('username'), password: field('password') } : {}),
    ...(field('refreshToken') ? { refreshToken: field('refreshToken') } : {}),
    ...(field('scope') ? { scope: field('scope') } : {}),
    ...(field('audience') ? { audience: field('audience') } : {}),
    credentialsPlacement: value['credentialsInBody'] ? 'body' : 'basic',
    ...(field('tokenPrefix') ? { tokenPrefix: field('tokenPrefix') } : {}),
  };
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function bodyFrom(value: unknown): RequestBody {
  if (!isObject(value)) return { mode: 'none' };
  const mimeType = str(value['mimeType']);
  if (mimeType === 'application/x-www-form-urlencoded')
    return { mode: 'urlencoded', fields: pairsFrom(value['params']) };
  if (mimeType === 'multipart/form-data')
    return {
      mode: 'form',
      fields: list(value['params'])
        .filter(isObject)
        .map((entry): FormField => {
          // Files stay on the Insomnia user's disk: only their names travel.
          const isFile = entry['type'] === 'file';
          return {
            key: fromInsomnia(str(entry['name'])),
            value: isFile ? baseName(str(entry['fileName'])) : fromInsomnia(str(entry['value'])),
            type: 'text',
            ...(entry['disabled'] ? { enabled: false } : {}),
          };
        }),
    };
  if (mimeType === 'application/octet-stream') return { mode: 'binary', file: null };
  if (value['text'] === undefined) return { mode: 'none' };
  const mode = mimeType.includes('json') ? 'json' : mimeType.includes('xml') ? 'xml' : 'text';
  return { mode, content: fromInsomnia(str(value['text'])) };
}

/** `application/graphql` bodies hold `{ query, variables, operationName }` as JSON text. */
function graphqlFrom(value: unknown): ApiRequestSpec['graphql'] {
  if (!isObject(value) || value['mimeType'] !== 'application/graphql') return undefined;
  let parsed: Json = {};
  try {
    const json: unknown = JSON.parse(str(value['text']) || '{}');
    if (isObject(json)) parsed = json;
  } catch {
    parsed = { query: str(value['text']) };
  }
  const variables = parsed['variables'];
  return {
    query: fromInsomnia(str(parsed['query'])),
    ...(isObject(variables) && Object.keys(variables).length
      ? { variables: fromInsomnia(JSON.stringify(variables, null, 2)) }
      : {}),
    ...(str(parsed['operationName']) ? { operationName: str(parsed['operationName']) } : {}),
  };
}

function scriptsFrom(resource: Json): Scripts | undefined {
  const preRequest = toAdkScript(str(resource['preRequestScript']).trim());
  const postResponse = toAdkScript(str(resource['afterResponseScript']).trim());
  if (!preRequest && !postResponse) return undefined;
  return { ...(preRequest ? { preRequest } : {}), ...(postResponse ? { postResponse } : {}) };
}

/** The description, with a note when Insomnia scripts came along. */
function describe(resource: Json, scripts: Scripts | undefined): Json {
  const description = [str(resource['description']), scripts ? INSOMNIA_SCRIPT_NOTE : '']
    .filter(Boolean)
    .join('\n\n');
  return description ? { description } : {};
}

function settingsFrom(resource: Json): ApiRequestSpec['settings'] {
  const follow = resource['settingFollowRedirects'];
  const settings = {
    ...(follow === 'on' || follow === 'off' ? { followRedirects: follow === 'on' } : {}),
    ...(resource['settingEncodeUrl'] === false ? { encodeUrl: false } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}

function requestFrom(resource: Json): ApiRequestSpec {
  const method = str(resource['method']).toUpperCase();
  const scripts = scriptsFrom(resource);
  const graphql = graphqlFrom(resource['body']);
  const settings = settingsFrom(resource);
  return {
    id: randomUUID(),
    type: 'request',
    ...(graphql ? { kind: 'graphql' as const, graphql } : {}),
    name: str(resource['name']) || 'Request',
    ...describe(resource, scripts),
    method: (HTTP_METHODS as readonly string[]).includes(method) ? (method as HttpMethod) : 'GET',
    url: fromInsomnia(str(resource['url'])),
    headers: pairsFrom(resource['headers']),
    query: pairsFrom(resource['parameters']),
    body: graphql ? { mode: 'none' } : bodyFrom(resource['body']),
    auth: authFrom(resource['authentication']),
    assertions: [],
    captures: [],
    ...(scripts ? { scripts } : {}),
    ...(settings ? { settings } : {}),
  };
}

export function importInsomnia(document: Json): CollectionInput {
  const resources = list(document['resources']).filter(isObject);
  const workspace = resources.find((resource) => resource['_type'] === 'workspace');
  const childrenOf = (parentId: unknown): ApiItem[] =>
    resources
      .filter((resource) => resource['parentId'] === parentId)
      .sort((a, b) => Number(a['metaSortKey'] ?? 0) - Number(b['metaSortKey'] ?? 0))
      .flatMap((resource): ApiItem[] => {
        if (resource['_type'] === 'request_group') {
          const auth = authFrom(resource['authentication']);
          const scripts = scriptsFrom(resource);
          const environment = isObject(resource['environment']) ? resource['environment'] : {};
          const vars = Object.entries(environment).map(([key, value]) => ({
            key,
            value: typeof value === 'string' ? fromInsomnia(value) : JSON.stringify(value),
          }));
          return [
            {
              id: randomUUID(),
              type: 'folder',
              name: str(resource['name']) || 'Folder',
              ...describe(resource, scripts),
              ...(auth.type !== 'inherit' ? { auth } : {}),
              ...(vars.length ? { vars } : {}),
              ...(scripts ? { scripts } : {}),
              items: childrenOf(resource['_id']),
            },
          ];
        }
        return resource['_type'] === 'request' ? [requestFrom(resource)] : [];
      });
  // Variables come from the base environment (the one directly under the workspace).
  const environment = resources.find(
    (resource) =>
      resource['_type'] === 'environment' && resource['parentId'] === workspace?.['_id'],
  );
  const data = isObject(environment?.['data']) ? environment['data'] : {};
  return {
    name: str(workspace?.['name']) || 'Insomnia collection',
    ...(str(workspace?.['description']) ? { description: str(workspace?.['description']) } : {}),
    variables: Object.entries(data).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? fromInsomnia(value) : JSON.stringify(value),
    })),
    auth: { type: 'none' },
    items: childrenOf(workspace?.['_id'] ?? null),
  };
}

function authTo(auth: RequestAuth | undefined): Json {
  switch (auth?.type) {
    case undefined:
    case 'inherit':
      return {};
    // Insomnia has no WSSE or EdgeGrid auth: there they need a pre-request script.
    case 'none':
    case 'wsse':
    case 'edgegrid':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: toInsomnia(auth.token) };
    case 'basic':
    case 'digest':
      return {
        type: auth.type,
        username: toInsomnia(auth.username),
        password: toInsomnia(auth.password),
      };
    case 'apikey':
      return {
        type: 'apikey',
        key: auth.key,
        value: toInsomnia(auth.value),
        addTo: auth.in === 'query' ? 'queryParams' : 'header',
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        grantType: auth.grantType,
        accessTokenUrl: toInsomnia(auth.accessTokenUrl),
        clientId: toInsomnia(auth.clientId),
        clientSecret: toInsomnia(auth.clientSecret),
        username: toInsomnia(auth.username ?? ''),
        password: toInsomnia(auth.password ?? ''),
        refreshToken: toInsomnia(auth.refreshToken ?? ''),
        scope: auth.scope ?? '',
        audience: auth.audience ?? '',
        credentialsInBody: auth.credentialsPlacement !== 'basic',
        tokenPrefix: auth.tokenPrefix ?? '',
      };
    case 'awsv4':
      return {
        type: 'iam',
        accessKeyId: toInsomnia(auth.accessKeyId),
        secretAccessKey: toInsomnia(auth.secretAccessKey),
        sessionToken: toInsomnia(auth.sessionToken ?? ''),
        service: auth.service,
        region: auth.region,
      };
    case 'oauth1':
      return {
        type: 'oauth1',
        consumerKey: toInsomnia(auth.consumerKey),
        consumerSecret: toInsomnia(auth.consumerSecret),
        tokenKey: toInsomnia(auth.token ?? ''),
        tokenSecret: toInsomnia(auth.tokenSecret ?? ''),
        signatureMethod: auth.signatureMethod,
        realm: auth.realm ?? '',
      };
  }
}

function bodyTo(body: RequestBody): Json {
  switch (body.mode) {
    case 'none':
      return {};
    case 'json':
      return { mimeType: 'application/json', text: toInsomnia(body.content) };
    case 'xml':
      return { mimeType: 'application/xml', text: toInsomnia(body.content) };
    case 'text':
      return { mimeType: 'text/plain', text: toInsomnia(body.content) };
    case 'sparql':
      return { mimeType: 'application/sparql-query', text: toInsomnia(body.content) };
    case 'urlencoded':
      return {
        mimeType: 'application/x-www-form-urlencoded',
        params: body.fields.map((f) => ({
          name: f.key,
          value: toInsomnia(f.value),
          disabled: f.enabled === false,
        })),
      };
    case 'form':
      return {
        mimeType: 'multipart/form-data',
        params: body.fields.map((f) => ({
          name: f.key,
          ...(f.type === 'file'
            ? { type: 'file', fileName: f.file?.fileName ?? f.value }
            : { value: toInsomnia(f.value) }),
          disabled: f.enabled === false,
        })),
      };
    case 'binary':
      // The file stays in ADK: Insomnia gets its name to pick it again.
      return { mimeType: 'application/octet-stream', fileName: body.file?.fileName ?? '' };
  }
}

function graphqlTo(request: ApiRequestSpec): Json {
  const graphql = request.graphql ?? { query: '' };
  let variables: unknown = {};
  try {
    variables = JSON.parse(graphql.variables?.trim() || '{}');
  } catch {
    // invalid JSON variables are dropped: Insomnia needs an object
  }
  return {
    mimeType: 'application/graphql',
    text: toInsomnia(
      JSON.stringify({
        query: graphql.query,
        variables,
        ...(graphql.operationName ? { operationName: graphql.operationName } : {}),
      }),
    ),
  };
}

/** The scripts of an item, calling Insomnia's `insomnia` instead of `adk`. */
function scriptsTo(adkScripts: Scripts | undefined, checks = ''): Json {
  const scripts = fromAdkScripts(adkScripts, 'insomnia');
  const after = [scripts?.postResponse, scripts?.tests, checks]
    .filter((part) => part?.trim())
    .join('\n');
  return {
    ...(scripts?.preRequest?.trim() ? { preRequestScript: scripts.preRequest } : {}),
    ...(after ? { afterResponseScript: after } : {}),
  };
}

function settingsTo(request: ApiRequestSpec): Json {
  const settings = request.settings;
  return {
    ...(settings?.followRedirects !== undefined
      ? { settingFollowRedirects: settings.followRedirects ? 'on' : 'off' }
      : {}),
    ...(settings?.encodeUrl !== undefined ? { settingEncodeUrl: settings.encodeUrl } : {}),
  };
}

const environmentData = (variables: readonly Variable[]) =>
  Object.fromEntries(
    variables
      .filter((variable) => variable.enabled !== false)
      .map((variable) => [variable.key, variable.secret ? '' : variable.value]),
  );

export interface InsomniaExportOptions {
  /** Sub-environments of the base environment; secret values are left empty. */
  readonly environments?: readonly {
    readonly name: string;
    readonly variables: readonly Variable[];
  }[];
  /**
   * Also writes the checks and captures as after-response scripts, so `inso run collection`
   * verifies them (pipelines); otherwise they are only listed in the description.
   */
  readonly executableChecks?: boolean;
}

export function exportInsomnia(
  collection: CollectionInput,
  options: InsomniaExportOptions = {},
): Json {
  const workspaceId = `wrk_${randomUUID().replace(/-/g, '')}`;
  const baseEnvironmentId = `env_${randomUUID().replace(/-/g, '')}`;
  const resources: Json[] = [
    {
      _id: workspaceId,
      _type: 'workspace',
      parentId: null,
      name: collection.name,
      description: collection.description ?? '',
      scope: 'collection',
    },
    {
      _id: baseEnvironmentId,
      _type: 'environment',
      parentId: workspaceId,
      name: 'Base Environment',
      data: environmentData(collection.variables),
    },
    ...(options.environments ?? []).map((environment) => ({
      _id: `env_${randomUUID().replace(/-/g, '')}`,
      _type: 'environment',
      parentId: baseEnvironmentId,
      name: environment.name,
      data: environmentData(environment.variables),
    })),
  ];
  let sort = 0;
  const add = (items: readonly ApiItem[], parentId: string, inherited: RequestAuth) => {
    for (const item of items) {
      const kind = item.type === 'request' ? (item.kind ?? 'http') : 'http';
      if (kind === 'grpc' || kind === 'websocket' || kind === 'socket') continue;
      sort += 1;
      const id = `${item.type === 'folder' ? 'fld' : 'req'}_${randomUUID().replace(/-/g, '')}`;
      if (item.type === 'folder') {
        resources.push({
          _id: id,
          _type: 'request_group',
          parentId,
          name: item.name,
          description: item.description ?? '',
          metaSortKey: sort,
          ...(item.vars?.length
            ? {
                environment: Object.fromEntries(
                  item.vars.map((entry) => [entry.key, toInsomnia(entry.value)]),
                ),
              }
            : {}),
          ...(item.auth && item.auth.type !== 'inherit'
            ? { authentication: authTo(item.auth) }
            : {}),
          ...scriptsTo(item.scripts),
        });
        add(item.items, id, item.auth && item.auth.type !== 'inherit' ? item.auth : inherited);
        continue;
      }
      const checks = item.assertions.map(
        (a) => `- ${[a.source, a.path, a.operator, a.expected].filter(Boolean).join(' ')}`,
      );
      const captures = item.captures.map(
        (c) => `- ${c.variable} ← ${c.source}${c.path ? ` ${c.path}` : ''}`,
      );
      const description = [
        item.description ?? '',
        checks.length ? `Checks (ADK):\n${checks.join('\n')}` : '',
        captures.length ? `Captures (ADK):\n${captures.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      resources.push({
        _id: id,
        _type: 'request',
        parentId,
        name: item.name,
        description,
        method: item.method,
        url: toInsomnia(item.url),
        headers: item.headers.map((h) => ({
          name: h.key,
          value: toInsomnia(h.value),
          disabled: h.enabled === false,
        })),
        parameters: item.query.map((q) => ({
          name: q.key,
          value: toInsomnia(q.value),
          disabled: q.enabled === false,
        })),
        body: kind === 'graphql' ? graphqlTo(item) : bodyTo(item.body),
        // Insomnia v4 has no auth inheritance: the effective auth is written on each request.
        authentication: authTo(item.auth.type === 'inherit' ? inherited : item.auth),
        metaSortKey: sort,
        ...scriptsTo(
          item.scripts,
          options.executableChecks
            ? fromAdkScript(toAdkScript(scriptFor(item).join('\n')), 'insomnia')
            : '',
        ),
        ...settingsTo(item),
      });
    }
  };
  add(collection.items, workspaceId, collection.auth);
  return {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'adk',
    resources,
  };
}
