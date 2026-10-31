// "Generate code": a request as a snippet of each language, as Bruno and Postman offer it. Pure
// functions; `{{variables}}` stay as they are, since they are resolved only when the request is sent.

import type {
  ApiCollection,
  ApiRequestSpec,
  FormField,
  KeyValue,
  RequestAuth,
} from '../api-test-types.js';
import { fillPathParams } from './integration-model.js';

export const CODE_TARGETS = [
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
  'grpcurl',
  'websocat',
  'netcat',
] as const;
export type CodeTarget = (typeof CODE_TARGETS)[number];

/** Name of each target and the highlight.js language of its snippet. */
export const CODE_TARGET_INFO: Record<
  CodeTarget,
  { readonly label: string; readonly highlight: string }
> = {
  curl: { label: 'cURL', highlight: 'bash' },
  fetch: { label: 'JavaScript (fetch)', highlight: 'javascript' },
  axios: { label: 'Node.js (axios)', highlight: 'javascript' },
  python: { label: 'Python (requests)', highlight: 'python' },
  go: { label: 'Go (net/http)', highlight: 'go' },
  java: { label: 'Java (HttpClient)', highlight: 'java' },
  csharp: { label: 'C# (HttpClient)', highlight: 'csharp' },
  php: { label: 'PHP (cURL)', highlight: 'php' },
  powershell: { label: 'PowerShell (Invoke-RestMethod)', highlight: 'powershell' },
  httpie: { label: 'HTTPie', highlight: 'bash' },
  grpcurl: { label: 'grpcurl', highlight: 'bash' },
  websocat: { label: 'websocat', highlight: 'bash' },
  netcat: { label: 'netcat / openssl', highlight: 'bash' },
};

