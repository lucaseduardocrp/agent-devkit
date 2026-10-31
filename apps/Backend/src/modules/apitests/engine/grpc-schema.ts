// Protobuf schema: files as parsed (.proto text) or described (server reflection), and the
// registry of resolved messages, enums and services the codec and the client work with.

export const SCALAR_TYPES = [
  'double',
  'float',
  'int64',
  'uint64',
  'int32',
  'fixed64',
  'fixed32',
  'bool',
  'string',
  'bytes',
  'uint32',
  'sfixed32',
  'sfixed64',
  'sint32',
  'sint64',
] as const;
export type ScalarType = (typeof SCALAR_TYPES)[number];

const SCALARS: ReadonlySet<string> = new Set(SCALAR_TYPES);

export function isScalar(type: string): type is ScalarType {
  return SCALARS.has(type);
}

export type Syntax = 'proto2' | 'proto3' | 'editions';

export interface RawField {
  readonly name: string;
  readonly number: number;
  readonly label?: 'optional' | 'required' | 'repeated';
  /** A scalar type name, or a message/enum reference (relative, or absolute with a leading dot). */
  readonly type: string;
  readonly jsonName?: string;
  readonly oneof?: string;
  /** proto3 `optional`: explicit presence. */
  readonly proto3Optional?: boolean;
  readonly packed?: boolean;
}

export interface RawEnum {
  readonly name: string;
  readonly values: readonly { readonly name: string; readonly number: number }[];
}

export interface RawMessage {
  readonly name: string;
  readonly fields: readonly RawField[];
  readonly messages: readonly RawMessage[];
  readonly enums: readonly RawEnum[];
  readonly mapEntry?: boolean;
}

export interface RawMethod {
  readonly name: string;
  readonly input: string;
  readonly output: string;
  readonly clientStreaming: boolean;
  readonly serverStreaming: boolean;
}

export interface RawService {
  readonly name: string;
  readonly methods: readonly RawMethod[];
}

export interface RawFile {
  readonly name: string;
  readonly package: string;
  readonly syntax: Syntax;
  readonly imports: readonly string[];
  readonly messages: readonly RawMessage[];
  readonly enums: readonly RawEnum[];
  readonly services: readonly RawService[];
}

export interface FieldInfo {
  /** Name as declared (snake_case usually). */
  readonly name: string;
  /** lowerCamel JSON name. */
  readonly jsonName: string;
  readonly number: number;
  readonly repeated: boolean;
  readonly packed: boolean;
  readonly kind: 'scalar' | 'enum' | 'message';
  /** Scalar type name, or the full name (no leading dot) of the enum or message. */
  readonly type: string;
  readonly oneof?: string;
  /** Has explicit presence: left out of the JSON output when not set. */
  readonly presence: boolean;
  readonly map?: { readonly key: FieldInfo; readonly value: FieldInfo };
}

export interface MessageInfo {
  readonly fullName: string;
  readonly fields: readonly FieldInfo[];
  readonly byNumber: ReadonlyMap<number, FieldInfo>;
  /** By JSON name and declared name. */
  readonly byName: ReadonlyMap<string, FieldInfo>;
  readonly mapEntry: boolean;
}

export interface EnumInfo {
  readonly fullName: string;
  readonly values: readonly { readonly name: string; readonly number: number }[];
  readonly byName: ReadonlyMap<string, number>;
  /** First name of each number (aliases share numbers). */
  readonly byNumber: ReadonlyMap<number, string>;
}

export interface MethodInfo {
  readonly name: string;
  /** `package.Service/Method`. */
  readonly path: string;
  readonly input: string;
  readonly output: string;
  readonly clientStreaming: boolean;
  readonly serverStreaming: boolean;
}

export interface ServiceInfo {
  readonly fullName: string;
  /** Name of the file that declares it. */
  readonly file: string;
  readonly methods: readonly MethodInfo[];
}

export class Registry {
  constructor(
    readonly messages: ReadonlyMap<string, MessageInfo>,
    readonly enums: ReadonlyMap<string, EnumInfo>,
    readonly services: ReadonlyMap<string, ServiceInfo>,
  ) {}

  message(fullName: string): MessageInfo {
    const found = this.messages.get(fullName);
    if (!found) throw new Error(`Message type ${fullName} not found`);
    return found;
  }

  enum(fullName: string): EnumInfo {
    const found = this.enums.get(fullName);
    if (!found) throw new Error(`Enum type ${fullName} not found`);
    return found;
  }

