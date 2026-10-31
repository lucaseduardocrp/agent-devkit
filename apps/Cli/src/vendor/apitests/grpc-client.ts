import http2 from 'node:http2';
import type { Socket } from 'node:net';
import zlib from 'node:zlib';
import { decodeMessage, encodeMessage } from './grpc-codec.js';
import { exampleMessage } from './grpc-example.js';
import { loadProtoFiles } from './grpc-proto.js';
import { ReflectionClient } from './grpc-reflection.js';
import type { MethodInfo, Registry } from './grpc-schema.js';
import { type NetworkOptions, openSocket } from './http-transport.js';
import type { GrpcServiceList, ProtoFile, StreamMessage } from './types.js';

// gRPC over node:http2: length-prefixed protobuf messages, status in the trailers. Connections
// go through the shared openSocket (proxy, TLS options, client certificates, guard).

export interface GrpcTarget {
  /** `grpc://host:port` (plaintext) or `grpcs://host:port` (TLS). */
  readonly url: URL;
  readonly protoFiles: readonly ProtoFile[];
  /** Entry proto file; every file is searched when absent. */
  readonly protoFile?: string;
  /** Use server reflection (v1, then v1alpha) instead of the proto files. */
  readonly reflection: boolean;
  /** Metadata sent with the call (and with reflection calls). */
  readonly metadata: readonly (readonly [string, string])[];
  readonly timeoutMs: number;
}

export interface GrpcCallResult {
  /** gRPC status code (0 = OK). */
  readonly status: number;
  readonly statusMessage: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly trailers: Readonly<Record<string, string>>;
  /** Sent and received messages as JSON text, in order. */
  readonly messages: readonly StreamMessage[];
  /** Received messages, decoded to JSON values. */
  readonly responses: readonly unknown[];
  readonly sizeBytes: number;
  readonly durationMs: number;
}

const CANCELLED = 1;
const UNKNOWN = 2;
const DEADLINE_EXCEEDED = 4;
const PERMISSION_DENIED = 7;
const RESOURCE_EXHAUSTED = 8;
const UNIMPLEMENTED = 12;
const INTERNAL = 13;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;

const USER_AGENT = 'adk-grpc/1.0';
/** Headers the protocol owns; metadata cannot set them. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'te',
  'grpc-timeout',
  'grpc-encoding',
  'connection',
  'host',
]);

interface Status {
  readonly status: number;
  readonly message: string;
}

/** The deadline passed or the caller cancelled. */
class GrpcAbort extends Error {
  constructor(readonly status: number) {
    super(status === DEADLINE_EXCEEDED ? 'Deadline exceeded' : 'Cancelled');
  }
}

/**
 * Calls `method` (`package.Service/Method`) with the request messages (one for unary and server
 * streaming, any number for client and bidirectional streaming).
 */
export async function grpcCall(
  target: GrpcTarget,
  method: string,
  requests: readonly unknown[],
  network: NetworkOptions,
): Promise<GrpcCallResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const path = `/${method.trim().replace(/^\//, '')}`;
  // With proto files, bad method names and request JSON fail before anything is sent.
  const local = target.reflection
    ? undefined
    : prepare(loadProtoFiles(target.protoFiles, target.protoFile).registry, path, requests, false);

  let connection: Connection;
  try {
    connection = await connect(target, network);
  } catch (error) {
    if (error instanceof GrpcAbort) return emptyResult(error.status, error.message, elapsed());
    throw error;
  }
  const run = async (): Promise<GrpcCallResult> => {
    let call = local;
    if (!call) {
      const reflection = new ReflectionClient(reflectionTransport(connection, target.metadata));
      call = prepare(await reflection.registry([serviceOf(path)]), path, requests, true);
    }
    return invoke(connection, target.metadata, path, call, elapsed);
  };
  return run()
    .catch((error: unknown) => {
      // Reflection cut short by the deadline or a cancel is that status, not an error.
      if (!connection.signal.aborted) throw error;
      const status = connection.abortStatus();
      return emptyResult(status.status, status.message, elapsed());
    })
    .finally(() => connection.close());
}

/** The services and methods of the server (reflection) or of the proto files. */
export async function grpcListServices(
  target: GrpcTarget,
  network: NetworkOptions,
): Promise<GrpcServiceList> {
  if (!target.reflection) {
    const { registry, entry } = loadProtoFiles(target.protoFiles, target.protoFile);
    const names = [...registry.services.values()]
      .filter((service) => entry === undefined || service.file === entry)
      .map((service) => service.fullName);
    return serviceList(registry, names);
  }
  const connection = await connect(target, network).catch((error: unknown) => {
    throw error instanceof GrpcAbort ? new Error(`${error.message} while listing services`) : error;
  });
  const reflection = new ReflectionClient(reflectionTransport(connection, target.metadata));
  return reflection
    .listServices()
    .then(async (names) => serviceList(await reflection.registry(names), names))
    .catch((error: unknown) => {
      if (!connection.signal.aborted) throw error;
      throw new Error(`${connection.abortStatus().message} while listing services`);
    })
    .finally(() => connection.close());
}

