import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { TOOLSETS, type Toolset } from '../core/tool.js';

const booleanFlag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .optional()
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/**
 * Accepts values as people paste them into hosting dashboards: surrounding quotes or spaces, a
 * bare domain without scheme (https is assumed; http for localhost) and trailing slashes.
 */
export function normalizeUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${/^(localhost|127\.0\.0\.1)(:|$)/.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

const urlVariable = z.preprocess(
  normalizeUrl,
  z.string().url('Must be a URL such as https://example.com'),
);

const environmentSchema = z.object({
  ADK_API_URL: urlVariable.default('http://localhost:3000'),
  ADK_TOKEN: z.string().min(1).optional(),
  ADK_WORKSPACE_ID: z.string().min(1).optional(),
  ADK_LOCALE: z.enum(['pt-BR', 'en-US']).optional(),
  ADK_MCP_TOOLSETS: z.string().optional(),
  ADK_MCP_READ_ONLY: booleanFlag,
  ADK_MCP_SESSION_FILE: z.string().min(1).optional(),
  ADK_MCP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(900_000).default(180_000),
  ADK_MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  ADK_MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  /** Injected by platforms such as Railway; used when ADK_MCP_HTTP_PORT is not set. */
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  ADK_MCP_ALLOWED_HOSTS: z.string().optional(),
  ADK_MCP_REQUIRE_AUTH: booleanFlag.optional(),
  ADK_MCP_PUBLIC_URL: urlVariable.optional(),
  ADK_MCP_OAUTH_SECRET: z.string().min(32).optional(),
  ADK_MCP_TRUST_PROXY: booleanFlag,
  ADK_MCP_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(600),
});

export interface McpConfig {
  readonly apiUrl: string;
  readonly token?: string;
  readonly workspaceId?: string;
  readonly locale?: 'pt-BR' | 'en-US';
  readonly toolsets: readonly Toolset[];
  readonly readOnly: boolean;
  readonly sessionFile: string;
  readonly timeoutMs: number;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly allowedHosts: readonly string[];
    /** Reject MCP requests without a bearer token. Defaults to true when not bound to loopback. */
    readonly requireAuth: boolean;
    /** Public base URL (https) of this server, used as OAuth issuer and resource. */
    readonly publicUrl?: string;
    /** Enables the OAuth 2.1 authorization server for remote connectors (with publicUrl). */
    readonly oauthSecret?: string;
    /** Honour X-Forwarded-* from one proxy hop (Railway, a load balancer). */
    readonly trustProxy: boolean;
    /** Requests per minute per client IP on /mcp and the OAuth endpoints. */
    readonly rateLimitPerMinute: number;
  };
}

export function parseToolsets(value: string | undefined): readonly Toolset[] {
  const names = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !TOOLSETS.includes(name as Toolset));
  if (unknown.length) {
    throw new Error(`Unknown toolset(s): ${unknown.join(', ')}. Valid: ${TOOLSETS.join(', ')}.`);
  }
  return names as Toolset[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const defaultSessionFile = () => join(homedir(), '.adk', 'mcp-session.json');

/**
 * API address saved by the last `devkit login`, so later commands reach the same ADK without
 * repeating --api-url. Explicit --api-url or ADK_API_URL still win.
 */
export async function storedApiUrl(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const file = environment['ADK_MCP_SESSION_FILE'] || defaultSessionFile();
  try {
    const { apiUrl } = JSON.parse(await readFile(file, 'utf8')) as { apiUrl?: unknown };
    return typeof apiUrl === 'string' && apiUrl ? apiUrl : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv): McpConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  const env = parsed.data;
  if (env.ADK_MCP_OAUTH_SECRET && !env.ADK_MCP_PUBLIC_URL) {
    throw new Error(
      'ADK_MCP_OAUTH_SECRET requires ADK_MCP_PUBLIC_URL (the https URL clients use).',
    );
  }
  return {
    apiUrl: env.ADK_API_URL.replace(/\/+$/, ''),
    token: env.ADK_TOKEN,
    workspaceId: env.ADK_WORKSPACE_ID,
    locale: env.ADK_LOCALE,
    toolsets: parseToolsets(env.ADK_MCP_TOOLSETS),
    readOnly: env.ADK_MCP_READ_ONLY,
    sessionFile: env.ADK_MCP_SESSION_FILE ?? defaultSessionFile(),
    timeoutMs: env.ADK_MCP_TIMEOUT_MS,
    http: {
      host: env.ADK_MCP_HTTP_HOST,
      port: env.ADK_MCP_HTTP_PORT ?? env.PORT ?? 3333,
      allowedHosts: (env.ADK_MCP_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      requireAuth:
        environment['ADK_MCP_REQUIRE_AUTH'] === undefined
          ? !LOOPBACK.has(env.ADK_MCP_HTTP_HOST)
          : Boolean(env.ADK_MCP_REQUIRE_AUTH),
      publicUrl: env.ADK_MCP_PUBLIC_URL?.replace(/\/+$/, ''),
      oauthSecret: env.ADK_MCP_OAUTH_SECRET,
      trustProxy: env.ADK_MCP_TRUST_PROXY,
      rateLimitPerMinute: env.ADK_MCP_RATE_LIMIT,
    },
  };
}
