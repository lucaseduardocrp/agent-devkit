import { builtinProto } from './grpc-proto.js';
import {
  buildRegistry,
  type RawEnum,
  type RawField,
  type RawFile,
  type RawMessage,
  type RawMethod,
  type RawService,
  type Registry,
} from './grpc-schema.js';
import { readFields, Writer } from './grpc-wire.js';

// gRPC server reflection (v1, then v1alpha). The reflection messages and the FileDescriptorProto
// subset we need are encoded and decoded by hand: no generated code, no dependencies.

/** Sends one request message on a (bidirectional) method and collects the response messages. */
export type ReflectionTransport = (
  path: string,
  request: Buffer,
) => Promise<{
  readonly status: number;
  readonly statusMessage: string;
  readonly messages: Buffer[];
}>;

const SERVICES = [
  'grpc.reflection.v1.ServerReflection',
  'grpc.reflection.v1alpha.ServerReflection',
] as const;
const UNIMPLEMENTED = 12;

export class ReflectionClient {
  private version = 0;
  private readonly files = new Map<string, RawFile>();
  private readonly requested = new Set<string>();

  constructor(private readonly transport: ReflectionTransport) {}

  /** Service names, the reflection service itself left out. */
  async listServices(): Promise<string[]> {
    const response = await this.ask(7, '*');
    return nested(response, 6, 1)
      .map((service) => text(readFields(service), 1))
      .filter((name) => !name.startsWith('grpc.reflection.'));
  }

  /** The registry of the files that define the symbols, with every dependency. */
  async registry(symbols: readonly string[]): Promise<Registry> {
    for (const symbol of symbols) this.addFiles(await this.ask(4, symbol));
    for (let missing = this.missing(); missing.length > 0; missing = this.missing()) {
      for (const name of missing) {
        // Asked once: a file the server does not return surfaces as an unresolved type.
        this.requested.add(name);
        try {
          this.addFiles(await this.ask(3, name));
        } catch (error) {
          const builtin = builtinProto(name);
          if (!builtin) throw error;
          this.files.set(name, builtin);
        }
      }
    }
    return buildRegistry([...this.files.values()]);
  }

  private missing(): string[] {
    const needed = new Set<string>();
    for (const file of this.files.values()) {
      for (const dependency of file.imports) needed.add(dependency);
    }
    return [...needed].filter((name) => !this.files.has(name) && !this.requested.has(name));
  }

  private addFiles(response: Fields): void {
    for (const bytes of nested(response, 4, 1)) {
      const file = decodeFileDescriptor(bytes);
      this.files.set(file.name, file);
    }
  }

  /** One ServerReflectionRequest (`field` = which request) on its own stream. */
  private async ask(field: number, value: string): Promise<Fields> {
    const request = new Writer().tag(field, 2).string(value).finish();
    for (;;) {
      const service = SERVICES[this.version];
      if (!service) throw new Error('Server reflection is not available on this server');
      const result = await this.transport(`/${service}/ServerReflectionInfo`, request);
      if (result.status === UNIMPLEMENTED) {
        this.version++;
        continue;
      }
      if (result.status !== 0) {
        throw new Error(
          `Server reflection failed (status ${result.status}) ${result.statusMessage}`.trim(),
        );
      }
      // One request, one response; none at all reads as an empty response.
      const response = readFields(Buffer.concat(result.messages.slice(0, 1)));
      const error = buffers(response, 7)[0];
      if (error) throw new Error(`Server reflection: ${text(readFields(error), 2)} (${value})`);
      return response;
    }
  }
}

type Fields = Map<number, (bigint | Buffer)[]>;

/** A string field (empty when absent). */
function text(fields: Fields, number: number): string {
  return buffers(fields, number)
    .map((value) => value.toString('utf8'))
    .join('');
}

function buffers(fields: Fields, number: number): Buffer[] {
  return (fields.get(number) ?? []).filter((value) => Buffer.isBuffer(value));
}

/** The `inner` fields of every `outer` message field. */
function nested(fields: Fields, outer: number, inner: number): Buffer[] {
  return buffers(fields, outer).flatMap((message) => buffers(readFields(message), inner));
}

