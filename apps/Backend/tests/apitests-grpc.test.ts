import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  grpcCall,
  grpcListServices,
  type GrpcTarget,
} from '../src/modules/apitests/engine/grpc-client.js';
import { decodeMessage, encodeMessage } from '../src/modules/apitests/engine/grpc-codec.js';
import { exampleMessage } from '../src/modules/apitests/engine/grpc-example.js';
import {
  builtinProto,
  loadProtoFiles,
  parseProto,
} from '../src/modules/apitests/engine/grpc-proto.js';
import { decodeFileDescriptor } from '../src/modules/apitests/engine/grpc-reflection.js';
import {
  buildRegistry,
  type RawMessage,
  type Registry,
} from '../src/modules/apitests/engine/grpc-schema.js';
import { readFields, Writer } from '../src/modules/apitests/engine/grpc-wire.js';
import type { ProtoFile } from '../src/modules/apitests/engine/types.js';

// openSocket is the transport package's; a plain TCP socket is enough for an h2c test server.
// `*.test` hosts stand for other cases: `hang.test` waits for the abort signal, `refuse.test`
// fails, `alias.test:<port>` connects to 127.0.0.1.
const sockets = vi.hoisted(() => ({
  opened: [] as { host: string; port: number; tls: boolean; alpn?: readonly string[] }[],
}));
vi.mock('../src/modules/apitests/engine/http-transport.js', async () => {
  const net = await import('node:net');
  return {
    openSocket: (
      target: { host: string; port: number; tls: boolean; alpn?: readonly string[] },
      network: { signal?: AbortSignal },
    ) =>
      new Promise((resolve, reject) => {
        sockets.opened.push(target);
        if (target.host === 'hang.test') {
          network.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          return;
        }
        if (target.host === 'refuse.test') return reject(new Error('connect ECONNREFUSED'));
        const host = target.host === 'alias.test' ? '127.0.0.1' : target.host;
        const socket = net.connect(target.port, host, () => resolve(socket));
        socket.once('error', reject);
      }),
  };
});

const ITEMS_PROTO = `
// Items API
syntax = "proto3";
package demo.v1;

import "google/protobuf/timestamp.proto";
import "google/protobuf/duration.proto";
import "google/protobuf/struct.proto";
import public "money.proto"; /* relative to this file */

option go_package = "example.com/demo;demo";

message Item {
  string id = 1;
  int64 big = 2;
  sint32 delta = 3;
  int32 neg = 4;
  repeated int32 counts = 5;
  map<string, int32> labels = 6;
  bytes blob = 7;
  Status status = 8;
  enum Status {
    option allow_alias = true;
    STATUS_UNSPECIFIED = 0;
    ACTIVE = 1;
    ENABLED = 1;
  }
  google.protobuf.Timestamp created_at = 9;
  google.protobuf.Duration ttl = 10;
  google.protobuf.Struct meta = 11;
  oneof choice {
    string name = 12;
    Nested nested = 13;
  }
  message Nested {
    int32 value = 1 [json_name = "val", deprecated = true];
    Item parent = 2;
  }
  common.Money price = 14;
  optional string note = 15;
  repeated uint64 ids = 16;
  double ratio = 17;
  float f = 18;
  fixed64 fx = 19;
  reserved 20 to 25;
  reserved "old";
}

message GetRequest { string id = 1; }
message ListRequest { int32 count = 1; }

service Items {
  option (custom.opt) = { a: 1 b: "x" };
  rpc Get(GetRequest) returns (Item);
  rpc List(.demo.v1.ListRequest) returns (stream Item) {}
  rpc Chat(stream Item) returns (stream Item);
  rpc Slow(GetRequest) returns (Item);
}
`;

const MONEY_PROTO = `syntax = 'proto3'; package common; message Money { string currency_code = 1; int64 units = 2; }`;

const PING_PROTO = `syntax = "proto3"; package refl.v1;
import "google/protobuf/timestamp.proto";
enum Kind { KIND_UNSPECIFIED = 0; LOUD = 1; }
message Ping { string text = 1; repeated int32 n = 2; map<string, string> tags = 3;
  google.protobuf.Timestamp at = 4; Kind kind = 5; }
service Pinger { rpc Ping(Ping) returns (Ping); rpc Watch(Ping) returns (stream Ping); }`;

const protoFiles: ProtoFile[] = [
  { name: 'demo/v1/items.proto', content: ITEMS_PROTO },
  { name: 'demo/v1/money.proto', content: MONEY_PROTO },
];
const items = loadProtoFiles(protoFiles).registry;
const ping = loadProtoFiles([{ name: 'ping.proto', content: PING_PROTO }]).registry;

describe('proto parser', () => {
  it('reads packages, nested types, maps, oneofs, enums and imports', () => {
    const item = items.message('demo.v1.Item');
    expect(item.fields.map((f) => f.jsonName)).toEqual([
      'id',
      'big',
      'delta',
      'neg',
      'counts',
      'labels',
      'blob',
      'status',
      'createdAt',
      'ttl',
      'meta',
      'name',
      'nested',
      'price',
      'note',
      'ids',
      'ratio',
      'f',
      'fx',
    ]);
    expect(item.byName.get('labels')?.map?.value.type).toBe('int32');
    expect(item.byName.get('created_at')?.type).toBe('google.protobuf.Timestamp');
    expect(item.byName.get('price')?.type).toBe('common.Money');
    expect(item.byName.get('nested')).toMatchObject({ oneof: 'choice', kind: 'message' });
    expect(item.byName.get('status')).toMatchObject({ kind: 'enum', type: 'demo.v1.Item.Status' });
    expect(item.byName.get('counts')?.packed).toBe(true);
    expect(item.byName.get('note')?.presence).toBe(true);
    expect(item.byName.get('id')?.presence).toBe(false);
    expect(items.message('demo.v1.Item.Nested').byName.get('val')?.name).toBe('value');
    expect(items.enum('demo.v1.Item.Status').byNumber.get(1)).toBe('ACTIVE');
    expect(items.method('/demo.v1.Items/List')).toMatchObject({
      input: 'demo.v1.ListRequest',
      serverStreaming: true,
      clientStreaming: false,
    });
    expect(items.method('demo.v1.Items/Chat')).toMatchObject({
      clientStreaming: true,
      serverStreaming: true,
    });
  });

  it('limits the files to the entry and its imports, and reports missing imports', () => {
    const only = loadProtoFiles(protoFiles, 'demo/v1/money.proto');
    expect(only.entry).toBe('demo/v1/money.proto');
    expect([...only.registry.services.keys()]).toEqual([]);
    expect(() =>
      loadProtoFiles([{ name: 'a.proto', content: 'syntax = "proto3"; import "nope.proto";' }]),
    ).toThrow('Import "nope.proto" not found (imported by a.proto)');
    expect(() =>
      loadProtoFiles([
        { name: 'a.proto', content: 'syntax = "proto3"; message A { Missing m = 1; }' },
      ]),
    ).toThrow('Type "Missing" not found (used by A.m)');
  });

  it('parses proto2 labels, packed options and relative scoping', () => {
    const file = parseProto(
      'p2.proto',
      `syntax = "proto2"; package a.b;
       message Outer { required int32 id = 1; repeated int32 plain = 2; repeated int32 packed = 3 [packed = true];
         optional Inner inner = 4; message Inner { optional string s = 1 [default = "x"]; } extensions 100 to max; }
       message Other { optional b.Outer.Inner ref = 1; optional .a.b.Outer abs = 2; }`,
    );
    const registry = buildRegistry([file]);
    const outer = registry.message('a.b.Outer');
    expect(outer.byName.get('plain')?.packed).toBe(false);
    expect(outer.byName.get('packed')?.packed).toBe(true);
    expect(outer.byName.get('id')?.presence).toBe(true);
    expect(registry.message('a.b.Other').byName.get('ref')?.type).toBe('a.b.Outer.Inner');
    expect(registry.message('a.b.Other').byName.get('abs')?.type).toBe('a.b.Outer');
  });
});

