interface ZipFile {
  readonly path: string;
  readonly content: string;
}

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  writeU16(target, offset, value & 0xffff);
  writeU16(target, offset + 2, value >>> 16);
}

/** Creates a standards-compliant, uncompressed ZIP archive without a runtime dependency. */
export function createSuiteZip(files: readonly ZipFile[]): Blob {
  const entries = files.map((file) => ({
    name: encoder.encode(file.path),
    data: encoder.encode(file.content),
  }));
  const localSize = entries.reduce(
    (size, entry) => size + 30 + entry.name.length + entry.data.length,
    0,
  );
  const centralSize = entries.reduce((size, entry) => size + 46 + entry.name.length, 0);
  const archive = new Uint8Array(localSize + centralSize + 22);
  let offset = 0;
  const records: {
    readonly offset: number;
    readonly name: Uint8Array;
    readonly data: Uint8Array;
  }[] = [];
  for (const entry of entries) {
    const localOffset = offset;
    const checksum = crc32(entry.data);
    writeU32(archive, offset, 0x04034b50);
    writeU16(archive, offset + 4, 20);
    writeU16(archive, offset + 6, 0x0800);
    writeU16(archive, offset + 8, 0);
    writeU32(archive, offset + 14, checksum);
    writeU32(archive, offset + 18, entry.data.length);
    writeU32(archive, offset + 22, entry.data.length);
    writeU16(archive, offset + 26, entry.name.length);
    archive.set(entry.name, offset + 30);
    archive.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
    records.push({ offset: localOffset, name: entry.name, data: entry.data });
  }
  const centralOffset = offset;
  for (const record of records) {
    const checksum = crc32(record.data);
    writeU32(archive, offset, 0x02014b50);
    writeU16(archive, offset + 4, 20);
    writeU16(archive, offset + 6, 20);
    writeU16(archive, offset + 8, 0x0800);
    writeU16(archive, offset + 10, 0);
    writeU32(archive, offset + 16, checksum);
    writeU32(archive, offset + 20, record.data.length);
    writeU32(archive, offset + 24, record.data.length);
    writeU16(archive, offset + 28, record.name.length);
    writeU32(archive, offset + 42, record.offset);
    archive.set(record.name, offset + 46);
    offset += 46 + record.name.length;
  }
  writeU32(archive, offset, 0x06054b50);
  writeU16(archive, offset + 8, records.length);
  writeU16(archive, offset + 10, records.length);
  writeU32(archive, offset + 12, centralSize);
  writeU32(archive, offset + 16, centralOffset);
  return new Blob([archive], { type: 'application/zip' });
}