const HTTP_TARGETS: readonly CodeTarget[] = [
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

/** The targets that make sense for the kind of the request, the first being the default. */
export function codeTargets(request: Pick<ApiRequestSpec, 'kind'>): readonly CodeTarget[] {
  switch (request.kind) {
    case 'grpc':
      return ['grpcurl'];
    case 'websocket':
      return ['websocat'];
    case 'socket':
      return ['netcat'];
    case 'sse':
      return ['curl', 'fetch', 'python', 'httpie'];
    default:
      return HTTP_TARGETS;
  }
}

// ---------- the request, ready to print ----------

type PreparedBody =
  | { readonly type: 'raw'; readonly content: string; readonly contentType: string }
  | { readonly type: 'urlencoded'; readonly fields: readonly (readonly [string, string])[] }
  | {
      readonly type: 'form';
      readonly fields: readonly {
        readonly key: string;
        readonly value: string;
        readonly fileName?: string;
        readonly contentType?: string;
      }[];
    }
  | { readonly type: 'binary'; readonly fileName: string; readonly contentType: string };

export interface PreparedRequest {
  readonly method: string;
  readonly url: string;
  /** Headers in order, the auth and the content type included (not for multipart forms). */
  readonly headers: readonly (readonly [string, string])[];
  readonly basic?: { readonly username: string; readonly password: string };
  readonly body: PreparedBody | null;
  /** The auth that applies: the request one, or the collection one when it inherits. */
  readonly auth: RequestAuth;
}

const enabled = <T extends KeyValue>(rows: readonly T[]): T[] =>
  rows.filter((row) => row.enabled !== false && row.key);

function withQuery(url: string, pairs: readonly (readonly [string, string])[]): string {
  if (!pairs.length) return url;
  const text = pairs.map(([key, value]) => (value ? `${key}=${value}` : key)).join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${text}`;
}

const RAW_TYPES = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  sparql: 'application/sparql-query',
} as const;

const encodeComponent = (value: string) =>
  // `{{variables}}` stay readable.
  value
    .split(/(\{\{[^{}]*\}\})/)
    .map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part)))
    .join('');

/** The GraphQL document as the JSON body of a POST (variables kept as typed when not JSON). */
export function graphqlPayload(request: Pick<ApiRequestSpec, 'graphql'>): string {
  const spec = request.graphql ?? { query: '' };
  const variables = spec.variables?.trim() || '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(variables);
  } catch {
    parsed = undefined;
  }
  const operation = spec.operationName
    ? `, "operationName": ${JSON.stringify(spec.operationName)}`
    : '';
  if (parsed !== undefined) {
    return JSON.stringify(
      {
        query: spec.query,
        variables: parsed,
        ...(spec.operationName ? { operationName: spec.operationName } : {}),
      },
      null,
      2,
    );
  }
  return `{"query": ${JSON.stringify(spec.query)}, "variables": ${variables}${operation}}`;
}

/** The request with its auth (inherited from the collection when `inherit`) applied. */
export function prepareRequest(
  request: ApiRequestSpec,
  collection: Pick<ApiCollection, 'auth'>,
): PreparedRequest {
  const auth: RequestAuth = request.auth.type === 'inherit' ? collection.auth : request.auth;
  const headers: [string, string][] = [];
  const query: [string, string][] = enabled(request.query).map((row) => [row.key, row.value]);
  let basic: PreparedRequest['basic'];
  if (auth.type === 'bearer') headers.push(['Authorization', `Bearer ${auth.token}`]);
  if (auth.type === 'basic' || auth.type === 'digest')
    basic = { username: auth.username, password: auth.password };
  if (auth.type === 'apikey') {
    if (auth.in === 'header') headers.push([auth.key, auth.value]);
    else query.push([auth.key, auth.value]);
  }
  if (auth.type === 'oauth2')
    headers.push(['Authorization', `${auth.tokenPrefix || 'Bearer'} {{oauth2AccessToken}}`]);
  for (const header of enabled(request.headers)) headers.push([header.key, header.value]);
  /** Adds the content type unless a header sets one; the one that applies. */
  const contentType = (type: string) => {
    const set = headers.find(([key]) => key.toLowerCase() === 'content-type');
    if (set) return set[1];
    headers.push(['Content-Type', type]);
    return type;
  };

  let method: string = request.method;
  let body: PreparedBody | null = null;
  if (request.kind === 'graphql') {
    if (method === 'GET') {
      const spec = request.graphql ?? { query: '' };
      query.push(['query', encodeComponent(spec.query)]);
      if (spec.variables?.trim() && spec.variables.trim() !== '{}')
        query.push(['variables', encodeComponent(spec.variables)]);
      if (spec.operationName) query.push(['operationName', spec.operationName]);
    } else {
      method = 'POST';
      body = {
        type: 'raw',
        content: graphqlPayload(request),
        contentType: contentType('application/json'),
      };
    }
  } else {
    const source = request.body;
    if (
      source.mode === 'json' ||
      source.mode === 'text' ||
      source.mode === 'xml' ||
      source.mode === 'sparql'
    ) {
      const type = contentType(RAW_TYPES[source.mode]);
      if (source.content) body = { type: 'raw', content: source.content, contentType: type };
    } else if (source.mode === 'urlencoded') {
      contentType('application/x-www-form-urlencoded');
      body = { type: 'urlencoded', fields: enabled(source.fields).map((f) => [f.key, f.value]) };
    } else if (source.mode === 'form') {
      body = {
        type: 'form',
        fields: enabled<FormField>(source.fields).map((field) =>
          field.type === 'file'
            ? {
                key: field.key,
                value: '',
                fileName: field.file?.fileName ?? 'file',
                contentType: field.contentType ?? field.file?.contentType,
              }
            : { key: field.key, value: field.value, contentType: field.contentType },
        ),
      };
    } else if (source.mode === 'binary') {
      body = {
        type: 'binary',
        fileName: source.file?.fileName ?? 'file.bin',
        contentType: contentType(source.file?.contentType || 'application/octet-stream'),
      };
    }
  }
  return {
    method,
    url: withQuery(fillPathParams(request.url, request.pathParams), query),
    headers,
    ...(basic ? { basic } : {}),
    body,
    auth,
  };
}

// ---------- quoting ----------

const shell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** A double-quoted string literal: valid in JavaScript, Python, Go, Java and C#. */
const str = (value: string) => JSON.stringify(value);
const php = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;

// ---------- generators ----------

function curl(request: ApiRequestSpec, prepared: PreparedRequest): string {
  const lines = [`curl -X ${prepared.method} ${shell(prepared.url)}`];
  if (request.kind === 'sse')
    lines.splice(0, 1, `curl -N -X ${prepared.method} ${shell(prepared.url)}`);
  const auth = prepared.auth;
  if (prepared.basic) {
    if (auth.type === 'digest') lines.push('--digest');
    lines.push(`-u ${shell(`${prepared.basic.username}:${prepared.basic.password}`)}`);
  }
  if (auth.type === 'awsv4')
    lines.push(
      `--aws-sigv4 ${shell(`aws:amz:${auth.region}:${auth.service}`)}`,
      `-u ${shell(`${auth.accessKeyId}:${auth.secretAccessKey}`)}`,
    );
  for (const [key, value] of prepared.headers) lines.push(`-H ${shell(`${key}: ${value}`)}`);
  const body = prepared.body;
  if (body?.type === 'raw') lines.push(`--data-raw ${shell(body.content)}`);
  if (body?.type === 'urlencoded')
    for (const [key, value] of body.fields)
      lines.push(`--data-urlencode ${shell(`${key}=${value}`)}`);
  if (body?.type === 'form')
    for (const field of body.fields) {
      const type = field.contentType ? `;type=${field.contentType}` : '';
      lines.push(
        `-F ${shell(field.fileName ? `${field.key}=@${field.fileName}${type}` : `${field.key}=${field.value}${type}`)}`,
      );
    }
  if (body?.type === 'binary') lines.push(`--data-binary ${shell(`@${body.fileName}`)}`);
  return lines.join(' \\\n  ');
}

function fetchJs(request: ApiRequestSpec, prepared: PreparedRequest): string {
  const lines: string[] = [];
  const headers = [...prepared.headers.map(([key, value]) => `    ${str(key)}: ${str(value)},`)];
  if (prepared.basic)
    headers.push(
      `    Authorization: 'Basic ' + btoa(${str(`${prepared.basic.username}:${prepared.basic.password}`)}),`,
    );
  const body = prepared.body;
  let bodyLine: string | null = null;
  if (body?.type === 'raw') bodyLine = `  body: ${str(body.content)},`;
  if (body?.type === 'urlencoded') {
    lines.push('const body = new URLSearchParams();');
    for (const [key, value] of body.fields) lines.push(`body.append(${str(key)}, ${str(value)});`);
    bodyLine = '  body,';
  }
  if (body?.type === 'form') {
    lines.push('const body = new FormData();');
    for (const field of body.fields)
      lines.push(
        field.fileName
          ? `body.append(${str(field.key)}, fileInput.files[0], ${str(field.fileName)});`
          : `body.append(${str(field.key)}, ${str(field.value)});`,
      );
    bodyLine = '  body,';
  }
  if (body?.type === 'binary') {
    lines.push(`// ${body.fileName}`);
    bodyLine = '  body: fileInput.files[0],';
  }
  if (lines.length) lines.push('');
  lines.push(`const response = await fetch(${str(prepared.url)}, {`);
  lines.push(`  method: ${str(prepared.method)},`);
  if (headers.length) lines.push('  headers: {', ...headers, '  },');
  if (bodyLine) lines.push(bodyLine);
  lines.push('});');
  if (request.kind === 'sse') {
    lines.push(
      '',
      'const reader = response.body.getReader();',
      'const decoder = new TextDecoder();',
      'for (;;) {',
      '  const { value, done } = await reader.read();',
      '  if (done) break;',
      '  console.log(decoder.decode(value));',
      '}',
    );
  } else {
    lines.push('', 'console.log(response.status, await response.text());');
  }
  return lines.join('\n');
}

