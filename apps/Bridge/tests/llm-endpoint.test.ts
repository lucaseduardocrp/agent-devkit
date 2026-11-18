import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdkChannel, type LlmEndpoint } from '../src/channels/adk/adk-channel.js';
import { LlmError, type LlmEvent, type LlmInput } from '../src/app/llm-host.js';

const TOKEN = 'shared-secret-token';
const controllers: AbortController[] = [];

afterEach(() => {
  controllers.splice(0).forEach((c) => c.abort());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function startChannel(llm?: LlmEndpoint) {
  const channel = new AdkChannel({
    port: 0,
    token: TOKEN,
    apiUrl: 'http://api:3000/',
    listClis: () => ['claude'],
    ...(llm ? { llm } : {}),
  });
  const controller = new AbortController();
  controllers.push(controller);
  void channel.start(async () => undefined, controller.signal);
  await vi.waitFor(() => expect(channel.port).toBeGreaterThan(0));
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`http://127.0.0.1:${channel.port}${path}`, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  return { call };
}

const stream = (...events: Array<LlmEvent | Error>) =>
  async function* (): AsyncGenerator<LlmEvent> {
    for (const event of events) {
      if (event instanceof Error) throw event;
      yield event;
    }
  };

function endpoint(make: (input: LlmInput, signal: AbortSignal) => AsyncGenerator<LlmEvent>) {
  const calls: Array<{ input: LlmInput; signal: AbortSignal }> = [];
  const llm: LlmEndpoint = {
    clis: async (workspaceId) => [
      {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        installed: true,
        signedIn: workspaceId === 'ws-1',
      },
    ],
    stream: (input, signal) => {
      calls.push({ input, signal });
      return make(input, signal);
    },
  };
  return { llm, calls };
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const valid = { workspaceId: 'ws-1', cli: 'claude', prompt: 'Olá' };

describe('GET /llm/clis', () => {
  it('lists the CLIs for a workspace and needs the shared token', async () => {
    const { llm } = endpoint(stream());
    const { call } = await startChannel(llm);
    expect((await call('/llm/clis?workspaceId=ws-1', {}, null)).status).toBe(401);
    const response = await call('/llm/clis?workspaceId=ws-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      clis: [{ id: 'claude', label: 'Claude', command: 'claude', installed: true, signedIn: true }],
    });
  });

  it('needs a workspace and reports a refusal of the host with its status', async () => {
    const { llm } = endpoint(stream());
    llm.clis = async () => {
      throw new LlmError('UNSUPPORTED', 'The workspace id is not valid.');
    };
    const { call } = await startChannel(llm);
    expect((await call('/llm/clis')).status).toBe(400);
    const response = await call('/llm/clis?workspaceId=x');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'UNSUPPORTED',
      message: 'The workspace id is not valid.',
    });
  });

  it('does not exist when the bridge has no LLM host', async () => {
    const { call } = await startChannel();
    expect((await call('/llm/clis?workspaceId=ws-1')).status).toBe(404);
    expect((await call('/llm/stream', post(valid))).status).toBe(404);
  });
});

