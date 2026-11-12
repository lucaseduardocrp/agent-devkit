import { randomUUID } from 'node:crypto';
import type { CollectionInput, EnvironmentInput } from '../domain/api-test.js';
import type {
  ApiFolder,
  ApiItem,
  ApiRequestSpec,
  Assertion,
  Capture,
  CollectionSettings,
  FormField,
  HttpMethod,
  KeyValue,
  OutgoingMessage,
  RequestAuth,
  RequestBody,
  RequestSettings,
  Scripts,
  Variable,
} from '../engine/types.js';
import { HTTP_METHODS } from '../engine/types.js';
import { fromAdkScripts, toAdkScript } from './script-api.js';

// Bruno collection (https://docs.usebruno.com): a folder with bruno.json, collection.bru, one
// folder.bru per folder and one .bru file per request, plus environments/<name>.bru. Assertions
// map to Bruno's declarative `assert` block and captures to `vars:post-response`. Files of
// multipart fields and binary bodies stay on the user's disk in Bruno: only their names travel.

export interface BrunoFile {
  readonly path: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------------------------
// Writing

const safeName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';

const indent = (text: string, spaces = 2) =>
  text
    .split('\n')
    .map((line) => (line ? `${' '.repeat(spaces)}${line}` : line))
    .join('\n');

const block = (title: string, lines: readonly string[]) =>
  lines.length ? `${title} {\n${lines.map((line) => indent(line)).join('\n')}\n}\n` : '';

const textBlock = (title: string, text: string | undefined) =>
  text?.trim() ? `${title} {\n${indent(text)}\n}\n` : '';

/** Keys with `:`, quotes, braces or spaces are quoted, as Bruno does. */
const keyString = (key: string) =>
  /[:"{} ]/.test(key) ? `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : key;
/** Multi-line values go between `'''`. */
const valueString = (value: string) =>
  /[\r\n]/.test(value) ? `'''\n${indent(value)}\n'''` : value;

const pairLine = (key: string, value: string, enabled = true) =>
  `${enabled ? '' : '~'}${keyString(key)}: ${valueString(value)}`;

const pairLines = (entries: readonly { key: string; value: string; enabled?: boolean }[]) =>
  entries.map((entry) => pairLine(entry.key, entry.value, entry.enabled !== false));

/** Bruno list items only allow letters, digits, `_` and `-`. */
const listItem = (value: string) => value.trim().replace(/[^\w-]+/g, '-');

function authMode(auth: RequestAuth | undefined): string {
  if (!auth || auth.type === 'inherit') return 'inherit';
  return auth.type === 'edgegrid' ? 'akamai-edgegrid' : auth.type;
}

function authBlock(auth: RequestAuth | undefined): string {
  switch (auth?.type) {
    case undefined:
    case 'none':
    case 'inherit':
      return '';
    case 'bearer':
      return block('auth:bearer', [`token: ${auth.token}`]);
    case 'basic':
    case 'digest':
    case 'wsse':
      return block(`auth:${auth.type}`, [
        `username: ${auth.username}`,
        `password: ${auth.password}`,
      ]);
    case 'apikey':
      return block('auth:apikey', [
        `key: ${auth.key}`,
        `value: ${auth.value}`,
        `placement: ${auth.in === 'query' ? 'queryparams' : 'header'}`,
      ]);
    case 'awsv4':
      return block('auth:awsv4', [
        `accessKeyId: ${auth.accessKeyId}`,
        `secretAccessKey: ${auth.secretAccessKey}`,
        `sessionToken: ${auth.sessionToken ?? ''}`,
        `service: ${auth.service}`,
        `region: ${auth.region}`,
        'profileName: ',
      ]);
    case 'oauth2': {
      // Bruno has no refresh_token grant: it is written as client credentials.
      const grant = auth.grantType === 'password' ? 'password' : 'client_credentials';
      const query = auth.tokenPlacement === 'query';
      return block('auth:oauth2', [
        `grant_type: ${grant}`,
        `access_token_url: ${auth.accessTokenUrl}`,
        'refresh_token_url: ',
        ...(grant === 'password'
          ? [`username: ${auth.username ?? ''}`, `password: ${auth.password ?? ''}`]
          : []),
        `client_id: ${auth.clientId}`,
        `client_secret: ${auth.clientSecret}`,
        `scope: ${auth.scope ?? ''}`,
        `credentials_placement: ${auth.credentialsPlacement === 'basic' ? 'basic_auth_header' : 'body'}`,
        'credentials_id: credentials',
        'token_source: access_token',
        `token_placement: ${query ? 'url' : 'header'}`,
        query
          ? `token_query_key: ${auth.tokenQueryKey ?? 'access_token'}`
          : `token_header_prefix: ${auth.tokenPrefix ?? 'Bearer'}`,
        'auto_fetch_token: true',
        'auto_refresh_token: true',
      ]);
    }
    case 'oauth1':
      return block('auth:oauth1', [
        `consumer_key: ${auth.consumerKey}`,
        `consumer_secret: ${auth.consumerSecret}`,
        `access_token: ${auth.token ?? ''}`,
        `token_secret: ${auth.tokenSecret ?? ''}`,
        'callback_url: ',
        'verifier: ',
        `signature_method: ${auth.signatureMethod}`,
        'private_key: ',
        'timestamp: ',
        'nonce: ',
        'version: 1.0',
        `realm: ${auth.realm ?? ''}`,
        `placement: ${auth.addTo === 'query' ? 'query' : 'header'}`,
        'include_body_hash: false',
      ]);
    case 'edgegrid':
      return block('auth:akamai-edgegrid', [
        `accessToken: ${auth.accessToken}`,
        `clientToken: ${auth.clientToken}`,
        `clientSecret: ${auth.clientSecret}`,
        'nonce: ',
        'timestamp: ',
        'baseURL: ',
        `headersToSign: ${auth.headersToSign ?? ''}`,
        `maxBodySize: ${auth.maxBodySize ?? ''}`,
      ]);
  }
}

/** `data.items[0].id` → `res.body.data.items[0].id`. */
function target(assertion: Pick<Assertion, 'source' | 'path'>): string {
  switch (assertion.source) {
    case 'status':
      return 'res.status';
    case 'duration':
      return 'res.responseTime';
    case 'header':
      return `res.headers["${(assertion.path ?? '').toLowerCase()}"]`;
    case 'body':
      return 'res.body';
    case 'json': {
      const path = (assertion.path ?? '').replace(/^\$\.?/, '');
      if (!path) return 'res.body';
      return path.startsWith('[') ? `res.body${path}` : `res.body.${path}`;
    }
  }
}

const BRUNO_TYPE_CHECKS: Readonly<Record<string, string>> = {
  string: 'isString',
  number: 'isNumber',
  boolean: 'isBoolean',
  array: 'isArray',
  object: 'isJson',
  null: 'isNull',
};

function assertLine(assertion: Assertion): string {
  const expected = assertion.expected ?? '';
  const quoted =
    /^-?\d+(\.\d+)?$/.test(expected) || /^(true|false|null)$/.test(expected)
      ? expected
      : `"${expected}"`;
  const operator: Record<Assertion['operator'], string> = {
    eq: `eq ${quoted}`,
    neq: `neq ${quoted}`,
    contains: `contains ${quoted}`,
    notContains: `notContains ${quoted}`,
    exists: 'isDefined',
    notExists: 'isUndefined',
    lt: `lt ${expected}`,
    lte: `lte ${expected}`,
    gt: `gt ${expected}`,
    gte: `gte ${expected}`,
    matches: `matches ${expected}`,
    isType: BRUNO_TYPE_CHECKS[expected.toLowerCase()] ?? `isJson`,
  };
  return `${target(assertion)}: ${operator[assertion.operator]}`;
}

const BODY_MODES: Readonly<Record<RequestBody['mode'], string>> = {
  none: 'none',
  json: 'json',
  text: 'text',
  xml: 'xml',
  sparql: 'sparql',
  urlencoded: 'formUrlEncoded',
  form: 'multipartForm',
  binary: 'file',
};

function bodyBlocks(body: RequestBody): string[] {
  switch (body.mode) {
    case 'none':
      return [];
    case 'json':
    case 'text':
    case 'xml':
    case 'sparql':
      return [`body:${body.mode} {\n${indent(body.content)}\n}\n`];
    case 'urlencoded':
      return [block('body:form-urlencoded', pairLines(body.fields))];
    case 'form':
      return [block('body:multipart-form', body.fields.map(formFieldLine))];
    case 'binary':
      return body.file
        ? [
            block('body:file', [
              `file: @file(${body.file.fileName})${body.file.contentType ? ` @contentType(${body.file.contentType})` : ''}`,
            ]),
          ]
        : [];
  }
}

function formFieldLine(field: FormField): string {
  const contentType = field.contentType ? ` @contentType(${field.contentType})` : '';
  const value =
    field.type === 'file'
      ? `@file(${field.file?.fileName ?? field.value})`
      : valueString(field.value);
  return `${field.enabled === false ? '~' : ''}${keyString(field.key)}: ${value}${contentType}`;
}

function messageBlocks(title: 'body:grpc' | 'body:ws', messages: readonly OutgoingMessage[]) {
  return messages.map((message, index) => {
    const lines = [`name: ${message.name ?? `message ${index + 1}`}`];
    if (title === 'body:ws' && message.type) lines.push(`type: ${message.type}`);
    lines.push(`content: '''\n${indent(message.content)}\n'''`);
    return block(title, lines);
  });
}

function grpcMessages(message: string): OutgoingMessage[] {
  try {
    const parsed: unknown = JSON.parse(message);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => ({ content: JSON.stringify(entry, null, 2) }));
    }
  } catch {
    // not JSON: sent as typed
  }
  return [{ content: message }];
}

