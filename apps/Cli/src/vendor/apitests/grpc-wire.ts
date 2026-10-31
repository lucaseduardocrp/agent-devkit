// Protobuf wire format: varints, tags and length-delimited fields. Node built-ins only.

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_START_GROUP = 3;
export const WIRE_END_GROUP = 4;
export const WIRE_FIXED32 = 5;

export class Writer {
  private readonly chunks: Buffer[] = [];

  tag(fieldNumber: number, wireType: number): this {
    return this.varint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
  }

  /** Negative values are written as their 64-bit two's complement (10 bytes), as protobuf does. */
  varint(value: bigint | number): this {
    let v = BigInt.asUintN(64, BigInt(value));
    const bytes: number[] = [];
    while (v > 0x7fn) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  raw(bytes: Uint8Array): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  /** A length-prefixed value. */
  bytes(bytes: Uint8Array): this {
    return this.varint(bytes.length).raw(bytes);
  }

  string(value: string): this {
    return this.bytes(Buffer.from(value, 'utf8'));
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class Reader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.buf[this.pos++];
      if (byte === undefined) throw new Error('Truncated protobuf message');
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, result);
      shift += 7n;
      if (shift > 70n) throw new Error('Malformed varint');
    }
  }

  tag(): { readonly fieldNumber: number; readonly wireType: number } {
    const tag = this.varint();
    return { fieldNumber: Number(tag >> 3n), wireType: Number(tag & 7n) };
  }

  take(length: number): Buffer {
    if (this.pos + length > this.buf.length) throw new Error('Truncated protobuf message');
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  bytes(): Buffer {
    return this.take(Number(this.varint()));
  }

  skip(wireType: number, fieldNumber: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.take(8);
        return;
      case WIRE_BYTES:
        this.bytes();
        return;
      case WIRE_FIXED32:
        this.take(4);
        return;
      case WIRE_START_GROUP:
        for (;;) {
          const tag = this.tag();
          if (tag.wireType === WIRE_END_GROUP) {
            if (tag.fieldNumber !== fieldNumber) throw new Error('Mismatched protobuf group');
            return;
          }
          this.skip(tag.wireType, tag.fieldNumber);
        }
      default:
        throw new Error(`Invalid protobuf wire type ${wireType}`);
    }
  }
}

/** Varint and length-delimited fields by number (the only kinds reflection messages use). */
export function readFields(buf: Buffer): Map<number, (bigint | Buffer)[]> {
  const fields = new Map<number, (bigint | Buffer)[]>();
  const reader = new Reader(buf);
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.tag();
    let value: bigint | Buffer;
    if (wireType === WIRE_VARINT) value = reader.varint();
    else if (wireType === WIRE_BYTES) value = reader.bytes();
    else {
      reader.skip(wireType, fieldNumber);
      continue;
    }
    const list = fields.get(fieldNumber) ?? [];
    list.push(value);
    fields.set(fieldNumber, list);
  }
  return fields;
}
