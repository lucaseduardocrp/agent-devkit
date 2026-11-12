import type { FieldInfo, MessageInfo, Registry, ScalarType } from './grpc-schema.js';
import {
  Reader,
  WIRE_BYTES,
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_VARINT,
  Writer,
} from './grpc-wire.js';

// Protobuf binary <-> proto3 JSON mapping. 64-bit integers are decimal strings, bytes base64,
// enums names; fields without presence are always written out so the full shape is visible.

type Json = unknown;
type JsonObject = Record<string, unknown>;

const WKT = 'google.protobuf.';
const WRAPPERS: ReadonlySet<string> = new Set(
  [
    'DoubleValue',
    'FloatValue',
    'Int64Value',
    'UInt64Value',
    'Int32Value',
    'UInt32Value',
    'BoolValue',
    'StringValue',
    'BytesValue',
  ].map((name) => WKT + name),
);

/** Well-known types whose JSON form is not an object of their fields. */
const SPECIAL_JSON: ReadonlySet<string> = new Set([
  ...WRAPPERS,
  `${WKT}Timestamp`,
  `${WKT}Duration`,
  `${WKT}Struct`,
  `${WKT}Value`,
  `${WKT}ListValue`,
  `${WKT}FieldMask`,
  `${WKT}Any`,
]);

/** Encodes a JSON value (proto3 JSON mapping) as a message of `typeName`. */
export function encodeMessage(registry: Registry, typeName: string, value: Json): Buffer {
  const writer = new Writer();
  writeMessage(writer, registry, registry.message(typeName), value);
  return writer.finish();
}

/** Decodes a message of `typeName` to its JSON value. Unknown fields are skipped. */
export function decodeMessage(registry: Registry, typeName: string, bytes: Buffer): Json {
  return readMessage(registry, registry.message(typeName), bytes);
}

function writeMessage(writer: Writer, registry: Registry, message: MessageInfo, value: Json): void {
  const plain = SPECIAL_JSON.has(message.fullName)
    ? wktToPlain(registry, message.fullName, value)
    : value;
  if (plain === null || plain === undefined) return;
  if (typeof plain !== 'object' || Array.isArray(plain)) {
    throw new Error(`${message.fullName} expects a JSON object, got ${describe(plain)}`);
  }
  for (const [key, fieldValue] of Object.entries(plain)) {
    const field = message.byName.get(key);
    if (!field) throw new Error(`Unknown field "${key}" in ${message.fullName}`);
    if (fieldValue === null && field.type !== `${WKT}Value`) continue;
    if (field.map) writeMap(writer, registry, field, field.map, fieldValue);
    else if (field.repeated) writeRepeated(writer, registry, field, fieldValue);
    else writeField(writer, registry, field, fieldValue);
  }
}