const captureLine = (capture: Capture) =>
  `${keyString(capture.variable)}: ${target({ source: capture.source, path: capture.path })}`;

/** The scripts of an item, calling Bruno's `bru` instead of `adk`. */
function scriptBlocks(adkScripts: Scripts | undefined): string[] {
  const scripts = fromAdkScripts(adkScripts, 'bru');
  return [
    textBlock('script:pre-request', scripts?.preRequest),
    textBlock('script:post-response', scripts?.postResponse),
    textBlock('tests', scripts?.tests),
  ];
}

function settingsBlock(request: ApiRequestSpec): string {
  const settings = request.settings ?? {};
  const lines: string[] = [];
  if (settings.encodeUrl !== undefined) lines.push(`encodeUrl: ${settings.encodeUrl}`);
  if (request.timeoutMs !== undefined) lines.push(`timeout: ${request.timeoutMs}`);
  if (settings.followRedirects !== undefined) {
    lines.push(`followRedirects: ${settings.followRedirects}`);
  }
  if (settings.maxRedirects !== undefined) lines.push(`maxRedirects: ${settings.maxRedirects}`);
  return block('settings', lines);
}

function metaBlock(name: string, type: string | undefined, seq: number, tags?: readonly string[]) {
  const lines = [`name: ${name}`];
  if (type) lines.push(`type: ${type}`);
  lines.push(`seq: ${seq}`);
  const items = (tags ?? []).map(listItem).filter(Boolean);
  if (items.length) lines.push(`tags: [\n${items.map((tag) => indent(tag)).join('\n')}\n]`);
  return block('meta', lines);
}

