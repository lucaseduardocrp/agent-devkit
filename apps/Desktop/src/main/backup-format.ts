/** The first line of a desktop backup (gzip-compressed, one JSON value per line). */
export interface BackupHeader {
  readonly format: 'adk-desktop-backup';
  readonly version: 1;
  readonly createdAt: string;
  /** Migrations applied to the database the backup was made from, in order. */
  readonly migrations: readonly string[];
  /** Without it, the integrations saved in the backup cannot be read. */
  readonly integrationEncryptionKey: string;
}

/** After the header: a table and its columns, then its rows (every value as text, or null). */
export type BackupLine =
  | { readonly table: string; readonly columns: readonly string[] }
  | { readonly row: readonly (string | null)[] };

export function isBackupHeader(value: unknown): value is BackupHeader {
  if (typeof value !== 'object' || value === null) return false;
  const header = value as Record<string, unknown>;
  return (
    header['format'] === 'adk-desktop-backup' &&
    header['version'] === 1 &&
    Array.isArray(header['migrations']) &&
    header['migrations'].every((name) => typeof name === 'string') &&
    typeof header['integrationEncryptionKey'] === 'string'
  );
}

/** A gzip stream starts with 1f 8b; anything else is treated as a plain SQL dump. */
export const isGzip = (start: Uint8Array): boolean => start[0] === 0x1f && start[1] === 0x8b;

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A string literal Postgres casts to the column's type (standard_conforming_strings is on). */
export const quoteLiteral = (value: string | null): string =>
  value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;

export function insertStatement(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  const values = rows.map((row) => `(${row.map(quoteLiteral).join(', ')})`).join(',\n');
  return `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES\n${values};`;
}

/**
 * Splits SQL text into statements as it arrives, so a large dump never has to fit in memory.
 * Understands single-quoted strings (with '' escapes), double-quoted identifiers and `--`
 * comments, which is everything a data-only pg_dump with --inserts produces.
 */
export class SqlStatementSplitter {
  private buffer = '';
  private state: 'code' | 'string' | 'identifier' | 'comment' = 'code';
  private scanned = 0;

  public push(chunk: string): string[] {
    this.buffer += chunk;
    const statements: string[] = [];
    let start = 0;
    let index = this.scanned;
    for (; index < this.buffer.length; index++) {
      const char = this.buffer[index];
      if (this.state === 'comment') {
        if (char === '\n') this.state = 'code';
      } else if (this.state === 'string') {
        if (char === "'") this.state = 'code';
      } else if (this.state === 'identifier') {
        if (char === '"') this.state = 'code';
      } else if (char === "'") {
        this.state = 'string';
      } else if (char === '"') {
        this.state = 'identifier';
      } else if (
        (char === '-' && this.buffer[index + 1] === '-') ||
        isMetaCommand(this.buffer, index)
      ) {
        this.state = 'comment';
      } else if (char === '-' && index === this.buffer.length - 1) {
        // Might be the first half of "--": wait for the next chunk.
        break;
      } else if (char === ';') {
        const statement = stripComments(this.buffer.slice(start, index)).trim();
        if (statement) statements.push(statement);
        start = index + 1;
      }
    }
    this.buffer = this.buffer.slice(start);
    this.scanned = index - start;
    return statements;
  }

  /** What is left once the input ends: a final statement without a semicolon, if any. */
  public end(): string[] {
    const rest = stripComments(this.buffer).trim();
    this.buffer = '';
    this.scanned = 0;
    return rest ? [rest] : [];
  }
}

/**
 * A psql meta-command such as the `\restrict <key>` line pg_dump 17.6+ writes around a plain dump:
 * a backslash that starts a line. It means nothing to the server, so it is read as a comment.
 */
function isMetaCommand(sql: string, index: number): boolean {
  return sql[index] === '\\' && (index === 0 || sql[index - 1] === '\n');
}

/** Removes `--` comments and psql meta-commands that sit outside strings and identifiers. */
function stripComments(sql: string): string {
  let result = '';
  let state: 'code' | 'string' | 'identifier' | 'comment' = 'code';
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (state === 'comment') {
      if (char !== '\n') continue;
      state = 'code';
    } else if (state === 'string') {
      if (char === "'") state = 'code';
    } else if (state === 'identifier') {
      if (char === '"') state = 'code';
    } else if (char === "'") {
      state = 'string';
    } else if (char === '"') {
      state = 'identifier';
    } else if ((char === '-' && sql[index + 1] === '-') || isMetaCommand(sql, index)) {
      state = 'comment';
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Only what a data-only dump contains may run while importing one: settings, row inserts and
 * sequence positions. A file that tries anything else (a COPY ... PROGRAM, a DROP) is refused.
 */
export function classifyDumpStatement(statement: string): 'run' | 'skip' | 'refuse' {
  if (/^INSERT\s+INTO\s+(?:"?public"?\.)?"?_prisma_migrations"?\s/i.test(statement)) return 'skip';
  if (/^INSERT\s+INTO\s/i.test(statement)) return 'run';
  if (/^SET\s/i.test(statement)) return 'run';
  if (/^SELECT\s+pg_catalog\.(?:set_config|setval)\s*\(/i.test(statement)) return 'run';
  return 'refuse';
}

/** A value from an .env file written by the setup wizard (plain or single-quoted). */
export function readEnvValue(text: string, key: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${key}=`)) continue;
    const value = line
      .slice(key.length + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    if (value) found = value;
  }
  return found;
}

/** The process id on the first line of postmaster.pid, when it holds one. */
export function postmasterPid(fileText: string): number | undefined {
  const pid = Number.parseInt(fileText, 10); // Stops at the end of the first line.
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}
