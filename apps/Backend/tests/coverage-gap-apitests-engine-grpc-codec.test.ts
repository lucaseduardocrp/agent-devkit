import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '../src/modules/apitests/engine/grpc-codec.js';
import { loadProtoFiles } from '../src/modules/apitests/engine/grpc-proto.js';

const WKT_IMPORTS = [
  'import "google/protobuf/timestamp.proto";',
  'import "google/protobuf/duration.proto";',
  'import "google/protobuf/field_mask.proto";',
  'import "google/protobuf/struct.proto";',
  'import "google/protobuf/wrappers.proto";',
  'import "google/protobuf/any.proto";',
].join('\n');

const registry = (source: string) =>
  loadProtoFiles([{ name: 'demo.proto', content: source }], 'demo.proto').registry;

describe('enum numbers and defaults', () => {
  const schema = registry(
    [
      'syntax = "proto3";',
      'package demo.v1;',
      'enum Color { RED = 0; GREEN = 1; }',
      'message Item { Color color = 1; }',
    ].join('\n'),
  );

  it('accepts a name, a numeric string and a plain number', () => {
    expect(decodeMessage(schema, 'demo.v1.Item', encodeMessage(schema, 'demo.v1.Item', { color: 'GREEN' }))).toEqual(
      { color: 'GREEN' },
    );
    expect(encodeMessage(schema, 'demo.v1.Item', { color: '1' })).toEqual(
      encodeMessage(schema, 'demo.v1.Item', { color: 1 }),
    );
  });

  it('defaults to the message with no fields set when the enum has no zero value', () => {
    const noZero = registry(
      [
        'syntax = "proto3";',
        'package demo.v1;',
        'enum Suit { SPADES = 1; HEARTS = 2; }',
        'message Card { Suit suit = 1; }',
      ].join('\n'),
    );
    expect(decodeMessage(noZero, 'demo.v1.Card', Buffer.alloc(0))).toEqual({ suit: 'SPADES' });
  });
});

describe('encoding and decoding every scalar type', () => {
  const schema = registry(
    [
      'syntax = "proto3";',
      'package demo.v1;',
      'message Scalars {',
      '  bool b = 1;',
      '  uint32 u32 = 2;',
      '  uint64 u64 = 3;',
      '  sint32 s32 = 4;',
      '  sint64 s64 = 5;',
      '  fixed32 f32 = 6;',
      '  float f = 7;',
      '  double d = 8;',
      '  sfixed32 sf32 = 9;',
      '  sfixed64 sf64 = 10;',
      '  bytes raw = 11;',
      '}',
    ].join('\n'),
  );

  it('round-trips every scalar, including negative sint and special floats', () => {
    const value = {
      b: true,
      u32: 1,
      u64: '9007199254740993',
      s32: -5,
      s64: '-5',
      f32: 1,
      sf32: -2,
      sf64: '-2',
      raw: Buffer.from('hi').toString('base64'),
    };
    expect(
      decodeMessage(
        schema,
        'demo.v1.Scalars',
        encodeMessage(schema, 'demo.v1.Scalars', { ...value, f: Infinity, d: -Infinity }),
      ),
    ).toEqual({ ...value, f: 'Infinity', d: '-Infinity' });
    expect(
      decodeMessage(
        schema,
        'demo.v1.Scalars',
        encodeMessage(schema, 'demo.v1.Scalars', { ...value, f: NaN }),
      ),
    ).toMatchObject({ f: 'NaN' });
  });

  it('defaults every absent scalar to its zero value', () => {
    expect(decodeMessage(schema, 'demo.v1.Scalars', Buffer.alloc(0))).toEqual({
      b: false,
      u32: 0,
      u64: '0',
      s32: 0,
      s64: '0',
      f32: 0,
      f: 0,
      d: 0,
      sf32: 0,
      sf64: '0',
      raw: '',
    });
  });

  it('leaves an absent nested message field out, since it always has explicit presence', () => {
    const nested = registry(
      ['syntax = "proto3";', 'package demo.v1;', 'message Inner {}', 'message Outer { Inner inner = 1; }'].join(
        '\n',
      ),
    );
    expect(decodeMessage(nested, 'demo.v1.Outer', Buffer.alloc(0))).toEqual({});
  });
});