/** `null` for requests Bruno cannot express (raw TCP/UDP sockets). */
export function requestFile(request: ApiRequestSpec, seq: number): string | null {
  const kind = request.kind ?? 'http';
  if (kind === 'socket') return null;
  const mode = authMode(request.auth);
  const parts: string[] = [];
  if (kind === 'grpc') {
    const grpc = request.grpc;
    parts.push(
      metaBlock(request.name, 'grpc', seq, request.tags),
      block('grpc', [
        `url: ${request.url}`,
        `method: ${grpc?.method ? `/${grpc.method.replace(/^\//, '')}` : ''}`,
        'body: grpc',
        ...(grpc?.protoFile ? [`protoPath: protos/${grpc.protoFile}`] : []),
        `auth: ${mode}`,
      ]),
      block('metadata', pairLines(request.headers)),
      authBlock(request.auth),
      ...messageBlocks('body:grpc', grpc ? grpcMessages(grpc.message) : []),
    );
  } else if (kind === 'websocket') {
    parts.push(
      metaBlock(request.name, 'ws', seq, request.tags),
      block('ws', [`url: ${request.url}`, 'body: ws', `auth: ${mode}`]),
      block('headers', pairLines(request.headers)),
      authBlock(request.auth),
      ...messageBlocks('body:ws', request.websocket?.messages ?? []),
    );
  } else {
    const graphql = kind === 'graphql' ? request.graphql : undefined;
    parts.push(
      metaBlock(request.name, graphql ? 'graphql' : 'http', seq, request.tags),
      block(request.method.toLowerCase(), [
        `url: ${request.url}`,
        `body: ${graphql ? 'graphql' : BODY_MODES[request.body.mode]}`,
        `auth: ${mode}`,
      ]),
      block('params:query', pairLines(request.query)),
      block('params:path', pairLines(request.pathParams ?? [])),
      block('headers', pairLines(request.headers)),
      authBlock(request.auth),
      ...(graphql
        ? [
            textBlock('body:graphql', graphql.query || ' '),
            textBlock('body:graphql:vars', graphql.variables),
          ]
        : bodyBlocks(request.body)),
    );
  }
  parts.push(
    block('vars:pre-request', pairLines(request.vars ?? [])),
    block('vars:post-response', request.captures.map(captureLine)),
    block('assert', request.assertions.map(assertLine)),
    ...scriptBlocks(request.scripts),
    settingsBlock(request),
    textBlock('docs', request.description),
  );
  return parts.filter(Boolean).join('\n');
}

export function environmentFile(variables: readonly Variable[]): string {
  const enabled = variables.filter((variable) => variable.enabled !== false);
  const plain = enabled.filter((variable) => !variable.secret);
  const secret = enabled.filter((variable) => variable.secret);
  return [
    block('vars', pairLines(plain)),
    secret.length
      ? `vars:secret [\n${secret.map((variable) => indent(variable.key)).join(',\n')}\n]\n`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function folderFile(folder: ApiFolder, seq: number): string {
  return [
    block('meta', [`name: ${folder.name}`, `seq: ${seq}`]),
    block('headers', pairLines(folder.headers ?? [])),
    folder.auth ? block('auth', [`mode: ${authMode(folder.auth)}`]) : '',
    authBlock(folder.auth),
    block('vars:pre-request', pairLines(folder.vars ?? [])),
    ...scriptBlocks(folder.scripts),
    textBlock('docs', folder.description),
  ]
    .filter(Boolean)
    .join('\n');
}

function collectionFile(collection: CollectionInput): string {
  const mode = authMode(collection.auth);
  return [
    block('meta', [`name: ${collection.name}`]),
    block('headers', pairLines(collection.headers ?? [])),
    block('auth', [`mode: ${mode === 'inherit' ? 'none' : mode}`]),
    authBlock(collection.auth),
    // Collection variables become Bruno's pre-request collection vars.
    block(
      'vars:pre-request',
      pairLines(
        collection.variables.map((variable) => ({
          ...variable,
          value: variable.secret ? '' : variable.value,
        })),
      ),
    ),
    ...scriptBlocks(collection.scripts),
    textBlock('docs', collection.description),
  ]
    .filter(Boolean)
    .join('\n');
}

const PRESET_TYPES: Readonly<Record<string, string>> = {
  http: 'http',
  graphql: 'graphql',
  grpc: 'grpc',
  websocket: 'ws',
};

function brunoJson(collection: CollectionInput): Record<string, unknown> {
  const settings: CollectionSettings = collection.settings ?? {};
  const config: Record<string, unknown> = {
    version: '1',
    name: collection.name,
    type: 'collection',
    ignore: ['node_modules', '.git'],
  };
  if (collection.scriptFlow) config['scripts'] = { flow: collection.scriptFlow };
  if (settings.proxy) {
    const proxy = settings.proxy;
    // Secrets stay in ADK: the proxy password is filled in locally.
    config['proxy'] = {
      inherit: false,
      ...(proxy.enabled ? {} : { disabled: true }),
      config: {
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port,
        auth: {
          username: proxy.username ?? '',
          password: '',
          ...(proxy.username ? {} : { disabled: true }),
        },
        bypassProxy: proxy.bypass ?? '',
      },
    };
  }
  if (settings.clientCertificates?.length) {
    // Certificates and keys stay in ADK; Bruno asks for the files of each domain.
    config['clientCertificates'] = {
      enabled: true,
      certs: settings.clientCertificates.map((certificate) =>
        certificate.type === 'pfx'
          ? { domain: certificate.domain, type: 'pfx', pfxFilePath: '', passphrase: '' }
          : {
              domain: certificate.domain,
              type: 'cert',
              certFilePath: '',
              keyFilePath: '',
              passphrase: '',
            },
      ),
    };
  }
  if (settings.presets) {
    config['presets'] = {
      requestType: PRESET_TYPES[settings.presets.kind ?? 'http'] ?? 'http',
      requestUrl: settings.presets.baseUrl ?? '',
    };
  }
  if (collection.protoFiles?.length) {
    config['protobuf'] = {
      protoFiles: collection.protoFiles.map((file) => ({
        path: `protos/${file.name}`,
        type: 'file',
      })),
      importPaths: [{ path: 'protos', enabled: true }],
    };
  }
  return config;
}

/** Every file of the Bruno collection, under a root folder named after the collection. */
export function exportBruno(
  collection: CollectionInput,
  environments: readonly { readonly name: string; readonly variables: readonly Variable[] }[] = [],
): BrunoFile[] {
  const root = safeName(collection.name);
  const files: BrunoFile[] = [
    { path: `${root}/bruno.json`, content: `${JSON.stringify(brunoJson(collection), null, 2)}\n` },
    { path: `${root}/collection.bru`, content: collectionFile(collection) },
  ];
  for (const environment of environments) {
    files.push({
      path: `${root}/environments/${safeName(environment.name)}.bru`,
      content: environmentFile(
        environment.variables.map((variable) =>
          variable.secret ? { ...variable, value: '' } : variable,
        ),
      ),
    });
  }
  for (const proto of collection.protoFiles ?? []) {
    files.push({ path: `${root}/protos/${proto.name}`, content: proto.content });
  }
  const walk = (items: readonly ApiItem[], folder: string) => {
    const used = new Set<string>();
    const unique = (name: string) => {
      let candidate = safeName(name);
      for (let n = 2; used.has(candidate.toLowerCase()); n += 1)
        candidate = `${safeName(name)} ${n}`;
      used.add(candidate.toLowerCase());
      return candidate;
    };
    items.forEach((item, index) => {
      if (item.type === 'folder') {
        const path = `${folder}/${unique(item.name)}`;
        files.push({ path: `${path}/folder.bru`, content: folderFile(item, index + 1) });
        walk(item.items, path);
        return;
      }
      const content = requestFile(item, index + 1);
      if (content !== null) files.push({ path: `${folder}/${unique(item.name)}.bru`, content });
    });
  };
  walk(collection.items, root);
  return files;
}

// ---------------------------------------------------------------------------------------------
// Reading

interface BruPair {
  readonly key: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly contentType?: string;
  /** `tags: [ a, b ]`. */
  readonly list?: readonly string[];
}

interface BruBlock {
  readonly name: string;
  readonly text?: string;
  readonly pairs?: readonly BruPair[];
  readonly items?: readonly string[];
}

const DICTIONARY_BODIES = new Set([
  'body:form-urlencoded',
  'body:multipart-form',
  'body:file',
  'body:grpc',
  'body:ws',
]);

function isTextBlock(name: string): boolean {
  if (name.startsWith('body')) return !DICTIONARY_BODIES.has(name);
  return name.startsWith('script:') || ['tests', 'docs', 'example'].includes(name);
}

function outdent(lines: readonly string[], spaces: number): string {
  const prefix = new RegExp(`^ {0,${spaces}}`);
  return lines.map((line) => line.replace(prefix, '')).join('\n');
}

/** Splits a .bru file into its blocks (dictionaries, text blocks and lists). */
export function parseBru(content: string): BruBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BruBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = /^([\w:.@-]+)\s*([{[])\s*$/.exec(lines[index]!);
    index += 1;
    if (!header) continue;
    const name = header[1]!;
    const close = header[2] === '[' ? ']' : '}';
    const body: string[] = [];
    while (index < lines.length && lines[index]!.trimEnd() !== close) {
      body.push(lines[index]!);
      index += 1;
    }
    index += 1;
    if (close === ']') {
      blocks.push({
        name,
        items: body
          .flatMap((line) => line.split(','))
          .map((item) => item.trim())
          .filter(Boolean),
      });
    } else if (isTextBlock(name)) {
      while (body.length && !body[0]?.trim()) body.shift();
      blocks.push({ name, text: outdent(body, 2) });
    } else {
      blocks.push({ name, pairs: parsePairs(body) });
    }
  }
  return blocks;
}

function parsePairs(lines: readonly string[]): BruPair[] {
  const pairs: BruPair[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let rest = lines[index]!.trim();
    // Annotations (`@description(...)`) decorate the next pair; ADK has no use for them.
    if (!rest || (rest.startsWith('@') && !rest.includes(':'))) continue;
    let enabled = true;
    if (rest.startsWith('~')) {
      enabled = false;
      rest = rest.slice(1);
    }
    let key: string;
    if (rest.startsWith('"')) {
      const end = /^"((?:[^"\\]|\\.)*)"\s*:/.exec(rest);
      if (!end) continue;
      key = end[1]!.replace(/\\(["\\])/g, '$1');
      rest = rest.slice(end[0].length);
    } else {
      const colon = rest.indexOf(':');
      if (colon < 0) continue;
      key = rest.slice(0, colon).trim();
      rest = rest.slice(colon + 1);
    }
    let value = rest.trim();
    let contentType: string | undefined;
    let list: string[] | undefined;
    if (value.startsWith("'''")) {
      const collected: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith("'''")) {
        collected.push(lines[index]!);
        index += 1;
      }
      contentType = /@contentType\(([^)]*)\)/.exec(lines[index] ?? '')?.[1];
      value = outdent(collected, 4);
    } else if (value === '[') {
      list = [];
      index += 1;
      while (index < lines.length && lines[index]!.trim() !== ']') {
        const item = lines[index]!.trim();
        if (item) list.push(item);
        index += 1;
      }
      value = list.join(', ');
    } else {
      const annotated = /^(.*?)\s*@contentType\(([^)]*)\)$/.exec(value);
      if (annotated) {
        value = annotated[1]!;
        contentType = annotated[2];
      }
    }
    pairs.push({
      key,
      value,
      enabled,
      ...(contentType ? { contentType } : {}),
      ...(list ? { list } : {}),
    });
  }
  return pairs;
}

class BruDocument {
  constructor(private readonly blocks: readonly BruBlock[]) {}

  static parse(content: string): BruDocument {
    return new BruDocument(parseBru(content));
  }

  block(name: string): BruBlock | undefined {
    return this.blocks.find((candidate) => candidate.name === name);
  }

  all(name: string): BruBlock[] {
    return this.blocks.filter((candidate) => candidate.name === name);
  }

  pairs(name: string): readonly BruPair[] {
    return this.block(name)?.pairs ?? [];
  }

  value(blockName: string, key: string): string | undefined {
    return this.pairs(blockName).find((pair) => pair.key === key)?.value;
  }

  text(name: string): string | undefined {
    const text = this.block(name)?.text;
    return text?.trim() ? text.replace(/\s+$/, '') : undefined;
  }

  keyValues(name: string): KeyValue[] {
    return this.pairs(name).map((pair) => ({
      key: pair.key.replace(/^@/, ''),
      value: pair.value,
      ...(pair.enabled ? {} : { enabled: false }),
    }));
  }
}

const valueOf = (pairs: readonly BruPair[], key: string) =>
  pairs.find((pair) => pair.key === key)?.value ?? '';

/** The auth of a mode (`bearer`, `oauth2`...) from its `auth:<mode>` block. */
function authFrom(mode: string | undefined, document: BruDocument): RequestAuth | undefined {
  switch (mode) {
    case undefined:
      return undefined;
    case 'inherit':
      return { type: 'inherit' };
    case 'bearer': {
      return { type: 'bearer', token: document.value('auth:bearer', 'token') ?? '' };
    }
    case 'basic':
    case 'digest':
    case 'wsse': {
      const pairs = document.pairs(`auth:${mode}`);
      return {
        type: mode,
        username: valueOf(pairs, 'username'),
        password: valueOf(pairs, 'password'),
      };
    }
    case 'apikey': {
      const pairs = document.pairs('auth:apikey');
      return {
        type: 'apikey',
        key: valueOf(pairs, 'key'),
        value: valueOf(pairs, 'value'),
        in: valueOf(pairs, 'placement') === 'queryparams' ? 'query' : 'header',
      };
    }
    case 'awsv4': {
      const pairs = document.pairs('auth:awsv4');
      return {
        type: 'awsv4',
        accessKeyId: valueOf(pairs, 'accessKeyId'),
        secretAccessKey: valueOf(pairs, 'secretAccessKey'),
        ...(valueOf(pairs, 'sessionToken') ? { sessionToken: valueOf(pairs, 'sessionToken') } : {}),
        service: valueOf(pairs, 'service'),
        region: valueOf(pairs, 'region'),
      };
    }
    case 'oauth2':
      return oauth2From(document.pairs('auth:oauth2'));
    case 'oauth1': {
      const pairs = document.pairs('auth:oauth1');
      const method = valueOf(pairs, 'signature_method');
      return {
        type: 'oauth1',
        consumerKey: valueOf(pairs, 'consumer_key'),
        consumerSecret: valueOf(pairs, 'consumer_secret'),
        ...(valueOf(pairs, 'access_token') ? { token: valueOf(pairs, 'access_token') } : {}),
        ...(valueOf(pairs, 'token_secret') ? { tokenSecret: valueOf(pairs, 'token_secret') } : {}),
        // RSA and SHA-512 signatures are not supported: HMAC-SHA1 is the closest.
        signatureMethod: method === 'HMAC-SHA256' || method === 'PLAINTEXT' ? method : 'HMAC-SHA1',
        ...(valueOf(pairs, 'realm') ? { realm: valueOf(pairs, 'realm') } : {}),
        addTo: valueOf(pairs, 'placement') === 'query' ? 'query' : 'header',
      };
    }
    case 'akamai-edgegrid': {
      const pairs = document.pairs('auth:akamai-edgegrid');
      const maxBodySize = Number.parseInt(valueOf(pairs, 'maxBodySize'), 10);
      return {
        type: 'edgegrid',
        accessToken: valueOf(pairs, 'accessToken'),
        clientToken: valueOf(pairs, 'clientToken'),
        clientSecret: valueOf(pairs, 'clientSecret'),
        ...(valueOf(pairs, 'headersToSign')
          ? { headersToSign: valueOf(pairs, 'headersToSign') }
          : {}),
        ...(Number.isFinite(maxBodySize) ? { maxBodySize } : {}),
      };
    }
    // NTLM has no ADK equivalent; `none` keeps the request runnable.
    default:
      return { type: 'none' };
  }
}

function oauth2From(pairs: readonly BruPair[]): RequestAuth {
  const grant = valueOf(pairs, 'grant_type');
  // Authorization code and implicit grants need a browser: not supported by the runner.
  if (grant !== 'password' && grant !== 'client_credentials') return { type: 'none' };
  const query = valueOf(pairs, 'token_placement') === 'url';
  return {
    type: 'oauth2',
    grantType: grant,
    accessTokenUrl: valueOf(pairs, 'access_token_url'),
    clientId: valueOf(pairs, 'client_id'),
    clientSecret: valueOf(pairs, 'client_secret'),
    ...(grant === 'password'
      ? { username: valueOf(pairs, 'username'), password: valueOf(pairs, 'password') }
      : {}),
    ...(valueOf(pairs, 'scope') ? { scope: valueOf(pairs, 'scope') } : {}),
    credentialsPlacement:
      valueOf(pairs, 'credentials_placement') === 'basic_auth_header' ? 'basic' : 'body',
    tokenPlacement: query ? 'query' : 'header',
    ...(query
      ? { tokenQueryKey: valueOf(pairs, 'token_query_key') || 'access_token' }
      : valueOf(pairs, 'token_header_prefix')
        ? { tokenPrefix: valueOf(pairs, 'token_header_prefix') }
        : {}),
  };
}

/** `res.body.a.b` → json `a.b`; `res.headers["x"]` → header `x`; `res.status`; `res.responseTime`. */
function sourceOf(expression: string): Pick<Assertion, 'source' | 'path'> | undefined {
  const text = expression.trim();
  if (text === 'res.status' || text === 'res.getStatus()') return { source: 'status' };
  if (text === 'res.responseTime' || text === 'res.getResponseTime()')
    return { source: 'duration' };
  if (text === 'res.body' || text === 'res.getBody()') return { source: 'body' };
  const header =
    /^res\.headers(?:\.([\w-]+)|\[\s*["']([^"']+)["']\s*\])$/.exec(text) ??
    /^res\.getHeader\(\s*["']([^"']+)["']\s*\)$/.exec(text);
  if (header) return { source: 'header', path: (header[1] ?? header[2]!).toLowerCase() };
  const json = /^res\.body((?:\.[\w$]+|\[\d+\]|\[["'][^"']+["']\])+)$/.exec(text);
  if (json) {
    const path = json[1]!.replace(/\[["']([^"']+)["']\]/g, '.$1').replace(/^\./, '');
    return { source: 'json', path };
  }
  return undefined;
}

const unquote = (value: string) => {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const TYPE_OPERATORS: Readonly<Record<string, string>> = {
  isString: 'string',
  isNumber: 'number',
  isBoolean: 'boolean',
  isArray: 'array',
  isJson: 'object',
  isNull: 'null',
};

const UNSUPPORTED_OPERATORS = new Set([
  'in',
  'notIn',
  'length',
  'notMatches',
  'between',
  'isEmpty',
  'isNotEmpty',
  'isTruthy',
  'isFalsy',
]);

function assertionFrom(pair: BruPair): Assertion | undefined {
  const at = sourceOf(pair.key);
  if (!at) return undefined;
  const [word = '', ...rest] = pair.value.trim().split(' ');
  const argument = unquote(rest.join(' '));
  const make = (operator: Assertion['operator'], expected?: string): Assertion => ({
    id: randomUUID(),
    ...at,
    operator,
    ...(expected !== undefined ? { expected } : {}),
  });
  switch (word) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
    case 'notContains':
    case 'matches':
      return make(word, argument);
    case 'isDefined':
      return make('exists');
    case 'isUndefined':
      return make('notExists');
    case 'startsWith':
      return make('matches', `^${escapeRegExp(argument)}`);
    case 'endsWith':
      return make('matches', `${escapeRegExp(argument)}$`);
    default: {
      const type = TYPE_OPERATORS[word];
      if (type) return make('isType', type);
      // A bare value is an equality check in Bruno; its other operators have no ADK equivalent.
      return UNSUPPORTED_OPERATORS.has(word) ? undefined : make('eq', unquote(pair.value));
    }
  }
}

/** `vars:post-response`: captures where ADK has one, `adk.setVar` lines otherwise. */
function postResponseVars(pairs: readonly BruPair[]): { captures: Capture[]; script: string[] } {
  const captures: Capture[] = [];
  const script: string[] = [];
  for (const pair of pairs.filter((candidate) => candidate.enabled)) {
    const variable = pair.key.replace(/^@/, '');
    const at = sourceOf(pair.value);
    if (at && at.source !== 'duration') {
      captures.push({ variable, source: at.source, ...(at.path ? { path: at.path } : {}) });
    } else {
      script.push(`adk.setVar(${JSON.stringify(variable)}, ${pair.value});`);
    }
  }
  return { captures, script };
}

function joinScript(...parts: (string | undefined)[]): string | undefined {
  const text = parts.filter((part) => part?.trim()).join('\n');
  return text || undefined;
}

/** The scripts of a .bru file, with Bruno's `bru` renamed to `adk`. */
function scriptsFrom(document: BruDocument, extraPostResponse: readonly string[] = []) {
  const text = (name: string) => {
    const script = document.text(name);
    return script === undefined ? undefined : toAdkScript(script);
  };
  const scripts: Scripts = {
    preRequest: text('script:pre-request'),
    postResponse: joinScript(text('script:post-response'), ...extraPostResponse),
    tests: text('tests'),
  };
  const present = Object.fromEntries(
    Object.entries(scripts).filter(([, value]) => value !== undefined),
  ) as Scripts;
  return Object.keys(present).length ? present : undefined;
}

const toBool = (value: string | undefined) =>
  value === undefined || value === '' ? undefined : value === 'true';

function settingsFrom(document: BruDocument): { settings?: RequestSettings; timeoutMs?: number } {
  const pairs = document.pairs('settings');
  const encodeUrl = toBool(pairs.find((pair) => pair.key === 'encodeUrl')?.value);
  const followRedirects = toBool(pairs.find((pair) => pair.key === 'followRedirects')?.value);
  const maxRedirects = Number.parseInt(valueOf(pairs, 'maxRedirects'), 10);
  const timeout = Number.parseInt(valueOf(pairs, 'timeout'), 10);
  const settings: RequestSettings = {
    ...(encodeUrl !== undefined ? { encodeUrl } : {}),
    ...(followRedirects !== undefined ? { followRedirects } : {}),
    ...(Number.isFinite(maxRedirects) ? { maxRedirects } : {}),
  };
  return {
    ...(Object.keys(settings).length ? { settings } : {}),
    // Bruno writes 0 for "use the collection timeout".
    ...(Number.isFinite(timeout) && timeout >= 100 ? { timeoutMs: timeout } : {}),
  };
}

function bodyFrom(mode: string, document: BruDocument): RequestBody {
  switch (mode) {
    case 'json':
    case 'text':
    case 'xml':
    case 'sparql':
      return { mode, content: document.text(`body:${mode}`) ?? '' };
    case 'formUrlEncoded':
      return { mode: 'urlencoded', fields: document.keyValues('body:form-urlencoded') };
    case 'multipartForm':
      return {
        mode: 'form',
        fields: document.pairs('body:multipart-form').map((pair): FormField => {
          const file = /^@file\((.*)\)$/.exec(pair.value);
          // Bruno points at files on the user's disk: only the file name is kept.
          const value = file ? file[1]!.split('|').map(baseName).join(', ') : pair.value;
          return {
            key: pair.key,
            value,
            type: 'text',
            ...(pair.enabled ? {} : { enabled: false }),
            ...(pair.contentType && !file ? { contentType: pair.contentType } : {}),
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

function messagesFrom(document: BruDocument, name: 'body:grpc' | 'body:ws'): OutgoingMessage[] {
  return document.all(name).map((message) => {
    const pairs = message.pairs!;
    const type = valueOf(pairs, 'type');
    return {
      ...(valueOf(pairs, 'name') ? { name: valueOf(pairs, 'name') } : {}),
      content: valueOf(pairs, 'content'),
      ...(type === 'text' || type === 'json' || type === 'binary' ? { type } : {}),
    };
  });
}

const BRU_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** One request .bru file. */
export function requestFromBru(content: string, fallbackName: string): ApiRequestSpec {
  const document = BruDocument.parse(content);
  const metaType = document.value('meta', 'type') ?? 'http';
  const name = document.value('meta', 'name') || fallbackName;
  const tags = document.pairs('meta').find((pair) => pair.key === 'tags')?.list;
  const methodBlock =
    BRU_METHODS.find((method) => document.block(method)) ??
    (document.block('http') ? 'http' : undefined);
  const http = methodBlock ? document.pairs(methodBlock) : [];
  const rawMethod = (
    methodBlock === 'http' ? valueOf(http, 'method') : (methodBlock ?? 'get')
  ).toUpperCase();
  const method = (HTTP_METHODS as readonly string[]).includes(rawMethod)
    ? (rawMethod as HttpMethod)
    : 'GET';
  const { captures, script } = postResponseVars(document.pairs('vars:post-response'));
  const vars = document.keyValues('vars:pre-request');
  const base = {
    id: randomUUID(),
    type: 'request' as const,
    name,
    ...(document.text('docs') ? { description: document.text('docs') } : {}),
    headers: [...document.keyValues('headers'), ...document.keyValues('metadata')],
    query: [...document.keyValues('params:query'), ...document.keyValues('query')],
    assertions: document
      .pairs('assert')
      .filter((pair) => pair.enabled)
      .flatMap((pair) => assertionFrom(pair) ?? []),
    captures,
    ...(vars.length ? { vars } : {}),
    ...(scriptsFrom(document, script) ? { scripts: scriptsFrom(document, script) } : {}),
    ...(tags?.length ? { tags: [...tags] } : {}),
    ...settingsFrom(document),
  };
  const pathParams = document.keyValues('params:path');

  if (metaType === 'grpc' || document.block('grpc')) {
    const grpc = document.pairs('grpc');
    const messages = messagesFrom(document, 'body:grpc');
    const protoPath = valueOf(grpc, 'protoPath');
    return {
      ...base,
      kind: 'grpc',
      method: 'POST',
      url: valueOf(grpc, 'url'),
      body: { mode: 'none' },
      auth: authFrom(valueOf(grpc, 'auth') || 'inherit', document)!,
      grpc: {
        method: valueOf(grpc, 'method').replace(/^\//, ''),
        ...(protoPath ? { protoFile: protoPath.replace(/^(\.\/)?protos\//, '') } : {}),
        message:
          messages.length > 1
            ? `[${messages.map((message) => message.content).join(',\n')}]`
            : (messages[0]?.content ?? '{}'),
      },
    };
  }
  if (metaType === 'ws' || document.block('ws')) {
    const ws = document.pairs('ws');
    return {
      ...base,
      kind: 'websocket',
      method: 'GET',
      url: valueOf(ws, 'url'),
      body: { mode: 'none' },
      auth: authFrom(valueOf(ws, 'auth') || 'inherit', document)!,
      websocket: { messages: messagesFrom(document, 'body:ws') },
    };
  }
  const bodyMode = valueOf(http, 'body');
  const graphql = metaType === 'graphql' || bodyMode === 'graphql';
  return {
    ...base,
    ...(graphql ? { kind: 'graphql' as const } : {}),
    method,
    url: valueOf(http, 'url'),
    ...(pathParams.length ? { pathParams } : {}),
    body: graphql ? { mode: 'none' } : bodyFrom(bodyMode, document),
    auth: authFrom(valueOf(http, 'auth') || 'inherit', document)!,
    ...(graphql
      ? {
          graphql: {
            query: document.text('body:graphql') ?? '',
            ...(document.text('body:graphql:vars')
              ? { variables: document.text('body:graphql:vars') }
              : {}),
          },
        }
      : {}),
  };
}

/** folder.bru and collection.bru: headers, auth, vars, scripts and docs. */
function containerFrom(content: string | undefined) {
  const document = BruDocument.parse(content ?? '');
  const { script } = postResponseVars(document.pairs('vars:post-response'));
  const mode = document.value('auth', 'mode');
  const headers = document.keyValues('headers');
  const vars = document.keyValues('vars:pre-request');
  return {
    document,
    name: document.value('meta', 'name'),
    seq: Number.parseInt(document.value('meta', 'seq') ?? '', 10),
    auth: authFrom(mode, document),
    headers,
    vars,
    scripts: scriptsFrom(document, script),
    description: document.text('docs'),
  };
}

export function environmentFromBru(name: string, content: string): EnvironmentInput {
  const document = BruDocument.parse(content);
  const secret = document.block('vars:secret')?.items ?? [];
  return {
    name,
    variables: [
      ...document.keyValues('vars'),
      ...secret.map((key) => ({ key: key.replace(/^~/, ''), value: '', secret: true })),
    ],
  };
}

interface FolderNode {
  readonly path: string;
  readonly folders: Map<string, FolderNode>;
  readonly requests: { readonly seq: number; readonly item: ApiRequestSpec }[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');

type ImportedSettings = NonNullable<CollectionInput['settings']>;

function settingsFromConfig(config: Json): ImportedSettings | undefined {
  const settings: ImportedSettings = {};
  const proxy = isObject(config['proxy']) ? config['proxy'] : undefined;
  // Bruno ≥ 2 nests the proxy under `config`; older files keep it flat with `enabled`.
  const proxyConfig = proxy && isObject(proxy['config']) ? proxy['config'] : proxy;
  if (proxy && proxyConfig && str(proxyConfig['hostname']) && proxy['inherit'] !== true) {
    const protocol = str(proxyConfig['protocol']);
    const auth = isObject(proxyConfig['auth']) ? proxyConfig['auth'] : {};
    const username = str(auth['username']);
    settings.proxy = {
      enabled: proxy['config'] ? proxy['disabled'] !== true : proxy['enabled'] === true,
      protocol:
        protocol === 'https' || protocol === 'socks4' || protocol === 'socks5' ? protocol : 'http',
      hostname: str(proxyConfig['hostname']),
      port: Number(proxyConfig['port']) || 0,
      ...(username && auth['disabled'] !== true && auth['enabled'] !== false ? { username } : {}),
      ...(str(proxyConfig['bypassProxy']) ? { bypass: str(proxyConfig['bypassProxy']) } : {}),
    };
  }
  const certificates = isObject(config['clientCertificates']) ? config['clientCertificates'] : {};
  const certs = Array.isArray(certificates['certs']) ? certificates['certs'].filter(isObject) : [];
  if (certs.length) {
    settings.clientCertificates = certs
      .filter((cert) => str(cert['domain']))
      .map((cert) => ({
        domain: str(cert['domain']),
        type: cert['type'] === 'pfx' ? 'pfx' : 'pem',
      }));
  }
  const presets = isObject(config['presets']) ? config['presets'] : undefined;
  if (presets) {
    const kind = ({ http: 'http', graphql: 'graphql', grpc: 'grpc', ws: 'websocket' } as const)[
      str(presets['requestType']) as 'http'
    ];
    settings.presets = {
      ...(kind ? { kind } : {}),
      ...(str(presets['requestUrl']) ? { baseUrl: str(presets['requestUrl']) } : {}),
    };
  }
  return Object.keys(settings).length ? settings : undefined;
}

/**
 * A Bruno collection from its files (paths relative to anything; the folder of bruno.json is
 * the root). A single request file works too.
 */
export function importBruno(files: readonly BrunoFile[]): {
  readonly collection: CollectionInput;
  readonly environments: EnvironmentInput[];
} {
  const normalized = files.map((file) => ({
    path: file.path.replace(/\\/g, '/').replace(/^\.?\//, ''),
    content: file.content,
  }));
  const anchor =
    normalized.find((file) => /(^|\/)bruno\.json$/.test(file.path)) ??
    normalized.find((file) => /(^|\/)collection\.bru$/.test(file.path));
  const root = anchor ? anchor.path.replace(/[^/]*$/, '') : '';
  const inRoot = normalized
    .filter((file) => file.path.startsWith(root))
    .map((file) => ({ ...file, path: file.path.slice(root.length) }));
  const byPath = new Map(inRoot.map((file) => [file.path, file.content]));

  let config: Json = {};
  try {
    const parsed: unknown = JSON.parse(byPath.get('bruno.json') ?? '{}');
    if (isObject(parsed)) config = parsed;
  } catch {
    // an unreadable bruno.json only loses the collection settings
  }

  const tree: FolderNode = { path: '', folders: new Map(), requests: [] };
  const nodeAt = (dir: string): FolderNode => {
    let node = tree;
    for (const segment of dir.split('/').filter(Boolean)) {
      const path = node.path ? `${node.path}/${segment}` : segment;
      let child = node.folders.get(segment);
      if (!child) {
        child = { path, folders: new Map(), requests: [] };
        node.folders.set(segment, child);
      }
      node = child;
    }
    return node;
  };
  const environments: EnvironmentInput[] = [];
  for (const { path, content } of inRoot) {
    if (!path.endsWith('.bru')) continue;
    const fileName = baseName(path);
    const dir = path.slice(0, path.length - fileName.length).replace(/\/$/, '');
    if (dir === 'environments') {
      environments.push(environmentFromBru(fileName.replace(/\.bru$/, ''), content));
      continue;
    }
    if (fileName === 'collection.bru' && dir === '') continue;
    if (fileName === 'folder.bru') {
      nodeAt(dir);
      continue;
    }
    const request = requestFromBru(content, fileName.replace(/\.bru$/, ''));
    const seq = Number.parseInt(BruDocument.parse(content).value('meta', 'seq') ?? '', 10);
    nodeAt(dir).requests.push({
      seq: Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER,
      item: request,
    });
  }

  const itemsOf = (node: FolderNode): ApiItem[] => {
    const entries: { seq: number; name: string; item: ApiItem }[] = node.requests.map(
      ({ seq, item }) => ({ seq, name: item.name, item }),
    );
    for (const [segment, child] of node.folders) {
      const folder = containerFrom(byPath.get(`${child.path}/folder.bru`));
      const item: ApiFolder = {
        id: randomUUID(),
        type: 'folder',
        name: folder.name || segment,
        ...(folder.description ? { description: folder.description } : {}),
        ...(folder.auth ? { auth: folder.auth } : {}),
        ...(folder.headers.length ? { headers: folder.headers } : {}),
        ...(folder.vars.length ? { vars: folder.vars } : {}),
        ...(folder.scripts ? { scripts: folder.scripts } : {}),
        items: itemsOf(child),
      };
      entries.push({
        seq: Number.isFinite(folder.seq) ? folder.seq : Number.MAX_SAFE_INTEGER,
        name: item.name,
        item,
      });
    }
    return entries
      .sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name))
      .map((entry) => entry.item);
  };

  const collection = containerFrom(byPath.get('collection.bru'));
  const scriptsConfig = isObject(config['scripts']) ? config['scripts'] : {};
  const flow = scriptsConfig['flow'];
  const protobuf = isObject(config['protobuf']) ? config['protobuf'] : {};
  const protoFiles = (Array.isArray(protobuf['protoFiles']) ? protobuf['protoFiles'] : [])
    .filter(isObject)
    .map((entry) => str(entry['path']).replace(/^\.\//, ''))
    .flatMap((path) => {
      const content = byPath.get(path);
      return content === undefined ? [] : [{ name: path.replace(/^protos\//, ''), content }];
    });
  const settings = settingsFromConfig(config);
  const auth = collection.auth && collection.auth.type !== 'inherit' ? collection.auth : undefined;
  return {
    collection: {
      name: str(config['name']) || collection.name || 'Bruno collection',
      ...(collection.description ? { description: collection.description } : {}),
      variables: collection.vars,
      auth: auth ?? { type: 'none' },
      items: itemsOf(tree),
      ...(collection.headers.length ? { headers: collection.headers } : {}),
      ...(collection.scripts ? { scripts: collection.scripts } : {}),
      ...(flow === 'sandwich' || flow === 'sequential' ? { scriptFlow: flow } : {}),
      ...(settings ? { settings } : {}),
      ...(protoFiles.length ? { protoFiles } : {}),
    },
    environments,
  };
}
