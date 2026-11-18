export interface SseMessage {
  readonly event: string;
  readonly data: string;
}

/**
 * Incremental parser of a server-sent events stream (HTML Living Standard, section 9.2.6). Feed it
 * decoded text as it arrives, in chunks of any size; it reports each complete message once.
 * Comment lines (the heartbeat) and fields other than `event` and `data` are ignored.
 */
export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onMessage({ event, data: data.join('\n') });
    event = 'message';
    data = [];
  };

  const readLine = (line: string) => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    // The last piece has no line break yet: it waits for the rest of its line.
    // split always returns at least one piece.
    buffer = lines.pop()!;
    for (const line of lines) readLine(line);
  };
}
