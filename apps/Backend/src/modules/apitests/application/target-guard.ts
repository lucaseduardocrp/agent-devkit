import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApplicationError } from '../../../shared/errors.js';
import { isLoopbackName } from '../../../shared/host-access.js';

// The ADK workers run inside the ADK infrastructure. Requests from a run must not reach that
// infrastructure itself (loopback, the cloud metadata endpoint) and, unless the self-hosted
// operator allows it, nothing on the private network either. Local runs (`devkit runner`) are not
// guarded: they execute with the user's own network access.

const LOCAL_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/** Hostnames that are always the machine itself, whatever DNS says. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    LOCAL_NAMES.has(host) ||
    host.endsWith('.localhost') ||
    (isIP(host) > 0 && isLoopbackOrLinkLocal(host))
  );
}

function ipv4Parts(address: string): number[] | null {
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  const parts = mapped.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isLoopbackOrLinkLocal(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) return v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254);
  const v6 = address.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fe80:');
}

export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4 as [number, number];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = address.toLowerCase();
  return v6.startsWith('fc') || v6.startsWith('fd');
}

/**
 * Checks every address the hostname resolves to before a worker sends a request. Redirects are
 * followed by fetch without a second check, so the guard is a safety net, not a sandbox: the
 * network policy of the worker remains the real boundary.
 */
export function remoteTargetGuard(
  options: {
    readonly allowPrivateNetwork?: boolean;
    /**
     * Host access of a local install (see shared/host-access.ts): `localhost` goes to this alias,
     * which is the user's own computer, and the private network it sits on is reachable too.
     */
    readonly hostAlias?: string | null;
  } = {},
) {
  const cache = new Map<string, Promise<void>>();
  const allowPrivateNetwork = options.allowPrivateNetwork || Boolean(options.hostAlias);
  const check = async (hostname: string) => {
    if (options.hostAlias && isLoopbackName(hostname)) return;
    if (isBlockedHostname(hostname)) throw blocked(hostname);
    const addresses = isIP(hostname.replace(/^\[|\]$/g, ''))
      ? [hostname.replace(/^\[|\]$/g, '')]
      : (await lookup(hostname, { all: true })).map((entry) => entry.address);
    for (const address of addresses) {
      if (isLoopbackOrLinkLocal(address) || (!allowPrivateNetwork && isPrivateAddress(address))) {
        throw blocked(hostname);
      }
    }
  };
  return (url: URL): Promise<void> => {
    let pending = cache.get(url.hostname);
    if (!pending) {
      pending = check(url.hostname);
      cache.set(url.hostname, pending);
    }
    return pending;
  };
}

function blocked(host: string) {
  return new ApplicationError(
    'API_TEST_TARGET_LOCAL',
    `${host} is on a local or private network the ADK workers do not reach. Run the test on your computer with devkit runner.`,
    400,
    [{ host }],
    { host },
  );
}
