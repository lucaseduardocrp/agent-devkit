import {
  SqlStatementSplitter,
  classifyDumpStatement,
  insertStatement,
  isBackupHeader,
  isGzip,
  postmasterPid,
  quoteIdentifier,
  quoteLiteral,
  readEnvValue,
} from '../src/main/backup-format.js';

describe('backup header', () => {
  const header = {
    format: 'adk-desktop-backup',
    version: 1,
    createdAt: '2026-11-10T00:00:00.000Z',
    migrations: ['1_a'],
    integrationEncryptionKey: 'k',
  };

  it('accepts a desktop backup header', () => {
    expect(isBackupHeader(header)).toBe(true);
  });

  it.each([
    null,
    'text',
    { ...header, format: 'other' },
    { ...header, version: 2 },
    { ...header, migrations: 'x' },
    { ...header, migrations: [1] },
    { ...header, integrationEncryptionKey: 1 },
  ])('refuses %j', (value) => {
    expect(isBackupHeader(value)).toBe(false);
  });

  it('recognises gzip by its first bytes', () => {
    expect(isGzip(new Uint8Array([0x1f, 0x8b]))).toBe(true);
    expect(isGzip(new Uint8Array([0x1f, 0x00]))).toBe(false);
    expect(isGzip(new TextEncoder().encode('--'))).toBe(false);
  });
});

describe('SQL text', () => {
  it('quotes identifiers and literals', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteLiteral("it's \\n")).toBe("'it''s \\n'");
    expect(quoteLiteral(null)).toBe('NULL');
  });

  it('builds a multi-row insert', () => {
    expect(
      insertStatement(
        't',
        ['a', 'b'],
        [
          ['1', null],
          ['x', "y'"],
        ],
      ),
    ).toBe(`INSERT INTO "t" ("a", "b") VALUES\n('1', NULL),\n('x', 'y''');`);
  });
});

describe('SqlStatementSplitter', () => {
  const split = (chunks: string[]) => {
    const splitter = new SqlStatementSplitter();
    return [...chunks.flatMap((chunk) => splitter.push(chunk)), ...splitter.end()];
  };

  it('splits on semicolons outside strings, identifiers and comments', () => {
    const sql = [
      '-- header; with a semicolon',
      "SET client_encoding = 'UTF8';",
      `INSERT INTO "we;ird" VALUES ('a;b', 'it''s', 'line\nbreak -- not a comment');`,
      'SELECT 1 -- trailing; comment',
      ';',
      ';',
      'SELECT 2',
    ].join('\n');
    expect(split([sql])).toEqual([
      "SET client_encoding = 'UTF8'",
      `INSERT INTO "we;ird" VALUES ('a;b', 'it''s', 'line\nbreak -- not a comment')`,
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('gives the same result whatever the chunk boundaries', () => {
    const sql = "INSERT INTO t VALUES ('x;y'); -- c;\nINSERT INTO \"u\" VALUES ('''');\n";
    const whole = split([sql]);
    for (let size = 1; size < 8; size++) {
      const chunks: string[] = [];
      for (let index = 0; index < sql.length; index += size)
        chunks.push(sql.slice(index, index + size));
      expect(split(chunks)).toEqual(whole);
    }
    expect(whole).toEqual(["INSERT INTO t VALUES ('x;y')", `INSERT INTO "u" VALUES ('''')`]);
  });

  it('skips psql meta-commands at the start of a line, but not backslashes in values', () => {
    const sql =
      "\\restrict k1\nSET a = 1;\nINSERT INTO t VALUES ('x\n\\not a command');\n\\unrestrict k1\n";
    expect(split([sql])).toEqual(['SET a = 1', "INSERT INTO t VALUES ('x\n\\not a command')"]);
    expect(split(['\\restrict k1'])).toEqual([]);
  });

  it('keeps a lone dash that is not a comment', () => {
    expect(split(['SELECT 3 -', ' 1;'])).toEqual(['SELECT 3 - 1']);
  });

  it('returns nothing for comments only', () => {
    expect(split(['-- only a comment\n'])).toEqual([]);
  });
});

describe('classifyDumpStatement', () => {
  it.each([
    ['INSERT INTO public.users (id) VALUES (1)', 'run'],
    ['SET statement_timeout = 0', 'run'],
    ["SELECT pg_catalog.set_config('search_path', '', false)", 'run'],
    ["SELECT pg_catalog.setval('public.seq', 4, true)", 'run'],
    ['INSERT INTO public._prisma_migrations (id) VALUES (1)', 'skip'],
    ['INSERT INTO "_prisma_migrations" (id) VALUES (1)', 'skip'],
    ["COPY t FROM PROGRAM 'calc'", 'refuse'],
    ['DROP TABLE users', 'refuse'],
    ["SELECT pg_read_file('x')", 'refuse'],
  ])('%s → %s', (statement, verdict) => {
    expect(classifyDumpStatement(statement)).toBe(verdict);
  });
});

describe('readEnvValue', () => {
  it('reads plain and quoted values, the last one winning', () => {
    const text = 'A=1\r\nKEY=\'first\'\nKEY="second"\nKEY=\nOTHER=x';
    expect(readEnvValue(text, 'KEY')).toBe('second');
    expect(readEnvValue('KEY=plain', 'KEY')).toBe('plain');
    expect(readEnvValue("KEY=''", 'KEY')).toBeUndefined();
    expect(readEnvValue('NOPE=1', 'KEY')).toBeUndefined();
  });
});

describe('postmasterPid', () => {
  it('reads the pid on the first line', () => {
    expect(postmasterPid('4242\nC:/data\n')).toBe(4242);
    expect(postmasterPid('')).toBeUndefined();
    expect(postmasterPid('-1\n')).toBeUndefined();
    expect(postmasterPid('abc')).toBeUndefined();
  });
});
