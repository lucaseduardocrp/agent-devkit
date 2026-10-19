import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeTunnel } from '../src/modules/e2e/application/tunnel-probe.js';

const { httpsRequest, dnsLookup } = vi.hoisted(() => ({
  httpsRequest: vi.fn(),
  dnsLookup: vi.fn(),
}));
vi.mock('node:https', () => ({ request: httpsRequest }));
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }));


type Address = { address: string; family: 4 | 6 };
type LookupCallback = (error: Error | null, address: unknown, family?: number) => void;
interface RequestOptions {
  method: string;
  timeout: number;
  headers: Record<string, string>;
  lookup: (host: string, options: { all?: boolean }, callback: LookupCallback) => void;
}

class FakeResponse extends EventEmitter {
  readonly setEncoding = vi.fn();
  readonly destroy = vi.fn();
  constructor(
    readonly statusCode: number | undefined,
    readonly headers: Record<string, string | undefined> = {},
  ) {
    super();
  }
}

class FakeRequest extends EventEmitter {
  readonly destroy = vi.fn((error?: Error) => {
    if (error) this.emit('error', error);
  });
  constructor(private readonly onEnd: () => void) {
    super();
  }
  end() {
    this.onEnd();
  }
}

/** Fakes `https.request`: `act` decides what the server and the socket do once it is sent. */
function serve(
  act: (input: {
    options: RequestOptions;
    respond: (response: FakeResponse) => void;
    outgoing: FakeRequest;
  }) => void,
) {
  const outgoing: FakeRequest[] = [];
  httpsRequest.mockImplementation(
    (_url: URL, options: RequestOptions, callback: (response: FakeResponse) => void) => {
      const request: FakeRequest = new FakeRequest(() =>
        act({ options, respond: callback, outgoing: request }),
      );
      outgoing.push(request);
      return request;
    },
  );
  return outgoing;
}

const publicDns = async (): Promise<Address[]> => [{ address: '104.16.1.1', family: 4 }];

beforeEach(() => {
  httpsRequest.mockReset();
  dnsLookup.mockReset();
});

