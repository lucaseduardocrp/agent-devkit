import path from 'node:path';
import type { ProtoFile } from './types.js';
import {
  buildRegistry,
  type RawEnum,
  type RawField,
  type RawFile,
  type RawMessage,
  type RawMethod,
  type RawService,
  type Registry,
  type Syntax,
} from './grpc-schema.js';

// .proto parser (proto3 and the common proto2 subset). Options, reserved ranges, extensions and
// groups are read and dropped: they do not change how messages are encoded as JSON.

const WELL_KNOWN: Readonly<Record<string, string>> = {
  'google/protobuf/timestamp.proto':
    'syntax = "proto3"; package google.protobuf; message Timestamp { int64 seconds = 1; int32 nanos = 2; }',
  'google/protobuf/duration.proto':
    'syntax = "proto3"; package google.protobuf; message Duration { int64 seconds = 1; int32 nanos = 2; }',
  'google/protobuf/empty.proto': 'syntax = "proto3"; package google.protobuf; message Empty {}',
  'google/protobuf/struct.proto': `syntax = "proto3"; package google.protobuf;
    message Struct { map<string, Value> fields = 1; }
    message Value {
      oneof kind {
        NullValue null_value = 1; double number_value = 2; string string_value = 3;
        bool bool_value = 4; Struct struct_value = 5; ListValue list_value = 6;
      }
    }
    enum NullValue { NULL_VALUE = 0; }
    message ListValue { repeated Value values = 1; }`,
  'google/protobuf/wrappers.proto': `syntax = "proto3"; package google.protobuf;
    message DoubleValue { double value = 1; } message FloatValue { float value = 1; }
    message Int64Value { int64 value = 1; } message UInt64Value { uint64 value = 1; }
    message Int32Value { int32 value = 1; } message UInt32Value { uint32 value = 1; }
    message BoolValue { bool value = 1; } message StringValue { string value = 1; }
    message BytesValue { bytes value = 1; }`,
  'google/protobuf/any.proto':
    'syntax = "proto3"; package google.protobuf; message Any { string type_url = 1; bytes value = 2; }',
  'google/protobuf/field_mask.proto':
    'syntax = "proto3"; package google.protobuf; message FieldMask { repeated string paths = 1; }',
};

/** A bundled well-known type file (`google/protobuf/timestamp.proto`, ...). */
export function builtinProto(name: string): RawFile | undefined {
  const source = WELL_KNOWN[name];
  return source === undefined ? undefined : parseProto(name, source);
}

/**
 * Parses the entry file and everything it imports (every file when there is no entry) and
 * resolves their types. Imports match a file name, a path relative to the importing file, a
 * file whose name ends with the import path, or a bundled well-known type.
 */
export function loadProtoFiles(
  files: readonly ProtoFile[],
  entry?: string,
): { readonly registry: Registry; readonly entry?: string } {
  const byName = new Map(files.map((file) => [normalize(file.name), file]));
  const find = (name: string, from?: string): ProtoFile | undefined => {
    const wanted = normalize(name);
    const relative = from ? normalize(path.posix.join(path.posix.dirname(from), wanted)) : wanted;
    const exact = byName.get(wanted) ?? byName.get(relative);
    if (exact) return exact;
    const suffix = files.find((file) => normalize(file.name).endsWith(`/${wanted}`));
    if (suffix) return suffix;
    const builtin = WELL_KNOWN[wanted];
    return builtin === undefined ? undefined : { name: wanted, content: builtin };
  };

  let entryName: string | undefined;
  const queue: ProtoFile[] = [...files];
  if (entry !== undefined) {
    const found = find(entry);
    if (!found) throw new Error(`Proto file "${entry}" not found`);
    entryName = normalize(found.name);
    queue.splice(0, queue.length, found);
  }
  const parsed = new Map<string, RawFile>();
  for (let file = queue.shift(); file; file = queue.shift()) {
    const name = normalize(file.name);
    if (parsed.has(name)) continue;
    const raw = parseProto(name, file.content);
    parsed.set(name, raw);
    for (const imported of raw.imports) {
      const found = find(imported, name);
      if (!found) throw new Error(`Import "${imported}" not found (imported by ${name})`);
      queue.push(found);
    }
  }
  const registry = buildRegistry([...parsed.values()]);
  return entryName === undefined ? { registry } : { registry, entry: entryName };
}