describe('protobuf codec', () => {
  const roundTrip = (registry: Registry, type: string, value: unknown): unknown =>
    decodeMessage(registry, type, encodeMessage(registry, type, value));

  it('round trips scalars, 64-bit strings, negatives, packed repeated, maps and bytes', () => {
    const out = roundTrip(items, 'demo.v1.Item', {
      id: 'a',
      big: '9007199254740993',
      delta: -5,
      neg: -2,
      counts: [1, 2, 300],
      labels: { x: 1, y: -1 },
      blob: Buffer.from('hi').toString('base64'),
      status: 'ENABLED',
      created_at: '2024-05-06T07:08:09.120Z',
      ttl: '1.5s',
      meta: { a: [1, 'two', null, { b: true }] },
      nested: { val: 3, parent: { id: 'p' } },
      price: { currencyCode: 'EUR', units: 12 },
      ids: ['18446744073709551615', 1],
      ratio: 0.25,
      f: 0.1,
      fx: '5',
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      id: 'a',
      big: '9007199254740993',
      delta: -5,
      neg: -2,
      counts: [1, 2, 300],
      labels: { x: 1, y: -1 },
      blob: 'aGk=',
      status: 'ACTIVE',
      createdAt: '2024-05-06T07:08:09.120Z',
      ttl: '1.500s',
      meta: { a: [1, 'two', null, { b: true }] },
      nested: { val: 3, parent: { id: 'p', big: '0' } },
      price: { currencyCode: 'EUR', units: '12' },
      ids: ['18446744073709551615', '1'],
      ratio: 0.25,
      f: 0.1,
      fx: '5',
    });
    expect(out).not.toHaveProperty('note');
    expect(out).not.toHaveProperty('name');
  });

  it('writes default values of fields without presence and decodes unpacked repeated fields', () => {
    expect(decodeMessage(items, 'demo.v1.GetRequest', Buffer.alloc(0))).toEqual({ id: '' });
    // counts = 5 as two unpacked varints, plus an unknown field 99 that is skipped.
    const bytes = new Writer()
      .tag(5, 0)
      .varint(7)
      .tag(5, 0)
      .varint(8)
      .tag(99, 2)
      .string('?')
      .finish();
    expect(decodeMessage(items, 'demo.v1.Item', bytes)).toMatchObject({
      counts: [7, 8],
      status: 'STATUS_UNSPECIFIED',
      labels: {},
      big: '0',
    });
  });

  it('encodes negative int32 as ten bytes and sint32 with zigzag', () => {
    const neg = encodeMessage(items, 'demo.v1.Item', { neg: -1 });
    expect(neg.length).toBe(11);
    expect(encodeMessage(items, 'demo.v1.Item', { delta: -1 })).toEqual(Buffer.from([0x18, 0x01]));
  });

  it('maps durations, timestamps and invalid input', () => {
    expect(roundTrip(items, 'demo.v1.Item', { ttl: '-0.000001s' })).toMatchObject({
      ttl: '-0.000001s',
    });
    expect(
      roundTrip(items, 'demo.v1.Item', { createdAt: '2024-01-01T02:00:00+02:00' }),
    ).toMatchObject({ createdAt: '2024-01-01T00:00:00Z' });
    expect(() => encodeMessage(items, 'demo.v1.Item', { nope: 1 })).toThrow(
      'Unknown field "nope" in demo.v1.Item',
    );
    expect(() => encodeMessage(items, 'demo.v1.Item', { status: 'WHAT' })).toThrow(
      'expected one of',
    );
    expect(() => encodeMessage(items, 'demo.v1.Item', { neg: 2 ** 40 })).toThrow('out of range');
  });

  it('builds example messages with every field, guarding recursion', () => {
    const example = exampleMessage(items, 'demo.v1.Item') as Record<string, unknown>;
    expect(example).toMatchObject({
      id: 'string',
      big: '0',
      counts: [0],
      labels: { string: 0 },
      status: 'STATUS_UNSPECIFIED',
      createdAt: '1970-01-01T00:00:00Z',
      name: 'string',
      price: { currencyCode: 'string', units: '0' },
    });
    expect(example).not.toHaveProperty('nested');
    expect(() => encodeMessage(items, 'demo.v1.Item', example)).not.toThrow();
  });
});

// --- Test server ------------------------------------------------------------------------------

const msg = (...fields: [number, string | number | Buffer][]): Buffer => {
  const writer = new Writer();
  for (const [number, value] of fields) {
    if (typeof value === 'number') writer.tag(number, 0).varint(value);
    else if (typeof value === 'string') writer.tag(number, 2).string(value);
    else writer.tag(number, 2).bytes(value);
  }
  return writer.finish();
};

const field = (name: string, number: number, label: number, type: number, typeName?: string) =>
  msg(
    [1, name],
    [3, number],
    [4, label],
    [5, type],
    ...(typeName ? [[6, typeName] as [number, string]] : []),
  );

/** refl/v1/ping.proto as a FileDescriptorProto, built by hand like protoc would. */
const PING_DESCRIPTOR = msg(
  [1, 'refl/v1/ping.proto'],
  [2, 'refl.v1'],
  [3, 'google/protobuf/timestamp.proto'],
  [
    4,
    msg(
      [1, 'Ping'],
      [2, field('text', 1, 1, 9)],
      [2, field('n', 2, 3, 5)],
      [2, field('tags', 3, 3, 11, '.refl.v1.Ping.TagsEntry')],
      [2, field('at', 4, 1, 11, '.google.protobuf.Timestamp')],
      [2, field('kind', 5, 1, 14, '.refl.v1.Kind')],
      [
        3,
        msg(
          [1, 'TagsEntry'],
          [2, field('key', 1, 1, 9)],
          [2, field('value', 2, 1, 9)],
          [7, msg([7, 1])],
        ),
      ],
    ),
  ],
  [5, msg([1, 'Kind'], [2, msg([1, 'KIND_UNSPECIFIED'], [2, 0])], [2, msg([1, 'LOUD'], [2, 1])])],
  [
    6,
    msg(
      [1, 'Pinger'],
      [2, msg([1, 'Ping'], [2, '.refl.v1.Ping'], [3, '.refl.v1.Ping'])],
      [2, msg([1, 'Watch'], [2, '.refl.v1.Ping'], [3, '.refl.v1.Ping'], [6, 1])],
    ),
  ],
  [12, 'proto3'],
);

const frame = (payload: Buffer, compressed = false): Buffer => {
  const prefix = Buffer.alloc(5);
  prefix[0] = compressed ? 1 : 0;
  prefix.writeUInt32BE(payload.length, 1);
  return Buffer.concat([prefix, payload]);
};

let server: http2.Http2Server;
let base = '';
let reflectionV1 = true;
let reflectionOn = true;
const seenHeaders: http2.IncomingHttpHeaders[] = [];

