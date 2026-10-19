import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { ApplicationError } from '../../../shared/errors.js';
import { accessHeaders } from './access-token.js';

export type TunnelProbeReason =
  'ok' | 'authentication' | 'origin_error' | 'network_error' | 'host_error';

export interface TunnelProbeResult {
  readonly reachable: boolean;
  readonly reason: TunnelProbeReason;
  readonly status: number | null;
}

type Address = { readonly address: string; readonly family: 4 | 6 };
type Resolver = (hostname: string) => Promise<readonly Address[]>;
type Requester = (
  url: URL,
  address: Address,
  headers: Record<string, string>,
) => Promise<{ status: number; location: string; body?: string }>;

const resolveHost: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((item) => ({
    address: item.address,
    family: item.family === 6 ? 6 : 4,
  }));

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Global unicast only. This excludes loopback, link-local, ULA and IPv4-mapped addresses.
    return /^[23][0-9a-f]{0,3}:/.test(normalized) && !normalized.startsWith('2001:db8:');
  }
  return false;
}

const requestHeaders: Requester = (url, address, headers) =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'GET',
        timeout: 8_000,
        headers: { 'user-agent': 'adk-e2e-tunnel-check/1', ...headers },
        lookup: (_host, options, callback) => {
          if (options.all) {
            (callback as (error: NodeJS.ErrnoException | null, addresses: Address[]) => void)(
              null,
              [address],
            );
          } else {
            callback(null, address.address, address.family);
          }
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = String(response.headers.location ?? '');
        if (status < 200 || status >= 300) {
          resolve({ status, location });
          response.destroy();
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk.slice(0, Math.max(0, 4096 - body.length));
          if (body.length === 4096) {
            resolve({ status, location, body });
            response.destroy();
          }
        });
        response.once('end', () => resolve({ status, location, body }));
        response.once('error', reject);
      },
    );
    outgoing.once('timeout', () => outgoing.destroy(new Error('timeout')));
    outgoing.once('error', reject);
    outgoing.end();
  });

/** Checks the same public HTTPS endpoint the Railway E2E worker will use. DNS is pinned. */
export async function probeTunnel(
  rawUrl: string,
  resolver: Resolver = resolveHost,
  requester: Requester = requestHeaders,
  access?: { clientId?: string; clientSecret?: string },
): Promise<TunnelProbeResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ApplicationError('E2E_INVALID_URL', 'Enter a public HTTPS URL.', 400);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new ApplicationError(
      'E2E_INVALID_URL',
      'Enter a public HTTPS URL without credentials, port or fragment.',
      400,
    );
  }
  if (Boolean(access?.clientId) !== Boolean(access?.clientSecret))
    throw new ApplicationError(
      'E2E_INVALID_ACCESS_TOKEN',
      'Enter both tunnel authentication fields.',
      400,
    );
  if (/[\r\n\0]/.test(`${access?.clientId ?? ''}${access?.clientSecret ?? ''}`))
    throw new ApplicationError(
      'E2E_INVALID_ACCESS_TOKEN',
      'The service token contains invalid characters.',
      400,
    );
  let addresses: readonly Address[];
  try {
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(literal);
    addresses = family
      ? [{ address: literal, family: family as 4 | 6 }]
      : await resolver(url.hostname);
  } catch {
    return { reachable: false, reason: 'network_error', status: null };
  }
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address))) {
    throw new ApplicationError(
      'E2E_INVALID_URL',
      'The URL must resolve only to public Internet addresses.',
      400,
    );
  }
  try {
    const {
      status,
      location,
      body = '',
    } = await requester(
      url,
      addresses[0]!,
      access?.clientId && access.clientSecret
        ? accessHeaders({ clientId: access.clientId, clientSecret: access.clientSecret })
        : {},
    );
    if (status === 401 || status === 403 || location.includes('/cdn-cgi/access/'))
      return { reachable: false, reason: 'authentication', status };
    if (
      body
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase() === 'invalid host header'
    )
      return { reachable: false, reason: 'host_error', status };
    if (status >= 500 || status === 0) return { reachable: false, reason: 'origin_error', status };
    return { reachable: true, reason: 'ok', status };
  } catch {
    return { reachable: false, reason: 'network_error', status: null };
  }
}