function serviceList(registry: Registry, names: readonly string[]): GrpcServiceList {
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
  const services = names
    .map((name) => registry.services.get(name))
    .filter((service) => service !== undefined)
    .map((service) => ({
      name: service.fullName,
      methods: service.methods
        .map((method) => ({
          name: method.name,
          path: method.path,
          requestType: method.input,
          responseType: method.output,
          clientStreaming: method.clientStreaming,
          serverStreaming: method.serverStreaming,
          example: exampleMessage(registry, method.input),
        }))
        .sort(byName),
    }))
    .sort(byName);
  return { services };
}

interface PreparedCall {
  readonly registry: Registry;
  readonly method: MethodInfo;
  readonly requests: readonly unknown[];
  readonly payloads: readonly Buffer[];
}

function prepare(
  registry: Registry,
  path: string,
  requests: readonly unknown[],
  reflection: boolean,
): PreparedCall {
  const method = registry.method(path);
  if (!method) {
    const where = reflection ? 'on the server (reflection)' : 'in the proto files';
    throw new Error(`Method ${path.slice(1)} not found ${where}`);
  }
  // Unary and server streaming calls send exactly one message.
  const toSend = method.clientStreaming ? requests : [requests[0] ?? {}];
  const payloads = toSend.map((request, index) => {
    try {
      return encodeMessage(registry, method.input, request);
    } catch (error) {
      const which = toSend.length > 1 ? ` #${index + 1}` : '';
      throw new Error(`Invalid request message${which}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  });
  return { registry, method, requests: toSend, payloads };
}

function serviceOf(path: string): string {
  return path.slice(1).split('/', 1).join('');
}

async function invoke(
  connection: Connection,
  metadata: GrpcTarget['metadata'],
  path: string,
  call: PreparedCall,
  elapsed: () => number,
): Promise<GrpcCallResult> {
  const messages: StreamMessage[] = [];
  const responses: unknown[] = [];
  const raw = await rawCall(connection, path, metadata, call.payloads, {
    onSent: (index) =>
      messages.push({
        direction: 'sent',
        at: elapsed(),
        data: pretty(call.requests[index]),
        type: 'json',
      }),
    onMessage: (payload) => {
      let value: unknown;
      try {
        value = decodeMessage(call.registry, call.method.output, payload);
      } catch (error) {
        throw new Error(`Could not decode the response message: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      responses.push(value);
      messages.push({ direction: 'received', at: elapsed(), data: pretty(value), type: 'json' });
    },
  });
  return {
    status: raw.status,
    statusMessage: raw.message,
    headers: raw.headers,
    trailers: raw.trailers,
    messages,
    responses,
    sizeBytes: raw.receivedBytes,
    durationMs: elapsed(),
  };
}

function emptyResult(status: number, message: string, durationMs: number): GrpcCallResult {
  return {
    status,
    statusMessage: message,
    headers: {},
    trailers: {},
    messages: [],
    responses: [],
    sizeBytes: 0,
    durationMs,
  };
}

function pretty(value: unknown): string {
  return String(JSON.stringify(value, null, 2));
}

// --- Connection -------------------------------------------------------------------------------

interface Connection {
  readonly session: http2.ClientHttp2Session;
  /** Aborted when the deadline passes or the caller cancels. */
  readonly signal: AbortSignal;
  readonly deadlineAt: number | undefined;
  abortStatus(): Status;
  close(): void;
}

async function connect(target: GrpcTarget, network: NetworkOptions): Promise<Connection> {
  const { url } = target;
  const tls = url.protocol === 'grpcs:';
  if (!tls && url.protocol !== 'grpc:') {
    throw new Error(`gRPC URLs start with grpc:// or grpcs:// (got ${url.protocol}//)`);
  }
  const controller = new AbortController();
  let reason: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  const cleanup = (): void => {
    clearTimeout(timer);
    network.signal?.removeEventListener('abort', onCancel);
  };
  // Whichever comes first wins: cleanup disarms the other one.
  const abort = (status: number): void => {
    cleanup();
    reason = status;
    controller.abort();
  };
  const onCancel = (): void => abort(CANCELLED);
  const deadlineAt = target.timeoutMs > 0 ? Date.now() + target.timeoutMs : undefined;
  if (deadlineAt !== undefined)
    timer = setTimeout(() => abort(DEADLINE_EXCEEDED), target.timeoutMs);
  if (network.signal?.aborted) abort(CANCELLED);
  else network.signal?.addEventListener('abort', onCancel, { once: true });

  let socket: Socket;
  try {
    if (reason !== undefined) throw new GrpcAbort(reason);
    socket = await openSocket(
      {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port ? Number(url.port) : tls ? 443 : 80,
        tls,
        alpn: ['h2'],
      },
      { ...network, signal: controller.signal },
    );
  } catch (error) {
    cleanup();
    throw reason === undefined ? error : new GrpcAbort(reason);
  }
  const session = http2.connect(`${tls ? 'https' : 'http'}://${url.host}`, {
    createConnection: () => socket,
  });
  // Failures reach the streams too; without a listener a session error would crash the process.
  session.on('error', () => undefined);
  return {
    session,
    signal: controller.signal,
    deadlineAt,
    abortStatus: () =>
      reason === DEADLINE_EXCEEDED
        ? { status: DEADLINE_EXCEEDED, message: 'Deadline exceeded' }
        : { status: CANCELLED, message: 'Cancelled' },
    close: () => {
      cleanup();
      session.destroy();
    },
  };
}

function reflectionTransport(connection: Connection, metadata: GrpcTarget['metadata']) {
  return async (path: string, request: Buffer) => {
    const messages: Buffer[] = [];
    const result = await rawCall(connection, path, metadata, [request], {
      onSent: () => undefined,
      onMessage: (payload) => messages.push(payload),
    });
    return { status: result.status, statusMessage: result.message, messages };
  };
}

// --- Streams ----------------------------------------------------------------------------------

interface RawCallHooks {
  readonly onSent: (index: number) => void;
  /** May throw: the call is then cancelled with INTERNAL. */
  readonly onMessage: (payload: Buffer) => void;
}

interface RawCallResult extends Status {
  readonly headers: Record<string, string>;
  readonly trailers: Record<string, string>;
  readonly receivedBytes: number;
}

/** Sends the messages, then ends the request side; responses are read as they arrive. */
function rawCall(
  connection: Connection,
  path: string,
  metadata: GrpcTarget['metadata'],
  payloads: readonly Buffer[],
  hooks: RawCallHooks,
): Promise<RawCallResult> {
  return new Promise((resolve) => {
    let stream: http2.ClientHttp2Stream;
    /* v8 ignore start -- defensive: an abort closes the running stream (no call starts after it)
       and request() only throws on a session that is already destroyed. */
    if (connection.signal.aborted) {
      resolve({ ...connection.abortStatus(), headers: {}, trailers: {}, receivedBytes: 0 });
      return;
    }
    try {
      stream = connection.session.request(requestHeaders(connection, path, metadata));
    } catch (error) {
      resolve({
        status: UNAVAILABLE,
        message: errorMessage(error),
        headers: {},
        trailers: {},
        receivedBytes: 0,
      });
      return;
    }
    /* v8 ignore stop */

    let headers: Record<string, string> = {};
    let trailers: Record<string, string> = {};
    let failure: Status | undefined;
    let streamError: Error | undefined;
    let pending: Buffer = Buffer.alloc(0);
    let receivedBytes = 0;
    const fail = (status: Status): void => {
      failure ??= status;
      stream.close(http2.constants.NGHTTP2_CANCEL);
    };
    const onAbort = (): void => fail(connection.abortStatus());
    connection.signal.addEventListener('abort', onAbort, { once: true });

    stream.on('response', (responseHeaders) => {
      headers = flatten(responseHeaders);
    });
    stream.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5 && failure === undefined) {
        const length = pending.readUInt32BE(1);
        if (pending.length < 5 + length) break;
        const compressed = (pending.readUInt8(0) & 1) === 1;
        const payload = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);
        receivedBytes += length;
        try {
          hooks.onMessage(
            compressed ? decompress(payload, headers['grpc-encoding'] ?? 'identity') : payload,
          );
        } catch (error) {
          fail({ status: INTERNAL, message: errorMessage(error) });
        }
      }
    });
    stream.on('trailers', (responseTrailers: http2.IncomingHttpHeaders) => {
      trailers = flatten(responseTrailers);
    });
    stream.on('error', (error: Error) => {
      streamError = error;
    });
    stream.on('close', () => {
      connection.signal.removeEventListener('abort', onAbort);
      const status =
        failure ??
        statusOf(headers, trailers) ??
        resetStatus(stream.rstCode, streamError) ??
        httpStatusOf(headers);
      const { ':status': _status, ...visibleHeaders } = headers;
      resolve({ ...status, headers: visibleHeaders, trailers, receivedBytes });
    });

    payloads.forEach((payload, index) => {
      const prefix = Buffer.alloc(5);
      prefix.writeUInt32BE(payload.length, 1);
      stream.write(Buffer.concat([prefix, payload]));
      hooks.onSent(index);
    });
    stream.end();
  });
}