function writeMap(
  writer: Writer,
  registry: Registry,
  field: FieldInfo,
  map: NonNullable<FieldInfo['map']>,
  value: Json,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Field ${field.jsonName} expects a JSON object (map)`);
  }
  for (const [key, entryValue] of Object.entries(value)) {
    const entry = new Writer();
    writeField(entry, registry, map.key, mapKey(map.key, key));
    if (entryValue !== null || map.value.type === `${WKT}Value`) {
      writeField(entry, registry, map.value, entryValue);
    }
    writer.tag(field.number, WIRE_BYTES).bytes(entry.finish());
  }
}

function mapKey(field: FieldInfo, key: string): Json {
  if (field.type === 'bool') return key === 'true';
  return key;
}

function writeRepeated(writer: Writer, registry: Registry, field: FieldInfo, value: Json): void {
  if (!Array.isArray(value)) throw new Error(`Field ${field.jsonName} expects a JSON array`);
  if (field.packed) {
    const packed = new Writer();
    for (const item of value) writeValue(packed, registry, field, item);
    writer.tag(field.number, WIRE_BYTES).bytes(packed.finish());
    return;
  }
  for (const item of value) writeField(writer, registry, field, item);
}

function writeField(writer: Writer, registry: Registry, field: FieldInfo, value: Json): void {
  writer.tag(field.number, wireTypeOf(field));
  writeValue(writer, registry, field, value);
}

function wireTypeOf(field: FieldInfo): number {
  if (field.kind === 'message') return WIRE_BYTES;
  if (field.kind === 'enum') return WIRE_VARINT;
  switch (field.type as ScalarType) {
    case 'double':
    case 'fixed64':
    case 'sfixed64':
      return WIRE_FIXED64;
    case 'float':
    case 'fixed32':
    case 'sfixed32':
      return WIRE_FIXED32;
    case 'string':
    case 'bytes':
      return WIRE_BYTES;
    default:
      return WIRE_VARINT;
  }
}

/** Writes the value without its tag. */
function writeValue(writer: Writer, registry: Registry, field: FieldInfo, value: Json): void {
  if (field.kind === 'message') {
    const nested = new Writer();
    writeMessage(nested, registry, registry.message(field.type), value);
    writer.bytes(nested.finish());
    return;
  }
  if (field.kind === 'enum') {
    writer.varint(enumNumber(registry, field, value));
    return;
  }
  const type = field.type as ScalarType;
  switch (type) {
    case 'string':
      if (typeof value !== 'string') throw invalid(field, value);
      writer.string(value);
      return;
    case 'bytes':
      if (typeof value !== 'string') throw invalid(field, value);
      writer.bytes(Buffer.from(value, 'base64'));
      return;
    case 'bool':
      writer.varint(toBool(field, value) ? 1 : 0);
      return;
    case 'double':
    case 'float': {
      const buf = Buffer.alloc(type === 'double' ? 8 : 4);
      if (type === 'double') buf.writeDoubleLE(toFloat(field, value));
      else buf.writeFloatLE(toFloat(field, value));
      writer.raw(buf);
      return;
    }
    case 'fixed32':
    case 'sfixed32': {
      const buf = Buffer.alloc(4);
      const n = toInteger(field, value, 32, type === 'sfixed32');
      if (type === 'fixed32') buf.writeUInt32LE(Number(n));
      else buf.writeInt32LE(Number(n));
      writer.raw(buf);
      return;
    }
    case 'fixed64':
    case 'sfixed64': {
      const buf = Buffer.alloc(8);
      const n = toInteger(field, value, 64, type === 'sfixed64');
      if (type === 'fixed64') buf.writeBigUInt64LE(n);
      else buf.writeBigInt64LE(n);
      writer.raw(buf);
      return;
    }
    case 'sint32':
    case 'sint64': {
      const n = toInteger(field, value, type === 'sint32' ? 32 : 64, true);
      writer.varint(n >= 0n ? n * 2n : -n * 2n - 1n);
      return;
    }
    case 'int32':
    case 'int64':
      writer.varint(toInteger(field, value, type === 'int32' ? 32 : 64, true));
      return;
    case 'uint32':
    case 'uint64':
      writer.varint(toInteger(field, value, type === 'uint32' ? 32 : 64, false));
      return;
  }
}

function enumNumber(registry: Registry, field: FieldInfo, value: Json): number {
  const info = registry.enum(field.type);
  if (value === null && field.type === `${WKT}NullValue`) return 0;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const number = info.byName.get(value);
    if (number !== undefined) return number;
    if (/^-?\d+$/.test(value)) return Number(value);
  }
  throw new Error(
    `Invalid value ${describe(value)} for enum field ${field.jsonName} (${info.fullName}); ` +
      `expected one of ${info.values.map((v) => v.name).join(', ')}`,
  );
}

function toInteger(field: FieldInfo, value: Json, bits: 32 | 64, signed: boolean): bigint {
  let n: bigint;
  if (typeof value === 'number' && Number.isInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) n = BigInt(value.trim());
  else if (typeof value === 'string' && Number.isInteger(Number(value)) && value.trim() !== '') {
    n = BigInt(Number(value));
  } else throw invalid(field, value);
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (n < min || n > max) throw new Error(`Value ${n} is out of range for field ${field.jsonName}`);
  return n;
}

function toFloat(field: FieldInfo, value: Json): number {
  if (typeof value === 'number') return value;
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  throw invalid(field, value);
}

function toBool(field: FieldInfo, value: Json): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw invalid(field, value);
}

function invalid(field: FieldInfo, value: Json): Error {
  return new Error(`Invalid value ${describe(value)} for ${field.type} field ${field.jsonName}`);
}

function describe(value: Json): string {
  const text = String(JSON.stringify(value));
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function readMessage(registry: Registry, message: MessageInfo, bytes: Buffer): Json {
  const values = new Map<FieldInfo, unknown>();
  const chunks = new Map<FieldInfo, Buffer[]>();
  const lists = new Map<FieldInfo, unknown[]>();
  const maps = new Map<FieldInfo, JsonObject>();
  const setSingular = (field: FieldInfo): void => {
    if (field.oneof === undefined) return;
    for (const other of message.fields) {
      if (other.oneof === field.oneof && other !== field) {
        values.delete(other);
        chunks.delete(other);
      }
    }
  };

  const reader = new Reader(bytes);
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.tag();
    const field = message.byNumber.get(fieldNumber);
    if (!field) {
      reader.skip(wireType, fieldNumber);
      continue;
    }
    if (field.map && wireType === WIRE_BYTES) {
      const entry = readMessage(
        registry,
        registry.message(field.type),
        reader.bytes(),
      ) as JsonObject;
      const map = maps.get(field) ?? {};
      // A message value left out of the entry is the empty message, not nothing.
      const valueType = field.map.value.kind === 'message' ? field.map.value.type : undefined;
      map[String(entry.key)] =
        'value' in entry || valueType === undefined
          ? entry.value
          : readMessage(registry, registry.message(valueType), Buffer.alloc(0));
      maps.set(field, map);
    } else if (field.kind === 'message' && wireType === WIRE_BYTES) {
      const payload = reader.bytes();
      if (field.repeated) {
        const list = lists.get(field) ?? [];
        list.push(readMessage(registry, registry.message(field.type), payload));
        lists.set(field, list);
      } else {
        setSingular(field);
        // Repeated occurrences of a singular message merge, which concatenation does.
        chunks.set(field, [...(chunks.get(field) ?? []), payload]);
      }
    } else if (field.repeated && wireType === WIRE_BYTES && wireTypeOf(field) !== WIRE_BYTES) {
      const packed = new Reader(reader.bytes());
      const list = lists.get(field) ?? [];
      while (!packed.done()) list.push(readValue(registry, field, packed, wireTypeOf(field)));
      lists.set(field, list);
    } else if (field.kind !== 'message' && wireType === wireTypeOf(field)) {
      const value = readValue(registry, field, reader, wireType);
      if (field.repeated) {
        const list = lists.get(field) ?? [];
        list.push(value);
        lists.set(field, list);
      } else {
        setSingular(field);
        values.set(field, value);
      }
    } else reader.skip(wireType, fieldNumber);
  }

  const out: JsonObject = {};
  for (const field of message.fields) {
    const chunk = chunks.get(field);
    if (field.map) out[field.jsonName] = maps.get(field) ?? {};
    else if (field.repeated) out[field.jsonName] = lists.get(field) ?? [];
    else if (chunk) {
      out[field.jsonName] = readMessage(
        registry,
        registry.message(field.type),
        Buffer.concat(chunk),
      );
    } else if (values.has(field)) out[field.jsonName] = values.get(field);
    else if (!field.presence) out[field.jsonName] = defaultValue(registry, field);
  }
  return SPECIAL_JSON.has(message.fullName) ? wktFromPlain(registry, message.fullName, out) : out;
}

function readValue(registry: Registry, field: FieldInfo, reader: Reader, wireType: number): Json {
  if (field.kind === 'enum') {
    const number = Number(BigInt.asIntN(32, reader.varint()));
    if (field.type === `${WKT}NullValue`) return null;
    return registry.enum(field.type).byNumber.get(number) ?? number;
  }
  if (wireType === WIRE_FIXED32) {
    const buf = reader.take(4);
    if (field.type === 'float') return floatJson(buf.readFloatLE(0), true);
    return field.type === 'sfixed32' ? buf.readInt32LE(0) : buf.readUInt32LE(0);
  }
  if (wireType === WIRE_FIXED64) {
    const buf = reader.take(8);
    if (field.type === 'double') return floatJson(buf.readDoubleLE(0), false);
    return String(field.type === 'sfixed64' ? buf.readBigInt64LE(0) : buf.readBigUInt64LE(0));
  }
  if (wireType === WIRE_BYTES) {
    const buf = reader.bytes();
    return field.type === 'string' ? buf.toString('utf8') : buf.toString('base64');
  }
  const raw = reader.varint();
  switch (field.type as ScalarType) {
    case 'bool':
      return raw !== 0n;
    case 'int32':
      return Number(BigInt.asIntN(32, raw));
    case 'uint32':
      return Number(BigInt.asUintN(32, raw));
    case 'int64':
      return String(BigInt.asIntN(64, raw));
    case 'sint32':
    case 'sint64': {
      const n = (raw >> 1n) ^ -(raw & 1n);
      return field.type === 'sint32' ? Number(BigInt.asIntN(32, n)) : String(BigInt.asIntN(64, n));
    }
    default:
      return String(raw);
  }
}

/** NaN and infinities are strings in JSON; floats print their shortest exact form. */
function floatJson(value: number, single: boolean): Json {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (!single) return value;
  // 9 significant digits always round trip a float32, so the loop ends by then.
  let digits = 1;
  let short = Number(value.toPrecision(digits));
  while (Math.fround(short) !== value) short = Number(value.toPrecision(++digits));
  return short;
}

function defaultValue(registry: Registry, field: FieldInfo): Json {
  if (field.kind === 'enum') {
    if (field.type === `${WKT}NullValue`) return null;
    const info = registry.enum(field.type);
    return info.byNumber.get(0) ?? info.values[0]?.name ?? 0;
  }
  // Message fields always have presence, so they never get a default here.
  switch (field.type as ScalarType) {
    case 'string':
    case 'bytes':
      return '';
    case 'bool':
      return false;
    case 'int64':
    case 'uint64':
    case 'sint64':
    case 'fixed64':
    case 'sfixed64':
      return '0';
    default:
      return 0;
  }
}

// --- Well-known types -------------------------------------------------------------------------

function wktToPlain(registry: Registry, typeName: string, value: Json): Json {
  if (WRAPPERS.has(typeName)) return value === null ? null : { value };
  switch (typeName) {
    case `${WKT}Timestamp`:
      return typeof value === 'string' ? parseTimestamp(value) : value;
    case `${WKT}Duration`:
      return typeof value === 'string' ? parseDuration(value) : value;
    case `${WKT}FieldMask`:
      return typeof value === 'string'
        ? { paths: value === '' ? [] : value.split(',').map((path) => snakeCase(path.trim())) }
        : value;
    case `${WKT}Struct`:
      return { fields: value };
    case `${WKT}ListValue`:
      return { values: value };
    case `${WKT}Value`:
      return valueToPlain(value);
    default: // Any: the last special type
      return anyToPlain(registry, value);
  }
}

function valueToPlain(value: Json): JsonObject {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'number') return { numberValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) return { listValue: value };
  if (typeof value === 'object') return { structValue: value };
  throw new Error(`Invalid google.protobuf.Value ${describe(value)}`);
}

function anyToPlain(registry: Registry, value: Json): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('google.protobuf.Any expects an object with "@type"');
  }
  const { '@type': typeUrl, ...rest } = value as JsonObject;
  if (typeof typeUrl !== 'string') throw new Error('google.protobuf.Any needs "@type"');
  const typeName = typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
  if (!registry.messages.has(typeName)) {
    // An unknown type can still be sent as its already encoded bytes.
    if (typeof rest.value === 'string') return { typeUrl, value: rest.value };
    throw new Error(`Type ${typeName} of google.protobuf.Any not found`);
  }
  const payload = SPECIAL_JSON.has(typeName) ? rest.value : rest;
  return { typeUrl, value: encodeMessage(registry, typeName, payload).toString('base64') };
}

function wktFromPlain(registry: Registry, typeName: string, plain: JsonObject): Json {
  if (WRAPPERS.has(typeName)) return plain.value;
  switch (typeName) {
    case `${WKT}Timestamp`:
      return formatTimestamp(String(plain.seconds), Number(plain.nanos));
    case `${WKT}Duration`:
      return formatDuration(BigInt(String(plain.seconds)), Number(plain.nanos));
    case `${WKT}FieldMask`:
      return (plain.paths as string[]).map(lowerCamel).join(',');
    case `${WKT}Struct`:
      return plain.fields;
    case `${WKT}ListValue`:
      return plain.values;
    case `${WKT}Value`: {
      const set = Object.entries(plain).find(([, v]) => v !== undefined);
      return set ? set[1] : null;
    }
    default: // Any: the last special type
      return anyFromPlain(registry, String(plain.typeUrl), String(plain.value));
  }
}

function anyFromPlain(registry: Registry, typeUrl: string, base64: string): Json {
  if (typeUrl === '') return {};
  const typeName = typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
  if (!registry.messages.has(typeName)) return { '@type': typeUrl, value: base64 };
  const decoded = decodeMessage(registry, typeName, Buffer.from(base64, 'base64'));
  return SPECIAL_JSON.has(typeName)
    ? { '@type': typeUrl, value: decoded }
    : { '@type': typeUrl, ...(decoded as JsonObject) };
}

const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

function parseTimestamp(text: string): JsonObject {
  const match = TIMESTAMP.exec(text.trim());
  const millis = match
    ? Date.parse(`${match[1]}T${match[2]}${String(match[4]).toUpperCase()}`)
    : NaN;
  if (!match || Number.isNaN(millis)) {
    throw new Error(`Invalid google.protobuf.Timestamp "${text}" (RFC 3339 expected)`);
  }
  return { seconds: String(millis / 1000), nanos: Number((match[3] ?? '').padEnd(9, '0')) };
}

function formatTimestamp(seconds: string, nanos: number): string {
  const iso = new Date(Number(seconds) * 1000).toISOString();
  return `${iso.slice(0, 19)}${fraction(nanos)}Z`;
}

function parseDuration(text: string): JsonObject {
  const match = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(text.trim());
  if (!match) throw new Error(`Invalid google.protobuf.Duration "${text}" (e.g. "1.5s")`);
  const sign = match[1] ? -1 : 1;
  const seconds = BigInt(String(match[2])) * BigInt(sign);
  const nanos = Number((match[3] ?? '').padEnd(9, '0')) * sign;
  return { seconds: String(seconds), nanos };
}

function formatDuration(seconds: bigint, nanos: number): string {
  const negative = seconds < 0n || nanos < 0;
  const abs = seconds < 0n ? -seconds : seconds;
  return `${negative ? '-' : ''}${abs}${fraction(Math.abs(nanos))}s`;
}

/** 0, 3, 6 or 9 fractional digits, as the JSON mapping prints them. */
function fraction(nanos: number): string {
  if (!nanos) return '';
  const digits = String(nanos).padStart(9, '0');
  if (digits.endsWith('000000')) return `.${digits.slice(0, 3)}`;
  if (digits.endsWith('000')) return `.${digits.slice(0, 6)}`;
  return `.${digits}`;
}

function snakeCase(path: string): string {
  return path.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function lowerCamel(path: string): string {
  return path.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}
