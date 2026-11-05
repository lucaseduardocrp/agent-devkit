import type { FieldInfo, Registry } from './grpc-schema.js';

// Example request messages: every field with a representative value, so users see the shape.

const MAX_DEPTH = 3;
const WKT = 'google.protobuf.';

const WKT_EXAMPLES: Readonly<Record<string, unknown>> = {
  [`${WKT}Timestamp`]: '1970-01-01T00:00:00Z',
  [`${WKT}Duration`]: '0s',
  [`${WKT}Struct`]: {},
  [`${WKT}Value`]: null,
  [`${WKT}ListValue`]: [],
  [`${WKT}Empty`]: {},
  [`${WKT}FieldMask`]: '',
  [`${WKT}Any`]: { '@type': `type.googleapis.com/${WKT}Empty` },
  [`${WKT}DoubleValue`]: 0,
  [`${WKT}FloatValue`]: 0,
  [`${WKT}Int64Value`]: '0',
  [`${WKT}UInt64Value`]: '0',
  [`${WKT}Int32Value`]: 0,
  [`${WKT}UInt32Value`]: 0,
  [`${WKT}BoolValue`]: false,
  [`${WKT}StringValue`]: 'string',
  [`${WKT}BytesValue`]: '',
};

/** A message of `typeName` with every field set; only the first field of each oneof. */
export function exampleMessage(registry: Registry, typeName: string, depth = 0): unknown {
  if (typeName in WKT_EXAMPLES) return WKT_EXAMPLES[typeName];
  // Recursive messages stop growing past a few levels.
  if (depth > MAX_DEPTH) return {};
  const message = registry.message(typeName);
  const out: Record<string, unknown> = {};
  const oneofs = new Set<string>();
  for (const field of message.fields) {
    if (field.oneof !== undefined) {
      if (oneofs.has(field.oneof)) continue;
      oneofs.add(field.oneof);
    }
    if (field.map) {
      const key = exampleValue(registry, field.map.key, depth);
      out[field.jsonName] = { [String(key)]: exampleValue(registry, field.map.value, depth) };
    } else {
      const value = exampleValue(registry, field, depth);
      out[field.jsonName] = field.repeated ? [value] : value;
    }
  }
  return out;
}

function exampleValue(registry: Registry, field: FieldInfo, depth: number): unknown {
  if (field.kind === 'message') {
    return exampleMessage(registry, field.type, depth + 1);
  }
  if (field.kind === 'enum') {
    if (field.type === `${WKT}NullValue`) return null;
    return registry.enum(field.type).values[0]?.name ?? 0;
  }
  switch (field.type) {
    case 'string':
      return 'string';
    case 'bytes':
      return Buffer.from('bytes').toString('base64');
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
