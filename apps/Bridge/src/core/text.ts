/** Splits text into chunks of at most `limit`, breaking at paragraph, line or word boundaries. */
export function splitMessage(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const minimum = Math.floor(limit / 2);
    let cut = window.lastIndexOf('\n\n');
    if (cut < minimum) cut = window.lastIndexOf('\n');
    if (cut < minimum) cut = window.lastIndexOf(' ');
    if (cut < minimum) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The end of a long text, where CLIs print their errors. */
export function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** Parses newline-delimited JSON, skipping lines that are not JSON objects. */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value && typeof value === 'object') events.push(value as Record<string, unknown>);
    } catch {
      // A log line that only looks like JSON.
    }
  }
  return events;
}
