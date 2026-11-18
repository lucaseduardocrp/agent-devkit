import { describe, expect, it } from 'vitest';
import {
  newRequest,
  type RequestBody,
  type RequestResult,
} from '../src/features/apitests/api-test-types.js';
import { formatGraphql } from '../src/features/apitests/integration/code-editing.js';
import { tokenize, type Token } from '../src/features/apitests/integration/code-syntax.js';
import {
  fieldCompletions,
  introspectionRequest,
  namedType,
  parseIntrospection,
  typeAt,
  typeLabel,
  type GraphqlSchema,
} from '../src/features/apitests/integration/graphql-schema.js';
import {
  GRPC_STATUS,
  grpcStatusLine,
  headerValue,
  isHtml,
  isOkStatus,
} from '../src/features/apitests/integration/integration-model.js';
import {
  base64Bytes,
  changeBodyMode,
  grpcMethodInfo,
  grpcServicesCache,
  sourceKey,
  streamingKind,
} from '../src/features/apitests/integration/protocol-model.js';

const kinds = (tokens: Token[]) => tokens.map((token) => `${token.kind}:${token.text}`);
const joined = (tokens: Token[]) => tokens.map((token) => token.text).join('');

describe('JavaScript tokenizer', () => {
  it('colors keywords, strings, templates, comments, numbers and punctuation', () => {
    const code =
      "// note\nconst a = 'x\\'y' + \"z\" + `t\n${1}`; /* c */ let n = 0x1F + 1.5e3 + .5 + 10n;\n#";
    const tokens = tokenize(code, 'javascript');
    expect(joined(tokens)).toBe(code);
    expect(kinds(tokens)).toEqual(
      expect.arrayContaining([
        'comment:// note',
        'keyword:const',
        "string:'x\\'y'",
        'string:"z"',
        'string:`t\n${1}`',
        'comment:/* c */',
        'number:0x1F',
        'number:1.5e3',
        'number:.5',
        'number:10n',
        'punct:;',
      ]),
    );
  });

  it('never loses text that is half written', () => {
    for (const code of ['"open', '/* open', '`open', "'a\nb'", '// end', 'a.b', '@']) {
      expect(joined(tokenize(code, 'javascript'))).toBe(code);
    }
  });
});

describe('GraphQL tokenizer', () => {
  it('colors keywords, variables, directives, arguments, strings and comments', () => {
    const code =
      'query Q($id: ID!) { # c\n user(id: $id, n: -1.5) @include(if: true) { ...F name } s: "a{{v}}" b: """x""" {{x}} }';
    const tokens = tokenize(code, 'graphql');
    expect(joined(tokens)).toBe(code);
    expect(kinds(tokens)).toEqual(
      expect.arrayContaining([
        'keyword:query',
        'attr:$id',
        'key:id',
        'tag:@include',
        'comment:# c',
        'number:-1.5',
        'punct:...',
        'string:"a',
        'variable:{{v}}',
        'string:"""x"""',
        'variable:{{x}}',
        'keyword:true',
        'text:name ',
      ]),
    );
  });

  it('keeps unfinished strings and stray characters', () => {
    for (const code of ['"open', '"""open', '# end', '$', '-', '"a\\"b"', '%']) {
      expect(joined(tokenize(code, 'graphql'))).toBe(code);
    }
  });
});

describe('formatGraphql', () => {
  it('puts one field per line and keeps arguments on the line of their field', () => {
    expect(formatGraphql('query Q($id: ID!) { user(id: $id) { id name } }')).toBe(
      'query Q($id: ID!) {\n  user(id: $id) {\n    id\n    name\n  }\n}',
    );
    expect(
      formatGraphql(
        '{\n# list\nitems(first: 2, after: "x") { ... on A { a }, ...F b: c @skip(if: true) }\n}',
      ),
    ).toBe(
      '{\n  # list\n  items(first: 2, after: "x") {\n    ... on A {\n      a\n    }\n    ...F\n    b: c @skip(if: true)\n  }\n}',
    );
    expect(formatGraphql('fragment F on User { id }')).toBe('fragment F on User {\n  id\n}');
    expect(formatGraphql('{ a(list: [1, 2]) }')).toBe('{\n  a(list: [1, 2])\n}');
  });

  it('gives up when the braces or parentheses do not balance', () => {
    expect(formatGraphql('{ a }}')).toBeNull();
    expect(formatGraphql('{ a')).toBeNull();
    expect(formatGraphql('{ a(b: 1 }')).toBeNull();
    expect(formatGraphql('{ a) }')).toBeNull();
  });
});

const ref = (name: string, kind = 'OBJECT') => ({ kind, name, ofType: null });
const nonNull = (inner: ReturnType<typeof ref>) => ({
  kind: 'NON_NULL',
  name: null,
  ofType: inner,
});
const list = (inner: object) => ({ kind: 'LIST', name: null, ofType: inner }) as never;