describe('tunnel probe over HTTPS (faked socket)', () => {
  it('sends a pinned GET with the access headers and stops at redirects to the Access login', async () => {
    let seen: RequestOptions | undefined;
    const responses: FakeResponse[] = [];
    serve(({ options, respond }) => {
      seen = options;
      const response = new FakeResponse(302, { location: '/cdn-cgi/access/login' });
      responses.push(response);
      respond(response);
    });
    await expect(
      probeTunnel('https://app.example.com/login', publicDns, undefined, {
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    ).resolves.toEqual({ reachable: false, reason: 'authentication', status: 302 });

    expect(httpsRequest).toHaveBeenCalledWith(
      new URL('https://app.example.com/login'),
      expect.anything(),
      expect.any(Function),
    );
    expect(seen).toMatchObject({
      method: 'GET',
      timeout: 8_000,
      headers: {
        'user-agent': 'adk-e2e-tunnel-check/1',
        'CF-Access-Client-Id': 'client-id',
        'CF-Access-Client-Secret': 'client-secret',
      },
    });
    expect(responses[0]!.destroy).toHaveBeenCalled();

    // DNS stays pinned to the address that was validated, for both lookup styles.
    const all = vi.fn();
    seen!.lookup('app.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '104.16.1.1', family: 4 }]);
    const single = vi.fn();
    seen!.lookup('app.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '104.16.1.1', 4);
  });

  it('treats a response without status or location as an origin failure', async () => {
    serve(({ respond }) => respond(new FakeResponse(undefined)));
    await expect(probeTunnel('https://app.example.com', publicDns)).resolves.toEqual({
      reachable: false,
      reason: 'origin_error',
      status: 0,
    });
  });

  it('reads the body of successful responses to spot an Invalid Host header page', async () => {
    serve(({ respond }) => {
      const response = new FakeResponse(200);
      respond(response);
      response.emit('data', '<html><body>Invalid ');
      response.emit('data', 'Host header</body></html>');
      response.emit('end');
      expect(response.setEncoding).toHaveBeenCalledWith('utf8');
    });
    await expect(probeTunnel('https://app.example.com', publicDns)).resolves.toEqual({
      reachable: false,
      reason: 'host_error',
      status: 200,
    });

    serve(({ respond }) => {
      const response = new FakeResponse(204);
      respond(response);
      response.emit('end');
    });
    await expect(probeTunnel('https://app.example.com', publicDns)).resolves.toEqual({
      reachable: true,
      reason: 'ok',
      status: 204,
    });
  });

  it('stops reading after 4 KB of body', async () => {
    const responses: FakeResponse[] = [];
    serve(({ respond }) => {
      const response = new FakeResponse(200);
      responses.push(response);
      respond(response);
      response.emit('data', 'a'.repeat(3_000));
      response.emit('data', 'b'.repeat(3_000));
    });
    await expect(probeTunnel('https://app.example.com', publicDns)).resolves.toEqual({
      reachable: true,
      reason: 'ok',
      status: 200,
    });
    expect(responses[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('reports response errors, socket errors and timeouts as network failures', async () => {
    const networkError = { reachable: false, reason: 'network_error', status: null };
    serve(({ respond }) => {
      const response = new FakeResponse(200);
      respond(response);
      response.emit('error', new Error('reset'));
    });
    await expect(probeTunnel('https://app.example.com', publicDns)).resolves.toEqual(
      networkError,
    );

    serve(({ outgoing }) => outgoing.emit('error', new Error('ECONNREFUSED')));
    await expect(probeTunnel('https://app.example.com', publicDns)).resolves.toEqual(
      networkError,
    );

    const sent = serve(({ outgoing }) => outgoing.emit('timeout'));
    await expect(probeTunnel('https://app.example.com', publicDns)).resolves.toEqual(
      networkError,
    );
    expect(sent[0]!.destroy).toHaveBeenCalledWith(new Error('timeout'));
  });
});

describe('tunnel probe DNS and address checks', () => {
  it('resolves every address of the host and connects to the first one', async () => {
    const requester = vi.fn(async () => ({ status: 200, location: '' }));
    dnsLookup.mockResolvedValueOnce([
      { address: '2606:4700::1', family: 6 },
      { address: '104.16.1.1', family: 4 },
    ]);
    await expect(
      probeTunnel('https://app.example.com', undefined, requester),
    ).resolves.toMatchObject({ reachable: true });
    expect(dnsLookup).toHaveBeenCalledWith('app.example.com', { all: true });
    expect(requester).toHaveBeenLastCalledWith(
      expect.any(URL),
      { address: '2606:4700::1', family: 6 },
      {},
    );

    dnsLookup.mockResolvedValueOnce([{ address: '104.16.1.1', family: 4 }]);
    await probeTunnel('https://app.example.com', undefined, requester);
    expect(requester).toHaveBeenLastCalledWith(
      expect.any(URL),
      { address: '104.16.1.1', family: 4 },
      {},
    );
  });

  it('uses IP literals without DNS', async () => {
    const requester = vi.fn(async () => ({ status: 200, location: '' }));
    const resolver = vi.fn();
    await probeTunnel('https://[2606:4700::1]/', resolver, requester);
    expect(resolver).not.toHaveBeenCalled();
    expect(requester).toHaveBeenCalledWith(
      expect.any(URL),
      { address: '2606:4700::1', family: 6 },
      {},
    );
  });

  it('accepts public addresses next to the reserved ranges', async () => {
    const requester = vi.fn(async () => ({ status: 200, location: '' }));
    for (const address of [
      '8.8.8.8',
      '100.63.0.1',
      '100.128.0.1',
      '169.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '192.1.0.1',
      '198.20.0.1',
      '2606:4700::1',
      '3fff::1',
    ])
      await expect(
        probeTunnel(
          'https://app.example.com',
          async () => [{ address, family: address.includes(':') ? 6 : 4 }],
          requester,
        ),
        address,
      ).resolves.toEqual({ reachable: true, reason: 'ok', status: 200 });
    expect(requester).toHaveBeenCalledTimes(10);
  });

  it('refuses private, reserved and unparseable DNS answers', async () => {
    for (const address of [
      '0.1.2.3',
      '10.0.0.1',
      '127.0.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.0.1',
      '192.0.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '2001:db8::1',
      'not-an-address',
    ])
      await expect(
        probeTunnel('https://app.example.com', async () => [{ address, family: 4 }]),
        address,
      ).rejects.toMatchObject({ code: 'E2E_INVALID_URL', statusCode: 400 });
    await expect(probeTunnel('https://app.example.com', async () => [])).rejects.toMatchObject({
      code: 'E2E_INVALID_URL',
      message: 'The URL must resolve only to public Internet addresses.',
    });
  });
});

describe('tunnel probe input validation', () => {
  it('rejects malformed URLs and URLs with credentials, ports or fragments', async () => {
    await expect(probeTunnel('not a url', publicDns)).rejects.toMatchObject({
      code: 'E2E_INVALID_URL',
      message: 'Enter a public HTTPS URL.',
    });
    for (const url of [
      'https://user:pw@app.example.com',
      'https://user@app.example.com',
      'https://app.example.com:8443',
      'https://app.example.com/#section',
    ])
      await expect(probeTunnel(url, publicDns), url).rejects.toMatchObject({
        code: 'E2E_INVALID_URL',
        message: 'Enter a public HTTPS URL without credentials, port or fragment.',
      });
  });

  it('requires both service token fields without control characters', async () => {
    const requester = vi.fn();
    await expect(
      probeTunnel('https://app.example.com', publicDns, requester, { clientId: 'id' }),
    ).rejects.toMatchObject({
      code: 'E2E_INVALID_ACCESS_TOKEN',
      message: 'Enter both tunnel authentication fields.',
    });
    await expect(
      probeTunnel('https://app.example.com', publicDns, requester, { clientSecret: 'secret' }),
    ).rejects.toMatchObject({ code: 'E2E_INVALID_ACCESS_TOKEN' });
    await expect(
      probeTunnel('https://app.example.com', publicDns, requester, {
        clientId: 'id\r\nX-Injected: 1',
        clientSecret: 'secret',
      }),
    ).rejects.toMatchObject({
      code: 'E2E_INVALID_ACCESS_TOKEN',
      message: 'The service token contains invalid characters.',
    });
    expect(requester).not.toHaveBeenCalled();
  });
});