function reflectionResponse(request: Buffer): Buffer {
  const fields = readFields(request);
  if (fields.has(7)) {
    return msg([
      6,
      msg([1, msg([1, 'refl.v1.Pinger'])], [1, msg([1, 'grpc.reflection.v1.ServerReflection'])]),
    ]);
  }
  const symbol = String(fields.get(4)?.[0] ?? fields.get(3)?.[0] ?? '');
  const descriptor = DESCRIPTORS[symbol.replace(/\.[^.]+$/, '')] ?? DESCRIPTORS[symbol];
  if (descriptor) return msg([4, msg([1, descriptor])]);
  if (symbol === 'empty.v1.Svc') return Buffer.alloc(0);
  return msg([7, msg([1, 5], [2, 'not found'])]);
}

/** By package (file_containing_symbol of a service) or by file name (file_by_filename). */
const DESCRIPTORS: Record<string, Buffer> = {
  'refl.v1': PING_DESCRIPTOR,
  'dep.v1': msg(
    [1, 'dep/svc.proto'],
    [2, 'dep.v1'],
    [3, 'dep/types.proto'],
    [6, msg([1, 'Svc'], [2, msg([1, 'Do'], [2, '.dep.v1.Thing'], [3, '.dep.v1.Thing'])])],
    [12, 'proto3'],
  ),
  'dep/types.proto': msg(
    [1, 'dep/types.proto'],
    [2, 'dep.v1'],
    [4, msg([1, 'Thing'], [2, field('size', 1, 1, 3)])],
    [12, 'proto3'],
  ),
  'broken.v1': msg([1, 'broken.proto'], [2, 'broken.v1'], [3, 'missing/dep.proto'], [12, 'proto3']),
};

/** Get requests whose id names a protocol misbehavior. */
function misbehave(stream: http2.ServerHttp2Stream, id: string): boolean {
  const grpc = { ':status': 200, 'content-type': 'application/grpc' };
  const respond = (headers: http2.OutgoingHttpHeaders, payload: Buffer, compressed = false) => {
    stream.respond(headers, { waitForTrailers: true });
    stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(frame(payload, compressed));
  };
  const item = encodeMessage(items, 'demo.v1.Item', { id });
  const http = /^http-(\d+)$/.exec(id);
  const rst = /^rst-(\d+)$/.exec(id);
  if (http) stream.respond({ ':status': Number(http[1]) }, { endStream: true });
  else if (rst) {
    stream.on('error', () => undefined);
    stream.close(Number(rst[1]));
  } else if (id === 'no-status') stream.respond(grpc, { endStream: true });
  else if (id === 'bad-status')
    stream.respond({ ...grpc, 'grpc-status': 'abc' }, { endStream: true });
  else if (id === 'bad-message') {
    stream.respond(
      { ...grpc, 'grpc-status': '3', 'grpc-message': '%E0%A4%A' },
      { endStream: true },
    );
  } else if (id === 'deflate') {
    respond({ ...grpc, 'grpc-encoding': 'deflate' }, zlib.deflateSync(item), true);
  } else if (id === 'nocodec') respond(grpc, item, true);
  else if (id === 'split') {
    const whole = frame(item);
    stream.respond(grpc, { waitForTrailers: true });
    stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.write(whole.subarray(0, 3));
    setTimeout(() => stream.write(whole.subarray(3, 8)), 20);
    setTimeout(() => stream.end(whole.subarray(8)), 40);
  } else if (id === 'garbage') respond(grpc, Buffer.from([0x0a, 0xff]));
  else if (id === 'multi') respond({ ...grpc, 'x-multi': ['a', 'b'] }, item);
  else return false;
  return true;
}

function handle(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
  // The misbehaving paths reset streams on purpose; the server side must not throw for that.
  stream.on('error', () => undefined);
  seenHeaders.push(headers);
  const path = String(headers[':path']);
  const send = (payloads: Buffer[], trailers: Record<string, string> = { 'grpc-status': '0' }) => {
    stream.respond(
      { ':status': 200, 'content-type': 'application/grpc' },
      { waitForTrailers: true },
    );
    stream.once('wantTrailers', () => stream.sendTrailers(trailers));
    for (const payload of payloads) stream.write(frame(payload));
    stream.end();
  };
  const reflection =
    reflectionOn &&
    (path === '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo' ||
      (reflectionV1 && path === '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo'));
  const known =
    reflection ||
    path.startsWith('/demo.v1.Items/') ||
    path.startsWith('/refl.v1.Pinger/') ||
    path.startsWith('/dep.v1.Svc/');
  if (!known) {
    stream.respond(
      { ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' },
      { endStream: true },
    );
    return;
  }

  const received: Buffer[] = [];
  let pending = Buffer.alloc(0);
  stream.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
      const length = pending.readUInt32BE(1);
      const payload = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      received.push(payload);
      if (path === '/demo.v1.Items/Chat') {
        // Bidirectional: answer every message as soon as it arrives.
        if (received.length === 1)
          stream.respond(
            { ':status': 200, 'content-type': 'application/grpc' },
            { waitForTrailers: true },
          );
        const item = decodeMessage(items, 'demo.v1.Item', payload) as { id: string };
        stream.write(frame(encodeMessage(items, 'demo.v1.Item', { id: `echo:${item.id}` })));
      }
    }
  });
  stream.on('end', () => {
    const first = received[0] ?? Buffer.alloc(0);
    if (reflection && headers['x-slow'] !== undefined) return;
    if (reflection) return send([reflectionResponse(first)]);
    switch (path) {
      case '/demo.v1.Items/Get': {
        const { id } = decodeMessage(items, 'demo.v1.GetRequest', first) as { id: string };
        if (misbehave(stream, id)) return;
        if (id === 'missing') {
          stream.respond(
            {
              ':status': 200,
              'content-type': 'application/grpc',
              'grpc-status': '5',
              'grpc-message': 'item%20not%20found',
            },
            { endStream: true },
          );
          return;
        }
        const item = encodeMessage(items, 'demo.v1.Item', {
          id,
          big: '-9223372036854775808',
          name: String(headers['x-token']),
        });
        if (id === 'gzip') {
          stream.respond(
            { ':status': 200, 'content-type': 'application/grpc', 'grpc-encoding': 'gzip' },
            { waitForTrailers: true },
          );
          stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end(frame(zlib.gzipSync(item), true));
          return;
        }
        return send([item], { 'grpc-status': '0', 'x-served-by': 'test' });
      }
      case '/demo.v1.Items/List': {
        const { count } = decodeMessage(items, 'demo.v1.ListRequest', first) as { count: number };
        const list = Array.from({ length: count }, (_, i) =>
          encodeMessage(items, 'demo.v1.Item', { id: `i${i}` }),
        );
        return send(list);
      }
      case '/demo.v1.Items/Chat':
        stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
        return;
      case '/demo.v1.Items/Slow':
        setTimeout(() => {
          if (!stream.closed) send([encodeMessage(items, 'demo.v1.Item', {})]);
        }, 2000);
        return;
      case '/refl.v1.Pinger/Ping': {
        const value = decodeMessage(ping, 'refl.v1.Ping', first);
        return send([encodeMessage(ping, 'refl.v1.Ping', value)]);
      }
      case '/dep.v1.Svc/Do':
        return send([first]);
      default:
        send([], { 'grpc-status': '12' });
    }
  });
}