function axios(prepared: PreparedRequest): string {
  const lines = ["import axios from 'axios';"];
  const body = prepared.body;
  let data: string | null = null;
  if (body?.type === 'raw') data = str(body.content);
  if (body?.type === 'urlencoded') {
    lines.push('', 'const data = new URLSearchParams();');
    for (const [key, value] of body.fields) lines.push(`data.append(${str(key)}, ${str(value)});`);
    data = 'data';
  }
  if (body?.type === 'form') {
    lines.splice(1, 0, "import fs from 'node:fs';");
    lines.push('', 'const data = new FormData();');
    for (const field of body.fields)
      lines.push(
        field.fileName
          ? `data.append(${str(field.key)}, new Blob([fs.readFileSync(${str(field.fileName)})]), ${str(field.fileName)});`
          : `data.append(${str(field.key)}, ${str(field.value)});`,
      );
    data = 'data';
  }
  if (body?.type === 'binary') {
    lines.splice(1, 0, "import fs from 'node:fs';");
    data = `fs.readFileSync(${str(body.fileName)})`;
  }
  lines.push('', 'const response = await axios.request({');
  lines.push(`  method: ${str(prepared.method)},`);
  lines.push(`  url: ${str(prepared.url)},`);
  if (prepared.headers.length) {
    lines.push('  headers: {');
    for (const [key, value] of prepared.headers) lines.push(`    ${str(key)}: ${str(value)},`);
    lines.push('  },');
  }
  if (prepared.basic)
    lines.push(
      `  auth: { username: ${str(prepared.basic.username)}, password: ${str(prepared.basic.password)} },`,
    );
  if (data) lines.push(`  data: ${data},`);
  lines.push('});', '', 'console.log(response.status, response.data);');
  return lines.join('\n');
}

