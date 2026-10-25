import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CloudflareTunnelManager } from './cloudflare-tunnel.js';

export const LOCAL_BRIDGE_PORT = 8765;

/** Browser control for a cloudflared process on the user's own computer. */
export function createLocalTunnelBridge(
  allowedOrigin: string,
  tunnel: Pick<
    CloudflareTunnelManager,
    'start' | 'stop' | 'status'
  > = new CloudflareTunnelManager(),
): Server {
  const origin = new URL(allowedOrigin);
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost')
    throw new Error('The ADK frontend origin must use HTTPS.');
  if (origin.origin !== allowedOrigin || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Pass only the ADK frontend origin, for example https://adk.example.com.');

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host;
    // Requests arrive only while the server listens, so it has a port.
    const activePort = (server.address() as AddressInfo).port;
    if (host !== `127.0.0.1:${activePort}`) {
      response.writeHead(403).end();
      return;
    }
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== allowedOrigin) {
      // Lets another ADK frontend explain that the helper must be restarted; nothing else is exposed.
      if (requestOrigin) {
        response.setHeader('Access-Control-Allow-Origin', requestOrigin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          code: 'origin_mismatch',
          error: 'The local helper was started for another ADK address.',
        }),
      );
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/status' && request.method === 'GET') {
      json(200, { tunnel: tunnel.status() ?? null });
      return;
    }
    if (request.url === '/tunnel' && request.method === 'DELETE') {
      tunnel.stop();
      json(200, { tunnel: null });
      return;
    }
    if (request.url !== '/tunnel' || request.method !== 'POST') {
      json(404, { error: 'Not found.' });
      return;
    }
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += String(chunk);
        if (raw.length > 1024) throw new Error('Request is too large.');
      }
      const value = JSON.parse(raw) as { url?: unknown };
      if (typeof value.url !== 'string') throw new Error('Enter a local URL.');
      json(200, { tunnel: await tunnel.start(value.url, true) });
    } catch (error) {
      json(400, { error: error instanceof Error ? error.message : 'Could not start tunnel.' });
    }
  }
  return server;
}