beforeAll(async () => {
  server = http2.createServer();
  server.on('stream', handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `grpc://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const target = (overrides: Partial<GrpcTarget> = {}): GrpcTarget => ({
  url: new URL(base),
  protoFiles,
  reflection: false,
  metadata: [],
  timeoutMs: 5000,
  ...overrides,
});

describe('gRPC calls over http2', () => {
  it('makes a unary call with metadata, headers and trailers', async () => {
    const result = await grpcCall(
      target({ metadata: [['X-Token', 'abc']] }),
      '/demo.v1.Items/Get',
      [{ id: 'one' }],
      {},
    );
    expect(result.status).toBe(0);
    expect(result.responses[0]).toMatchObject({
      id: 'one',
      big: '-9223372036854775808',
      name: 'abc',
    });
    expect(result.trailers['x-served-by']).toBe('test');
    expect(result.headers['content-type']).toBe('application/grpc');
    expect(result.messages.map((m) => m.direction)).toEqual(['sent', 'received']);
    expect(JSON.parse(result.messages[0]?.data ?? '')).toEqual({ id: 'one' });
    expect(result.sizeBytes).toBeGreaterThan(0);
    const sent = seenHeaders.at(-1) ?? {};
    expect(sent).toMatchObject({
      'content-type': 'application/grpc',
      te: 'trailers',
      'user-agent': 'adk-grpc/1.0',
      'x-token': 'abc',
    });
    expect(String(sent['grpc-timeout'])).toMatch(/^\d+m$/);
  });

  it('reads gzip-compressed messages', async () => {
    const result = await grpcCall(target(), 'demo.v1.Items/Get', [{ id: 'gzip' }], {});
    expect(result.status).toBe(0);
    expect(result.responses[0]).toMatchObject({ id: 'gzip' });
  });

  it('streams server responses', async () => {
    const result = await grpcCall(target(), 'demo.v1.Items/List', [{ count: 3 }], {});
    expect(result.status).toBe(0);
    expect(result.responses.map((r) => (r as { id: string }).id)).toEqual(['i0', 'i1', 'i2']);
  });

  it('runs bidirectional streams', async () => {
    const result = await grpcCall(target(), 'demo.v1.Items/Chat', [{ id: 'a' }, { id: 'b' }], {});
    expect(result.status).toBe(0);
    expect(result.responses.map((r) => (r as { id: string }).id)).toEqual(['echo:a', 'echo:b']);
    expect(result.messages.filter((m) => m.direction === 'sent')).toHaveLength(2);
  });

  it('returns trailers-only errors and unimplemented methods as statuses', async () => {
    const missing = await grpcCall(target(), 'demo.v1.Items/Get', [{ id: 'missing' }], {});
    expect(missing).toMatchObject({ status: 5, statusMessage: 'item not found', responses: [] });
    const other = await grpcCall(
      target({
        protoFiles: [
          {
            name: 'x.proto',
            content:
              'syntax = "proto3"; package x; message M {} service S { rpc Do(M) returns (M); }',
          },
        ],
      }),
      'x.S/Do',
      [{}],
      {},
    );
    expect(other.status).toBe(12);
  });

  it('stops at the deadline and on cancel', async () => {
    const late = await grpcCall(target({ timeoutMs: 150 }), 'demo.v1.Items/Slow', [{}], {});
    expect(late).toMatchObject({ status: 4, statusMessage: 'Deadline exceeded' });
    expect(late.durationMs).toBeLessThan(1500);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await grpcCall(target(), 'demo.v1.Items/Slow', [{}], {
      signal: controller.signal,
    });
    expect(cancelled.status).toBe(1);
  });

  it('throws when the method or the request cannot be resolved', async () => {
    await expect(grpcCall(target(), 'demo.v1.Items/Nope', [{}], {})).rejects.toThrow(
      'Method demo.v1.Items/Nope not found in the proto files',
    );
    await expect(grpcCall(target(), 'demo.v1.Items/Get', [{ idd: 1 }], {})).rejects.toThrow(
      'Invalid request message: Unknown field "idd"',
    );
  });

  it('lists the services of the proto files with examples', async () => {
    const list = await grpcListServices(target(), {});
    expect(list.services.map((s) => s.name)).toEqual(['demo.v1.Items']);
    expect(list.services[0]?.methods.map((m) => m.name)).toEqual(['Chat', 'Get', 'List', 'Slow']);
    expect(list.services[0]?.methods[1]).toMatchObject({
      path: 'demo.v1.Items/Get',
      requestType: 'demo.v1.GetRequest',
      responseType: 'demo.v1.Item',
      example: { id: 'string' },
    });
    const money = await grpcListServices(target({ protoFile: 'demo/v1/money.proto' }), {});
    expect(money.services).toEqual([]);
  });
});

describe('server reflection', () => {
  it('decodes FileDescriptorProto like the parser reads the same .proto', () => {
    const fromDescriptor = buildRegistry([
      decodeFileDescriptor(PING_DESCRIPTOR),
      builtinProto('google/protobuf/timestamp.proto')!,
    ]);
    const value = {
      text: 'hi',
      n: [1, 2],
      tags: { a: 'b' },
      at: '2024-01-01T00:00:00Z',
      kind: 'LOUD',
    };
    const bytes = encodeMessage(fromDescriptor, 'refl.v1.Ping', value);
    expect(decodeMessage(ping, 'refl.v1.Ping', bytes)).toEqual(value);
    expect(fromDescriptor.message('refl.v1.Ping').byName.get('tags')?.map).toBeDefined();
  });

  it('lists services and calls methods through reflection v1', async () => {
    const reflect = target({ reflection: true, protoFiles: [] });
    const list = await grpcListServices(reflect, {});
    expect(list.services.map((s) => s.name)).toEqual(['refl.v1.Pinger']);
    expect(list.services[0]?.methods.map((m) => [m.name, m.serverStreaming])).toEqual([
      ['Ping', false],
      ['Watch', true],
    ]);
    expect(list.services[0]?.methods[0]?.example).toEqual({
      text: 'string',
      n: [0],
      tags: { string: 'string' },
      at: '1970-01-01T00:00:00Z',
      kind: 'KIND_UNSPECIFIED',
    });
    const result = await grpcCall(reflect, 'refl.v1.Pinger/Ping', [{ text: 'yo', kind: 1 }], {});
    expect(result.status).toBe(0);
    expect(result.responses[0]).toEqual({ text: 'yo', n: [], tags: {}, kind: 'LOUD' });
  });

  it('falls back to v1alpha', async () => {
    reflectionV1 = false;
    try {
      const list = await grpcListServices(target({ reflection: true, protoFiles: [] }), {});
      expect(list.services.map((s) => s.name)).toEqual(['refl.v1.Pinger']);
      expect(seenHeaders.some((h) => String(h[':path']).includes('v1alpha'))).toBe(true);
    } finally {
      reflectionV1 = true;
    }
  });

  it('throws when the method is not on the server', async () => {
    await expect(
      grpcCall(target({ reflection: true, protoFiles: [] }), 'nope.Svc/Do', [{}], {}),
    ).rejects.toThrow('Server reflection: not found');
  });
});

describe('gRPC protocol edge cases', () => {
  const get = (id: string, overrides: Partial<GrpcTarget> = {}) =>
    grpcCall(target(overrides), 'demo.v1.Items/Get', [{ id }], {});

  it('maps HTTP statuses, resets and missing statuses', async () => {
    const statuses = await Promise.all(
      ['http-400', 'http-401', 'http-403', 'http-404', 'http-503', 'http-500'].map((id) => get(id)),
    );
    expect(statuses.map((r) => [r.status, r.statusMessage])).toEqual([
      [13, 'HTTP 400'],
      [16, 'HTTP 401'],
      [7, 'HTTP 403'],
      [12, 'HTTP 404'],
      [14, 'HTTP 503'],
      [2, 'HTTP 500'],
    ]);
    expect((await get('http-200')).statusMessage).toBe(
      'Unexpected content-type "" (is this a gRPC server?)',
    );
    expect(await get('no-status')).toMatchObject({
      status: 2,
      statusMessage: 'The server ended the call without a grpc-status',
    });
    expect((await get('bad-status')).status).toBe(2);
    expect(await get('bad-message')).toMatchObject({ status: 3, statusMessage: '%E0%A4%A' });
    const { constants } = http2;
    const resets = await Promise.all(
      [
        constants.NGHTTP2_REFUSED_STREAM,
        constants.NGHTTP2_CANCEL,
        constants.NGHTTP2_ENHANCE_YOUR_CALM,
        constants.NGHTTP2_INADEQUATE_SECURITY,
        constants.NGHTTP2_PROTOCOL_ERROR,
      ].map((code) => get(`rst-${code}`)),
    );
    expect(resets.map((r) => r.status)).toEqual([14, 1, 8, 7, 13]);
    const quiet = await get(`rst-${constants.NGHTTP2_NO_ERROR}`);
    expect([2, 14]).toContain(quiet.status);
  });

  it('decompresses deflate, rejects unknown encodings and undecodable messages', async () => {
    expect((await get('deflate')).responses).toMatchObject([{ id: 'deflate' }]);
    expect(await get('nocodec')).toMatchObject({
      status: 13,
      statusMessage: 'Compressed message with unsupported grpc-encoding "identity"',
    });
    const garbage = await get('garbage');
    expect(garbage.status).toBe(13);
    expect(garbage.statusMessage).toMatch(/^Could not decode the response message: Truncated/);
    expect((await get('multi')).headers['x-multi']).toBe('a, b');
  });

  it('sends metadata as headers, protocol headers win', async () => {
    await grpcCall(
      target({
        timeoutMs: 2e8,
        metadata: [
          ['', 'x'],
          [':path', '/x'],
          ['te', 'x'],
          ['X-Multi', 'a'],
          ['x-multi', 'b'],
          ['x-multi', 'c'],
          ['user-agent', 'custom'],
          ['trace-bin', 'AAEC'],
        ],
      }),
      'demo.v1.Items/Get',
      [{ id: 'm' }],
      {},
    );
    const sent = seenHeaders.at(-1) ?? {};
    expect(sent).toMatchObject({
      ':path': '/demo.v1.Items/Get',
      te: 'trailers',
      'x-multi': 'a, b, c',
      'user-agent': 'custom',
      'trace-bin': 'AAEC',
      'grpc-timeout': '200000S',
    });
    await get('no-deadline', { timeoutMs: 0 });
    expect(seenHeaders.at(-1)?.['grpc-timeout']).toBeUndefined();
  });

  it('reports invalid client-streaming messages by position', async () => {
    await expect(
      grpcCall(target(), 'demo.v1.Items/Chat', [{ id: 'a' }, { nope: 1 }], {}),
    ).rejects.toThrow('Invalid request message #2: Unknown field "nope"');
  });

  it('connects with the URL host and default ports, through openSocket', async () => {
    const port = (server.address() as AddressInfo).port;
    const aliased = await grpcCall(
      target({ url: new URL(`grpcs://alias.test:${port}`) }),
      'demo.v1.Items/Get',
      [{ id: 'tls' }],
      {},
    );
    expect(aliased.status).toBeGreaterThanOrEqual(0);
    expect(sockets.opened.at(-1)).toEqual({ host: 'alias.test', port, tls: true, alpn: ['h2'] });
    await expect(get('x', { url: new URL('grpc://refuse.test') })).rejects.toThrow('ECONNREFUSED');
    expect(sockets.opened.at(-1)).toMatchObject({ port: 80, tls: false });
    await expect(get('x', { url: new URL('grpcs://[::1]') })).rejects.toThrow();
    expect(sockets.opened.at(-1)).toMatchObject({ host: '::1', port: 443, tls: true });
    await expect(get('x', { url: new URL('http://127.0.0.1') })).rejects.toThrow(
      'gRPC URLs start with grpc:// or grpcs:// (got http://)',
    );
  });

  it('times out or cancels while connecting', async () => {
    const hang = new URL('grpc://hang.test:1');
    expect(await get('x', { url: hang, timeoutMs: 50 })).toMatchObject({
      status: 4,
      statusMessage: 'Deadline exceeded',
    });
    const controller = new AbortController();
    controller.abort();
    const opened = sockets.opened.length;
    const cancelled = await grpcCall(target(), 'demo.v1.Items/Get', [{}], {
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ status: 1, statusMessage: 'Cancelled', messages: [] });
    expect(sockets.opened.length).toBe(opened);
    await expect(
      grpcListServices(target({ url: hang, reflection: true, timeoutMs: 50 }), {}),
    ).rejects.toThrow('Deadline exceeded while listing services');
  });

  it('fails cleanly when the server does not speak HTTP/2', async () => {
    const net = await import('node:net');
    const plain = net.createServer((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    try {
      const port = (plain.address() as AddressInfo).port;
      const result = await get('x', { url: new URL(`grpc://127.0.0.1:${port}`) });
      expect(result.status).toBe(13);
      expect(result.statusMessage).not.toBe('');
    } finally {
      plain.close();
    }
  });
});