function python(request: ApiRequestSpec, prepared: PreparedRequest): string {
  const lines = ['import requests', ''];
  lines.push(`url = ${str(prepared.url)}`);
  const headers = prepared.headers.filter(
    ([key]) => !(prepared.body?.type === 'form' && key.toLowerCase() === 'content-type'),
  );
  if (headers.length) {
    lines.push('headers = {');
    for (const [key, value] of headers) lines.push(`    ${str(key)}: ${str(value)},`);
    lines.push('}');
  }
  const args = ['url'];
  if (headers.length) args.push('headers=headers');
  const body = prepared.body;
  if (body?.type === 'raw') {
    lines.push(`data = ${str(body.content)}`);
    args.push('data=data.encode("utf-8")');
  }
  if (body?.type === 'urlencoded') {
    lines.push('data = {');
    for (const [key, value] of body.fields) lines.push(`    ${str(key)}: ${str(value)},`);
    lines.push('}');
    args.push('data=data');
  }
  if (body?.type === 'form') {
    lines.push('files = {');
    for (const field of body.fields)
      lines.push(
        field.fileName
          ? `    ${str(field.key)}: (${str(field.fileName)}, open(${str(field.fileName)}, "rb")${field.contentType ? `, ${str(field.contentType)}` : ''}),`
          : `    ${str(field.key)}: (None, ${str(field.value)}),`,
      );
    lines.push('}');
    args.push('files=files');
  }
  if (body?.type === 'binary') {
    lines.push(`data = open(${str(body.fileName)}, "rb")`);
    args.push('data=data');
  }
  if (prepared.basic) {
    if (prepared.auth.type === 'digest') {
      lines.splice(1, 0, 'from requests.auth import HTTPDigestAuth');
      args.push(
        `auth=HTTPDigestAuth(${str(prepared.basic.username)}, ${str(prepared.basic.password)})`,
      );
    } else {
      args.push(`auth=(${str(prepared.basic.username)}, ${str(prepared.basic.password)})`);
    }
  }
  if (request.kind === 'sse') args.push('stream=True');
  lines.push('');
  lines.push(`response = requests.request(${str(prepared.method)}, ${args.join(', ')})`);
  if (request.kind === 'sse')
    lines.push('for line in response.iter_lines(decode_unicode=True):', '    print(line)');
  else lines.push('print(response.status_code, response.text)');
  return lines.join('\n');
}

