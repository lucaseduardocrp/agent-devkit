import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from '../../core/registry.js';
import { MemorySessionStore, Session } from '../../core/session.js';
import type { McpConfig } from '../config.js';
import { createMcpServer } from '../create-server.js';
import type { SkillFile } from '../skills.js';
import { AdkOAuthProvider } from './oauth.js';
import { TokenVerifier } from './token-verifier.js';

export interface HttpServerOptions {
  readonly sessionTtlMs?: number;
  readonly maxSessions?: number;
  readonly maxBodyBytes?: number;
  readonly fetch?: typeof fetch;
}

interface LiveSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly session: Session;
  /** Authenticated user that owns this session. */
  readonly owner: string;
  lastSeen: number;
}

interface RecoveredSession {
  readonly session: Session;
  readonly owner: string;
  lastSeen: number;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1']);

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  return match?.[1];
}

/**
 * Hosts accepted in the Host and Origin headers (DNS-rebinding protection). A loopback server
 * accepts only loopback names unless configured otherwise; the public URL host is always allowed.
 */
export function effectiveAllowedHosts(config: McpConfig): ReadonlySet<string> {
  const hosts = new Set(config.http.allowedHosts.map((host) => host.toLowerCase()));
  if (!hosts.size && LOOPBACK_BIND.has(config.http.host)) {
    for (const host of LOOPBACK_HOSTS) hosts.add(host);
  }
  if (config.http.publicUrl) hosts.add(new URL(config.http.publicUrl).host.toLowerCase());
  return hosts;
}

const hostAllowed = (allowed: ReadonlySet<string>, host: string) =>
  !allowed.size || allowed.has(host) || allowed.has(host.replace(/:\d+$/, ''));

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

/**
 * Team / remote mode (Streamable HTTP on /mcp). Each request carries the user's own ADK token;
 * with ADK_MCP_PUBLIC_URL + ADK_MCP_OAUTH_SECRET the server also acts as an OAuth 2.1
 * authorization server so connectors such as claude.ai can sign users in.
 */
