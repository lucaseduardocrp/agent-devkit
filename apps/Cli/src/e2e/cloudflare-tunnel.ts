import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { localOrigin } from '@agent-devkit/mcp';

export interface TunnelInfo {
  readonly localUrl: string;
  readonly publicUrl: string;
  /** Session credentials for the local multi-service gateway. */
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const LOCAL_ROUTE = '/_adk/local/';
const HOP_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cf-access-client-id',
  'cf-access-client-secret',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-visitor',
]);

function loopbackUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function validToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A private, per-session gateway. Only loopback services can be addressed through it. */
export function createLocalGateway(
  frontend: string,
  token: { clientId: string; clientSecret: string },
): Server {
  const base = loopbackUrl(frontend);
  if (!base) throw new Error('Gateway frontend must be a loopback HTTP service.');
  return createServer((incoming, outgoing) => {
    if (
      !validToken(String(incoming.headers['cf-access-client-id'] ?? ''), token.clientId) ||
      !validToken(String(incoming.headers['cf-access-client-secret'] ?? ''), token.clientSecret)
    ) {
      outgoing.writeHead(403).end();
      return;
    }
    const requestUrl = incoming.url ?? '/';
    let destination: URL;
    try {
      if (requestUrl.startsWith(LOCAL_ROUTE)) {
        const remainder = requestUrl.slice(LOCAL_ROUTE.length);
        const slash = remainder.indexOf('/');
        if (slash < 0) {
          outgoing.writeHead(400).end();
          return;
        }
        const encodedOrigin = remainder.slice(0, slash);
        const rawOrigin = Buffer.from(encodedOrigin, 'base64url').toString('utf8');
        if (Buffer.from(rawOrigin, 'utf8').toString('base64url') !== encodedOrigin) {
          outgoing.writeHead(400).end();
          return;
        }
        const origin = loopbackUrl(rawOrigin);
        if (!origin || origin.origin !== rawOrigin) {
          outgoing.writeHead(403).end();
          return;
        }
        destination = new URL(remainder.slice(slash), origin);
        if (destination.origin !== origin.origin) {
          outgoing.writeHead(403).end();
          return;
        }
      } else {
        destination = new URL(requestUrl, base);
        if (destination.origin !== base.origin) {
          outgoing.writeHead(403).end();
          return;
        }
      }
    } catch {
      outgoing.writeHead(400).end();
      return;
    }
    forwardLocalRequest(incoming, outgoing, destination);
  });
}

function forwardLocalRequest(incoming: IncomingMessage, outgoing: ServerResponse, url: URL): void {
  const headers = Object.fromEntries(
    Object.entries(incoming.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())),
  );
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
    url,
    {
      method: incoming.method,
      headers: { ...headers, host: url.host },
      timeout: 30_000,
      // Loopback development APIs commonly use locally trusted certificates.
      ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    },
    (response) => {
      const responseHeaders = Object.fromEntries(
        Object.entries(response.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())),
      );
      outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
      response.pipe(outgoing);
    },
  );
  request.once('timeout', () => request.destroy(new Error('Local service timed out.')));
  request.once('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502).end('Local service unavailable.');
    else outgoing.destroy();
  });
  incoming.pipe(request);
}

export class CloudflareTunnelManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private current: TunnelInfo | undefined;
  private pending: Promise<TunnelInfo> | undefined;
  private target: string | undefined;
  private cancelStartup: ((error: Error) => void) | undefined;
  private gateway: Server | undefined;
  private generation = 0;

  public constructor(
    private readonly executable = process.env['ADK_CLOUDFLARED_PATH'] || 'cloudflared',
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  public status(): TunnelInfo | undefined {
    return this.current;
  }

  public async start(input: string, fullstack = false): Promise<TunnelInfo> {
    const origin = localOrigin(input);
    if (this.target && this.target !== origin) {
      throw new Error(
        `A tunnel for ${this.target} is already running. Stop it before starting another.`,
      );
    }
    if (this.current) return this.current;
    if (this.pending) return this.pending;
    this.target = origin;
    const generation = ++this.generation;
    this.pending = this.launchForTarget(origin, fullstack, generation);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  public stop(): void {
    this.generation += 1;
    this.cancelStartup?.(new Error('Tunnel stopped.'));
    this.current = undefined;
    this.target = undefined;
    this.child?.kill();
    this.child = undefined;
    if (this.gateway?.listening) this.gateway.close();
    this.gateway = undefined;
  }

  private async launchForTarget(
    origin: string,
    fullstack: boolean,
    generation: number,
  ): Promise<TunnelInfo> {
    if (!fullstack) return this.launch(origin);
    const token = {
      clientId: `adk-local-${randomBytes(12).toString('hex')}`,
      clientSecret: randomBytes(32).toString('hex'),
    };
    const gateway = createLocalGateway(origin, token);
    this.gateway = gateway;
    try {
      await new Promise<void>((resolve, reject) => {
        gateway.once('error', reject);
        gateway.listen(0, '127.0.0.1', resolve);
      });
      if (generation !== this.generation) throw new Error('Tunnel stopped.');
      const address = gateway.address();
      if (!address || typeof address === 'string') throw new Error('Gateway port unavailable.');
      const tunnel = await this.launch(`http://127.0.0.1:${address.port}`);
      if (generation !== this.generation) throw new Error('Tunnel stopped.');
      const info = {
        ...tunnel,
        localUrl: origin,
        accessClientId: token.clientId,
        accessClientSecret: token.clientSecret,
      };
      this.current = info;
      return info;
    } catch (error) {
      if (gateway.listening) gateway.close();
      if (this.gateway === gateway) this.gateway = undefined;
      if (generation === this.generation && this.target === origin) this.target = undefined;
      throw error;
    }
  }

  public waitForClose(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => child.once('close', () => resolve()));
  }

  private launch(origin: string): Promise<TunnelInfo> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        this.executable,
        ['tunnel', '--url', origin, '--http-host-header', new URL(origin).host],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      this.child = child;
      let settled = false;
      let logs = '';
      const timeout = setTimeout(
        () => fail(new Error('Cloudflare Tunnel did not provide a URL within 45 seconds.')),
        45_000,
      );
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.cancelStartup = undefined;
        if (this.child === child) {
          this.child = undefined;
          this.target = undefined;
          child.kill();
        }
        reject(error);
      };
      this.cancelStartup = fail;
      const receive = (chunk: Buffer) => {
        const line = chunk.toString();
        logs = (logs + line).slice(-8_000);
        const publicUrl = logs.match(QUICK_TUNNEL_URL)?.[0];
        if (settled || !publicUrl) return;
        settled = true;
        clearTimeout(timeout);
        this.cancelStartup = undefined;
        const info = { localUrl: origin, publicUrl };
        this.current = info;
        resolve(info);
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', (error) =>
        fail(
          new Error(
            `Could not start cloudflared (${error.message}). Install cloudflared or set ADK_CLOUDFLARED_PATH.`,
          ),
        ),
      );
      child.once('exit', (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.current = undefined;
        this.target = undefined;
        if (this.gateway?.listening) this.gateway.close();
        this.gateway = undefined;
        if (!settled)
          fail(
            new Error(`cloudflared exited before opening a tunnel (code ${code}). ${logs.trim()}`),
          );
      });
    });
  }
}
