import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/** A server listening on an ephemeral port, with the address to point a request at. */
export interface TestServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function close(server: http.Server | net.Server | http2.Http2Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function listening(server: http.Server | net.Server | http2.Http2Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** An unmasked server frame; `opcode` 1 is text, 8 close. */
function serverFrame(opcode: number, data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }
  const header = Buffer.from([0x80 | opcode, 126, 0, 0]);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** Reads the client's masked frames out of `buffer`, leaving any partial frame in `rest`. */
function clientFrames(buffer: Buffer): {
  frames: { opcode: number; payload: Buffer }[];
  rest: Buffer;
} {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let data = buffer;
  for (;;) {
    if (data.length < 2) break;
    let length = data[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (data.length < 4) break;
      length = data.readUInt16BE(2);
      offset = 4;
    }
    if (data.length < offset + 4 + length) break;
    const mask = data.subarray(offset, offset + 4);
    const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < length; index++) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
    frames.push({ opcode: data[0]! & 0x0f, payload });
    data = data.subarray(offset + 4 + length);
  }
  return { frames, rest: data };
}

/**
 * A WebSocket server that echoes every text frame back, answers a close frame with a close
 * frame, and reports the subprotocol it was asked for in a first message.
 */
export async function websocketServer(): Promise<TestServer> {
  const server = http.createServer();
  server.on('upgrade', (request, socket: Duplex) => {
    socket.on('error', () => {});
    const key = String(request.headers['sec-websocket-key']);
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    const protocol = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')[0]
      ?.trim();
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
        '',
        '',
      ].join('\r\n'),
    );
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = clientFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const { opcode, payload } of frames) {
        if (opcode === 8) socket.end(serverFrame(8, payload));
        else socket.write(serverFrame(1, payload));
      }
    });
  });
  const port = await listening(server);
  return { url: `ws://127.0.0.1:${port}/`, port, close: () => close(server) };
}

/** An SSE server that sends `events` and then keeps the stream open. */
export async function sseServer(
  events: readonly string[] = ['data: {"n":1}\n\n', 'data: {"n":2}\n\n'],
): Promise<TestServer & { bodies: string[] }> {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-stream': 'yes' });
      for (const event of events) response.write(event);
    });
  });
  const port = await listening(server);
  return { url: `http://127.0.0.1:${port}/`, port, bodies, close: () => close(server) };
}

/** What an echo server saw, in the order the requests arrived. */
export interface EchoRecord {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * An HTTP server that echoes what it received as JSON and answers with `headers` — raw pairs,
 * so repeated names (`set-cookie`) arrive repeated.
 */
export async function echoServer(
  headers: readonly (readonly [string, string])[] = [],
): Promise<TestServer & { seen: EchoRecord[] }> {
  const seen: EchoRecord[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({
        method: String(request.method),
        url: String(request.url),
        headers: request.headers,
        body,
      });
      const payload = JSON.stringify({ method: request.method, url: request.url, body });
      response.writeHead(200, [
        'content-type',
        'application/json',
        'x-content-type-options',
        'nosniff',
        ...headers.flatMap(([key, value]) => [key, value]),
      ]);
      response.end(payload);
    });
  });
  const port = await listening(server);
  return { url: `http://127.0.0.1:${port}/`, port, seen, close: () => close(server) };
}

/**
 * A WebSocket server that completes the handshake and then resets the connection (a TCP RST),
 * so the client's socket reports an 'error' instead of a clean close.
 */
export async function resettingWebsocketServer(): Promise<TestServer> {
  const server = http.createServer();
  server.on('upgrade', (request, socket: Duplex) => {
    socket.on('error', () => {});
    const key = String(request.headers['sec-websocket-key']);
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    // Give the client a moment to parse the 101 reply and start listening before the reset.
    setTimeout(() => (socket as net.Socket & { resetAndDestroy(): void }).resetAndDestroy(), 50);
  });
  const port = await listening(server);
  return { url: `ws://127.0.0.1:${port}/`, port, close: () => close(server) };
}

/** An OAuth2 token endpoint answering every request with the same access token. */
export async function tokenServer(
  token = 'issued-token',
): Promise<TestServer & { seen: EchoRecord[] }> {
  const seen: EchoRecord[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: String(request.method),
        url: String(request.url),
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
    });
  });
  const port = await listening(server);
  return { url: `http://127.0.0.1:${port}/token`, port, seen, close: () => close(server) };
}

/** An HTTP server that redirects `/from` to `/to` once, then echoes. */
export async function redirectServer(): Promise<TestServer> {
  const server = http.createServer((request, response) => {
    if (request.url === '/from') {
      response.writeHead(302, { location: '/to' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"arrived":true}');
  });
  const port = await listening(server);
  return { url: `http://127.0.0.1:${port}/from`, port, close: () => close(server) };
}

/** One proto source defining `demo.v1.Greeter/Say`, with a single string field each way. */
export const GREETER_PROTO = [
  'syntax = "proto3";',
  'package demo.v1;',
  'message Ping { string id = 1; }',
  'message Pong { string id = 1; }',
  'service Greeter { rpc Say(Ping) returns (Pong); }',
].join('\n');

/** A length-prefixed gRPC frame around `payload`. */
function grpcFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** `Pong { id }` on the wire: field 1, length-delimited. */
function pong(id: string): Buffer {
  const value = Buffer.from(id);
  return Buffer.concat([Buffer.from([0x0a, value.length]), value]);
}

/**
 * A plaintext gRPC server answering `demo.v1.Greeter/Say` with one `Pong` per request message,
 * plus a header and a trailer of its own so a result carries both.
 */
export async function grpcServer(
  replies: readonly string[] = ['hi'],
): Promise<TestServer & { paths: string[]; metadata: http2.IncomingHttpHeaders[] }> {
  const paths: string[] = [];
  const metadata: http2.IncomingHttpHeaders[] = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    paths.push(String(headers[':path']));
    metadata.push(headers);
    stream.on('data', () => {});
    stream.on('end', () => {
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc', 'x-served-by': 'adk-test' },
        { waitForTrailers: true },
      );
      stream.once('wantTrailers', () =>
        stream.sendTrailers({ 'grpc-status': '0', 'x-trailer': 'done' }),
      );
      for (const reply of replies) stream.write(grpcFrame(pong(reply)));
      stream.end();
    });
  });
  const port = await listening(server);
  return {
    url: `grpc://127.0.0.1:${port}`,
    port,
    paths,
    metadata,
    close: () => close(server),
  };
}

/** A TCP server that answers every chunk it receives with `reply(text)`. */
export async function socketServer(
  reply: (text: string) => string = (text) => `echo:${text}`,
): Promise<TestServer> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => socket.write(reply(chunk.toString())));
  });
  const port = await listening(server);
  return { url: `tcp://127.0.0.1:${port}`, port, close: () => close(server) };
}
