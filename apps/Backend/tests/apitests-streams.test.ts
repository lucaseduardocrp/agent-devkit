import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetworkOptions } from '../src/modules/apitests/engine/http-transport.js';
import {
  SseParser,
  encodeClientFrame,
  socketExchange,
  sseExchange,
  websocketExchange,
} from '../src/modules/apitests/engine/stream-clients.js';

// Self-signed localhost / 127.0.0.1 test certificate (valid until 2126), test only.
const TEST_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDJzCCAg+gAwIBAgIUf5x7cInjBKpMcamNKInn0H92V6MwDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyOTExMDkxMFoYDzIxMjYx',
  'MDA1MTEwOTEwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB',
  'AQUAA4IBDwAwggEKAoIBAQDLqYA5czZCjU3/b75pSx788wBlYlx+kVWcO5D3T/S+',
  'BwuBWpHHSa3db/OQZy0JDEG5pHMwELUdJHTpkUkXVkIy2H2dD2rKy7/QoS7Ft8bq',
  'CG0Bzkpj/zA1pVifCOyaAoYdOkHXEn+F25w92pjG10izLLlbAdRo3YDxJhlpBuyO',
  'LuUvrQf4XvAdj+wlvHHivsPAEWLK4IDukAbeCfPluLPBcyg87dbMVTEY+fXmfqZ/',
  'AdGD07LIqRNP4JP9gtzTq75u0Eh5kBfdzIosUdmB/dh3gglmdceiIeiFrATPdiyw',
  'WCPseuMg1D5LQJm8bJ9BlDMt4VhHzjKgC3cgaMN1r2L7AgMBAAGjbzBtMB0GA1Ud',
  'DgQWBBSXzD2cbyQ4MViT662sBkyTMevQgjAfBgNVHSMEGDAWgBSXzD2cbyQ4MViT',
  '662sBkyTMevQgjAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z',
  'dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEApN/piQmCXgZJA9TYcB6lOawXHtIs',
  'vZz1zfZqH13uyZ+pTbbYaXWNpHGnh6KsrMbgTSuK/T2E23eE8rnX66WsC9sKmGt1',
  'bXNlaw8ozVc07hXQd7I4JC7m5cVWR6BmnBPm5Yp477viMrdoGxL204KH+qxODhNV',
  'JBQ0n5fc89Xn4VfUlBJPR61qg8FaYOb5d1fGLyRG6Mm2vPrxO3HGu6iPkSYLJJpY',
  'cLtuqIYSbLRjXoVHDtTrYUMYjoKHvTFDenH53t3F5OFdq5M9mNU786RvLfTEk46K',
  'u/gip6WRHsLCgIVgIBmw+JSIccMWJYIglyP9bKzGI+IPMGnKPb4mXTfDRQ==',
  '-----END CERTIFICATE-----',
].join('\n');
const TEST_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDLqYA5czZCjU3/',
  'b75pSx788wBlYlx+kVWcO5D3T/S+BwuBWpHHSa3db/OQZy0JDEG5pHMwELUdJHTp',
  'kUkXVkIy2H2dD2rKy7/QoS7Ft8bqCG0Bzkpj/zA1pVifCOyaAoYdOkHXEn+F25w9',
  '2pjG10izLLlbAdRo3YDxJhlpBuyOLuUvrQf4XvAdj+wlvHHivsPAEWLK4IDukAbe',
  'CfPluLPBcyg87dbMVTEY+fXmfqZ/AdGD07LIqRNP4JP9gtzTq75u0Eh5kBfdzIos',
  'UdmB/dh3gglmdceiIeiFrATPdiywWCPseuMg1D5LQJm8bJ9BlDMt4VhHzjKgC3cg',
  'aMN1r2L7AgMBAAECggEAE42OdfWNvA388w0zZsCDlR1vaExtPOmPIpTFcjkG8keS',
  '3zRm0o9MVfotlCuTs06t8LjNJkw0VzvszY/ZSJhLer42MSINyrKNE+alqu3d9xIg',
  'BRBdLASQCFZ7j6k3rgGYBq5VK+TmwV84POgDyvNYU3tzwD0Iu5iojH5v6hl0FKJY',
  'EizHrLUY0c1GpcUxXMpR+EjLbDGI+MC5DLndYGavoja3gMAu3CXfestY9oiCTZ23',
  '9T2GhrMb60dZwclLY/TMbTyYLF2Y5ASOcC7MZ1Ul6rsfHoqZUpXr/9yQvfamPYg9',
  'O1P8TLNGtQQCNFCCwfWF0LwfNG6g1rIzqaIdyBMawQKBgQDvRjHvHPc7/6tidkev',
  'UdvjYd6mmcbV4Y3E6E/FDkaZt81ONXOJoUy071LTDFk8FGo3mkVd8K5OZtUcP2e4',
  'HV9YRhtpsEQuGvByezu5iY8WwGWXm/ck65ihSZn2VUWYMdw9VsTfgqgQfTbAVIb/',
  'RX6zGurC4oI95mIMSDDob0j1uQKBgQDZ5gdPJ2BRX+HqZUAQxCoMCm8gPZe/yg0W',
  'nELN6lJdYMjFtSQPzJxGGpCv4G7xaM0UqlmccWIBrikLof1QHU8mcT/2BR16s9QE',
  'ns77GmIspQEHH93ZBallmHzLKQEMwZjrfBw75nL/aQZ2mw01xgpxVcXsxJdrJpQA',
  'akrCCSF4UwKBgQDJ1km67ZE0gHge562Sm5fEGEPL/331331Kc7kOfftaIezCo14h',
  '4/mjyxnvw8PmZUYwPydyldtDcYUlferNKaHLAeCP58urpLfdqkx4NyyHwaYxHLR+',
  '5Wnr6/0/CTFar/yblX0fGcURm746wVLbNNEq3nLYEGBTPOrKd38iIvXFqQKBgQDH',
  'PjU0xZanEfurrwWTzyt7cxcF7gwSTRkGsb/MNhU2WUd8sRPWdov29leS2q/XgrLz',
  '0Ii8KlkpnCzf/DF6zjIPvsJznV3FUyXtS6GLriZTGFYGQ7dBuJGa2oJR6p6RIX1I',
  '5mWSyDgjH8/PKBw+LWZjF8ExrNmgGth+QLM3Fc5LDQKBgDSgIRJGMGVuLRQXFkja',
  'KoyeZw+OYvtJeHGZOdITNcfXTkVl+B8AGT6FdVfmdCWx4lDFqiSAYjQbYG9HR1k8',
  'wXnEWi0w0x7ejb/qtYcbcE+rLIEIQeMlsjop6SmnXXBH2a/z+lsiv+RUzb6T5LDw',
  'kgp1xNXeOhSS4Ojm/m2IYJKO',
  '-----END PRIVATE KEY-----',
].join('\n');