const schemaJson = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      subscriptionType: null,
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              args: [{ name: 'id', type: nonNull(ref('ID', 'SCALAR')) }],
              type: ref('User'),
            },
            { name: 'users', args: [], type: nonNull(list(nonNull(ref('User')))) },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [{ name: 'createUser', args: [], type: ref('User') }],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          fields: [
            { name: 'id', args: [], type: ref('ID', 'SCALAR') },
            { name: 'name', args: [], type: ref('String', 'SCALAR') },
            { name: 'friends', args: [], type: list(ref('User')) },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Admin',
          fields: [{ name: 'level', args: [], type: ref('Int', 'SCALAR') }],
        },
        { kind: 'SCALAR', name: 'ID' },
        { kind: 'OBJECT', name: '__Type', fields: [] },
      ],
    },
  },
};

const result = (body: string, patch: Partial<RequestResult> = {}): RequestResult => ({
  requestId: 'r',
  name: 'r',
  path: [],
  method: 'POST',
  url: 'u',
  status: 200,
  durationMs: 1,
  sizeBytes: 1,
  passed: true,
  assertions: [],
  response: { headers: {}, bodyPreview: body },
  ...patch,
});

describe('GraphQL schema', () => {
  const schema: GraphqlSchema = parseIntrospection(result(JSON.stringify(schemaJson)));

  it('asks the server with the introspection query', () => {
    const request = introspectionRequest({
      ...newRequest('g', 'graphql'),
      scripts: { preRequest: 'x' },
    });
    expect(request.graphql?.query).toContain('__schema');
    expect(request.method).toBe('POST');
    expect(request.assertions).toEqual([]);
    expect(request.scripts).toBeUndefined();
  });

  it('reads the schema, or a readable reason', () => {
    expect(schema.queryType).toBe('Query');
    expect(schema.subscriptionType).toBeNull();
    expect(schema.types.has('__Type')).toBe(false);
    expect(() => parseIntrospection(result('', { error: 'refused' }))).toThrow('refused');
    expect(() =>
      parseIntrospection(
        result('{', { response: { headers: {}, bodyPreview: '{', truncated: true } }),
      ),
    ).toThrow('truncated');
    expect(() => parseIntrospection(result('<html>'))).toThrow('HTTP 200: a resposta não é JSON');
    expect(() => parseIntrospection(result('{}', { status: null, response: undefined }))).toThrow(
      'HTTP —: a resposta não é JSON',
    );
    expect(() => parseIntrospection(result('{"errors":[{"message":"no"}]}'))).toThrow('no');
    expect(() => parseIntrospection(result('{"data":{}}', { status: null }))).toThrow(
      'HTTP —: no __schema',
    );
    const bare = parseIntrospection(result('{"data":{"__schema":{"types":[]}}}'));
    expect([bare.queryType, bare.mutationType, bare.subscriptionType]).toEqual([null, null, null]);
  });

  it('names wrapped types', () => {
    const users = schema.types.get('Query')!.fields![1]!.type;
    expect(typeLabel(users)).toBe('[User!]!');
    expect(namedType(users)).toBe('User');
    expect(typeLabel({ kind: 'OBJECT', name: null, ofType: null })).toBe('?');
    expect(namedType({ kind: 'OBJECT', name: null, ofType: null })).toBe('');
  });

  it('finds the type at the caret through selections, fragments and operations', () => {
    const at = (text: string) => typeAt(schema, text, text.indexOf('|'));
    expect(at('{ user(id: 1) { | } }')).toBe('User');
    expect(at('query { users { friends { | } } }')).toBe('User');
    expect(at('mutation M { createUser { | } }')).toBe('User');
    expect(at('subscription { | }')).toBeNull();
    expect(at('{ u: user(id: "a)b") @include(if: true) { | } }')).toBe('User');
    expect(at('fragment F on Admin { | }')).toBe('Admin');
    expect(at('{ user { ... on Admin { | } } }')).toBe('Admin');
    expect(at('{ missing { | } }')).toBeNull();
    expect(at('{ user(id: | ) }')).toBeNull();
    expect(at('|')).toBeNull();
    expect(at('{ user { id } } { | }')).toBe('Query');
    expect(at('{ # comment\n | }')).toBe('Query');
    expect(at('{ # comment |')).toBeNull();
    expect(at('{ a: "open |')).toBeNull();
    expect(at('{ ) @ | }')).toBe('Query');
    expect(at('{ a: "x\\"y" | }')).toBe('Query');
    // A brace with nothing identifying it (not a field, a type or an operation) stays unresolved.
    expect(at('{ user { { | } } }')).toBeNull();
  });

  it('completes the fields of the type at the caret', () => {
    const complete = fieldCompletions(schema);
    const text = '{ user(id: 1) { na';
    expect(complete(text, text.length)).toEqual({
      start: text.length - 2,
      items: [{ label: 'name', detail: 'String' }],
    });
    expect(complete('{ user { name', 13)!.items).toEqual([]);
    expect(complete('{ ', 2)).toBeNull();
    expect(complete('query Q($i', 10)).toBeNull();
    expect(complete('{ user { ...F', 13)).toBeNull();
    expect(complete('{ missing { a', 13)).toBeNull();
    expect(complete('{ ID { a', 8)).toBeNull();
  });
});