describe('POST /llm/stream', () => {
  it('streams deltas and usage as server-sent events, ending with done', async () => {
    const { llm, calls } = endpoint(
      stream(
        { type: 'delta', text: 'Olá, ' },
        { type: 'delta', text: 'mundo' },
        { type: 'usage', inputTokens: 5, outputTokens: 2, model: 'm' },
      ),
    );
    const { call } = await startChannel(llm);
    const response = await call(
      '/llm/stream',
      post({ ...valid, instruction: 'Seja breve', model: 'm', credential: 'sk-ant-oat-abc' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toBe(
      [
        'event: delta\ndata: {"text":"Olá, "}\n\n',
        'event: delta\ndata: {"text":"mundo"}\n\n',
        'event: usage\ndata: {"type":"usage","inputTokens":5,"outputTokens":2,"model":"m"}\n\n',
        'event: done\ndata: {}\n\n',
      ].join(''),
    );
    expect(calls[0]!.input).toEqual({
      workspaceId: 'ws-1',
      cli: 'claude',
      prompt: 'Olá',
      instruction: 'Seja breve',
      model: 'm',
      credential: 'sk-ant-oat-abc',
    });
  });

  it('hands the ADK tools of the request to the host, and only when they are whole', async () => {
    const mcp = { name: 'adk-tools', url: 'http://mcp:3333/mcp', token: 'adk_pat_x' };
    const { llm, calls } = endpoint(stream({ type: 'delta', text: 'ok' }));
    const { call } = await startChannel(llm);
    for (const sent of [mcp, { name: 'adk-tools', url: 'http://mcp:3333/mcp' }, 'adk', null, 5]) {
      await (await call('/llm/stream', post({ ...valid, mcp: sent }))).text();
    }
    expect(calls.map((entry) => entry.input.mcp)).toEqual([
      mcp,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('answers a plain JSON error, with a status, when the request cannot start', async () => {
    const statuses: Array<[ConstructorParameters<typeof LlmError>[0], number]> = [
      ['UNSUPPORTED', 400],
      ['NOT_AUTHENTICATED', 422],
      ['NOT_INSTALLED', 503],
      ['TIMEOUT', 504],
      ['FAILED', 502],
    ];
    for (const [code, status] of statuses) {
      const { llm } = endpoint(stream(new LlmError(code, `detail ${code}`)));
      const { call } = await startChannel(llm);
      const response = await call('/llm/stream', post(valid));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code, message: `detail ${code}` });
    }
  });

  it('never uses 401 for a CLI failure: that status means the shared token', async () => {
    const { llm } = endpoint(stream(new LlmError('NOT_AUTHENTICATED', 'no token')));
    const { call } = await startChannel(llm);
    expect((await call('/llm/stream', post(valid))).status).not.toBe(401);
  });

  it('gives no detail of an unexpected failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { llm } = endpoint(stream(new TypeError('internal path /secret/place')));
    const { call } = await startChannel(llm);
    const response = await call('/llm/stream', post(valid));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('/secret/place');
  });

  it('reports a failure after the answer started as an error event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const known = endpoint(
      stream({ type: 'delta', text: 'meio' }, new LlmError('TIMEOUT', 'too slow')),
    );
    const first = await startChannel(known.llm);
    const body = await (await first.call('/llm/stream', post(valid))).text();
    expect(body).toContain('event: delta');
    expect(body).toContain('event: error\ndata: {"code":"TIMEOUT","message":"too slow"}');
    expect(body).not.toContain('event: done');

    const unknown = endpoint(stream({ type: 'delta', text: 'meio' }, new Error('secret detail')));
    const second = await startChannel(unknown.llm);
    const text = await (await second.call('/llm/stream', post(valid))).text();
    expect(text).toContain('"code":"FAILED"');
    expect(text).not.toContain('secret detail');
  });

  it('ends with done when the CLI says nothing at all', async () => {
    const { llm } = endpoint(stream());
    const { call } = await startChannel(llm);
    expect(await (await call('/llm/stream', post(valid))).text()).toBe('event: done\ndata: {}\n\n');
  });

  it('requires workspaceId, cli and prompt, and rejects an unreadable body', async () => {
    const { llm } = endpoint(stream());
    const { call } = await startChannel(llm);
    for (const body of [
      {},
      { ...valid, prompt: '' },
      { ...valid, cli: 5 },
      { cli: 'claude', prompt: 'x' },
    ]) {
      expect((await call('/llm/stream', post(body))).status).toBe(400);
    }
    expect((await call('/llm/stream', { method: 'POST', body: '{not json' })).status).toBe(400);
    expect((await call('/llm/stream', post(valid), null)).status).toBe(401);
  });

  it('passes images and files on, and refuses attachments that are not base64', async () => {
    const { llm, calls } = endpoint(stream({ type: 'delta', text: 'ok' }));
    const { call } = await startChannel(llm);
    const images = [{ mimeType: 'image/png', data: 'AAEC' }];
    const files = [{ name: 'a.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' }];
    expect((await call('/llm/stream', post({ ...valid, images, files }))).status).toBe(200);
    expect(calls[0]!.input).toMatchObject({ images, files });

    for (const bad of [
      { images: [{ mimeType: 'image/png', data: 'not base64!' }] },
      { images: 'AAEC' },
      { files: [{ mimeType: 'text/plain', data: 'AAEC' }] },
      { images: Array.from({ length: 21 }, () => images[0]) },
    ]) {
      expect((await call('/llm/stream', post({ ...valid, ...bad }))).status).toBe(400);
    }
  });

  it('accepts a long prompt, well above what a chat message may be', async () => {
    const { llm, calls } = endpoint(stream({ type: 'delta', text: 'ok' }));
    const { call } = await startChannel(llm);
    const response = await call('/llm/stream', post({ ...valid, prompt: 'x'.repeat(1_000_000) }));
    expect(response.status).toBe(200);
    await response.text();
    expect(calls[0]!.input.prompt).toHaveLength(1_000_000);
  });

  it('stops the CLI when the API goes away', async () => {
    let seen: AbortSignal | undefined;
    const { llm } = endpoint(async function* (_input, signal) {
      seen = signal;
      yield { type: 'delta', text: 'x'.repeat(100) };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    });
    const { call } = await startChannel(llm);
    const controller = new AbortController();
    const response = await call('/llm/stream', { ...post(valid), signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });

  it('sends a heartbeat so idle proxies keep the stream open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let finish!: () => void;
    const { llm } = endpoint(async function* () {
      yield { type: 'delta', text: 'a' };
      await new Promise<void>((resolve) => (finish = resolve));
    });
    const { call } = await startChannel(llm);
    const controller = new AbortController();
    const response = await call('/llm/stream', { ...post(valid), signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    vi.advanceTimersByTime(15_000);
    let received = '';
    while (!received.includes(': keep-alive')) {
      const { value } = await reader.read();
      received += new TextDecoder().decode(value);
    }
    expect(received).toContain(': keep-alive');
    finish();
    controller.abort();
  });

  it('closes a stream that fails before the headers were sent, without crashing', async () => {
    const { llm } = endpoint(stream());
    llm.stream = () => {
      throw new Error('synchronous failure');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { call } = await startChannel(llm);
    expect((await call('/llm/stream', post(valid))).status).toBe(500);
  });
});