describe('server reflection edge cases', () => {
  const reflect = (overrides: Partial<GrpcTarget> = {}) =>
    target({ reflection: true, protoFiles: [], ...overrides });

  it('fetches missing dependencies by file name', async () => {
    const result = await grpcCall(reflect(), '/dep.v1.Svc/Do', [{ size: '42' }], {});
    expect(result).toMatchObject({ status: 0, responses: [{ size: '42' }] });
  });

  it('fails when a dependency is neither served nor bundled', async () => {
    await expect(grpcCall(reflect(), 'broken.v1.Svc/Do', [{}], {})).rejects.toThrow(
      'Server reflection: not found (missing/dep.proto)',
    );
  });

  it('reports methods the descriptors do not have', async () => {
    await expect(grpcCall(reflect(), 'empty.v1.Svc/Do', [{}], {})).rejects.toThrow(
      'Method empty.v1.Svc/Do not found on the server (reflection)',
    );
  });

  it('reports servers without reflection', async () => {
    reflectionOn = false;
    try {
      await expect(grpcListServices(reflect(), {})).rejects.toThrow(
        'Server reflection is not available on this server',
      );
    } finally {
      reflectionOn = true;
    }
  });

  it('returns the deadline status when reflection is too slow', async () => {
    const slow = reflect({ timeoutMs: 100, metadata: [['x-slow', '1']] });
    expect(await grpcCall(slow, 'refl.v1.Pinger/Ping', [{}], {})).toMatchObject({ status: 4 });
    await expect(grpcListServices(slow, {})).rejects.toThrow(
      'Deadline exceeded while listing services',
    );
  });

  it('decodes descriptors with absent fields, groups, oneofs and options', () => {
    const file = decodeFileDescriptor(
      msg(
        [12, 'editions'],
        [
          4,
          msg(
            [1, 'M'],
            [8, msg([1, 'choice'])],
            [2, msg([1, 'bare'])],
            [2, msg([1, 'grp'], [3, 2], [5, 10])],
            [2, msg([1, 'c'], [3, 3], [4, 1], [5, 9], [9, 0], [10, 'cee'])],
            [2, msg([1, 'p'], [3, 4], [4, 3], [5, 5], [8, msg([2, 0])])],
            [2, msg([1, 'q'], [3, 5], [4, 3], [5, 5], [8, msg([1, 1])])],
            [2, msg([1, 'o'], [3, 6], [4, 1], [5, 9], [17, 1], [9, 0])],
            [7, msg([3, 1])],
          ),
        ],
        [5, msg([1, 'E'], [2, msg([1, 'ZERO'])])],
      ),
    );
    expect(file).toMatchObject({ name: '', package: '', syntax: 'editions', imports: [] });
    expect(file.enums[0]?.values).toEqual([{ name: 'ZERO', number: 0 }]);
    const fields = file.messages[0]?.fields ?? [];
    expect(file.messages[0]?.mapEntry).toBe(false);
    expect(fields.map((f) => f.name)).toEqual(['bare', 'c', 'p', 'q', 'o']);
    expect(fields[0]).toEqual({ name: 'bare', number: 0, type: '', label: 'optional' });
    expect(fields[1]).toMatchObject({ oneof: 'choice', jsonName: 'cee' });
    expect(fields[2]?.packed).toBe(false);
    expect(fields[3]).not.toHaveProperty('packed');
    expect(fields[4]).toMatchObject({ proto3Optional: true, oneof: 'choice' });
    expect(decodeFileDescriptor(msg([12, 'proto2'])).syntax).toBe('proto2');
    const message = file.messages[0] as RawMessage;
    const registry = buildRegistry([
      { ...file, messages: [{ ...message, fields: fields.slice(1) }] },
    ]);
    expect(registry.message('M').byName.get('o')).toMatchObject({ presence: true });
    expect(registry.message('M').byName.get('o')).not.toHaveProperty('oneof');
    expect(registry.message('M').byName.get('c')?.presence).toBe(true);
  });
});

