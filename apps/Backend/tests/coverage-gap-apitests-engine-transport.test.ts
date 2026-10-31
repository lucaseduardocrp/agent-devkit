import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readHandshake, sendHttp } from '../src/modules/apitests/engine/http-transport.js';

const listen = async (server: net.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

describe('readHandshake', () => {
  it('rejects when the socket itself errors during the handshake', async () => {
    const socket = new net.Socket();
    const promise = readHandshake(socket, new AbortController().signal, () => undefined);
    socket.emit('error', new Error('boom'));
    await expect(promise).rejects.toThrow('boom');
  });
});

describe('accept and accept-encoding are not duplicated', () => {
  let server: http.Server;
  let base = '';
  let seen: http.IncomingHttpHeaders = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200);
      res.end();
    });
    const port = await listen(server);
    base = `http://127.0.0.1:${port}/`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('keeps a caller-provided Host header instead of adding another', async () => {
    await sendHttp(
      {
        method: 'GET',
        url: new URL(base),
        headers: [['host', 'custom.test']],
      },
      {},
    );
    expect(seen.host).toBe('custom.test');
  });

  it('keeps a caller-provided Accept header instead of adding another', async () => {
    await sendHttp(
      {
        method: 'GET',
        url: new URL(base),
        headers: [['accept', 'application/json']],
      },
      {},
    );
    expect(seen.accept).toBe('application/json');
  });

  it('keeps a caller-provided Accept-Encoding header instead of adding another', async () => {
    await sendHttp(
      {
        method: 'GET',
        url: new URL(base),
        headers: [['accept-encoding', 'identity']],
      },
      {},
    );
    expect(seen['accept-encoding']).toBe('identity');
  });
});