  /** `package.Service/Method`, with or without a leading slash. */
  method(path: string): MethodInfo | undefined {
    const [service = '', name = ''] = path.replace(/^\//, '').split('/');
    return this.services.get(service)?.methods.find((method) => method.name === name);
  }
}

/** protoc's default JSON name: underscores dropped, the next letter upper-cased. */
export function jsonNameOf(name: string): string {
  let out = '';
  let upper = false;
  for (const char of name) {
    if (char === '_') upper = true;
    else {
      out += upper ? char.toUpperCase() : char;
      upper = false;
    }
  }
  return out;
}

type SymbolKind = 'message' | 'enum';

interface PendingMessage {
  readonly fullName: string;
  readonly raw: RawMessage;
  readonly syntax: Syntax;
}

/**
 * Resolves the type references of the files (protobuf scoping: innermost scope first, a leading
 * dot is absolute). The first definition of a name wins.
 */
export function buildRegistry(files: readonly RawFile[]): Registry {
  const symbols = new Map<string, SymbolKind>();
  const pending: PendingMessage[] = [];
  const enums = new Map<string, EnumInfo>();

  const addEnum = (scope: string, raw: RawEnum): void => {
    const fullName = join(scope, raw.name);
    if (symbols.has(fullName)) return;
    symbols.set(fullName, 'enum');
    enums.set(fullName, enumInfo(fullName, raw));
  };
  const addMessage = (scope: string, raw: RawMessage, syntax: Syntax): void => {
    const fullName = join(scope, raw.name);
    if (symbols.has(fullName)) return;
    symbols.set(fullName, 'message');
    pending.push({ fullName, raw, syntax });
    raw.messages.forEach((nested) => addMessage(fullName, nested, syntax));
    raw.enums.forEach((nested) => addEnum(fullName, nested));
  };
  for (const file of files) {
    file.messages.forEach((message) => addMessage(file.package, message, file.syntax));
    file.enums.forEach((raw) => addEnum(file.package, raw));
  }

  const resolve = (ref: string, scope: string, usedBy: string): string => {
    const found = resolveName(symbols, ref, scope);
    if (!found) throw new Error(`Type "${ref}" not found (used by ${usedBy})`);
    return found;
  };

  const messages = new Map<string, MessageInfo>();
  const mutableFields = new Map<string, FieldInfo[]>();
  for (const { fullName, raw, syntax } of pending) {
    const fields = raw.fields.map((field) => {
      if (isScalar(field.type)) return fieldInfo(field, 'scalar', field.type, syntax);
      const type = resolve(field.type, fullName, `${fullName}.${field.name}`);
      return fieldInfo(field, symbols.get(type) as SymbolKind, type, syntax);
    });
    mutableFields.set(fullName, fields);
    messages.set(fullName, messageInfo(fullName, fields, raw.mapEntry === true));
  }
  // Map fields point at their synthetic entry messages, known only once every message is built.
  for (const [fullName, fields] of mutableFields) {
    let changed = false;
    const withMaps = fields.map((field) => {
      // Scalar type names are never message names, so only message fields find an entry.
      const entry = field.repeated ? messages.get(field.type) : undefined;
      if (!entry?.mapEntry) return field;
      changed = true;
      const key = entry.byNumber.get(1) as FieldInfo;
      const value = entry.byNumber.get(2) as FieldInfo;
      return { ...field, packed: false, map: { key, value } };
    });
    if (changed) messages.set(fullName, messageInfo(fullName, withMaps, false));
  }

  const services = new Map<string, ServiceInfo>();
  for (const file of files) {
    for (const service of file.services) {
      const fullName = join(file.package, service.name);
      if (services.has(fullName)) continue;
      const methods = service.methods.map((method) => {
        const usedBy = `${fullName}/${method.name}`;
        const input = resolve(method.input, file.package, usedBy);
        const output = resolve(method.output, file.package, usedBy);
        if (symbols.get(input) !== 'message' || symbols.get(output) !== 'message') {
          throw new Error(`${usedBy} must take and return message types`);
        }
        return { ...method, path: usedBy, input, output };
      });
      services.set(fullName, { fullName, file: file.name, methods });
    }
  }
  return new Registry(messages, enums, services);
}

function join(scope: string, name: string): string {
  return scope ? `${scope}.${name}` : name;
}

function resolveName(
  symbols: ReadonlyMap<string, SymbolKind>,
  ref: string,
  scope: string,
): string | undefined {
  if (ref.startsWith('.')) return symbols.has(ref.slice(1)) ? ref.slice(1) : undefined;
  const parts = scope ? scope.split('.') : [];
  for (let i = parts.length; i >= 0; i--) {
    const candidate = join(parts.slice(0, i).join('.'), ref);
    if (symbols.has(candidate)) return candidate;
  }
  return undefined;
}

const UNPACKABLE: ReadonlySet<string> = new Set(['string', 'bytes']);

function fieldInfo(
  raw: RawField,
  kind: FieldInfo['kind'],
  type: string,
  syntax: Syntax,
): FieldInfo {
  const repeated = raw.label === 'repeated';
  const packable = repeated && kind !== 'message' && !UNPACKABLE.has(type);
  const oneof = raw.proto3Optional ? undefined : raw.oneof;
  const presence =
    !repeated &&
    (kind === 'message' ||
      oneof !== undefined ||
      raw.proto3Optional === true ||
      (syntax !== 'proto3' && raw.label !== undefined) ||
      syntax === 'editions');
  return {
    name: raw.name,
    jsonName: raw.jsonName ?? jsonNameOf(raw.name),
    number: raw.number,
    repeated,
    packed: packable && (raw.packed ?? syntax !== 'proto2'),
    kind,
    type,
    ...(oneof !== undefined ? { oneof } : {}),
    presence,
  };
}

function messageInfo(
  fullName: string,
  fields: readonly FieldInfo[],
  mapEntry: boolean,
): MessageInfo {
  const byNumber = new Map<number, FieldInfo>();
  const byName = new Map<string, FieldInfo>();
  for (const field of fields) {
    byNumber.set(field.number, field);
    byName.set(field.name, field);
    byName.set(field.jsonName, field);
  }
  return { fullName, fields, byNumber, byName, mapEntry };
}

function enumInfo(fullName: string, raw: RawEnum): EnumInfo {
  const byName = new Map<string, number>();
  const byNumber = new Map<number, string>();
  for (const value of raw.values) {
    byName.set(value.name, value.number);
    if (!byNumber.has(value.number)) byNumber.set(value.number, value.name);
  }
  return { fullName, values: raw.values, byName, byNumber };
}