describe('well-known types', () => {
  const wrapped = registry(
    [
      'syntax = "proto3";',
      'package demo.v1;',
      WKT_IMPORTS,
      'message Box {',
      '  google.protobuf.Int32Value maybe = 1;',
      '  google.protobuf.Timestamp at = 2;',
      '  google.protobuf.Duration spent = 3;',
      '  google.protobuf.FieldMask mask = 4;',
      '  google.protobuf.Struct data = 5;',
      '  google.protobuf.ListValue items = 6;',
      '  google.protobuf.Value any = 7;',
      '  google.protobuf.Any typed = 8;',
      '}',
    ].join('\n'),
  );

  it('round-trips a wrapper, including an explicit null', () => {
    expect(
      decodeMessage(wrapped, 'demo.v1.Box', encodeMessage(wrapped, 'demo.v1.Box', { maybe: 5 })),
    ).toMatchObject({ maybe: 5 });
    expect(encodeMessage(wrapped, 'demo.v1.Box', { maybe: null })).toEqual(Buffer.alloc(0));
  });

  it('round-trips a timestamp, a duration and a field mask', () => {
    const value = {
      at: '2026-01-01T00:00:00Z',
      spent: '1.500s',
      mask: 'user_name,other_field',
    };
    expect(decodeMessage(wrapped, 'demo.v1.Box', encodeMessage(wrapped, 'demo.v1.Box', value))).toMatchObject(
      { at: '2026-01-01T00:00:00Z', spent: '1.500s', mask: 'userName,otherField' },
    );
    // An empty field mask has no paths.
    expect(
      decodeMessage(wrapped, 'demo.v1.Box', encodeMessage(wrapped, 'demo.v1.Box', { mask: '' })),
    ).toMatchObject({ mask: '' });
  });

  it('round-trips a Struct and a ListValue', () => {
    const value = { data: { a: 1 }, items: [1, 'two'] };
    expect(decodeMessage(wrapped, 'demo.v1.Box', encodeMessage(wrapped, 'demo.v1.Box', value))).toEqual(
      value,
    );
  });

  it('round-trips every kind of google.protobuf.Value, and an unset one', () => {
    for (const any of [null, 1, 'text', true, [1, 2], { a: 1 }]) {
      expect(
        decodeMessage(wrapped, 'demo.v1.Box', encodeMessage(wrapped, 'demo.v1.Box', { any })),
      ).toEqual({ any });
    }
  });

  it('refuses an invalid google.protobuf.Value', () => {
    expect(() =>
      encodeMessage(wrapped, 'demo.v1.Box', { any: () => {} } as never),
    ).toThrow('Invalid google.protobuf.Value');
  });

  it('round-trips an Any of a known message type, and one of an unknown type sent pre-encoded', () => {
    // The Any's own fields are inlined at the top level alongside "@type", per the JSON mapping.
    const known = { typed: { '@type': 'type.googleapis.com/demo.v1.Box', maybe: 7 } };
    const roundTripped = decodeMessage(wrapped, 'demo.v1.Box', encodeMessage(wrapped, 'demo.v1.Box', known));
    expect((roundTripped as { typed: { maybe: number } }).typed).toMatchObject({ maybe: 7 });

    const raw = Buffer.from('anything').toString('base64');
    const unknown = { typed: { '@type': 'type.googleapis.com/demo.v1.Unknown', value: raw } };
    const encoded = encodeMessage(wrapped, 'demo.v1.Box', unknown);
    expect(
      (decodeMessage(wrapped, 'demo.v1.Box', encoded) as { typed: { value: string } }).typed.value,
    ).toBe(raw);
  });

  it('encodes an Any wrapping a null wrapper value as an empty embedded message', () => {
    // A null wrapper value writes no bytes at all for the embedded message; decoding it back
    // reads the wrapper's own default (0 for Int32Value).
    const encoded = encodeMessage(wrapped, 'demo.v1.Box', {
      typed: { '@type': 'type.googleapis.com/google.protobuf.Int32Value', value: null },
    });
    expect(
      (decodeMessage(wrapped, 'demo.v1.Box', encoded) as { typed: { value: number } }).typed.value,
    ).toBe(0);
  });

  it('refuses an Any with no @type and one of an unknown type with no pre-encoded value', () => {
    expect(() => encodeMessage(wrapped, 'demo.v1.Box', { typed: { foo: 1 } })).toThrow('needs "@type"');
    expect(() =>
      encodeMessage(wrapped, 'demo.v1.Box', {
        typed: { '@type': 'type.googleapis.com/demo.v1.Unknown', foo: 1 },
      }),
    ).toThrow('not found');
  });

  it('decodes a wire-explicit null_value, as a third-party encoder might send it', () => {
    // field 1 (null_value), wire type 0 (varint), value 0 — our own encoder skips this field
    // instead (a null field value is simply omitted), but a real peer may still send it.
    expect(decodeMessage(wrapped, 'google.protobuf.Value', Buffer.from([0x08, 0x00]))).toBeNull();
  });

  it('answers an empty object decoding an Any whose own type_url is absent', () => {
    // A message laid out exactly like google.protobuf.Any (same field numbers and wire types),
    // but under a plain name, so it can be encoded with "type_url" left unset.
    const fake = registry(
      ['syntax = "proto3";', 'package demo.v1;', 'message FakeAny { string type_url = 1; bytes value = 2; }'].join(
        '\n',
      ),
    );
    const bytes = encodeMessage(fake, 'demo.v1.FakeAny', { value: Buffer.from('x').toString('base64') });
    expect(decodeMessage(wrapped, 'google.protobuf.Any', bytes)).toEqual({});
  });
});
