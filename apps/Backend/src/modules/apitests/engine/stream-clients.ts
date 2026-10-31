import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import type { Socket } from 'node:net';
import {
  connectTarget,
  decodeBody,
  httpHeadEnd,
  lifetime,
  openHttpResponse,
  parseHttpHead,
  portOf,
  readHandshake,
  toError,
  untilAborted,
  type Connection,
  type Lifetime,
  type NetworkOptions,
  type OpenResponse,
} from './http-transport.js';
import type { OutgoingMessage, RequestTimeline, StreamMessage } from './types.js';

// WebSocket (RFC 6455), server-sent events and raw TCP/TLS/UDP exchanges: connect, send the
// messages in order, listen for a while and record everything with its time. Network failures
// end up in `error`, never thrown. Node built-ins only.

export interface ExchangeResult {
  /** 101 for an accepted WebSocket, the HTTP status for SSE, 0 for a socket that connected. */
  readonly status: number | null;
  readonly statusText?: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly messages: readonly StreamMessage[];
  /** Bytes received. */
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly remoteAddress?: string;
  readonly timings?: NonNullable<RequestTimeline['timings']>;
  /** Set when the exchange failed (connection refused, handshake rejected...). */
  readonly error?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Timings = NonNullable<RequestTimeline['timings']>;

/** Time allowed for the peer to answer our WebSocket close frame. */
const CLOSE_GRACE_MS = 1000;
/** Largest WebSocket message kept; a bigger one closes the connection with 1009. */
const MAX_WS_MESSAGE = 16 * 1024 * 1024;
/** Body bytes kept when an SSE URL answers something that is not an event stream. */
const MAX_PLAIN_BODY = 2 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Records messages with their time since the start of the exchange. */
class Exchange {
  readonly started = performance.now();
  readonly messages: StreamMessage[] = [];
  readonly result: Mutable<Omit<ExchangeResult, 'messages' | 'durationMs'>> = {
    status: null,
    headers: [],
    sizeBytes: 0,
  };

  add(direction: StreamMessage['direction'], data: string, extra: Partial<StreamMessage> = {}) {
    this.messages.push({
      direction,
      at: Math.round(performance.now() - this.started),
      data,
      ...extra,
    });
  }

  timings(connection: Connection, extra: Partial<Timings> = {}): void {
    this.result.timings = { ...connection.phases, ...extra, total: 0 };
  }

  finish(): ExchangeResult {
    const durationMs = Math.round(performance.now() - this.started);
    const timings = this.result.timings ? { ...this.result.timings, total: durationMs } : undefined;
    return { ...this.result, ...(timings ? { timings } : {}), messages: this.messages, durationMs };
  }
}

/** Resolves once `stop()` is called; `stopped` tells whether it was. */
class Stopper {
  stopped = false;
  readonly promise: Promise<void>;
  readonly stop: () => void;

  constructor() {
    let wake!: () => void;
    this.promise = new Promise<void>((resolve) => (wake = resolve));
    this.stop = () => {
      this.stopped = true;
      wake();
    };
  }
}

/** Waits `ms`, less when the signal aborts or the stopper stops. */
function wait(ms: number, signal: AbortSignal, stopper?: Stopper): Promise<void> {
  if (signal.aborted || stopper?.stopped || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    void stopper?.promise.then(done);
  });
}

const messageOf = (error: unknown) => toError(error).message;

/**
 * The error of an exchange interrupted by its lifetime: none when only the listening was cut by
 * the timeout (the exchange itself went through).
 */
function interruption(life: Lifetime, listening: boolean): string | undefined {
  if (!life.signal.aborted || (listening && life.timedOut())) return undefined;
  return messageOf(life.signal.reason);
}

// ---------------------------------------------------------------------------------------------
// WebSocket

const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

/** One client frame: FIN set, always masked (RFC 6455 §5.3). */
export function encodeClientFrame(opcode: number, payload: Buffer, mask = randomBytes(4)): Buffer {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), bigLength(length)]);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index++) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([head, mask, masked]);
}

function bigLength(length: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  return bytes;
}

/** Client side of an open WebSocket: frame parsing, fragmentation, ping/pong and close. */
class WebSocketSession {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentsSize = 0;
  private fragmentOpcode = 0;
  private closeSent = false;
  /** A close frame went by (theirs, or ours after a protocol error): nothing more is parsed. */
  private finished = false;
  /** The close: the peer's close frame, or ours after a protocol error. */
  closeFrame: { readonly code: number; readonly reason: string } | undefined;
  readonly ended: Promise<void>;

