import { createServer, type Server } from 'node:net';
import { isPortFree, pickPort } from '../src/main/ports.js';

const listen = (port: number): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });

const close = (server: Server) => new Promise((resolve) => server.close(resolve));

describe('ports', () => {
  it('tells a free port from a busy one', async () => {
    const { server, port } = await listen(0);
    expect(await isPortFree(port)).toBe(false);
    await close(server);
    expect(await isPortFree(port)).toBe(true);
  });

  it('returns the preferred port when it is free and not taken', async () => {
    const { server, port } = await listen(0);
    await close(server);
    expect(await pickPort(port, [])).toBe(port);
  });

  it('picks another port when the preferred one is busy', async () => {
    const { server, port } = await listen(0);
    const picked = await pickPort(port, []);
    expect(picked).not.toBe(port);
    expect(picked).toBeGreaterThan(0);
    await close(server);
  });

  it('picks another port when the preferred one is already taken by this app', async () => {
    const { server, port } = await listen(0);
    await close(server);
    expect(await pickPort(port, [port])).not.toBe(port);
  });
});
