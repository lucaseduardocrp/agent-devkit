import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from '../src/lib/sse.js';

function collect() {
  const messages: SseMessage[] = [];
  return { messages, feed: createSseParser((message) => messages.push(message)) };
}

describe('createSseParser', () => {
  it('reports each complete message with its event name and data', () => {
    const { messages, feed } = collect();
    feed('event: run\ndata: {"id":"r1"}\n\nevent: ready\ndata: {}\n\n');
    expect(messages).toEqual([
      { event: 'run', data: '{"id":"r1"}' },
      { event: 'ready', data: '{}' },
    ]);
  });

  it('waits for the rest of a message split across chunks, at any point', () => {
    const { messages, feed } = collect();
    const text = 'event: run\ndata: {"id":"abc"}\n\n';
    for (const char of text) feed(char);
    expect(messages).toEqual([{ event: 'run', data: '{"id":"abc"}' }]);
  });

  it('defaults the event name, joins data lines and accepts CRLF line breaks', () => {
    const { messages, feed } = collect();
    feed('data: one\r\ndata: two\r\n\r\n');
    feed('data:no-space\n\n');
    expect(messages).toEqual([
      { event: 'message', data: 'one\ntwo' },
      { event: 'message', data: 'no-space' },
    ]);
  });

  it('ignores comments (the heartbeat), unknown fields and blocks without data', () => {
    const { messages, feed } = collect();
    feed(': keep-alive\n\nretry: 3000\n\nid: 7\nevent: run\n\n');
    expect(messages).toEqual([]);
    // A field without a colon is a field with an empty value.
    feed('event: run\ndata\n\n');
    expect(messages).toEqual([{ event: 'run', data: '' }]);
  });

  it('starts every message with the default event again', () => {
    const { messages, feed } = collect();
    feed('event: run\ndata: a\n\ndata: b\n\n');
    expect(messages.map((message) => message.event)).toEqual(['run', 'message']);
  });
});
