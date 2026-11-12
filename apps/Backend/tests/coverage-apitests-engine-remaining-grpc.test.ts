import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '../src/modules/apitests/engine/grpc-codec.js';
import { loadProtoFiles } from '../src/modules/apitests/engine/grpc-proto.js';

const PROTO = `syntax = "proto3"; package rem;
import "google/protobuf/wrappers.proto";
import "google/protobuf/struct.proto";
message Nulls { repeated google.protobuf.NullValue items = 1; }
message Floats { float f = 1; repeated float list = 2; }
service Svc {
  rpc Call (Nulls) returns (Nulls) { option (opt) = { nested: { deep: 1 } }; }
}`;
const { registry } = loadProtoFiles([{ name: 'rem.proto', content: PROTO }]);

describe('grpc codec edge cases', () => {
  it('writes nothing for an undefined or null message value', () => {
    expect(encodeMessage(registry, 'rem.Nulls', undefined)).toHaveLength(0);
    expect(encodeMessage(registry, 'rem.Nulls', null)).toHaveLength(0);
    expect(encodeMessage(registry, 'google.protobuf.Int32Value', null)).toHaveLength(0);
  });

  it('round trips repeated NullValue entries', () => {
    const bytes = encodeMessage(registry, 'rem.Nulls', { items: [null, 'NULL_VALUE'] });
    expect(decodeMessage(registry, 'rem.Nulls', bytes)).toEqual({ items: [null, null] });
  });

  it('prints floats with their shortest exact digits', () => {
    const bytes = encodeMessage(registry, 'rem.Floats', { f: 0.1, list: [3.14159, 16777216] });
    expect(decodeMessage(registry, 'rem.Floats', bytes)).toEqual({
      f: 0.1,
      list: [3.14159, 16777216],
    });
  });

  it('skips nested braces in an rpc body while parsing', () => {
    expect(registry.message('rem.Nulls').byName.has('items')).toBe(true);
  });
});