const ALL_PROTO = `syntax = "proto3"; package all;
import "google/protobuf/wrappers.proto"; import "google/protobuf/any.proto";
import "google/protobuf/field_mask.proto"; import "google/protobuf/empty.proto";
import "google/protobuf/struct.proto"; import "google/protobuf/timestamp.proto";
import "google/protobuf/duration.proto";
enum Color { RED = 0; GREEN = 1; }
enum Odd { ODD_ONE = 1; }
enum Nothing {}
message All {
  double d = 1; float f = 2; int64 i64 = 3; uint64 u64 = 4; int32 i32 = 5; fixed64 f64 = 6;
  fixed32 f32 = 7; bool b = 8; string s = 9; bytes by = 10; uint32 u32 = 11; sfixed32 sf32 = 12;
  sfixed64 sf64 = 13; sint32 s32 = 14; sint64 s64 = 15;
  repeated double rd = 16; repeated float rf = 17; repeated fixed32 rf32 = 18;
  repeated sfixed64 rsf64 = 19; repeated bool rb = 20; repeated sint64 rs64 = 21;
  repeated Color rc = 22; repeated string rs = 23;
  map<bool, string> bools = 24; map<int64, All> nested = 25;
  map<string, google.protobuf.Value> values = 26;
  google.protobuf.Int32Value w32 = 27; google.protobuf.StringValue ws = 28;
  google.protobuf.BytesValue wb = 29; google.protobuf.Any any = 30;
  google.protobuf.FieldMask mask = 31; google.protobuf.Empty empty = 32;
  google.protobuf.Value value = 33; google.protobuf.ListValue list = 34;
  google.protobuf.NullValue null_value = 35; Odd odd = 36; Nothing nothing = 37;
  google.protobuf.Struct st = 38; google.protobuf.Timestamp ts = 39;
  google.protobuf.Duration du = 40; All child = 41;
}`;
const all = loadProtoFiles([{ name: 'all.proto', content: ALL_PROTO }]).registry;
const trip = (value: unknown): Record<string, unknown> =>
  decodeMessage(all, 'all.All', encodeMessage(all, 'all.All', value)) as Record<string, unknown>;