function normalize(name: string): string {
  return path.posix.normalize(name.replace(/\\/g, '/')).replace(/^(\.\/)+/, '');
}

interface Token {
  readonly kind: 'ident' | 'number' | 'string' | 'symbol';
  readonly value: string;
  readonly line: number;
}

const IDENT = /\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/y;
const NUMBER = /(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y;

function tokenize(source: string, file: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const match = (regex: RegExp): string | undefined => {
    regex.lastIndex = i;
    return regex.exec(source)?.[0];
  };
  while (i < source.length) {
    const char = source.charAt(i);
    const ident = match(IDENT);
    if (char === '\n') {
      line++;
      i++;
    } else if (/\s/.test(char)) {
      i++;
    } else if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += source.slice(i, stop).split('\n').length - 1;
      i = stop;
    } else if (char === '"' || char === "'") {
      const [value, next] = readString(source, i, file, line);
      tokens.push({ kind: 'string', value, line });
      i = next;
    } else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source.charAt(i + 1)))) {
      const value = String(match(NUMBER));
      tokens.push({ kind: 'number', value, line });
      i += value.length;
    } else if (ident !== undefined) {
      tokens.push({ kind: 'ident', value: ident, line });
      i += ident.length;
    } else {
      tokens.push({ kind: 'symbol', value: char, line });
      i++;
    }
  }
  return tokens;
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

function readString(source: string, start: number, file: string, line: number): [string, number] {
  const quote = source[start];
  let out = '';
  let i = start + 1;
  while (i < source.length && source[i] !== quote) {
    const char = source.charAt(i);
    if (char === '\n') break;
    if (char !== '\\') {
      out += char;
      i++;
      continue;
    }
    const next = source.charAt(i + 1);
    const hex = /^[xX]([0-9a-fA-F]{1,2})/.exec(source.slice(i + 1, i + 4));
    const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1, i + 4));
    const unicode = /^u([0-9a-fA-F]{4})/.exec(source.slice(i + 1, i + 6));
    if (hex) {
      out += String.fromCharCode(parseInt(String(hex[1]), 16));
      i += 1 + hex[0].length;
    } else if (octal) {
      out += String.fromCharCode(parseInt(octal[0], 8));
      i += 1 + octal[0].length;
    } else if (unicode) {
      out += String.fromCharCode(parseInt(String(unicode[1]), 16));
      i += 1 + unicode[0].length;
    } else {
      out += ESCAPES[next] ?? next;
      i += 2;
    }
  }
  if (source[i] !== quote) throw new Error(`${file}:${line}: unterminated string`);
  return [out, i + 1];
}

interface MutableMessage {
  readonly name: string;
  readonly fields: RawField[];
  readonly messages: RawMessage[];
  readonly enums: RawEnum[];
}

/** Parses one .proto source. Type references are left unresolved (see `buildRegistry`). */
export function parseProto(file: string, source: string): RawFile {
  return new Parser(file, tokenize(source, file)).file();
}

class Parser {
  private pos = 0;
  private syntax: Syntax = 'proto2';

  constructor(
    private readonly fileName: string,
    private readonly tokens: readonly Token[],
  ) {}

  file(): RawFile {
    let pkg = '';
    const imports: string[] = [];
    const messages: RawMessage[] = [];
    const enums: RawEnum[] = [];
    const services: RawService[] = [];
    while (!this.atEnd()) {
      const token = this.next();
      const word = token.value;
      if (word === 'syntax' || word === 'edition') {
        this.expect('=');
        const value = this.string();
        this.syntax = word === 'edition' ? 'editions' : value === 'proto3' ? 'proto3' : 'proto2';
        this.expect(';');
      } else if (word === 'package') {
        pkg = this.ident();
        this.expect(';');
      } else if (word === 'import') {
        if (this.peekIs('public') || this.peekIs('weak')) this.next();
        imports.push(this.string());
        this.expect(';');
      } else if (word === 'option') this.skipStatement();
      else if (word === 'message') messages.push(this.message());
      else if (word === 'enum') enums.push(this.enumBody());
      else if (word === 'service') services.push(this.service());
      else if (word === 'extend') {
        this.ident();
        this.skipBlock();
      } else if (word !== ';') this.fail(`unexpected "${word}"`, token);
    }
    return {
      name: this.fileName,
      package: pkg,
      syntax: this.syntax,
      imports,
      messages,
      enums,
      services,
    };
  }