function requestHeaders(
  connection: Connection,
  path: string,
  metadata: GrpcTarget['metadata'],
): http2.OutgoingHttpHeaders {
  const headers: Record<string, string | string[]> = {
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/grpc',
    te: 'trailers',
    'user-agent': USER_AGENT,
    'grpc-accept-encoding': 'identity,gzip,deflate',
  };
  if (connection.deadlineAt !== undefined) {
    const ms = Math.max(1, connection.deadlineAt - Date.now());
    // The header allows at most 8 digits.
    headers['grpc-timeout'] = ms < 1e8 ? `${ms}m` : `${Math.ceil(ms / 1000)}S`;
  }
  const fromMetadata = new Set<string>();
  for (const [rawKey, value] of metadata) {
    const key = rawKey.trim().toLowerCase();
    if (!key || key.startsWith(':') || RESERVED_HEADERS.has(key)) continue;
    // `-bin` values are already base64, as the protocol sends them.
    headers[key] = fromMetadata.has(key)
      ? [headers[key] as string | string[], value].flat()
      : value;
    fromMetadata.add(key);
  }
  return headers;
}

function decompress(payload: Buffer, encoding: string): Buffer {
  if (encoding === 'gzip') return zlib.gunzipSync(payload);
  if (encoding === 'deflate') return zlib.inflateSync(payload);
  throw new Error(`Compressed message with unsupported grpc-encoding "${encoding}"`);
}

