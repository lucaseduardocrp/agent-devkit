import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openSocket,
  readHandshake,
  type NetworkOptions,
} from '../src/modules/apitests/engine/http-transport.js';

describe('handshake socket errors', () => {
  it('rejects when the socket fails while waiting for the reply', async () => {
    const socket = new net.Socket();
    const pending = readHandshake(socket, new AbortController().signal, () => undefined);
    socket.emit('error', new Error('ECONNRESET'));
    await expect(pending).rejects.toThrow('ECONNRESET');
  });
});

describe('SOCKS5 with a full IPv6 address', () => {
  const requests: Buffer[] = [];
  let server: net.Server;
  let port = 0;

  beforeAll(async () => {
    server = net.createServer((socket) => {
      let stage = 0;
      socket.on('data', (data) => {
        if (stage === 0) {
          stage = 1;
          socket.write(Buffer.from([5, 0]));
          return;
        }
        requests.push(data);
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('encodes the eight groups of an address without a compressed run', async () => {
    const network: NetworkOptions = {
      proxy: { enabled: true, protocol: 'socks5', hostname: '127.0.0.1', port },
    };
    const socket = await openSocket(
      { host: '2001:db8:0:0:0:0:1:2', port: 80, tls: false },
      network,
    );
    socket.destroy();
    expect(requests[0]?.subarray(4, 20).toString('hex')).toBe('20010db8000000000000000000010002');
  });
});