describe('codec: every scalar and well-known type', () => {
  it('round trips every scalar type at its limits', () => {
    const scalars = {
      d: -1.5,
      f: 1.5,
      i64: '-5',
      u64: '18446744073709551615',
      i32: -7,
      f64: '7',
      f32: 4294967295,
      b: true,
      s: 'é',
      by: 'AAEC',
      u32: 4294967295,
      sf32: -3,
      sf64: '-9',
      s32: -2147483648,
      s64: '-9223372036854775808',
    };
    expect(trip(scalars)).toMatchObject(scalars);
  });

  it('accepts strings for numbers and booleans, names or numbers for enums', () => {
    expect(
      trip({
        i32: '12',
        i64: '1e3',
        f: '1.5',
        d: 'NaN',
        rd: ['Infinity', '-Infinity', 2],
        rf: [0.1, 'NaN'],
        rf32: [1, 2],
        rsf64: ['-1'],
        b: 'true',
        rb: ['false', true],
        rc: ['GREEN', 0, '1'],
        rs64: ['-3', 4],
        rs: ['a', 'b'],
        odd: 7,
      }),
    ).toMatchObject({
      i32: 12,
      i64: '1000',
      f: 1.5,
      d: 'NaN',
      rd: ['Infinity', '-Infinity', 2],
      rf: [0.1, 'NaN'],
      rf32: [1, 2],
      rsf64: ['-1'],
      b: true,
      rb: [false, true],
      rc: ['GREEN', 'RED', 'GREEN'],
      rs64: ['-3', '4'],
      rs: ['a', 'b'],
      odd: 7,
    });
  });

  it('rejects values of the wrong type', () => {
    const bad: [unknown, string][] = [
      [{ s: 1 }, 'Invalid value 1 for string field s'],
      [{ by: 1 }, 'Invalid value 1 for bytes field by'],
      [{ b: 'yes' }, 'Invalid value "yes" for bool field b'],
      [{ d: 'abc' }, 'Invalid value "abc" for double field d'],
      [{ d: '' }, 'Invalid value "" for double field d'],
      [{ i32: 1.5 }, 'Invalid value 1.5 for int32 field i32'],
      [{ i32: 'abc' }, 'Invalid value "abc" for int32 field i32'],
      [{ i32: ' ' }, 'Invalid value " " for int32 field i32'],
      [{ u32: -1 }, 'Value -1 is out of range for field u32'],
      [{ s: 'x'.repeat(80).split('') }, ',...'],
      [{ rd: 'x' }, 'Field rd expects a JSON array'],
      [{ bools: [] }, 'Field bools expects a JSON object (map)'],
      [{ child: 'x' }, 'all.All expects a JSON object, got "x"'],
      [[1], 'all.All expects a JSON object, got [1]'],
      [
        { rc: [true] },
        'Invalid value true for enum field rc (all.Color); expected one of RED, GREEN',
      ],
      [{ value: Symbol('x') }, 'Invalid google.protobuf.Value'],
      [{ ts: 'yesterday' }, 'Invalid google.protobuf.Timestamp "yesterday"'],
      [{ ts: '2024-13-45T00:00:00Z' }, 'Invalid google.protobuf.Timestamp'],
      [{ du: '3m' }, 'Invalid google.protobuf.Duration "3m"'],
      [{ any: 'x' }, 'google.protobuf.Any expects an object with "@type"'],
      [{ any: {} }, 'google.protobuf.Any needs "@type"'],
      [{ any: { '@type': 'x/unknown.T' } }, 'Type unknown.T of google.protobuf.Any not found'],
    ];
    for (const [value, message] of bad) {
      expect(() => encodeMessage(all, 'all.All', value), JSON.stringify(String(value))).toThrow(
        message,
      );
    }
  });

  it('maps wrappers, Any, FieldMask, Empty, Struct, Value and ListValue', () => {
    const out = trip({
      w32: 5,
      ws: 'x',
      wb: 'AQ==',
      any: { '@type': 'type.googleapis.com/all.All', s: 'in' },
      mask: 'fooBar,baz',
      empty: {},
      value: { a: [1, 'x', true, null] },
      list: [1, 'a'],
      st: { k: { deep: null } },
      values: { n: null, b: false },
      null_value: null,
    });
    expect(out).toMatchObject({
      w32: 5,
      ws: 'x',
      wb: 'AQ==',
      any: { '@type': 'type.googleapis.com/all.All', s: 'in', i32: 0 },
      mask: 'fooBar,baz',
      empty: {},
      value: { a: [1, 'x', true, null] },
      list: [1, 'a'],
      st: { k: { deep: null } },
      values: { n: null, b: false },
      nullValue: null,
    });
    expect(trip({ w32: null, mask: '', value: 2 })).toMatchObject({ mask: '', value: 2 });
    expect(trip({ mask: { paths: ['a_b'] }, value: 's' })).toMatchObject({
      mask: 'aB',
      value: 's',
    });
    expect(
      trip({ any: { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '2s' } }),
    ).toMatchObject({
      any: { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '2s' },
    });
    expect(trip({ any: { '@type': 'x/unknown.T', value: 'AAE=' } })).toMatchObject({
      any: { '@type': 'x/unknown.T', value: 'AAE=' },
    });
    const emptyAny = new Writer()
      .tag(30, 2)
      .bytes(Buffer.alloc(0))
      .tag(33, 2)
      .bytes(Buffer.alloc(0));
    expect(decodeMessage(all, 'all.All', emptyAny.finish())).toMatchObject({
      any: {},
      value: null,
    });
  });

  it('maps timestamps, durations and their object forms', () => {
    expect(
      trip({
        ts: { seconds: '1', nanos: 5 },
        du: { seconds: '3' },
        child: { ts: '2024-01-01 00:00:00.123456z', du: '-1.000000001s' },
      }),
    ).toMatchObject({
      ts: '1970-01-01T00:00:01.000000005Z',
      du: '3s',
      child: { ts: '2024-01-01T00:00:00.123456Z', du: '-1.000000001s' },
    });
  });

  it('writes defaults: first enum value, 0 for empty enums, null for NullValue', () => {
    expect(decodeMessage(all, 'all.All', Buffer.alloc(0))).toMatchObject({
      odd: 'ODD_ONE',
      nothing: 0,
      nullValue: null,
      rs: [],
      bools: {},
      by: '',
      u64: '0',
    });
  });

  it('decodes maps with bool, int64 keys and missing message values', () => {
    expect(
      trip({ bools: { true: 'y', false: 'n' }, nested: { '-1': null, 2: { s: 'x' } } }),
    ).toMatchObject({
      bools: { true: 'y', false: 'n' },
      nested: { '-1': { s: '' }, '2': { s: 'x' } },
    });
  });

  it('skips unknown fields and fields with an unexpected wire type, merges and clears', () => {
    const bytes = new Writer()
      .tag(90, 1)
      .raw(Buffer.alloc(8))
      .tag(91, 5)
      .raw(Buffer.alloc(4))
      .tag(92, 3)
      .tag(1, 0)
      .varint(1)
      .tag(92, 4)
      .tag(9, 0)
      .varint(1)
      .tag(41, 0)
      .varint(1)
      .tag(24, 0)
      .varint(1)
      .tag(41, 2)
      .bytes(encodeMessage(all, 'all.All', { s: 'a' }))
      .tag(41, 2)
      .bytes(encodeMessage(all, 'all.All', { i32: 2 }))
      .finish();
    expect(decodeMessage(all, 'all.All', bytes)).toMatchObject({
      s: '',
      child: { s: 'a', i32: 2 },
    });
    const nested = encodeMessage(items, 'demo.v1.Item.Nested', { val: 1 });
    const nameThenNested = new Writer().tag(12, 2).string('n').tag(13, 2).bytes(nested).finish();
    const nestedThenName = new Writer().tag(13, 2).bytes(nested).tag(12, 2).string('n').finish();
    expect(decodeMessage(items, 'demo.v1.Item', nameThenNested)).toMatchObject({
      nested: { val: 1 },
    });
    expect(decodeMessage(items, 'demo.v1.Item', nameThenNested)).not.toHaveProperty('name');
    expect(decodeMessage(items, 'demo.v1.Item', nestedThenName)).toMatchObject({ name: 'n' });
    expect(decodeMessage(items, 'demo.v1.Item', nestedThenName)).not.toHaveProperty('nested');
  });

  it('rejects malformed binary messages', () => {
    const decode = (bytes: number[]) => () => decodeMessage(all, 'all.All', Buffer.from(bytes));
    expect(decode([0x08, 0x80])).toThrow('Truncated protobuf message');
    expect(decode([0x08, ...Array<number>(11).fill(0xff)])).toThrow('Malformed varint');
    expect(decode([0x4a, 0x05, 0x61])).toThrow('Truncated protobuf message');
    expect(decode([0xe3, 0x05, 0xec, 0x05])).toThrow('Mismatched protobuf group');
    expect(decode([0xe7, 0x05])).toThrow('Invalid protobuf wire type 7');
    const withFixed = Buffer.concat([
      msg([1, 'x.proto']),
      new Writer().tag(99, 5).raw(Buffer.alloc(4)).finish(),
    ]);
    expect(decodeFileDescriptor(withFixed).name).toBe('x.proto');
  });

  it('builds examples for every type, cutting recursion at depth 3', () => {
    const example = exampleMessage(all, 'all.All') as Record<string, unknown>;
    expect(example).toMatchObject({
      d: 0,
      i64: '0',
      b: false,
      s: 'string',
      by: 'Ynl0ZXM=',
      rc: ['RED'],
      bools: { false: 'string' },
      values: { string: null },
      nothing: 0,
      nullValue: null,
      any: { '@type': 'type.googleapis.com/google.protobuf.Empty' },
    });
    const depth = (value: unknown): number =>
      value && typeof value === 'object' && 'child' in value ? 1 + depth(value.child) : 0;
    expect(depth(example)).toBe(4);
    expect(() => encodeMessage(all, 'all.All', example)).not.toThrow();
  });
});