  constructor(
    private readonly socket: Socket,
    private readonly onMessage: (opcode: number, payload: Buffer) => void,
  ) {
    this.ended = new Promise((resolve) => socket.once('close', () => resolve()));
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
  }

  get open(): boolean {
    return !this.socket.destroyed && !this.closeFrame;
  }

  send(opcode: number, payload: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(encodeClientFrame(opcode, payload));
  }

  close(code: number, reason = ''): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code);
    payload.write(reason, 2);
    this.send(OPCODE.close, payload);
  }

  private feed(chunk: Buffer): void {
    if (this.finished) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      // Checked before buffering the payload: a peer never makes us hold more than one message.
      if (this.fragmentsSize + length > MAX_WS_MESSAGE) return this.fail(1009, 'Message too big');
      const masked = (second & 0x80) !== 0;
      const payloadAt = offset + (masked ? 4 : 0);
      if (this.buffer.length < payloadAt + length) return;
      const payload = Buffer.from(this.buffer.subarray(payloadAt, payloadAt + length));
      if (masked) {
        for (let index = 0; index < length; index++) {
          payload[index] = payload[index]! ^ this.buffer[offset + (index % 4)]!;
        }
      }
      this.buffer = this.buffer.subarray(payloadAt + length);
      this.frame((first & 0x80) !== 0, first & 0x0f, payload);
    }
  }

  private frame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OPCODE.close: {
        this.finished = true;
        this.closeFrame = {
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.subarray(2).toString('utf8'),
        };
        // Echo the close (RFC 6455 §5.5.1), then the server closes the TCP connection.
        this.close(payload.length >= 2 ? this.closeFrame.code : 1000);
        this.socket.end();
        return;
      }
      case OPCODE.ping:
        return this.send(OPCODE.pong, payload);
      case OPCODE.pong:
        return;
      case OPCODE.text:
      case OPCODE.binary:
        if (fin) return this.onMessage(opcode, payload);
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentsSize = payload.length;
        return;
      case OPCODE.continuation: {
        this.fragments.push(payload);
        this.fragmentsSize += payload.length;
        if (!fin) return;
        const message = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentsSize = 0;
        return this.onMessage(this.fragmentOpcode, message);
      }
      default:
        return this.fail(1002, 'Unknown opcode');
    }
  }

  private fail(code: number, reason: string): void {
    this.finished = true;
    this.closeFrame = { code, reason };
    this.close(code, reason);
    this.socket.end();
  }
}