export function createHttpServer(
  config: McpConfig,
  registry: ToolRegistry,
  skills: readonly SkillFile[],
  options: HttpServerOptions = {},
): Server {
  const ttl = options.sessionTtlMs ?? 2 * 60 * 60_000;
  const maxSessions = options.maxSessions ?? 500;
  const maxBody = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const sessions = new Map<string, LiveSession>();
  const recoveredSessions = new Map<string, RecoveredSession>();
  const allowed = effectiveAllowedHosts(config);
  const api = { apiUrl: config.apiUrl, timeoutMs: config.timeoutMs, fetch: options.fetch };
  const verifier = new TokenVerifier(api);
  const oauth =
    config.http.publicUrl && config.http.oauthSecret
      ? new AdkOAuthProvider(config.http.oauthSecret, api)
      : undefined;
  const resourceUrl = config.http.publicUrl ? new URL('/mcp', config.http.publicUrl) : undefined;
  const challenge = [
    'Bearer realm="adk"',
    ...(oauth && resourceUrl
      ? [`resource_metadata="${getOAuthProtectedResourceMetadataUrl(resourceUrl)}"`]
      : []),
  ].join(', ');

  const app = express();
  app.disable('x-powered-by');
  if (config.http.trustProxy) app.set('trust proxy', 1);

  // Before the host guard: platform health checks use their own Host header.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', sessions: sessions.size, oauth: Boolean(oauth) });
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = req.headers.origin;
    let originHost: string;
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : '';
    } catch {
      originHost = 'invalid';
    }
    // The Origin check guards the MCP endpoint against DNS rebinding. The OAuth pages are left out:
    // their login form is posted with `Origin: null` (no-referrer policy), and they are protected
    // by sealed authorization requests and registered redirect URIs instead.
    const checkOrigin = req.path === '/mcp';
    if (
      !hostAllowed(allowed, host) ||
      (checkOrigin && origin && !hostAllowed(allowed, originHost))
    ) {
      res.status(403).json({ error: 'Host or origin not allowed.' });
      return;
    }
    next();
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.http.rateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down and retry shortly.' },
  });

  if (oauth && config.http.publicUrl && resourceUrl) {
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: new URL(config.http.publicUrl),
        resourceServerUrl: resourceUrl,
        resourceName: 'ADK',
        clientRegistrationOptions: { clientIdGeneration: false },
      }),
    );
    app.use(limiter, oauth.loginRouter());
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, live] of sessions) {
      if (now - live.lastSeen > ttl) {
        sessions.delete(id);
        recoveredSessions.set(id, { session: live.session, owner: live.owner, lastSeen: now });
        void live.transport.close();
      }
    }
    for (const [id, recovered] of recoveredSessions) {
      if (now - recovered.lastSeen > 24 * 60 * 60_000) recoveredSessions.delete(id);
    }
  }, 60_000);
  sweep.unref();

  app.all('/mcp', limiter, (req: Request, res: Response) => {
    void (async () => {
      const token = bearerToken(req.headers.authorization);
      if ((config.http.requireAuth || oauth) && !token) {
        res
          .status(401)
          .set('www-authenticate', challenge)
          .json({ error: 'An ADK bearer token is required (Authorization: Bearer <token>).' });
        return;
      }
      const user = token ? await verifier.verify(token) : null;
      if (token && !user) {
        res
          .status(401)
          .set('www-authenticate', `${challenge}, error="invalid_token"`)
          .json({ error: 'The ADK token is invalid, expired or revoked.' });
        return;
      }
      (req as IncomingMessage & { auth?: unknown }).auth = token
        ? { token, clientId: 'adk-mcp', scopes: [] }
        : undefined;

      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = await readJson(req, maxBody);
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE';
          res
            .status(tooLarge ? 413 : 400)
            .json({ error: tooLarge ? 'Payload too large.' : 'Invalid JSON.' });
          return;
        }
      }

      const owner = user?.id ?? 'anonymous';
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (existing) {
        if (existing.owner !== owner) {
          res.status(403).json({ error: 'This MCP session belongs to a different user.' });
          return;
        }
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (
        user &&
        typeof sessionId === 'string' &&
        req.method === 'POST' &&
        !isInitializeRequest(body)
      ) {
        const recovered = recoveredSessions.get(sessionId);
        if (recovered && recovered.owner !== owner) {
          res.status(403).json({ error: 'This MCP session belongs to a different user.' });
          return;
        }
        if (recovered) recovered.lastSeen = Date.now();
        const session =
          recovered?.session ??
          new Session(new MemorySessionStore(), {
            apiUrl: config.apiUrl,
            workspaceId: config.workspaceId,
          });
        if (!recovered) {
          if (recoveredSessions.size >= maxSessions) {
            recoveredSessions.delete(recoveredSessions.keys().next().value!);
          }
          recoveredSessions.set(sessionId, { session, owner, lastSeen: Date.now() });
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const mcp = createMcpServer({ ...config, registry, session, skills, fetch: options.fetch });
        await mcp.connect(transport);
        try {
          await transport.handleRequest(req, res, body);
        } finally {
          await mcp.close();
        }
        return;
      }
      if (sessionId && !isInitializeRequest(body)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Unknown or missing MCP session. Initialize first.' },
          id: null,
        });
        return;
      }
      if (sessions.size >= maxSessions) {
        res.status(503).json({ error: 'Too many active MCP sessions. Try again later.' });
        return;
      }

      const session = new Session(new MemorySessionStore(), {
        apiUrl: config.apiUrl,
        // A shared operator token must never be lent to anonymous remote callers.
        token: LOOPBACK_BIND.has(config.http.host) ? config.token : undefined,
        workspaceId: config.workspaceId,
      });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, session, owner, lastSeen: Date.now() });
        },
      });
      // Only initialized sessions are ever closed (idle sweep or DELETE), so the id is set here.
      transport.onclose = () => sessions.delete(transport.sessionId!);
      const mcp = createMcpServer({ ...config, registry, session, skills, fetch: options.fetch });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.status(502).json({ error: 'The ADK API is unavailable.' });
      console.error('[devkit] HTTP request failed:', error);
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found. The MCP endpoint is /mcp.' });
  });

  const server = createServer(app);
  server.on('close', () => clearInterval(sweep));
  return server;
}