const local: NetworkOptions = {
  connectHost: (host) => (host === 'localhost' ? '127.0.0.1' : host),
};
const servers: { close(): unknown }[] = [];

const listen = async (server: net.Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

afterAll(() => {
  for (const server of servers) server.close();
});

// --- Minimal WebSocket server side (unmasked frames) -----------------------------------------

function serverFrame(opcode: number, payload: Buffer | string, fin = true): Buffer {
  const data = Buffer.from(payload);
  const first = (fin ? 0x80 : 0) | opcode;
  if (data.length < 126) return Buffer.concat([Buffer.from([first, data.length]), data]);
  if (data.length < 65536) {
    return Buffer.concat([Buffer.from([first, 126, data.length >> 8, data.length & 255]), data]);
  }
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(data.length));
  return Buffer.concat([Buffer.from([first, 127]), length, data]);
}

/** Splits the client's (masked) frames out of `buffer`. */
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
    } else if (length === 127) {
      if (data.length < 10) break;
      length = Number(data.readBigUInt64BE(2));
      offset = 10;
    }
    if (data.length < offset + 4 + length) break;
    const mask = data.subarray(offset, offset + 4);
    const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < length; index++)
      payload[index] = payload[index]! ^ mask[index % 4]!;
    frames.push({ opcode: data[0]! & 0x0f, payload });
    data = data.subarray(offset + 4 + length);
  }
  return { frames, rest: data };
}

const upgrades: http.IncomingHttpHeaders[] = [];

