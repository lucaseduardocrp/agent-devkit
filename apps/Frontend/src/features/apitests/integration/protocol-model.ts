// Pure helpers of the request editors of each protocol: body modes, files, messages and the
// gRPC method lists. No React here.

import type {
  ApiRequestSpec,
  FormField,
  GrpcMethodInfo,
  GrpcServiceList,
  GrpcSpec,
  OutgoingMessage,
  RequestBody,
} from '../api-test-types.js';

/** Keeps what can be kept when the body type changes: the text, or the fields. */
export function changeBodyMode(body: RequestBody, mode: RequestBody['mode']): RequestBody {
  const content = 'content' in body ? body.content : '';
  const fields: FormField[] = 'fields' in body ? body.fields : [];
  switch (mode) {
    case 'none':
      return { mode };
    case 'binary':
      return { mode, file: null };
    case 'form':
      return { mode, fields };
    case 'urlencoded':
      return { mode, fields: fields.filter((field) => field.type !== 'file') };
    default:
      return { mode, content };
  }
}

/** Files are kept in the collection as base64: larger ones would make it heavy to load and save. */
export const MAX_FILE_BYTES = 3 * 1024 * 1024;

/** Size of the file a base64 text holds. */
export const base64Bytes = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

export type MessageType = NonNullable<OutgoingMessage['type']>;

/** The types each protocol sends: WebSocket frames or raw socket bytes. */
export const MESSAGE_TYPES: Record<'websocket' | 'socket', readonly MessageType[]> = {
  websocket: ['text', 'json', 'binary'],
  socket: ['text', 'hex', 'base64'],
};

export const grpcSpec = (request: ApiRequestSpec): GrpcSpec =>
  request.grpc ?? { method: '', reflection: true, message: '{}' };

/** Where the methods come from: the server (reflection) or a proto file of the collection. */
export const sourceKey = (request: ApiRequestSpec) => {
  const spec = grpcSpec(request);
  return `${request.url}|${spec.reflection === false ? `proto:${spec.protoFile ?? ''}` : 'reflection'}`;
};

/** Services already listed, by URL and source, for this page session. */
export const grpcServicesCache = new Map<string, GrpcServiceList>();

/** The method a request calls, when its services were listed. */
export function grpcMethodInfo(request: ApiRequestSpec): GrpcMethodInfo | null {
  const list = grpcServicesCache.get(sourceKey(request));
  const path = grpcSpec(request).method;
  for (const service of list?.services ?? [])
    for (const method of service.methods) if (method.path === path) return method;
  return null;
}

export function streamingKind(method: Pick<GrpcMethodInfo, 'clientStreaming' | 'serverStreaming'>) {
  if (method.clientStreaming && method.serverStreaming) return 'bidi' as const;
  if (method.clientStreaming) return 'client' as const;
  if (method.serverStreaming) return 'server' as const;
  return 'unary' as const;
}