describe('proto parser details', () => {
  it('reads options, escapes, groups, extensions and streaming flags', () => {
    const file = parseProto(
      'ex.proto',
      `/* header
          comment */ syntax = "proto2";
      package ex;
      import weak 'esc\\x41\\101\\u0042\\n\\q' ".proto";
      option java_package = "a" "b";
      option (my.opt) = { nested: { a: 1 } };
      extend google.protobuf.FieldOptions { optional string x = 5000; }
      enum Top { option allow_alias = true; reserved 5; ; NEG = -1; ZERO = 0x0; OCT = 010 [deprecated = true]; }
      message M {
        ;
        option deprecated = true;
        extensions 100 to max;
        extend Other { optional int32 y = 101; }
        optional group G = 1 [deprecated = true] { optional int32 a = 2; }
        repeated group H = 3 { }
        map<string, Top> my_map = 4 [json_name = "mm"];
        map<int32, string> plain = 5;
        oneof o { option (x) = 1; ; string s = 6; int32 i = 7 [(custom).sub = -2, (c) = { a: 1 }]; }
        optional string str = 8 [default = "a" "b", json_name = 'j'];
        required double d = 9 [default = -inf];
        optional float f = 10 [default = .5];
        repeated int32 e = 11 [packed = false];
      }
      service S {
        option deprecated = true;
        ;
        rpc A (M) returns (stream .ex.M) { option deprecated = true; };
        rpc B (stream M) returns (M) {}
      }
      /* never closed`,
    );
    expect(file.imports).toEqual(['escAAB\nq.proto']);
    expect(file.enums[0]?.values).toEqual([
      { name: 'NEG', number: -1 },
      { name: 'ZERO', number: 0 },
      { name: 'OCT', number: 8 },
    ]);
    const message = file.messages[0];
    expect(message?.messages.map((m) => m.name)).toEqual(['MyMapEntry', 'PlainEntry']);
    expect(message?.fields.map((f) => [f.name, f.jsonName, f.label, f.oneof])).toEqual([
      ['my_map', 'mm', 'repeated', undefined],
      ['plain', undefined, 'repeated', undefined],
      ['s', undefined, undefined, 'o'],
      ['i', undefined, undefined, 'o'],
      ['str', 'j', 'optional', undefined],
      ['d', undefined, 'required', undefined],
      ['f', undefined, 'optional', undefined],
      ['e', undefined, 'repeated', undefined],
    ]);
    expect(file.services[0]?.methods).toEqual([
      { name: 'A', input: 'M', output: '.ex.M', clientStreaming: false, serverStreaming: true },
      { name: 'B', input: 'M', output: 'M', clientStreaming: true, serverStreaming: false },
    ]);
    expect(parseProto('e.proto', 'edition = "2023";').syntax).toBe('editions');
    expect(parseProto('o.proto', 'syntax = "proto4";').syntax).toBe('proto2');
  });

  it('skips a stray top-level semicolon and a field option with a nested aggregate value', () => {
    expect(() => parseProto('s.proto', 'syntax = "proto3";\n;\nmessage M {}')).not.toThrow();
    const file = parseProto(
      'opt.proto',
      'syntax = "proto3"; message M { int32 a = 1 [(opt) = { a: { b: 1 } }]; }',
    );
    expect(file.messages[0]?.fields[0]).toMatchObject({ name: 'a', number: 1 });
  });

  it('reports syntax errors with the file and line', () => {
    const errors: [string, string][] = [
      ['syntax = 3;', 'p.proto:1: expected a string, got "3"'],
      ['message 1 {}', 'expected a name, got "1"'],
      ['message M { int32 a = b; }', 'expected a number, got "b"'],
      ['message M { int32 a = 1.5; }', 'expected an integer, got "1.5"'],
      ['message M {\n int32 a = 1 }', 'p.proto:2: expected ";", got "}"'],
      ['bogus;', 'unexpected "bogus"'],
      ['. ;', 'unexpected "."'],
      ['service S { foo; }', 'unexpected "foo" in service S'],
      ['message M {', 'p.proto: unexpected end of file'],
      ['import "unterminated', 'p.proto:1: unterminated string'],
      ['import "broken\n";', 'unterminated string'],
    ];
    for (const [source, message] of errors) {
      expect(() => parseProto('p.proto', source), source).toThrow(message);
    }
    expect(builtinProto('nope.proto')).toBeUndefined();
  });

  it('resolves imports by name, relative path and suffix', () => {
    const files: ProtoFile[] = [
      {
        name: './dir/a.proto',
        content:
          'syntax = "proto3"; import "b.proto"; import "y/c.proto"; message A { B b = 1; C c = 2; }',
      },
      { name: 'dir\\b.proto', content: 'syntax = "proto3"; import "x/y/c.proto"; message B {}' },
      { name: 'x/y/c.proto', content: 'syntax = "proto3"; message C {}' },
    ];
    const loaded = loadProtoFiles(files, 'dir/a.proto');
    expect(loaded.entry).toBe('dir/a.proto');
    expect(loaded.registry.message('A').byName.get('c')?.type).toBe('C');
    expect(() => loadProtoFiles(files, 'nope.proto')).toThrow('Proto file "nope.proto" not found');
  });

  it('keeps the first definition and checks names and method types', () => {
    const file = (name: string, content: string) =>
      parseProto(name, `syntax = "proto3"; ${content}`);
    const registry = buildRegistry([
      file(
        '1.proto',
        'package p; message M { int32 a = 1; } enum E { X = 0; } service S { rpc A(M) returns (M); }',
      ),
      file(
        '2.proto',
        'package p; message M { int32 b = 1; } enum E { Y = 0; } service S { rpc B(M) returns (M); }',
      ),
    ]);
    expect(registry.message('p.M').fields.map((f) => f.name)).toEqual(['a']);
    expect(registry.enum('p.E').values[0]?.name).toBe('X');
    expect(registry.services.get('p.S')?.methods.map((m) => m.name)).toEqual(['A']);
    expect(registry.method('p.S/Nope')).toBeUndefined();
    expect(() => registry.message('p.Nope')).toThrow('Message type p.Nope not found');
    expect(() => registry.enum('p.Nope')).toThrow('Enum type p.Nope not found');
    expect(() =>
      buildRegistry([
        file('3.proto', 'enum E { Z = 0; } message M {} service S { rpc A(E) returns (M); }'),
      ]),
    ).toThrow('S/A must take and return message types');
    expect(() =>
      buildRegistry([
        file('3.proto', 'message M {} service S { rpc A(M) returns (E); } enum E { Z = 0; }'),
      ]),
    ).toThrow('S/A must take and return message types');
    expect(() => buildRegistry([file('4.proto', 'message M { .nope.X x = 1; }')])).toThrow(
      'Type ".nope.X" not found (used by M.x)',
    );
  });
});

describe('gRPC client details', () => {
  it('lists only the entry file services and sends {} for unary calls without a message', async () => {
    const list = await grpcListServices(target({ protoFile: 'demo/v1/items.proto' }), {});
    expect(list.services.map((s) => s.name)).toEqual(['demo.v1.Items']);
    const result = await grpcCall(target(), 'demo.v1.Items/Get', [], {});
    expect(result.messages[0]?.data).toBe('{}');
    expect(result.responses).toMatchObject([{ id: '' }]);
  });

  it('reassembles messages split across data frames', async () => {
    const result = await grpcCall(target(), 'demo.v1.Items/Get', [{ id: 'split' }], {});
    expect(result.responses).toMatchObject([{ id: 'split' }]);
  });

  it('rethrows connection failures while listing services', async () => {
    await expect(
      grpcListServices(target({ reflection: true, url: new URL('grpc://refuse.test:1') }), {}),
    ).rejects.toThrow('ECONNREFUSED');
  });
});