function flatten(headers: http2.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key] = [value].flat().join(', ');
  return out;
}

/** From the trailers, or the headers of a trailers-only response. */
function statusOf(
  headers: Record<string, string>,
  trailers: Record<string, string>,
): Status | undefined {
  const source = trailers['grpc-status'] !== undefined ? trailers : headers;
  const code = source['grpc-status'];
  if (code === undefined || !/^\d+$/.test(code.trim())) return undefined;
  return { status: Number(code), message: percentDecode(source['grpc-message'] ?? '') };
}

/** RST_STREAM codes to statuses, as gRPC clients map them. */
const RST_STATUS: Readonly<Record<number, number>> = {
  [http2.constants.NGHTTP2_NO_ERROR]: UNAVAILABLE,
  [http2.constants.NGHTTP2_REFUSED_STREAM]: UNAVAILABLE,
  [http2.constants.NGHTTP2_CANCEL]: CANCELLED,
  [http2.constants.NGHTTP2_ENHANCE_YOUR_CALM]: RESOURCE_EXHAUSTED,
  [http2.constants.NGHTTP2_INADEQUATE_SECURITY]: PERMISSION_DENIED,
};

/** A stream that failed or was reset (a remote CANCEL emits no error). */
function resetStatus(rstCode: number, error: Error | undefined): Status | undefined {
  if (!error && rstCode === http2.constants.NGHTTP2_NO_ERROR) return undefined;
  return {
    status: RST_STATUS[rstCode] ?? INTERNAL,
    message: error?.message ?? `The server reset the stream (code ${rstCode})`,
  };
}

/** gRPC's HTTP status to status mapping, for responses without grpc-status. */
const HTTP_STATUS: Readonly<Record<number, number>> = {
  400: INTERNAL,
  401: UNAUTHENTICATED,
  403: PERMISSION_DENIED,
  404: UNIMPLEMENTED,
  429: UNAVAILABLE,
  502: UNAVAILABLE,
  503: UNAVAILABLE,
  504: UNAVAILABLE,
};

function httpStatusOf(headers: Record<string, string>): Status {
  const http = headers[':status'];
  if (http === undefined) return { status: UNKNOWN, message: 'No response from the server' };
  if (http !== '200')
    return { status: HTTP_STATUS[Number(http)] ?? UNKNOWN, message: `HTTP ${http}` };
  const contentType = headers['content-type'] ?? '';
  const message = contentType.startsWith('application/grpc')
    ? 'The server ended the call without a grpc-status'
    : `Unexpected content-type "${contentType}" (is this a gRPC server?)`;
  return { status: UNKNOWN, message };
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Everything thrown here (codec, node:http2) is an Error. */
function errorMessage(error: unknown): string {
  return (error as Error).message;
}