describe('protocol helpers', () => {
  it('keeps what it can when the body type changes', () => {
    const json = { mode: 'json', content: '{}' } as const;
    expect(changeBodyMode(json, 'none')).toEqual({ mode: 'none' });
    expect(changeBodyMode(json, 'xml')).toEqual({ mode: 'xml', content: '{}' });
    expect(changeBodyMode(json, 'binary')).toEqual({ mode: 'binary', file: null });
    expect(changeBodyMode(json, 'form')).toEqual({ mode: 'form', fields: [] });
    const form: RequestBody = {
      mode: 'form',
      fields: [
        { key: 'a', value: '1' },
        { key: 'f', value: '', type: 'file' },
      ],
    };
    expect(changeBodyMode(form, 'urlencoded')).toEqual({
      mode: 'urlencoded',
      fields: [{ key: 'a', value: '1' }],
    });
    expect(changeBodyMode(form, 'text')).toEqual({ mode: 'text', content: '' });
  });

  it('measures base64 content', () => {
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
  });

  it('names the streaming of gRPC methods and finds the method of a request', () => {
    expect(streamingKind({ clientStreaming: true, serverStreaming: true })).toBe('bidi');
    expect(streamingKind({ clientStreaming: true, serverStreaming: false })).toBe('client');
    expect(streamingKind({ clientStreaming: false, serverStreaming: true })).toBe('server');
    expect(streamingKind({ clientStreaming: false, serverStreaming: false })).toBe('unary');
    const request = { ...newRequest('g', 'grpc'), grpc: { method: 'a.B/C', message: '{}' } };
    expect(grpcMethodInfo(request)).toBeNull();
    const method = {
      name: 'C',
      path: 'a.B/C',
      requestType: 'In',
      responseType: 'Out',
      clientStreaming: false,
      serverStreaming: false,
      example: {},
    };
    grpcServicesCache.set(sourceKey(request), {
      services: [{ name: 'a.B', methods: [{ ...method, path: 'a.B/D' }, method] }],
    });
    expect(grpcMethodInfo(request)).toBe(method);
    expect(sourceKey({ ...request, grpc: { ...request.grpc, reflection: false } })).toBe(
      'grpc://localhost:50051|proto:',
    );
    expect(sourceKey({ ...request, grpc: undefined })).toBe('grpc://localhost:50051|reflection');
    grpcServicesCache.clear();
  });

  it('names statuses as each protocol does', () => {
    expect(GRPC_STATUS[16]).toBe('UNAUTHENTICATED');
    expect(grpcStatusLine(0)).toBe('0 OK');
    expect(grpcStatusLine(99)).toBe('99');
    expect(isOkStatus('grpc', 0)).toBe(true);
    expect(isOkStatus('socket', 1)).toBe(false);
    expect(isOkStatus(undefined, 302)).toBe(true);
    expect(isOkStatus('http', 500)).toBe(false);
    expect(isOkStatus('http', null)).toBe(false);
    expect(headerValue({ 'Content-Type': 'a' }, 'content-type')).toBe('a');
    expect(isHtml('text/html; charset=utf-8', '')).toBe(true);
    expect(isHtml(undefined, '<!DOCTYPE html><p>')).toBe(true);
    expect(isHtml('application/json', '{}')).toBe(false);
  });
});

describe('tokenizer and formatter edges', () => {
  it('keeps a trailing dot and an empty document', () => {
    expect(joined(tokenize('a.', 'javascript'))).toBe('a.');
    expect(joined(tokenize('', 'graphql'))).toBe('');
    expect(formatGraphql('')).toBe('');
  });

  it('treats leading and trailing whitespace as having no neighbor to compare against', () => {
    // Leading/trailing whitespace tokens scan past the start/end of the document without
    // finding anything significant, so the neighbor comes back empty either way.
    expect(formatGraphql(' { a } ')).toBe('{\n  a\n}');
  });

  it('inserts the space a field missed after a closing parenthesis', () => {
    // No whitespace token runs between `)` and the next field, so the general case has to
    // notice the parenthesis itself and add the separator.
    expect(formatGraphql('{ a(id: 1)b }')).toBe('{\n  a(id: 1) b\n}');
  });

  it('breaks the lines of a selection set written with commas', () => {
    expect(formatGraphql('{ a, b }')).toBe('{\n  a\n  b\n}');
    expect(formatGraphql('query A { a } query B { b }')).toBe(
      'query A {\n  a\n}\nquery B {\n  b\n}',
    );
    // A field right after a closing brace goes on its own line.
    expect(formatGraphql('{ a { b } c }')).toBe('{\n  a {\n    b\n  }\n  c\n}');
  });

  it('reads the subscription root of a schema', () => {
    const schema = parseIntrospection(
      result(
        JSON.stringify({
          data: {
            __schema: { subscriptionType: { name: 'Subscription' }, types: [] },
          },
        }),
      ),
    );
    expect(schema.subscriptionType).toBe('Subscription');
  });
});
