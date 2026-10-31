// Data files of the collection runner: one row per iteration, each column a `{{variable}}`.
// CSV with a header row (RFC 4180: quoted fields hold commas, quotes as "" and line breaks) or a
// JSON array of objects. Parsed in the browser, so the run gets plain rows.

export const MAX_DATA_ROWS = 1000;
export const MAX_DATA_COLUMNS = 100;

export type DataFileError =
  | 'empty'
  | 'invalidJson'
  | 'notArray'
  | 'notObjects'
  | 'unclosedQuote'
  | 'tooManyRows'
  | 'tooManyColumns';

export type DataFile =
  | { readonly ok: true; readonly columns: string[]; readonly rows: Record<string, string>[] }
  | { readonly ok: false; readonly error: DataFileError };

/** The records of a CSV text; throws `unclosedQuote` when a quoted field never ends. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) endField();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (text[index + 1] === '\n') index++;
      endRow();
    } else field += char;
  }
  if (quoted) throw new Error('unclosedQuote');
  if (field !== '' || row.length) endRow();
  // Blank lines are not records.
  return rows.filter((record) => record.length > 1 || record[0] !== '');
}

/** A JSON value as text: strings as they are, numbers and objects as JSON. */
const cell = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : JSON.stringify(value);

function limits(columns: string[], rows: Record<string, string>[]): DataFile {
  if (!rows.length) return { ok: false, error: 'empty' };
  if (rows.length > MAX_DATA_ROWS) return { ok: false, error: 'tooManyRows' };
  if (columns.length > MAX_DATA_COLUMNS) return { ok: false, error: 'tooManyColumns' };
  return { ok: true, columns, rows };
}

/** Reads a data file: JSON when its name ends in .json or it starts with `[`, CSV otherwise. */
export function parseDataFile(text: string, fileName = ''): DataFile {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty' };
  if (/\.json$/i.test(fileName) || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'invalidJson' };
    }
    if (!Array.isArray(parsed)) return { ok: false, error: 'notArray' };
    if (parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))
      return { ok: false, error: 'notObjects' };
    const columns = [...new Set(parsed.flatMap((item: object) => Object.keys(item)))];
    const rows = (parsed as Record<string, unknown>[]).map((item) =>
      Object.fromEntries(columns.map((column) => [column, cell(item[column])])),
    );
    return limits(columns, rows);
  }
  let records: string[][];
  try {
    // Semicolons when the header has them and no commas (spreadsheets in pt-BR export so).
    const header = trimmed.split(/\r?\n/, 1)[0]!;
    records = parseCsv(text, header.includes(';') && !header.includes(',') ? ';' : ',');
  } catch {
    return { ok: false, error: 'unclosedQuote' };
  }
  const [header = [], ...body] = records;
  const columns = header.map((name, index) => name.trim() || `column${index + 1}`);
  const rows = body.map((record) =>
    Object.fromEntries(columns.map((column, index) => [column, record[index] ?? ''])),
  );
  return limits(columns, rows);
}