function go(prepared: PreparedRequest): string {
  const imports = new Set(['fmt', 'io', 'net/http']);
  const setup: string[] = [];
  let reader = 'nil';
  const body = prepared.body;
  if (body?.type === 'raw') {
    imports.add('strings');
    reader = `strings.NewReader(${str(body.content)})`;
  }
  if (body?.type === 'urlencoded') {
    imports.add('net/url').add('strings');
    setup.push('\tform := url.Values{}');
    for (const [key, value] of body.fields) setup.push(`\tform.Set(${str(key)}, ${str(value)})`);
    reader = 'strings.NewReader(form.Encode())';
  }
  if (body?.type === 'form') {
    imports.add('bytes').add('mime/multipart').add('os');
    setup.push('\tvar payload bytes.Buffer', '\twriter := multipart.NewWriter(&payload)');
    for (const field of body.fields) {
      if (field.fileName) {
        setup.push(
          '\t{',
          `\t\tpart, _ := writer.CreateFormFile(${str(field.key)}, ${str(field.fileName)})`,
          `\t\tcontent, _ := os.ReadFile(${str(field.fileName)})`,
          '\t\tpart.Write(content)',
          '\t}',
        );
      } else {
        setup.push(`\twriter.WriteField(${str(field.key)}, ${str(field.value)})`);
      }
    }
    setup.push('\twriter.Close()');
    reader = '&payload';
  }
  if (body?.type === 'binary') {
    imports.add('bytes').add('os');
    setup.push(`\tcontent, _ := os.ReadFile(${str(body.fileName)})`);
    reader = 'bytes.NewReader(content)';
  }
  const lines = [
    'package main',
    '',
    'import (',
    ...[...imports].sort().map((name) => `\t${str(name)}`),
    ')',
    '',
    'func main() {',
    ...setup,
    `\treq, err := http.NewRequest(${str(prepared.method)}, ${str(prepared.url)}, ${reader})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
  ];
  for (const [key, value] of prepared.headers)
    lines.push(`\treq.Header.Set(${str(key)}, ${str(value)})`);
  if (body?.type === 'form')
    lines.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
  if (prepared.basic)
    lines.push(
      `\treq.SetBasicAuth(${str(prepared.basic.username)}, ${str(prepared.basic.password)})`,
    );
  lines.push(
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer res.Body.Close()',
    '\tdata, _ := io.ReadAll(res.Body)',
    '\tfmt.Println(res.StatusCode, string(data))',
    '}',
  );
  return lines.join('\n');
}

function java(prepared: PreparedRequest): string {
  const body = prepared.body;
  let publisher = 'HttpRequest.BodyPublishers.noBody()';
  const lines = [
    'import java.net.URI;',
    'import java.net.http.HttpClient;',
    'import java.net.http.HttpRequest;',
    'import java.net.http.HttpResponse;',
  ];
  if (prepared.basic) lines.push('import java.util.Base64;');
  if (body?.type === 'binary' || body?.type === 'form') lines.push('import java.nio.file.Path;');
  lines.push('', 'HttpClient client = HttpClient.newHttpClient();');
  if (body?.type === 'raw') publisher = `HttpRequest.BodyPublishers.ofString(${str(body.content)})`;
  if (body?.type === 'urlencoded')
    publisher = `HttpRequest.BodyPublishers.ofString(${str(
      body.fields
        .map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`)
        .join('&'),
    )})`;
  if (body?.type === 'binary')
    publisher = `HttpRequest.BodyPublishers.ofFile(Path.of(${str(body.fileName)}))`;
  if (body?.type === 'form') {
    // The JDK has no multipart builder: the parts are written by hand.
    lines.push('String boundary = "----adk" + System.currentTimeMillis();');
    lines.push('var parts = new java.util.ArrayList<byte[]>();');
    for (const field of body.fields) {
      const head = field.fileName
        ? `Content-Disposition: form-data; name="${field.key}"; filename="${field.fileName}"\r\nContent-Type: ${field.contentType ?? 'application/octet-stream'}\r\n\r\n`
        : `Content-Disposition: form-data; name="${field.key}"\r\n\r\n`;
      lines.push(`parts.add(("--" + boundary + "\\r\\n" + ${str(head)}).getBytes());`);
      lines.push(
        field.fileName
          ? `parts.add(java.nio.file.Files.readAllBytes(Path.of(${str(field.fileName)})));`
          : `parts.add(${str(field.value)}.getBytes());`,
      );
      lines.push('parts.add("\\r\\n".getBytes());');
    }
    lines.push('parts.add(("--" + boundary + "--\\r\\n").getBytes());');
    publisher = 'HttpRequest.BodyPublishers.ofByteArrays(parts)';
  }
  lines.push('HttpRequest request = HttpRequest.newBuilder()');
  lines.push(`    .uri(URI.create(${str(prepared.url)}))`);
  for (const [key, value] of prepared.headers)
    lines.push(`    .header(${str(key)}, ${str(value)})`);
  if (body?.type === 'form')
    lines.push('    .header("Content-Type", "multipart/form-data; boundary=" + boundary)');
  if (prepared.basic)
    lines.push(
      `    .header("Authorization", "Basic " + Base64.getEncoder().encodeToString(${str(`${prepared.basic.username}:${prepared.basic.password}`)}.getBytes()))`,
    );
  lines.push(`    .method(${str(prepared.method)}, ${publisher})`);
  lines.push('    .build();');
  lines.push(
    '',
    'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());',
    'System.out.println(response.statusCode() + " " + response.body());',
  );
  return lines.join('\n');
}

function csharp(prepared: PreparedRequest): string {
  const lines = [
    'using System.Net.Http;',
    'using System.Net.Http.Headers;',
    'using System.Text;',
    '',
    'var client = new HttpClient();',
    `var request = new HttpRequestMessage(new HttpMethod(${str(prepared.method)}), ${str(prepared.url)});`,
  ];
  const isContentHeader = (key: string) => /^content-/i.test(key);
  for (const [key, value] of prepared.headers.filter(([key]) => !isContentHeader(key)))
    lines.push(`request.Headers.TryAddWithoutValidation(${str(key)}, ${str(value)});`);
  if (prepared.basic)
    lines.push(
      `request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(${str(`${prepared.basic.username}:${prepared.basic.password}`)})));`,
    );
  const body = prepared.body;
  if (body?.type === 'raw')
    lines.push(
      `request.Content = new StringContent(${str(body.content)}, Encoding.UTF8, ${str(body.contentType)});`,
    );
  if (body?.type === 'urlencoded') {
    lines.push('request.Content = new FormUrlEncodedContent(new Dictionary<string, string>');
    lines.push('{');
    for (const [key, value] of body.fields) lines.push(`    [${str(key)}] = ${str(value)},`);
    lines.push('});');
  }
  if (body?.type === 'form') {
    lines.push('var form = new MultipartFormDataContent();');
    for (const field of body.fields)
      lines.push(
        field.fileName
          ? `form.Add(new ByteArrayContent(File.ReadAllBytes(${str(field.fileName)})), ${str(field.key)}, ${str(field.fileName)});`
          : `form.Add(new StringContent(${str(field.value)}), ${str(field.key)});`,
      );
    lines.push('request.Content = form;');
  }
  if (body?.type === 'binary') {
    lines.push(`request.Content = new ByteArrayContent(File.ReadAllBytes(${str(body.fileName)}));`);
    lines.push(
      `request.Content.Headers.ContentType = new MediaTypeHeaderValue(${str(body.contentType)});`,
    );
  }
  lines.push(
    '',
    'var response = await client.SendAsync(request);',
    'Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");',
  );
  return lines.join('\n');
}

function phpCurl(prepared: PreparedRequest): string {
  const options = [
    `  CURLOPT_URL => ${php(prepared.url)},`,
    '  CURLOPT_RETURNTRANSFER => true,',
    `  CURLOPT_CUSTOMREQUEST => ${php(prepared.method)},`,
  ];
  const headers = prepared.headers.filter(
    ([key]) => !(prepared.body?.type === 'form' && key.toLowerCase() === 'content-type'),
  );
  if (headers.length) {
    options.push('  CURLOPT_HTTPHEADER => [');
    for (const [key, value] of headers) options.push(`    ${php(`${key}: ${value}`)},`);
    options.push('  ],');
  }
  if (prepared.basic)
    options.push(
      `  CURLOPT_USERPWD => ${php(`${prepared.basic.username}:${prepared.basic.password}`)},`,
    );
  const body = prepared.body;
  if (body?.type === 'raw') options.push(`  CURLOPT_POSTFIELDS => ${php(body.content)},`);
  if (body?.type === 'urlencoded') {
    options.push('  CURLOPT_POSTFIELDS => http_build_query([');
    for (const [key, value] of body.fields) options.push(`    ${php(key)} => ${php(value)},`);
    options.push('  ]),');
  }
  if (body?.type === 'form') {
    options.push('  CURLOPT_POSTFIELDS => [');
    for (const field of body.fields)
      options.push(
        field.fileName
          ? `    ${php(field.key)} => new CURLFile(${php(field.fileName)}${field.contentType ? `, ${php(field.contentType)}` : ''}),`
          : `    ${php(field.key)} => ${php(field.value)},`,
      );
    options.push('  ],');
  }
  if (body?.type === 'binary')
    options.push(`  CURLOPT_POSTFIELDS => file_get_contents(${php(body.fileName)}),`);
  return [
    '<?php',
    '',
    '$curl = curl_init();',
    'curl_setopt_array($curl, [',
    ...options,
    ']);',
    '',
    '$response = curl_exec($curl);',
    '$status = curl_getinfo($curl, CURLINFO_HTTP_CODE);',
    'curl_close($curl);',
    '',
    'echo $status . " " . $response;',
  ].join('\n');
}

function powershell(prepared: PreparedRequest): string {
  const lines: string[] = [];
  const headers = prepared.headers.filter(([key]) => key.toLowerCase() !== 'content-type');
  if (headers.length || prepared.basic) {
    lines.push('$headers = @{');
    for (const [key, value] of headers) lines.push(`    ${ps(key)} = ${ps(value)}`);
    if (prepared.basic)
      lines.push(
        `    'Authorization' = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${ps(`${prepared.basic.username}:${prepared.basic.password}`)}))`,
      );
    lines.push('}');
  }
  const args = [`-Uri ${ps(prepared.url)}`, `-Method ${prepared.method}`];
  if (headers.length || prepared.basic) args.push('-Headers $headers');
  const body = prepared.body;
  if (body?.type === 'raw') {
    lines.push(`$body = ${ps(body.content)}`);
    args.push('-Body $body', `-ContentType ${ps(body.contentType)}`);
  }
  if (body?.type === 'urlencoded') {
    lines.push('$body = @{');
    for (const [key, value] of body.fields) lines.push(`    ${ps(key)} = ${ps(value)}`);
    lines.push('}');
    args.push('-Body $body', "-ContentType 'application/x-www-form-urlencoded'");
  }
  if (body?.type === 'form') {
    lines.push('$form = @{');
    for (const field of body.fields)
      lines.push(
        field.fileName
          ? `    ${ps(field.key)} = Get-Item -Path ${ps(field.fileName)}`
          : `    ${ps(field.key)} = ${ps(field.value)}`,
      );
    lines.push('}');
    args.push('-Form $form');
  }
  if (body?.type === 'binary')
    args.push(`-InFile ${ps(body.fileName)}`, `-ContentType ${ps(body.contentType)}`);
  lines.push(`$response = Invoke-RestMethod ${args.join(' `\n  ')}`, '$response');
  return lines.join('\n');
}

function httpie(request: ApiRequestSpec, prepared: PreparedRequest): string {
  const body = prepared.body;
  const parts = ['http'];
  if (request.kind === 'sse') parts.push('--stream');
  if (body?.type === 'urlencoded') parts.push('--form');
  if (body?.type === 'form') parts.push('--multipart');
  if (prepared.basic) {
    if (prepared.auth.type === 'digest') parts.push('--auth-type=digest');
    parts.push(`-a ${shell(`${prepared.basic.username}:${prepared.basic.password}`)}`);
  }
  parts.push(prepared.method, shell(prepared.url));
  for (const [key, value] of prepared.headers) parts.push(shell(`${key}:${value}`));
  if (body?.type === 'urlencoded')
    for (const [key, value] of body.fields) parts.push(shell(`${key}=${value}`));
  if (body?.type === 'form')
    for (const field of body.fields)
      parts.push(
        shell(field.fileName ? `${field.key}@${field.fileName}` : `${field.key}=${field.value}`),
      );
  const command = parts.join(' \\\n  ');
  if (body?.type === 'raw') return `printf '%s' ${shell(body.content)} | ${command}`;
  if (body?.type === 'binary') return `${command} < ${shell(body.fileName)}`;
  return command;
}

function grpcurl(request: ApiRequestSpec, auth: RequestAuth): string {
  const spec = request.grpc ?? { method: '', message: '{}' };
  const match = /^(grpcs?):\/\/([^/]+)/i.exec(request.url.trim());
  const address = match?.[2] ?? request.url.replace(/^\w+:\/\//, '');
  const parts = ['grpcurl'];
  if (!match || match[1]!.toLowerCase() === 'grpc') parts.push('-plaintext');
  if (spec.reflection === false && spec.protoFile) parts.push(`-proto ${shell(spec.protoFile)}`);
  if (auth.type === 'bearer') parts.push(`-H ${shell(`authorization: Bearer ${auth.token}`)}`);
  if (auth.type === 'apikey') parts.push(`-H ${shell(`${auth.key}: ${auth.value}`)}`);
  for (const header of enabled(request.headers))
    parts.push(`-H ${shell(`${header.key}: ${header.value}`)}`);
  let data = spec.message.trim();
  try {
    const parsed: unknown = JSON.parse(data);
    // Streams of requests go as one JSON object after the other.
    data = Array.isArray(parsed)
      ? parsed.map((item) => JSON.stringify(item)).join('\n')
      : JSON.stringify(parsed);
  } catch {
    // Kept as typed ({{variables}} where a value goes).
  }
  if (data) parts.push(`-d ${shell(data)}`);
  parts.push(shell(address), shell(spec.method || 'package.Service/Method'));
  return parts.join(' \\\n  ');
}

function websocat(request: ApiRequestSpec, auth: RequestAuth): string {
  const spec = request.websocket ?? { messages: [] };
  const parts = ['websocat'];
  if (auth.type === 'bearer') parts.push(`-H ${shell(`Authorization: Bearer ${auth.token}`)}`);
  if (auth.type === 'apikey' && auth.in === 'header')
    parts.push(`-H ${shell(`${auth.key}: ${auth.value}`)}`);
  for (const header of enabled(request.headers))
    parts.push(`-H ${shell(`${header.key}: ${header.value}`)}`);
  if (spec.subprotocols?.length) parts.push(`--protocol ${shell(spec.subprotocols.join(', '))}`);
  if (spec.messages.some((message) => message.type === 'binary')) parts.push('--binary');
  parts.push(shell(fillPathParams(request.url, request.pathParams)));
  const messages = spec.messages.filter((message) => message.content);
  const command = parts.join(' \\\n  ');
  if (!messages.length) return command;
  const contents = messages.map((message) =>
    message.type === 'json' ? message.content.replace(/\s*\n\s*/g, ' ') : message.content,
  );
  return `printf '%s\\n' ${contents.map(shell).join(' ')} | ${command}`;
}

function netcat(request: ApiRequestSpec): string {
  const spec = request.socket ?? { messages: [] };
  const match = /^(tcp|tls|udp):\/\/([^/:]+)(?::(\d+))?/i.exec(request.url.trim());
  const scheme = match?.[1]?.toLowerCase() ?? 'tcp';
  const host = match?.[2] ?? 'localhost';
  const port = match?.[3] ?? '9000';
  const command =
    scheme === 'tls'
      ? `openssl s_client -quiet -connect ${host}:${port}`
      : `nc${scheme === 'udp' ? ' -u' : ''} ${host} ${port}`;
  const messages = spec.messages.filter((message) => message.content);
  if (!messages.length) return command;
  const input = messages.map((message) => {
    if (message.type === 'hex')
      return `printf '%s' ${shell(message.content.replace(/\s+/g, ''))} | xxd -r -p`;
    if (message.type === 'base64') return `printf '%s' ${shell(message.content)} | base64 -d`;
    return `printf '%s' ${shell(message.content)}`;
  });
  return input.length === 1 ? `${input[0]} | ${command}` : `{ ${input.join('; ')}; } | ${command}`;
}

/** The request as a snippet of `target`. */
export function generateCode(
  target: CodeTarget,
  request: ApiRequestSpec,
  collection: Pick<ApiCollection, 'auth'>,
): string {
  const auth = request.auth.type === 'inherit' ? collection.auth : request.auth;
  if (target === 'grpcurl') return grpcurl(request, auth);
  if (target === 'websocat') return websocat(request, auth);
  if (target === 'netcat') return netcat(request);
  const prepared = prepareRequest(request, collection);
  switch (target) {
    case 'fetch':
      return fetchJs(request, prepared);
    case 'axios':
      return axios(prepared);
    case 'python':
      return python(request, prepared);
    case 'go':
      return go(prepared);
    case 'java':
      return java(prepared);
    case 'csharp':
      return csharp(prepared);
    case 'php':
      return phpCurl(prepared);
    case 'powershell':
      return powershell(prepared);
    case 'httpie':
      return httpie(request, prepared);
    default:
      return curl(request, prepared);
  }
}