  private message(): RawMessage {
    const message: MutableMessage = {
      name: this.ident(),
      fields: [],
      messages: [],
      enums: [],
    };
    this.expect('{');
    while (!this.eat('}')) {
      const word = this.peek().value;
      if (word === ';') this.next();
      else if (word === 'option' || word === 'reserved' || word === 'extensions') {
        this.skipStatement();
      } else if (word === 'message') {
        this.next();
        message.messages.push(this.message());
      } else if (word === 'enum') {
        this.next();
        message.enums.push(this.enumBody());
      } else if (word === 'extend') {
        this.next();
        this.ident();
        this.skipBlock();
      } else if (word === 'oneof') {
        this.next();
        this.oneof(message);
      } else if (word === 'map' && this.peekIs('<', 1)) {
        this.next();
        this.mapField(message);
      } else this.field(message);
    }
    return message;
  }

  private field(message: MutableMessage, oneof?: string): void {
    let label: RawField['label'];
    const first = this.peek().value;
    if (
      oneof === undefined &&
      (first === 'optional' || first === 'required' || first === 'repeated')
    ) {
      label = first;
      this.next();
    }
    const type = this.ident();
    const name = this.ident();
    this.expect('=');
    const number = this.integer();
    if (type === 'group') {
      // proto2 groups are rare and deprecated: the field is dropped (skipped on decode).
      if (this.peekIs('[')) this.fieldOptions();
      this.skipBlock();
      return;
    }
    const options = this.peekIs('[') ? this.fieldOptions() : {};
    this.expect(';');
    const proto3Optional = this.syntax === 'proto3' && label === 'optional';
    message.fields.push({
      name,
      number,
      type,
      ...(label !== undefined && !proto3Optional ? { label } : {}),
      ...(proto3Optional ? { proto3Optional } : {}),
      ...(oneof !== undefined ? { oneof } : {}),
      ...options,
    });
  }

  private mapField(message: MutableMessage): void {
    this.expect('<');
    const key = this.ident();
    this.expect(',');
    const value = this.ident();
    this.expect('>');
    const name = this.ident();
    this.expect('=');
    const number = this.integer();
    const options = this.peekIs('[') ? this.fieldOptions() : {};
    this.expect(';');
    // Like protoc: a nested `<Name>Entry` message with key = 1 and value = 2.
    const entryName = `${name.charAt(0).toUpperCase()}${name.slice(1)}`.replace(
      /_(\w)/g,
      (_m, c: string) => c.toUpperCase(),
    );
    message.messages.push({
      name: `${entryName}Entry`,
      fields: [
        { name: 'key', number: 1, type: key, label: 'optional' },
        { name: 'value', number: 2, type: value, label: 'optional' },
      ],
      messages: [],
      enums: [],
      mapEntry: true,
    });
    message.fields.push({
      name,
      number,
      type: `${entryName}Entry`,
      label: 'repeated',
      ...(options.jsonName !== undefined ? { jsonName: options.jsonName } : {}),
    });
  }

  private oneof(message: MutableMessage): void {
    const name = this.ident();
    this.expect('{');
    while (!this.eat('}')) {
      if (this.eat(';')) continue;
      if (this.peekIs('option')) this.skipStatement();
      else this.field(message, name);
    }
  }

  private fieldOptions(): { jsonName?: string; packed?: boolean } {
    const options: { jsonName?: string; packed?: boolean } = {};
    this.expect('[');
    for (;;) {
      let name = '';
      while (!this.peekIs('=')) name += this.next().value;
      this.expect('=');
      if (this.peekIs('{')) this.skipBlock();
      else {
        const value = this.constant();
        if (name === 'json_name') options.jsonName = value;
        if (name === 'packed') options.packed = value === 'true';
      }
      if (this.eat(']')) return options;
      this.expect(',');
    }
  }

