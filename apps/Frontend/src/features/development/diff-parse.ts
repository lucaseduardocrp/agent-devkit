export interface DiffRow {
  readonly kind: 'hunk' | 'add' | 'del' | 'context' | 'note';
  readonly text: string;
  /** The line number in the file before and after the change; null where the line is not there. */
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

/**
 * Reads a unified diff of one file into rows with their line numbers. Whatever comes before the
 * first hunk (the file header) is left out, and so is a file git reported as binary.
 */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (!inHunk || line === '') {
      continue;
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      // "\ No newline at end of file", or the note of a patch the runner cut.
      rows.push({ kind: 'note', text: line.replace(/^\\ /, ''), oldLine: null, newLine: null });
    }
  }
  return rows;
}

/** The folder part of a path, with its closing slash, and the file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/');
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}