/** Answers the client's frames: echo, close echo, pong report, fragments on demand. */
function answerFrames(socket: Duplex) {
  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    const { frames, rest } = clientFrames(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const { opcode, payload } of frames) {
      if (opcode === 8) {
        socket.end(serverFrame(8, payload));
      } else if (opcode === 10) {
        socket.write(serverFrame(1, `pong:${payload.toString()}`));
      } else if (payload.toString() === 'frag') {
        socket.write(
          Buffer.concat([
            serverFrame(1, 'ab', false),
            serverFrame(0, 'c', false),
            serverFrame(0, 'd'),
          ]),
        );
      } else if (payload.toString() === 'never-close') {
        // Ignores our close frame from now on.
        socket.removeAllListeners('data');
      } else {
        socket.write(serverFrame(opcode, payload));
      }
    }
  });
}

/** Writes `parts` one by one with pauses, so the client parses partial frames. */
async function inParts(socket: Duplex, parts: readonly Buffer[]): Promise<void> {
  (socket as net.Socket).setNoDelay?.(true);
  for (const part of parts) {
    socket.write(part);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function onUpgrade(req: http.IncomingMessage, socket: Duplex): void {
  socket.on('error', () => {});
  const path = req.url ?? '/';
  upgrades.push(req.headers);
  const raw: Record<string, string> = {
    '/reject': 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n',
    '/noreason': 'HTTP/1.1 400\r\n\r\n',
    '/garbage': 'nonsense\r\n\r\n',
  };
  if (raw[path]) {
    socket.end(raw[path]);
    return;
  }
  if (path === '/silent') return;
  const key = String(req.headers['sec-websocket-key']);
  const accept =
    path === '/badaccept'
      ? 'wrong'
      : createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  const protocol = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')[0]
    ?.trim();
  const head = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    '',
    '',
  ].join('\r\n');
  // Frames written with the head land in the client's handshake read: they must not be lost.
  const greeting: Record<string, Buffer> = {
    '/greet': serverFrame(1, 'hello'),
    '/ping': serverFrame(9, 'p'),
    '/pong': serverFrame(10, 'unsolicited'),
    '/closefirst': serverFrame(8, Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from('bye')])),
    '/closeempty': serverFrame(8, ''),
    '/badop': serverFrame(3, 'x'),
    // Announces a 32 MB message: refused before it is buffered.
    '/huge': Buffer.from([0x82, 127, 0, 0, 0, 0, 2, 0, 0, 0]),
    '/masked': Buffer.from([0x81, 0x82, 1, 2, 3, 4, 'o'.charCodeAt(0) ^ 1, 'k'.charCodeAt(0) ^ 2]),
  };
  socket.write(Buffer.concat([Buffer.from(head), greeting[path] ?? Buffer.alloc(0)]));
  if (path === '/drop') {
    setTimeout(() => socket.destroy(), 30);
    return;
  }
  if (path === '/split') {
    // A 16-bit and a 64-bit length frame, each cut inside its length field.
    const medium = serverFrame(1, 'm'.repeat(200));
    const large = serverFrame(2, Buffer.alloc(70_000, 1));
    void inParts(socket, [
      medium.subarray(0, 3),
      medium.subarray(3),
      large.subarray(0, 5),
      large.subarray(5),
    ]);
  }
  answerFrames(socket);
}

let wsBase = '';
let wssBase = '';

beforeAll(async () => {
  const server = http.createServer((_req, res) => res.end('plain'));
  server.on('upgrade', onUpgrade);
  wsBase = `ws://127.0.0.1:${await listen(server)}`;
  const secure = https.createServer({ cert: TEST_CERT, key: TEST_KEY });
  secure.on('upgrade', onUpgrade);
  wssBase = `wss://localhost:${await listen(secure)}`;
});

const ws = (path: string, extra: Partial<Parameters<typeof websocketExchange>[0]> = {}) => ({
  url: new URL(path, wsBase),
  headers: [] as [string, string][],
  messages: [],
  listenMs: 50,
  timeoutMs: 3000,
  ...extra,
});