function int(fields: Fields, number: number): number | undefined {
  const value = fields.get(number)?.at(-1);
  return typeof value === 'bigint' ? Number(BigInt.asIntN(32, value)) : undefined;
}

/** FieldDescriptorProto.Type numbers to scalar names (11 message, 14 enum, 10 group). */
const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'double',
  2: 'float',
  3: 'int64',
  4: 'uint64',
  5: 'int32',
  6: 'fixed64',
  7: 'fixed32',
  8: 'bool',
  9: 'string',
  12: 'bytes',
  13: 'uint32',
  15: 'sfixed32',
  16: 'sfixed64',
  17: 'sint32',
  18: 'sint64',
};

/** Decodes the FileDescriptorProto fields that matter for JSON encoding and calls. */
export function decodeFileDescriptor(bytes: Buffer): RawFile {
  const fields = readFields(bytes);
  const syntax = text(fields, 12);
  return {
    name: text(fields, 1),
    package: text(fields, 2),
    syntax: syntax === 'proto3' || syntax === 'editions' ? syntax : 'proto2',
    imports: buffers(fields, 3).map((dependency) => dependency.toString('utf8')),
    messages: buffers(fields, 4).map(decodeMessage),
    enums: buffers(fields, 5).map(decodeEnum),
    services: buffers(fields, 6).map(decodeService),
  };
}

function decodeMessage(bytes: Buffer): RawMessage {
  const fields = readFields(bytes);
  const oneofs = buffers(fields, 8).map((oneof) => text(readFields(oneof), 1));
  return {
    name: text(fields, 1),
    fields: buffers(fields, 2)
      .map((field) => decodeField(field, oneofs))
      .filter((field) => field !== undefined),
    messages: buffers(fields, 3).map(decodeMessage),
    enums: buffers(fields, 4).map(decodeEnum),
    mapEntry: buffers(fields, 7).some((options) => int(readFields(options), 7) === 1),
  };
}

const LABELS: Readonly<Record<number, RawField['label']>> = {
  1: 'optional',
  2: 'required',
  3: 'repeated',
};

function decodeField(bytes: Buffer, oneofs: readonly string[]): RawField | undefined {
  const fields = readFields(bytes);
  const typeNumber = int(fields, 5);
  // Groups (10) are dropped; message (11) and enum (14) fields carry an absolute type name.
  if (typeNumber === 10) return undefined;
  const oneof = oneofs[int(fields, 9) ?? -1];
  const jsonName = text(fields, 10);
  const packed = buffers(fields, 8)
    .map((options) => int(readFields(options), 2))
    .find((value) => value !== undefined);
  return {
    name: text(fields, 1),
    number: int(fields, 3) ?? 0,
    type: TYPE_NAMES[typeNumber ?? 0] ?? text(fields, 6),
    label: LABELS[int(fields, 4) ?? 1],
    ...(jsonName ? { jsonName } : {}),
    ...(oneof !== undefined ? { oneof } : {}),
    ...(int(fields, 17) === 1 ? { proto3Optional: true } : {}),
    ...(packed !== undefined ? { packed: packed === 1 } : {}),
  };
}

function decodeEnum(bytes: Buffer): RawEnum {
  const fields = readFields(bytes);
  return {
    name: text(fields, 1),
    values: buffers(fields, 2).map((value) => {
      const valueFields = readFields(value);
      return { name: text(valueFields, 1), number: int(valueFields, 2) ?? 0 };
    }),
  };
}

function decodeService(bytes: Buffer): RawService {
  const fields = readFields(bytes);
  return {
    name: text(fields, 1),
    methods: buffers(fields, 2).map((method): RawMethod => {
      const methodFields = readFields(method);
      return {
        name: text(methodFields, 1),
        input: text(methodFields, 2),
        output: text(methodFields, 3),
        clientStreaming: int(methodFields, 5) === 1,
        serverStreaming: int(methodFields, 6) === 1,
      };
    }),
  };
}
