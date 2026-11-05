import { describe, expect, it } from 'vitest';
import {
  newRequest,
  type ApiRequestSpec,
  type RequestAuth,
} from '../src/features/apitests/api-test-types.js';
import {
  CODE_TARGETS,
  CODE_TARGET_INFO,
  codeTargets,
  generateCode,
  graphqlPayload,
  prepareRequest,
  type CodeTarget,
} from '../src/features/apitests/integration/code-generation.js';

const HTTP: CodeTarget[] = [
  'curl',
  'fetch',
  'axios',
  'python',
  'go',
  'java',
  'csharp',
  'php',
  'powershell',
  'httpie',
];
const none: { auth: RequestAuth } = { auth: { type: 'none' } };

function http(patch: Partial<ApiRequestSpec>): ApiRequestSpec {
  return { ...newRequest('r', 'http', '{{baseUrl}}'), ...patch };
}

const all = (request: ApiRequestSpec, collection = none) =>
  Object.fromEntries(HTTP.map((target) => [target, generateCode(target, request, collection)]));

describe('code generation', () => {
  it('offers the targets of each kind', () => {
    expect(codeTargets({})).toEqual(HTTP);
    expect(codeTargets({ kind: 'graphql' })).toEqual(HTTP);
    expect(codeTargets({ kind: 'grpc' })).toEqual(['grpcurl']);
    expect(codeTargets({ kind: 'websocket' })).toEqual(['websocat']);
    expect(codeTargets({ kind: 'socket' })).toEqual(['netcat']);
    expect(codeTargets({ kind: 'sse' })).toEqual(['curl', 'fetch', 'python', 'httpie']);
    expect(CODE_TARGETS.every((target) => CODE_TARGET_INFO[target].label)).toBe(true);
  });

  it('keeps the variables, fills path params and adds the query and the auth', () => {
    const request = http({
      method: 'POST',
      url: '{{baseUrl}}/orders/:id',
      pathParams: [{ key: 'id', value: '{{orderId}}' }],
      query: [
        { key: 'page', value: '2' },
        { key: 'sort', value: '' },
        { key: 'off', value: '1', enabled: false },
      ],
      headers: [{ key: 'X-Trace', value: "it's" }],
      body: { mode: 'json', content: '{"name": "{{name}}"}' },
      auth: { type: 'bearer', token: '{{token}}' },
    });
    const code = all(request);
    expect(code.curl).toBe(
      [
        "curl -X POST '{{baseUrl}}/orders/{{orderId}}?page=2&sort'",
        "-H 'Authorization: Bearer {{token}}'",
        "-H 'X-Trace: it'\\''s'",
        "-H 'Content-Type: application/json'",
        `--data-raw '{"name": "{{name}}"}'`,
      ].join(' \\\n  '),
    );
    expect(code.fetch).toContain('"Authorization": "Bearer {{token}}"');
    expect(code.fetch).toContain('body: "{\\"name\\": \\"{{name}}\\"}"');
    expect(code.axios).toContain('data: "{\\"name\\": \\"{{name}}\\"}"');
    expect(code.python).toContain('data=data.encode("utf-8")');
    expect(code.go).toContain('strings.NewReader(');
    expect(code.java).toContain('HttpRequest.BodyPublishers.ofString(');
    expect(code.csharp).toContain('new StringContent(');
    expect(code.csharp).toContain('"application/json"');
    expect(code.php).toContain('CURLOPT_POSTFIELDS => \'{"name": "{{name}}"}\'');
    expect(code.powershell).toContain("-ContentType 'application/json'");
    expect(code.httpie).toMatch(/^printf '%s' .* \| http/);
    // An explicit content type is not repeated.
    const typed = prepareRequest(
      http({
        headers: [{ key: 'content-type', value: 'application/vnd+json' }],
        body: { mode: 'json', content: '' },
      }),
      none,
    );
    expect(typed.headers).toEqual([['content-type', 'application/vnd+json']]);
    expect(typed.body).toBeNull();
  });

  it('writes each kind of auth', () => {
    const basic = all(http({ auth: { type: 'basic', username: 'ana', password: '{{pw}}' } }));
    expect(basic.curl).toContain("-u 'ana:{{pw}}'");
    expect(basic.fetch).toContain('\'Basic \' + btoa("ana:{{pw}}")');
    expect(basic.axios).toContain('auth: { username: "ana", password: "{{pw}}" }');
    expect(basic.python).toContain('auth=("ana", "{{pw}}")');
    expect(basic.go).toContain('req.SetBasicAuth("ana", "{{pw}}")');
    expect(basic.java).toContain('Base64.getEncoder()');
    expect(basic.csharp).toContain('Convert.ToBase64String');
    expect(basic.php).toContain("CURLOPT_USERPWD => 'ana:{{pw}}'");
    expect(basic.powershell).toContain('ToBase64String');
    expect(basic.httpie).toContain("-a 'ana:{{pw}}'");

    const digest = all(http({ auth: { type: 'digest', username: 'u', password: 'p' } }));
    expect(digest.curl).toContain('--digest');
    expect(digest.python).toContain('HTTPDigestAuth("u", "p")');
    expect(digest.httpie).toContain('--auth-type=digest');

    const inherited = generateCode('curl', http({}), {
      auth: { type: 'apikey', key: 'X-Key', value: '{{key}}', in: 'header' },
    });
    expect(inherited).toContain("-H 'X-Key: {{key}}'");
    const query = generateCode(
      'curl',
      http({ auth: { type: 'apikey', key: 'key', value: 'v', in: 'query' } }),
      none,
    );
    expect(query).toContain("'{{baseUrl}}/?key=v'");
    const oauth = prepareRequest(
      http({
        auth: {
          type: 'oauth2',
          grantType: 'client_credentials',
          accessTokenUrl: '',
          clientId: '',
          clientSecret: '',
        },
      }),
      none,
    );
    expect(oauth.headers).toEqual([['Authorization', 'Bearer {{oauth2AccessToken}}']]);
    const prefixed = prepareRequest(
      http({
        auth: {
          type: 'oauth2',
          grantType: 'password',
          accessTokenUrl: '',
          clientId: '',
          clientSecret: '',
          tokenPrefix: 'Token',
        },
      }),
      none,
    );
    expect(prefixed.headers[0]![1]).toBe('Token {{oauth2AccessToken}}');
    const aws = generateCode(
      'curl',
      http({
        auth: {
          type: 'awsv4',
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
          service: 's3',
          region: 'us-east-1',
        },
      }),
      none,
    );
    expect(aws).toContain("--aws-sigv4 'aws:amz:us-east-1:s3'");
  });

  it('writes urlencoded, multipart and binary bodies', () => {
    const form = all(
      http({
        method: 'POST',
        body: {
          mode: 'urlencoded',
          fields: [
            { key: 'a b', value: 'c&d' },
            { key: '', value: 'skipped' },
          ],
        },
      }),
    );
    expect(form.curl).toContain("--data-urlencode 'a b=c&d'");
    expect(form.fetch).toContain('new URLSearchParams()');
    expect(form.axios).toContain('data.append("a b", "c&d")');
    expect(form.python).toContain('data=data');
    expect(form.go).toContain('form.Set("a b", "c&d")');
    expect(form.java).toContain('a%20b=c%26d');
    expect(form.csharp).toContain('FormUrlEncodedContent');
    expect(form.php).toContain('http_build_query');
    expect(form.powershell).toContain('application/x-www-form-urlencoded');
    expect(form.httpie).toContain('--form');

    const multipart = all(
      http({
        method: 'POST',
        headers: [{ key: 'Content-Type', value: 'multipart/form-data' }],
        body: {
          mode: 'form',
          fields: [
            { key: 'name', value: 'Ana', contentType: 'text/plain' },
            { key: 'note', value: 'hi' },
            {
              key: 'avatar',
              value: '',
              type: 'file',
              file: { fileName: 'a.png', contentType: 'image/png', data: 'AA==' },
            },
            { key: 'doc', value: '', type: 'file', file: { fileName: 'd.bin', data: '' } },
            { key: 'empty', value: '', type: 'file' },
          ],
        },
      }),
    );
    expect(multipart.curl).toContain("-F 'avatar=@a.png;type=image/png'");
    expect(multipart.curl).toContain("-F 'name=Ana;type=text/plain'");
    expect(multipart.curl).toContain("-F 'empty=@file'");
    expect(multipart.fetch).toContain('fileInput.files[0], "a.png"');
    expect(multipart.axios).toContain("import fs from 'node:fs';");
    expect(multipart.python).toContain('"avatar": ("a.png", open("a.png", "rb"), "image/png")');
    expect(multipart.python).toContain('"doc": ("d.bin", open("d.bin", "rb")),');
    expect(multipart.python).not.toContain('"Content-Type"');
    expect(multipart.go).toContain('writer.CreateFormFile("avatar", "a.png")');
    expect(multipart.java).toContain('filename=\\"a.png\\"');
    expect(multipart.java).toContain('application/octet-stream');
    expect(multipart.csharp).toContain('MultipartFormDataContent');
    expect(multipart.php).toContain("new CURLFile('a.png', 'image/png')");
    expect(multipart.php).toContain("new CURLFile('d.bin')");
    expect(multipart.powershell).toContain("Get-Item -Path 'a.png'");
    expect(multipart.httpie).toContain("'avatar@a.png'");

    const binary = all(
      http({
        method: 'PUT',
        body: {
          mode: 'binary',
          file: { fileName: 'x.pdf', contentType: 'application/pdf', data: '' },
        },
      }),
    );
    expect(binary.curl).toContain("--data-binary '@x.pdf'");
    expect(binary.fetch).toContain('body: fileInput.files[0]');
    expect(binary.axios).toContain('fs.readFileSync("x.pdf")');
    expect(binary.python).toContain('open("x.pdf", "rb")');
    expect(binary.go).toContain('bytes.NewReader(content)');
    expect(binary.java).toContain('ofFile(Path.of("x.pdf"))');
    expect(binary.csharp).toContain('MediaTypeHeaderValue("application/pdf")');
    expect(binary.php).toContain("file_get_contents('x.pdf')");
    expect(binary.powershell).toContain("-InFile 'x.pdf'");
    expect(binary.httpie).toContain("< 'x.pdf'");
    const unnamed = prepareRequest(http({ body: { mode: 'binary', file: null } }), none);
    expect(unnamed.body).toEqual({
      type: 'binary',
      fileName: 'file.bin',
      contentType: 'application/octet-stream',
    });

    const raw = prepareRequest(
      http({ body: { mode: 'sparql', content: 'SELECT * WHERE {}' } }),
      none,
    );
    expect(raw.headers).toEqual([['Content-Type', 'application/sparql-query']]);
    // Requests without a body or headers.
    const plain = all(http({}));
    expect(plain.java).toContain('noBody()');
    expect(plain.powershell).not.toContain('$headers');
    expect(plain.python).not.toContain('headers=');
    expect(plain.php).not.toContain('CURLOPT_HTTPHEADER');
    expect(plain.axios).not.toContain('headers:');
    expect(plain.fetch).not.toContain('headers:');
  });

  it('posts GraphQL documents as JSON, or puts them in the query of a GET', () => {
    const graphql = newRequest('g', 'graphql', '{{baseUrl}}');
    const post = generateCode(
      'curl',
      {
        ...graphql,
        graphql: { query: '{ me { id } }', variables: '{"a": 1}', operationName: 'Me' },
      },
      none,
    );
    expect(post).toContain('"operationName": "Me"');
    expect(post).toContain("-H 'Content-Type: application/json'");
    expect(graphqlPayload({ graphql: { query: 'q', variables: '{"id": {{id}}}' } })).toBe(
      '{"query": "q", "variables": {"id": {{id}}}}',
    );
    expect(graphqlPayload({ graphql: { query: 'q', variables: 'x', operationName: 'Op' } })).toBe(
      '{"query": "q", "variables": x, "operationName": "Op"}',
    );
    expect(JSON.parse(graphqlPayload({}))).toEqual({ query: '', variables: {} });
    const get = prepareRequest(
      {
        ...graphql,
        method: 'GET',
        graphql: { query: '{ a }', variables: '{"x": "{{v}}"}', operationName: 'A' },
      },
      none,
    );
    expect(get.url).toBe(
      '{{baseUrl}}/graphql?query=%7B%20a%20%7D&variables=%7B%22x%22%3A%20%22{{v}}%22%7D&operationName=A',
    );
    expect(get.body).toBeNull();
    const bare = prepareRequest({ ...graphql, method: 'GET', graphql: undefined }, none);
    expect(bare.url).toBe('{{baseUrl}}/graphql?query');
    const empty = prepareRequest(
      { ...graphql, method: 'GET', graphql: { query: 'q', variables: '{}' } },
      none,
    );
    expect(empty.url).toBe('{{baseUrl}}/graphql?query=q');
  });

  it('streams server-sent events', () => {
    const sse = newRequest('s', 'sse', '{{baseUrl}}');
    expect(generateCode('curl', sse, none)).toMatch(/^curl -N -X GET/);
    expect(generateCode('fetch', sse, none)).toContain('response.body.getReader()');
    expect(generateCode('python', sse, none)).toContain('stream=True');
    expect(generateCode('httpie', sse, none)).toContain('--stream');
  });

  it('calls gRPC with grpcurl', () => {
    const grpc = newRequest('g', 'grpc');
    expect(generateCode('grpcurl', grpc, none)).toBe(
      "grpcurl \\\n  -plaintext \\\n  -d '{}' \\\n  'localhost:50051' \\\n  'package.Service/Method'",
    );
    const secure = generateCode(
      'grpcurl',
      {
        ...grpc,
        url: 'grpcs://api.test:443',
        headers: [{ key: 'x-tenant', value: '1' }],
        grpc: {
          method: 'shop.Orders/Create',
          reflection: false,
          protoFile: 'shop.proto',
          message: '[{"id": 1}, {"id": 2}]',
        },
      },
      { auth: { type: 'bearer', token: '{{token}}' } },
    );
    expect(secure).not.toContain('-plaintext');
    expect(secure).toContain("-proto 'shop.proto'");
    expect(secure).toContain("-H 'authorization: Bearer {{token}}'");
    expect(secure).toContain("-H 'x-tenant: 1'");
    expect(secure).toContain(`-d '{"id":1}\n{"id":2}'`);
    expect(secure).toContain("'api.test:443'");
    const other = generateCode(
      'grpcurl',
      {
        ...grpc,
        url: 'localhost:1',
        grpc: undefined,
        auth: { type: 'apikey', key: 'k', value: 'v', in: 'header' },
      },
      none,
    );
    expect(other).toContain("-H 'k: v'");
    expect(other).toContain("'localhost:1'");
    const variable = generateCode(
      'grpcurl',
      { ...grpc, grpc: { method: 'a.B/C', message: '{"id": {{id}}}' } },
      none,
    );
    expect(variable).toContain(`-d '{"id": {{id}}}'`);
    expect(
      generateCode('grpcurl', { ...grpc, grpc: { method: 'a.B/C', message: ' ' } }, none),
    ).not.toContain('-d');
  });

  it('opens WebSockets with websocat', () => {
    const ws = newRequest('w', 'websocket');
    expect(generateCode('websocat', { ...ws, url: 'wss://x' }, none)).toBe(
      "websocat \\\n  'wss://x'",
    );
    const full = generateCode(
      'websocat',
      {
        ...ws,
        url: 'wss://x/:room',
        pathParams: [{ key: 'room', value: '7' }],
        headers: [{ key: 'X-A', value: '1' }],
        auth: { type: 'bearer', token: 't' },
        websocket: {
          subprotocols: ['graphql-ws', 'json'],
          messages: [
            { content: '{\n  "a": 1\n}', type: 'json' },
            { content: 'AAE=', type: 'binary' },
            { content: '' },
          ],
        },
      },
      none,
    );
    expect(full).toContain("-H 'Authorization: Bearer t'");
    expect(full).toContain("--protocol 'graphql-ws, json'");
    expect(full).toContain('--binary');
    expect(full).toContain("'wss://x/7'");
    expect(full).toMatch(/^printf '%s\\n' '\{ "a": 1 \}' 'AAE=' \| websocat/);
    const key = generateCode(
      'websocat',
      { ...ws, websocket: undefined, auth: { type: 'apikey', key: 'k', value: 'v', in: 'header' } },
      none,
    );
    expect(key).toContain("-H 'k: v'");
    const queryKey = generateCode(
      'websocat',
      { ...ws, auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' } },
      none,
    );
    expect(queryKey).not.toContain('-H');
  });

  it('talks to sockets with netcat or openssl', () => {
    const socket = newRequest('s', 'socket');
    expect(generateCode('netcat', { ...socket, socket: undefined }, none)).toBe(
      'nc localhost 9000',
    );
    expect(
      generateCode(
        'netcat',
        { ...socket, url: 'udp://h:53', socket: { messages: [{ content: 'ping' }] } },
        none,
      ),
    ).toBe("printf '%s' 'ping' | nc -u h 53");
    expect(
      generateCode(
        'netcat',
        {
          ...socket,
          url: 'tls://h:443',
          socket: {
            messages: [
              { content: '48 65', type: 'hex' },
              { content: 'SGk=', type: 'base64' },
            ],
          },
        },
        none,
      ),
    ).toBe(
      "{ printf '%s' '4865' | xxd -r -p; printf '%s' 'SGk=' | base64 -d; } | openssl s_client -quiet -connect h:443",
    );
    expect(generateCode('netcat', { ...socket, url: 'weird' }, none)).toBe('nc localhost 9000');
    expect(generateCode('netcat', { ...socket, url: 'tcp://h' }, none)).toBe('nc h 9000');
  });
});

describe('code generation edge cases', () => {
  it('appends the query to a URL that already has one', () => {
    const request = {
      ...newRequest('r'),
      url: '{{baseUrl}}/x?a=1',
      query: [{ key: 'b', value: '2' }],
    };
    expect(prepareRequest(request, none).url).toBe('{{baseUrl}}/x?a=1&b=2');
  });
});