  private enumBody(): RawEnum {
    const name = this.ident();
    const values: { name: string; number: number }[] = [];
    this.expect('{');
    while (!this.eat('}')) {
      if (this.eat(';')) continue;
      if (this.peekIs('option') || this.peekIs('reserved')) {
        this.skipStatement();
        continue;
      }
      const valueName = this.ident();
      this.expect('=');
      const negative = this.eat('-');
      const number = this.integer();
      if (this.peekIs('[')) this.fieldOptions();
      this.expect(';');
      values.push({ name: valueName, number: negative ? -number : number });
    }
    return { name, values };
  }

  private service(): RawService {
    const name = this.ident();
    const methods: RawMethod[] = [];
    this.expect('{');
    while (!this.eat('}')) {
      if (this.eat(';')) continue;
      const token = this.next();
      const word = token.value;
      if (word === 'option') {
        this.pos--;
        this.skipStatement();
        continue;
      }
      if (word !== 'rpc') this.fail(`unexpected "${word}" in service ${name}`, token);
      const methodName = this.ident();
      const [clientStreaming, input] = this.rpcType();
      this.expect('returns');
      const [serverStreaming, output] = this.rpcType();
      if (this.peekIs('{')) {
        this.skipBlock();
        this.eat(';');
      } else this.expect(';');
      methods.push({ name: methodName, input, output, clientStreaming, serverStreaming });
    }
    return { name, methods };
  }

  private rpcType(): [boolean, string] {
    this.expect('(');
    const streaming = this.peekIs('stream');
    if (streaming) this.next();
    const type = this.ident();
    this.expect(')');
    return [streaming, type];
  }

  /** Skips to the end of a statement, over aggregate `{ ... }` option values. */
  private skipStatement(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const value = this.next().value;
      if (value === '{') depth++;
      else if (value === '}') depth--;
      else if (value === ';' && depth === 0) return;
    }
  }

  private skipBlock(): void {
    this.expect('{');
    let depth = 1;
    while (depth > 0) {
      const value = this.next().value;
      if (value === '{') depth++;
      else if (value === '}') depth--;
    }
  }

  private constant(): string {
    if (this.eat('-')) return `-${this.next().value}`;
    const token = this.next();
    if (token.kind === 'string') {
      let value = token.value;
      while (this.peek().kind === 'string') value += this.next().value;
      return value;
    }
    return token.value;
  }

  private string(): string {
    const token = this.next();
    if (token.kind !== 'string') this.fail(`expected a string, got "${token.value}"`, token);
    let value = token.value;
    while (!this.atEnd() && this.peek().kind === 'string') value += this.next().value;
    return value;
  }

  private ident(): string {
    const token = this.next();
    if (token.kind !== 'ident') this.fail(`expected a name, got "${token.value}"`, token);
    return token.value;
  }

  private integer(): number {
    const token = this.next();
    if (token.kind !== 'number') this.fail(`expected a number, got "${token.value}"`, token);
    const text = token.value;
    if (/^0[xX]/.test(text)) return parseInt(text.slice(2), 16);
    if (/^0[0-7]+$/.test(text)) return parseInt(text, 8);
    const value = Number(text);
    if (!Number.isInteger(value)) this.fail(`expected an integer, got "${text}"`, token);
    return value;
  }

  private expect(symbol: string): void {
    const token = this.next();
    if (token.value !== symbol) this.fail(`expected "${symbol}", got "${token.value}"`, token);
  }

  private eat(value: string): boolean {
    if (this.atEnd() || this.peek().value !== value) return false;
    this.pos++;
    return true;
  }

  private peekIs(value: string, ahead = 0): boolean {
    return this.tokens[this.pos + ahead]?.value === value;
  }

  private peek(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error(`${this.fileName}: unexpected end of file`);
    return token;
  }

  private next(): Token {
    const token = this.peek();
    this.pos++;
    return token;
  }

  private atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private fail(message: string, token: Token): never {
    throw new Error(`${this.fileName}:${token.line}: ${message}`);
  }
}