describe('websocketExchange', () => {
  it('exchanges text, JSON and binary messages and closes with 1000', async () => {
    const big = Buffer.alloc(70_000, 7).toString('base64');
    const result = await websocketExchange(
      ws('/echo', {
        headers: [
          ['x-trace', 'abc'],
          ['Host', 'ignored'],
        ],
        subprotocols: ['chat', 'json'],
        messages: [
          { content: 'hi' },
          { content: '{"a":1}', type: 'json', delayMs: 10 },
          { content: Buffer.from([1, 2, 3]).toString('base64'), type: 'binary' },
          { content: 'x'.repeat(300) },
          { content: big, type: 'binary' },
          { content: 'frag' },
        ],
        listenMs: 300,
        maxMessages: 6,
      }),
      local,
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(101);
    expect(result.statusText).toBe('Switching Protocols');
    expect(result.closeCode).toBe(1000);
    expect(result.remoteAddress).toBe('127.0.0.1');
    expect(result.timings?.firstByte).toBeDefined();
    const last = upgrades.at(-1)!;
    expect(last['x-trace']).toBe('abc');
    expect(last.host).toBe(new URL(wsBase).host);
    expect(last['sec-websocket-protocol']).toBe('chat, json');
    const received = result.messages.filter((message) => message.direction === 'received');
    expect(received.map((message) => message.data)).toEqual([
      'hi',
      '{"a":1}',
      'AQID',
      'x'.repeat(300),
      big,
      'abcd',
    ]);
    expect(received[2]?.type).toBe('binary');
    const sent = result.messages.filter((message) => message.direction === 'sent');
    expect(sent.map((message) => message.type)).toEqual([
      'text',
      'json',
      'binary',
      'text',
      'binary',
      'text',
    ]);
    const info = result.messages.filter((message) => message.direction === 'info');
    expect(info[0]?.data).toBe(`Connected to ${wsBase}/echo (chat)`);
    expect(info[1]?.data).toBe('Closed 1000');
  });

  it('keeps frames sent right after the handshake and answers pings', async () => {
    const greet = await websocketExchange(ws('/greet'), local);
    expect(greet.messages.find((message) => message.direction === 'received')?.data).toBe('hello');
    const ping = await websocketExchange(ws('/ping'), local);
    expect(ping.messages.find((message) => message.direction === 'received')?.data).toBe('pong:p');
    const masked = await websocketExchange(ws('/masked'), local);
    expect(masked.messages.find((message) => message.direction === 'received')?.data).toBe('ok');
  });

  it('records the close of the server', async () => {
    const result = await websocketExchange(
      ws('/closefirst', { messages: [{ content: 'late', delayMs: 50 }], listenMs: 1000 }),
      local,
    );
    expect(result).toMatchObject({ closeCode: 4000, closeReason: 'bye' });
    expect(result.messages.some((message) => message.direction === 'sent')).toBe(false);
    expect(result.messages.at(-1)?.data).toBe('Closed 4000 bye');
    const empty = await websocketExchange(ws('/closeempty'), local);
    expect(empty.closeCode).toBe(1005);
    const dropped = await websocketExchange(ws('/drop', { listenMs: 1000 }), local);
    expect(dropped.closeCode).toBe(1006);
    expect(dropped.messages.at(-1)?.data).toBe('Connection closed without a close frame (1006)');
  });

  it('closes on protocol errors', async () => {
    const unknown = await websocketExchange(ws('/badop', { listenMs: 1000 }), local);
    expect(unknown.closeCode).toBe(1002);
    const huge = await websocketExchange(ws('/huge', { listenMs: 1000 }), local);
    expect(huge.closeCode).toBe(1009);
  });

  it('gives up waiting for the close reply after a grace period', async () => {
    const result = await websocketExchange(
      ws('/echo', { messages: [{ content: 'never-close' }] }),
      local,
    );
    expect(result.closeCode).toBe(1006);
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
  });

  it('reports rejected handshakes', async () => {
    const rejected = await websocketExchange(ws('/reject'), local);
    expect(rejected).toMatchObject({
      status: 403,
      error: 'WebSocket handshake rejected: HTTP 403 Forbidden',
    });
    const bad = await websocketExchange(ws('/badaccept'), local);
    expect(bad.error).toBe('WebSocket handshake failed: invalid Sec-WebSocket-Accept');
    const scheme = await websocketExchange(ws('/x', { url: new URL('http://127.0.0.1/') }), local);
    expect(scheme).toMatchObject({
      status: null,
      error: 'WebSocket URLs start with ws:// or wss://',
    });
  });

  it('times out, aborts and applies the guard', async () => {
    const silent = await websocketExchange(ws('/silent', { timeoutMs: 100 }), local);
    expect(silent).toMatchObject({ status: null, error: 'Timed out after 100 ms' });
    // A timeout while listening only ends the listening.
    const listening = await websocketExchange(
      ws('/echo', { listenMs: 5000, timeoutMs: 200 }),
      local,
    );
    expect(listening.error).toBeUndefined();
    expect(listening.closeCode).toBe(1000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await websocketExchange(ws('/echo', { listenMs: 5000 }), {
      ...local,
      signal: controller.signal,
    });
    expect(aborted.error).toBe('The request was aborted');
    const guarded = await websocketExchange(ws('/echo'), {
      guard: () => Promise.reject(new Error('blocked')),
    });
    expect(guarded.error).toBe('blocked');
    // Aborted before sending the delayed message.
    const early = new AbortController();
    setTimeout(() => early.abort(), 50);
    const unsent = await websocketExchange(
      ws('/echo', { messages: [{ content: 'x', delayMs: 2000 }] }),
      {
        ...local,
        signal: early.signal,
      },
    );
    expect(unsent.error).toBe('The request was aborted');
    expect(unsent.messages.some((message) => message.direction === 'sent')).toBe(false);
  });

  it('connects over TLS', async () => {
    const result = await websocketExchange(
      { ...ws('/echo', { messages: [{ content: 'secure' }] }), url: new URL('/echo', wssBase) },
      { ...local, tls: { caCertificate: TEST_CERT } },
    );
    expect(result.error).toBeUndefined();
    expect(result.timings?.tls).toBeDefined();
    expect(result.messages.find((message) => message.direction === 'received')?.data).toBe(
      'secure',
    );
  });

  it('parses frames that arrive in pieces and ignores unsolicited pongs', async () => {
    const split = await websocketExchange(ws('/split', { maxMessages: 2, listenMs: 2000 }), local);
    expect(split.messages.filter((message) => message.direction === 'received')).toMatchObject([
      { data: 'm'.repeat(200), type: 'text' },
      { data: Buffer.alloc(70_000, 1).toString('base64'), type: 'binary' },
    ]);
    const pong = await websocketExchange(ws('/pong', { messages: [{ content: 'after' }] }), local);
    expect(pong.messages.filter((message) => message.direction === 'received')).toMatchObject([
      { data: 'after' },
    ]);
  });

  it('stops listening at once when maxMessages arrived while sending', async () => {
    const result = await websocketExchange(
      ws('/greet', { maxMessages: 1, messages: [{ content: 'x', delayMs: 100 }], listenMs: 3000 }),
      local,
    );
    expect(result.durationMs).toBeLessThan(1000);
    expect(result.messages.filter((message) => message.direction === 'received')).toHaveLength(2);
  });

  it('reports odd handshake replies', async () => {
    const noReason = await websocketExchange(ws('/noreason'), local);
    expect(noReason).toMatchObject({
      status: 400,
      statusText: '',
      error: 'WebSocket handshake rejected: HTTP 400',
    });
    const garbage = await websocketExchange(ws('/garbage'), local);
    expect(garbage).toMatchObject({ status: 0, error: 'WebSocket handshake rejected: HTTP 0' });
  });

  it('encodes 64-bit lengths in client frames', () => {
    const frame = encodeClientFrame(2, Buffer.alloc(70_000), Buffer.from([0, 0, 0, 0]));
    expect(frame[1]).toBe(0x80 | 127);
    expect(Number(frame.readBigUInt64BE(2))).toBe(70_000);
  });
});

// --- Server-sent events ----------------------------------------------------------------------

describe('SseParser', () => {
  it('parses fields, comments, multi-line data and every line ending', () => {
    const events: { event: string; data: string }[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push(': comment\r\nid: 7\r\nretry: 1500\r\nretry: soon\nevent: update\ndata: a\r');
    parser.push('\ndata:b\nunknown: x\nid: bad\0id\ndata\n\r');
    parser.push('data: second\n\n\n');
    expect(events).toEqual([
      { event: 'update', data: 'a\nb\n' },
      { event: 'message', data: 'second' },
    ]);
    expect(parser.lastEventId).toBe('7');
    expect(parser.retryMs).toBe(1500);
  });
});

describe('sseExchange', () => {
  let base = '';
  beforeAll(async () => {
    const server = http.createServer((req, res): void => {
      if (req.url === '/plain') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"accept":"${req.headers.accept}","body":"${req.method}"}`);
        return;
      }
      if (req.url === '/untyped') {
        res.writeHead(200);
        res.end('data: not announced\n\n');
        return;
      }
      if (req.url === '/down') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(': hello\n\nevent: tick\ndata: 1\n\n');
      res.write('data: line 1\ndata: line 2\n\n');
      if (req.url === '/end') {
        res.end('data: last\n\n');
        return;
      }
      const timer = setInterval(() => res.write('data: more\n\n'), 20);
      res.on('close', () => clearInterval(timer));
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  const sse = (path: string, extra: Partial<Parameters<typeof sseExchange>[0]> = {}) => ({
    url: new URL(path, base),
    method: 'GET',
    headers: [] as [string, string][],
    listenMs: 100,
    timeoutMs: 3000,
    ...extra,
  });

  it('collects events until maxEvents', async () => {
    const result = await sseExchange(sse('/events', { maxEvents: 3, listenMs: 2000 }), local);
    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.messages.map(({ data, event, type }) => ({ data, event, type }))).toEqual([
      { data: '1', event: 'tick', type: 'event' },
      { data: 'line 1\nline 2', event: 'message', type: 'event' },
      { data: 'more', event: 'message', type: 'event' },
    ]);
    expect(result.durationMs).toBeLessThan(2000);
    expect(result.timings?.firstByte).toBeDefined();
    expect(result.remoteAddress).toBe('127.0.0.1');
  });

  it('listens for listenMs and notes the end of the stream', async () => {
    const listened = await sseExchange(sse('/events', { listenMs: 150 }), local);
    expect(listened.messages.length).toBeGreaterThan(2);
    const ended = await sseExchange(sse('/end', { listenMs: 2000 }), local);
    expect(ended.messages.map((message) => message.data)).toEqual([
      '1',
      'line 1\nline 2',
      'last',
      'Stream ended by the server',
    ]);
    const down = await sseExchange(sse('/down', { listenMs: 2000 }), local);
    expect(down.error).toBe('The connection closed before the response ended');
  });

  it('records a response that is not an event stream as one message', async () => {
    const result = await sseExchange(
      sse('/plain', {
        method: 'POST',
        body: 'x',
        headers: [
          ['Accept', 'application/json'],
          ['cache-control', 'max-age=0'],
        ],
      }),
      local,
    );
    expect(result.messages).toMatchObject([
      { direction: 'received', type: 'text', data: '{"accept":"application/json","body":"POST"}' },
    ]);
    expect(result.sizeBytes).toBe(result.messages[0]!.data.length);
    const untyped = await sseExchange(sse('/untyped'), local);
    expect(untyped.messages).toMatchObject([{ type: 'text', data: 'data: not announced\n\n' }]);
  });

  it('reports an abort while listening', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await sseExchange(sse('/events', { listenMs: 5000 }), {
      ...local,
      signal: controller.signal,
    });
    expect(result.error).toBe('The request was aborted');
    expect(result.status).toBe(200);
  });

  it('reports connection failures and timeouts', async () => {
    const closed = net.createServer();
    const port = await listen(closed);
    closed.close();
    const refused = await sseExchange(
      sse('/', { url: new URL(`http://127.0.0.1:${port}/`) }),
      local,
    );
    expect(refused.status).toBeNull();
    expect(refused.error).toMatch(/ECONNREFUSED/);
    const timedOut = await sseExchange(sse('/events', { listenMs: 5000, timeoutMs: 150 }), local);
    expect(timedOut.error).toBeUndefined();
    const silent = net.createServer(() => {});
    const silentPort = await listen(silent);
    const noAnswer = await sseExchange(
      sse('/', { url: new URL(`http://127.0.0.1:${silentPort}/`), timeoutMs: 100 }),
      local,
    );
    expect(noAnswer.error).toBe('Timed out after 100 ms');
  });
});

// --- Raw sockets -----------------------------------------------------------------------------

describe('socketExchange', () => {
  let tcpPort = 0;
  let tlsPort = 0;
  let udpPort = 0;
  let closingPort = 0;
  let greetingPort = 0;
  let udp6Port = 0;
  const udpEcho = async (type: 'udp4' | 'udp6', address: string) => {
    const udp = dgram.createSocket(type);
    udp.on('message', (message, remote) =>
      udp.send(Buffer.concat([Buffer.from('echo:'), message]), remote.port, remote.address),
    );
    await new Promise<void>((resolve) => udp.bind(0, address, resolve));
    servers.push(udp);
    return udp.address().port;
  };
  beforeAll(async () => {
    tcpPort = await listen(net.createServer((socket) => socket.pipe(socket)));
    closingPort = await listen(net.createServer((socket) => socket.end('bye')));
    greetingPort = await listen(
      net.createServer((socket) => {
        socket.on('error', () => {});
        socket.write('hello');
      }),
    );
    tlsPort = await listen(
      tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, (socket) => socket.pipe(socket)),
    );
    udpPort = await udpEcho('udp4', '127.0.0.1');
    udp6Port = await udpEcho('udp6', '::1');
  });

  const raw = (url: string, extra: Partial<Parameters<typeof socketExchange>[0]> = {}) => ({
    url: new URL(url),
    messages: [],
    listenMs: 100,
    responseEncoding: 'text' as const,
    timeoutMs: 3000,
    ...extra,
  });

  it('talks TCP in text, hex and base64 and stops at readUntil', async () => {
    const result = await socketExchange(
      raw(`tcp://127.0.0.1:${tcpPort}`, {
        messages: [
          { content: 'PING ' },
          { content: '0x4f 4b', type: 'hex', delayMs: 20 },
          { content: Buffer.from('\nEND').toString('base64'), type: 'base64' },
        ],
        listenMs: 2000,
        readUntil: 'END',
      }),
      local,
    );
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeLessThan(2000);
    const text = result.messages
      .filter((message) => message.direction === 'received')
      .map((message) => message.data)
      .join('');
    expect(text).toBe('PING OK\nEND');
    expect(result.sizeBytes).toBe(11);
    expect(result.messages[0]).toMatchObject({
      direction: 'info',
      data: `Connected to 127.0.0.1:${tcpPort}`,
    });
    expect(
      result.messages
        .filter((message) => message.direction === 'sent')
        .map((message) => message.type),
    ).toEqual(['text', 'binary', 'binary']);
    expect(result.timings?.connect).toBeDefined();
  });

  it('encodes what it receives and notes when the server closes', async () => {
    const hex = await socketExchange(
      raw(`tcp://127.0.0.1:${closingPort}`, { responseEncoding: 'hex', listenMs: 2000 }),
      local,
    );
    expect(
      hex.messages.filter((message) => message.direction !== 'sent').map((message) => message.data),
    ).toEqual([
      `Connected to 127.0.0.1:${closingPort}`,
      Buffer.from('bye').toString('hex'),
      'Connection closed by the server',
    ]);
    expect(hex.durationMs).toBeLessThan(2000);
    const base64 = await socketExchange(
      raw(`tcp://127.0.0.1:${tcpPort}`, {
        responseEncoding: 'base64',
        messages: [{ content: 'hi' }],
      }),
      local,
    );
    expect(base64.messages.find((message) => message.direction === 'received')).toMatchObject({
      data: Buffer.from('hi').toString('base64'),
      type: 'binary',
    });
  });

  it('talks TLS and UDP', async () => {
    const secure = await socketExchange(
      raw(`tls://localhost:${tlsPort}`, {
        messages: [{ content: 'tls!' }],
        readUntil: 'tls!',
        listenMs: 2000,
      }),
      { ...local, tls: { caCertificate: TEST_CERT } },
    );
    expect(secure.error).toBeUndefined();
    expect(secure.timings?.tls).toBeDefined();
    expect(secure.messages.find((message) => message.direction === 'received')?.data).toBe('tls!');
    const udp = await socketExchange(
      raw(`udp://localhost:${udpPort}`, {
        messages: [{ content: 'u' }],
        readUntil: 'echo:u',
        listenMs: 2000,
      }),
      { ...local, proxy: { enabled: true, protocol: 'socks5', hostname: '127.0.0.1', port: 1 } },
    );
    expect(udp).toMatchObject({ status: 0, remoteAddress: '127.0.0.1' });
    expect(udp.error).toBeUndefined();
    expect(udp.messages.find((message) => message.direction === 'received')?.data).toBe('echo:u');
  });

  it('reports bad URLs, bad messages and connection failures', async () => {
    expect((await socketExchange(raw('http://127.0.0.1:80'), local)).error).toBe(
      'Socket URLs start with tcp://, tls:// or udp://',
    );
    expect((await socketExchange(raw('tcp://127.0.0.1'), local)).error).toBe(
      'Socket URLs need a host and a port',
    );
    const badHex = await socketExchange(
      raw(`tcp://127.0.0.1:${tcpPort}`, { messages: [{ content: 'zz', type: 'hex' }] }),
      local,
    );
    expect(badHex).toMatchObject({ status: null, error: 'Message 1 is not valid hex' });
    const closed = net.createServer();
    const port = await listen(closed);
    closed.close();
    const refused = await socketExchange(raw(`tcp://127.0.0.1:${port}`), local);
    expect(refused.status).toBeNull();
    expect(refused.error).toMatch(/ECONNREFUSED/);
    const unknownHost = await socketExchange(raw('udp://adk-missing.invalid:9'), local);
    expect(unknownHost.status).toBeNull();
    expect(unknownHost.error).toMatch(/ENOTFOUND|EAI_AGAIN/);
  });

  it('stops at once when readUntil matched while sending, and applies the guard', async () => {
    const guarded: string[] = [];
    const result = await socketExchange(
      raw(`tcp://127.0.0.1:${greetingPort}`, {
        messages: [{ content: 'x', delayMs: 100 }],
        readUntil: 'hello',
        listenMs: 3000,
      }),
      {
        ...local,
        guard: (url) => {
          guarded.push(url.href);
          return Promise.resolve();
        },
      },
    );
    expect(result.durationMs).toBeLessThan(1000);
    expect(guarded).toEqual([`tcp://127.0.0.1:${greetingPort}`]);
  });

  it('talks UDP over IPv6 and without host mapping', async () => {
    const v6 = await socketExchange(
      raw(`udp://[::1]:${udp6Port}`, {
        messages: [{ content: 'six' }],
        readUntil: 'echo:six',
        listenMs: 2000,
      }),
      {},
    );
    expect(v6).toMatchObject({ status: 0, remoteAddress: '::1' });
    expect(v6.messages.find((message) => message.direction === 'received')?.data).toBe('echo:six');
    const v4 = await socketExchange(
      raw(`udp://127.0.0.1:${udpPort}`, {
        messages: [{ content: 'four' }],
        readUntil: 'echo:four',
        listenMs: 2000,
      }),
      {},
    );
    expect(v4.messages.find((message) => message.direction === 'received')?.data).toBe('echo:four');
  });

  it('reports a connection reset by the peer', async () => {
    const resetPort = await listen(
      net.createServer((socket) => {
        socket.on('error', () => {});
        setTimeout(() => socket.resetAndDestroy(), 30);
      }),
    );
    const result = await socketExchange(
      raw(`tcp://127.0.0.1:${resetPort}`, { listenMs: 2000 }),
      local,
    );
    expect(result.error).toMatch(/ECONNRESET/);
    expect(result.messages.at(-1)?.data).toMatch(/^Connection error: /);
  });

  it('times out and aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const aborted = await socketExchange(
      raw(`tcp://127.0.0.1:${tcpPort}`, { messages: [{ content: 'x', delayMs: 2000 }] }),
      { ...local, signal: controller.signal },
    );
    expect(aborted.error).toBe('The request was aborted');
    const listening = await socketExchange(
      raw(`tcp://127.0.0.1:${tcpPort}`, { listenMs: 5000, timeoutMs: 100 }),
      local,
    );
    expect(listening.error).toBeUndefined();
  });
});