function handshakeRequest(
  url: URL,
  key: string,
  headers: readonly (readonly [string, string])[],
  subprotocols: readonly string[],
): string {
  // The handshake's own headers win over custom ones of the same name.
  const reserved = new Set([
    'host',
    'upgrade',
    'connection',
    'sec-websocket-key',
    'sec-websocket-version',
    ...(subprotocols.length ? ['sec-websocket-protocol'] : []),
  ]);
  const custom = headers.filter(([name]) => !reserved.has(name.toLowerCase()));
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(subprotocols.length ? [`Sec-WebSocket-Protocol: ${subprotocols.join(', ')}`] : []),
    ...custom.map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

const headerValue = (headers: readonly (readonly [string, string])[], name: string) =>
  headers.find(([key]) => key === name)?.[1];

/** WebSocket client (RFC 6455) over {@link openSocket}: handshake, send, listen, close. */
export function websocketExchange(
  input: {
    readonly url: URL;
    readonly headers: readonly (readonly [string, string])[];
    /** Variables already resolved. */
    readonly messages: readonly OutgoingMessage[];
    readonly subprotocols?: readonly string[];
    readonly listenMs: number;
    readonly maxMessages?: number;
    readonly timeoutMs: number;
  },
  network: NetworkOptions,
): Promise<ExchangeResult> {
  const exchange = new Exchange();
  const { result } = exchange;
  const life = lifetime(network.signal, input.timeoutMs);
  let connection: Connection | undefined;
  let listening = false;
  const run = async (): Promise<ExchangeResult> => {
    const secure = input.url.protocol === 'wss:';
    if (!secure && input.url.protocol !== 'ws:') {
      throw new Error('WebSocket URLs start with ws:// or wss://');
    }
    await untilAborted(network.guard?.(input.url), life.signal);
    connection = await connectTarget(
      { host: input.url.hostname, port: portOf(input.url), tls: secure, alpn: ['http/1.1'] },
      network,
      life.signal,
    );
    result.remoteAddress = connection.remoteAddress;
    const readyAt = performance.now();
    const key = randomBytes(16).toString('base64');
    connection.socket.write(
      handshakeRequest(input.url, key, input.headers, input.subprotocols ?? []),
    );
    const head = parseHttpHead(await readHandshake(connection.socket, life.signal, httpHeadEnd));
    exchange.timings(connection, {
      firstByte: Math.round((performance.now() - readyAt) * 10) / 10,
    });
    result.status = head.status;
    result.statusText = head.statusText;
    result.headers = head.headers;
    if (head.status !== 101) {
      result.error = `WebSocket handshake rejected: HTTP ${head.status} ${head.statusText}`.trim();
      return exchange.finish();
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    if (headerValue(head.headers, 'sec-websocket-accept') !== accept) {
      result.error = 'WebSocket handshake failed: invalid Sec-WebSocket-Accept';
      return exchange.finish();
    }
    const protocol = headerValue(head.headers, 'sec-websocket-protocol');
    exchange.add('info', `Connected to ${input.url.href}${protocol ? ` (${protocol})` : ''}`);

    const stopper = new Stopper();
    let received = 0;
    const session = new WebSocketSession(connection.socket, (opcode, payload) => {
      result.sizeBytes += payload.length;
      received++;
      const text = opcode === OPCODE.text;
      exchange.add('received', payload.toString(text ? 'utf8' : 'base64'), {
        type: text ? 'text' : 'binary',
      });
      if (listening && input.maxMessages && received >= input.maxMessages) stopper.stop();
    });
    const ended = new Stopper();
    void session.ended.then(() => {
      ended.stop();
      stopper.stop();
    });

    for (const message of input.messages) {
      await wait(message.delayMs ?? 0, life.signal, stopper);
      if (life.signal.aborted || !session.open) break;
      const binary = message.type === 'binary';
      session.send(
        binary ? OPCODE.binary : OPCODE.text,
        Buffer.from(message.content, binary ? 'base64' : 'utf8'),
      );
      exchange.add('sent', message.content, {
        type: binary ? 'binary' : message.type === 'json' ? 'json' : 'text',
      });
    }
    listening = !life.signal.aborted;
    if (input.maxMessages && received >= input.maxMessages) stopper.stop();
    await wait(input.listenMs, life.signal, stopper);

    if (session.open) {
      session.close(1000);
      await wait(CLOSE_GRACE_MS, new AbortController().signal, ended);
    }
    const close = session.closeFrame;
    result.closeCode = close?.code ?? 1006;
    if (close?.reason) result.closeReason = close.reason;
    exchange.add(
      'info',
      close
        ? `Closed ${close.code}${close.reason ? ` ${close.reason}` : ''}`
        : 'Connection closed without a close frame (1006)',
    );
    const error = interruption(life, listening);
    if (error) result.error = error;
    return exchange.finish();
  };
  return run()
    .catch((error: unknown) => {
      result.error = interruption(life, listening) ?? messageOf(error);
      return exchange.finish();
    })
    .finally(() => {
      connection?.destroy();
      life.dispose();
    });
}

// ---------------------------------------------------------------------------------------------
// Server-sent events

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Incremental text/event-stream parser (HTML Living Standard §9.2.6). */
export class SseParser {
  private pending = '';
  private data: string[] = [];
  private event = '';
  /** Last event id and reconnection time, as the stream set them. */
  lastEventId = '';
  retryMs: number | undefined;

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(text: string): void {
    this.pending += text;
    // A trailing \r may be the first half of \r\n: keep it until the next chunk.
    const lines = this.pending.split(/\r\n|\r(?!$)|\n/);
    this.pending = lines.pop()!;
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    switch (field) {
      case 'event':
        this.event = value;
        return;
      case 'data':
        this.data.push(value);
        return;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        return;
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        return;
      default:
        return;
    }
  }

  private dispatch(): void {
    const data = this.data;
    const event = this.event || 'message';
    this.data = [];
    this.event = '';
    if (data.length) this.onEvent({ event, data: data.join('\n') });
  }
}

/** Server-sent events: opens the stream and collects events for `listenMs`. */
export function sseExchange(
  input: {
    readonly url: URL;
    readonly method: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body?: string;
    readonly listenMs: number;
    readonly maxEvents?: number;
    readonly timeoutMs: number;
  },
  network: NetworkOptions,
): Promise<ExchangeResult> {
  const exchange = new Exchange();
  const { result } = exchange;
  const life = lifetime(network.signal, input.timeoutMs);
  const has = (name: string) => input.headers.some(([key]) => key.toLowerCase() === name);
  const headers = [
    ...input.headers,
    ...(has('accept') ? [] : [['accept', 'text/event-stream'] as const]),
    ...(has('cache-control') ? [] : [['cache-control', 'no-cache'] as const]),
  ];
  let opened: OpenResponse | undefined;
  let listening = false;
  const run = async (): Promise<ExchangeResult> => {
    opened = await openHttpResponse(
      {
        method: input.method,
        url: input.url,
        headers,
        ...(input.body !== undefined ? { body: input.body } : {}),
      },
      network,
      life.signal,
    );
    const { response, connection } = opened;
    exchange.timings(connection, {
      firstByte: Math.round((opened.responseAt - opened.readyAt) * 10) / 10,
    });
    result.remoteAddress = connection.remoteAddress;
    result.status = response.statusCode!;
    result.statusText = response.statusMessage!;
    result.headers = pairs(response.rawHeaders);
    listening = true;
    const isStream = /^text\/event-stream/i.test(String(response.headers['content-type'] ?? ''));
    const text = new TextDecoder();
    if (!isStream) {
      const chunks: Buffer[] = [];
      let kept = 0;
      await decodeBody(response, (chunk) => {
        result.sizeBytes += chunk.length;
        if (kept < MAX_PLAIN_BODY) chunks.push(chunk.subarray(0, MAX_PLAIN_BODY - kept));
        kept += chunk.length;
      });
      exchange.add('received', text.decode(Buffer.concat(chunks)), { type: 'text' });
      return exchange.finish();
    }
    const stopper = new Stopper();
    let events = 0;
    const parser = new SseParser(({ event, data }) => {
      exchange.add('received', data, { type: 'event', event });
      events++;
      if (input.maxEvents && events >= input.maxEvents) stopper.stop();
    });
    const reading = decodeBody(response, (chunk) => {
      result.sizeBytes += chunk.length;
      if (!stopper.stopped) parser.push(text.decode(chunk, { stream: true }));
    }).then(
      () => {
        if (!stopper.stopped) exchange.add('info', 'Stream ended by the server');
      },
      (error: unknown) => {
        if (!stopper.stopped && !life.signal.aborted) result.error = messageOf(error);
      },
    );
    await Promise.race([reading, wait(input.listenMs, life.signal, stopper)]);
    stopper.stop();
    const error = interruption(life, listening);
    if (error) result.error = error;
    return exchange.finish();
  };
  return run()
    .catch((error: unknown) => {
      result.error = interruption(life, listening) ?? messageOf(error);
      return exchange.finish();
    })
    .finally(() => {
      opened?.connection.destroy();
      life.dispose();
    });
}

function pairs(raw: readonly string[]): [string, string][] {
  const list: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    list.push([raw[index]!.toLowerCase(), raw[index + 1]!]);
  }
  return list;
}

// ---------------------------------------------------------------------------------------------
// TCP, TLS and UDP

function encodeOutgoing(message: OutgoingMessage, index: number): Buffer {
  switch (message.type) {
    case 'hex': {
      const hex = message.content.replace(/0x|[\s:]/gi, '');
      if (!/^(?:[0-9a-f]{2})*$/i.test(hex))
        throw new Error(`Message ${index + 1} is not valid hex`);
      return Buffer.from(hex, 'hex');
    }
    case 'base64':
    case 'binary':
      return Buffer.from(message.content, 'base64');
    default:
      return Buffer.from(message.content, 'utf8');
  }
}

/** What a raw exchange sends through and how it stops. */
interface RawChannel {
  send(data: Buffer): void;
  close(): void;
}

/** Raw TCP, TLS (`tls://`) or UDP (`udp://`) exchange. */
export function socketExchange(
  input: {
    readonly url: URL;
    /** Variables already resolved; `type` text, hex or base64. */
    readonly messages: readonly OutgoingMessage[];
    readonly listenMs: number;
    readonly readUntil?: string;
    readonly responseEncoding: 'text' | 'hex' | 'base64';
    readonly timeoutMs: number;
  },
  network: NetworkOptions,
): Promise<ExchangeResult> {
  const exchange = new Exchange();
  const { result } = exchange;
  const life = lifetime(network.signal, input.timeoutMs);
  const stopper = new Stopper();
  const decoder = new TextDecoder();
  let receivedText = '';
  let listening = false;
  let channel: RawChannel | undefined;
  const until = input.readUntil;
  const untilFound = () => Boolean(until && receivedText.includes(until));
  const onData = (chunk: Buffer) => {
    result.sizeBytes += chunk.length;
    const encoding = input.responseEncoding;
    exchange.add(
      'received',
      encoding === 'text' ? chunk.toString('utf8') : chunk.toString(encoding),
      {
        type: encoding === 'text' ? 'text' : 'binary',
      },
    );
    receivedText += decoder.decode(chunk, { stream: true });
    if (listening && untilFound()) stopper.stop();
  };
  const onClosed = (reason?: string) => {
    if (stopper.stopped) return;
    exchange.add('info', reason ?? 'Connection closed by the server');
    stopper.stop();
  };
  const run = async (): Promise<ExchangeResult> => {
    const protocol = input.url.protocol;
    if (!['tcp:', 'tls:', 'udp:'].includes(protocol)) {
      throw new Error('Socket URLs start with tcp://, tls:// or udp://');
    }
    const port = Number(input.url.port);
    if (!input.url.hostname || !port) throw new Error('Socket URLs need a host and a port');
    const outgoing = input.messages.map(encodeOutgoing);
    await untilAborted(network.guard?.(input.url), life.signal);
    channel =
      protocol === 'udp:'
        ? await openUdp(input.url.hostname, port, network, life.signal, exchange, onData, onClosed)
        : await openStream(
            input.url.hostname,
            port,
            protocol === 'tls:',
            network,
            life.signal,
            exchange,
            onData,
            onClosed,
          );
    result.status = 0;
    exchange.add('info', `Connected to ${input.url.host}`);

    for (const [index, message] of input.messages.entries()) {
      await wait(message.delayMs ?? 0, life.signal, stopper);
      if (life.signal.aborted || stopper.stopped) break;
      channel.send(outgoing[index]!);
      exchange.add('sent', message.content, {
        type: (message.type ?? 'text') === 'text' ? 'text' : 'binary',
      });
    }
    listening = !life.signal.aborted;
    if (untilFound()) stopper.stop();
    await wait(input.listenMs, life.signal, stopper);
    const error = interruption(life, listening) ?? result.error;
    if (error) result.error = error;
    return exchange.finish();
  };
  return run()
    .catch((error: unknown) => {
      result.error = interruption(life, listening) ?? messageOf(error);
      return exchange.finish();
    })
    .finally(() => {
      stopper.stop();
      channel?.close();
      life.dispose();
    });
}

async function openStream(
  host: string,
  port: number,
  secure: boolean,
  network: NetworkOptions,
  signal: AbortSignal,
  exchange: Exchange,
  onData: (chunk: Buffer) => void,
  onClosed: (reason?: string) => void,
): Promise<RawChannel> {
  const connection = await connectTarget({ host, port, tls: secure }, network, signal);
  exchange.timings(connection);
  exchange.result.remoteAddress = connection.remoteAddress;
  const { socket } = connection;
  socket.on('data', onData);
  socket.on('error', (error) => {
    exchange.result.error = error.message;
    onClosed(`Connection error: ${error.message}`);
  });
  socket.once('end', () => onClosed());
  socket.once('close', () => onClosed());
  return {
    send: (data) => void socket.write(data),
    close: () => connection.destroy(),
  };
}

async function openUdp(
  host: string,
  port: number,
  network: NetworkOptions,
  signal: AbortSignal,
  exchange: Exchange,
  onData: (chunk: Buffer) => void,
  onClosed: (reason?: string) => void,
): Promise<RawChannel> {
  // UDP never goes through the proxy; host access still maps the address.
  const started = performance.now();
  const mapped = (network.connectHost?.(host) ?? host).replace(/^\[|\]$/g, '');
  const { address, family } = await untilAborted(lookup(mapped), signal);
  const dnsAt = performance.now();
  const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  // Connecting a UDP socket only binds it locally and fixes the peer: it fails only on local
  // resource errors, which reach this handler like ICMP errors (port unreachable) and send
  // errors do. None of them can be produced reliably in tests.
  /* v8 ignore next 4 -- local socket and ICMP errors */
  socket.on('error', (error) => {
    exchange.result.error = error.message;
    onClosed(`Socket error: ${error.message}`);
  });
  await new Promise<void>((resolve) => socket.connect(port, address, resolve));
  exchange.result.remoteAddress = address;
  exchange.result.timings = {
    dns: Math.round((dnsAt - started) * 10) / 10,
    connect: Math.round((performance.now() - dnsAt) * 10) / 10,
    total: 0,
  };
  socket.on('message', (message: Buffer) => onData(message));
  // Without a callback, send errors are emitted as 'error' events.
  return { send: (data) => void socket.send(data), close: () => socket.close() };
}
