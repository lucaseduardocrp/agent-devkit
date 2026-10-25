import type { CollectionInput } from '../domain/api-test.js';
import type { ApiItem, ApiRequestSpec, Assertion, RequestAuth, Variable } from '../engine/types.js';

// Bruno collection (https://docs.usebruno.com): a folder with bruno.json, collection.bru, one
// folder.bru per folder and one .bru file per request, plus environments/<name>.bru. Assertions
// map to Bruno's declarative `assert` block and captures to `vars:post-response`.

export interface BrunoFile {
  readonly path: string;
  readonly content: string;
}

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

const pairLines = (entries: readonly { key: string; value: string; enabled?: boolean }[]) =>
  entries.map((entry) => `${entry.enabled === false ? '~' : ''}${entry.key}: ${entry.value}`);

function authMode(auth: RequestAuth | undefined): string {
  switch (auth?.type) {
    case 'bearer':
    case 'basic':
    case 'apikey':
      return auth.type;
    case 'none':
      return 'none';
    default:
      return 'inherit';
  }
}

function authBlock(auth: RequestAuth | undefined): string {
  switch (auth?.type) {
    case 'bearer':
      return block('auth:bearer', [`token: ${auth.token}`]);
    case 'basic':
      return block('auth:basic', [`username: ${auth.username}`, `password: ${auth.password}`]);
    case 'apikey':
      return block('auth:apikey', [
        `key: ${auth.key}`,
        `value: ${auth.value}`,
        `placement: ${auth.in === 'query' ? 'queryparams' : 'header'}`,
      ]);
    default:
      return '';
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
      return path ? `res.body.${path}` : 'res.body';
    }
  }
}

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
    isType: `is${expected.charAt(0).toUpperCase()}${expected.slice(1).toLowerCase()}`,
  };
  return `${target(assertion)}: ${operator[assertion.operator]}`;
}

function requestFile(request: ApiRequestSpec, seq: number): string {
  const bodyMode =
    request.body.mode === 'none'
      ? 'none'
      : request.body.mode === 'urlencoded'
        ? 'formUrlEncoded'
        : request.body.mode === 'form'
          ? 'multipartForm'
          : request.body.mode;
  const parts = [
    block('meta', [`name: ${request.name}`, 'type: http', `seq: ${seq}`]),
    block(request.method.toLowerCase(), [
      `url: ${request.url}`,
      `body: ${bodyMode}`,
      `auth: ${authMode(request.auth)}`,
    ]),
    block('params:query', pairLines(request.query)),
    block('params:path', pairLines(request.pathParams ?? [])),
    block('headers', pairLines(request.headers)),
    authBlock(request.auth),
  ];
  const body = request.body;
  if (body.mode === 'json' || body.mode === 'text' || body.mode === 'xml') {
    parts.push(`body:${body.mode} {\n${indent(body.content)}\n}\n`);
  } else if (body.mode === 'urlencoded') {
    parts.push(block('body:form-urlencoded', pairLines(body.fields)));
  } else if (body.mode === 'form') {
    parts.push(block('body:multipart-form', pairLines(body.fields)));
  }
  parts.push(
    block(
      'vars:post-response',
      request.captures.map(
        (capture) =>
          `${capture.variable}: ${target({ source: capture.source, path: capture.path })}`,
      ),
    ),
  );
  parts.push(block('assert', request.assertions.map(assertLine)));
  if (request.description) parts.push(`docs {\n${indent(request.description)}\n}\n`);
  return parts.filter(Boolean).join('\n');
}

function environmentFile(variables: readonly Variable[]): string {
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

/** Every file of the Bruno collection, under a root folder named after the collection. */
export function exportBruno(
  collection: CollectionInput,
  environments: readonly { readonly name: string; readonly variables: readonly Variable[] }[] = [],
): BrunoFile[] {
  const root = safeName(collection.name);
  const files: BrunoFile[] = [
    {
      path: `${root}/bruno.json`,
      content: `${JSON.stringify({ version: '1', name: collection.name, type: 'collection', ignore: ['node_modules', '.git'] }, null, 2)}\n`,
    },
    {
      path: `${root}/collection.bru`,
      content: [
        block('meta', [`name: ${collection.name}`]),
        block('auth', [
          `mode: ${authMode(collection.auth) === 'inherit' ? 'none' : authMode(collection.auth)}`,
        ]),
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
        collection.description ? `docs {\n${indent(collection.description)}\n}\n` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
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
        files.push({
          path: `${path}/folder.bru`,
          content: [
            block('meta', [`name: ${item.name}`, `seq: ${index + 1}`]),
            item.auth ? block('auth', [`mode: ${authMode(item.auth)}`]) : '',
            authBlock(item.auth),
          ]
            .filter(Boolean)
            .join('\n'),
        });
        walk(item.items, path);
      } else {
        files.push({
          path: `${folder}/${unique(item.name)}.bru`,
          content: requestFile(item, index + 1),
        });
      }
    });
  };
  walk(collection.items, root);
  return files;
}
