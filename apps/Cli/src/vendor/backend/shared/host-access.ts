import { lookup, type LookupAddress, type LookupAllOptions, type LookupOneOptions } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';

// When ADK runs in Docker on the user's own computer (the setup wizard's local install), a test
// target on `localhost` means that computer, not the container that runs the test. With host
// access on, the workers reach it through Docker's host alias: browsers through Chromium's host
// resolver rules and API requests through their own DNS lookup, so in both cases the request still
// says `Host: localhost` and keeps the localhost origin (cookies, CORS, SSO and dev servers that
// only accept localhost keep working).

/** Hostnames that mean "this machine". */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLoopbackName = (hostname: string) => LOOPBACK_NAMES.has(hostname.toLowerCase());

/**
 * The host alias the workers use for `localhost`, or null when host access is off.
 *
 * `ADK_HOST_ACCESS`: `true` turns it on, `false` (or unset, as in development and the cloud) off,
 * and `auto` (the Docker Compose default) on only while ADK is reachable from this computer alone
 * (`ADK_BIND_ADDRESS` is a loopback address): a server shared on the network must not let its
 * users reach the services of the machine it runs on.
 */
export function hostAliasFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const mode = (env['ADK_HOST_ACCESS'] ?? '').trim().toLowerCase();
  const alias = env['ADK_HOST_ALIAS']?.trim() || 'host.docker.internal';
  if (mode === 'true') return alias;
  if (mode !== 'auto') return null;
  const bind = (env['ADK_BIND_ADDRESS'] ?? '127.0.0.1').trim().toLowerCase();
  return ['127.0.0.1', 'localhost', '::1'].includes(bind) ? alias : null;
}

/** Chromium arguments that send `localhost` to the host alias; the page keeps its localhost origin. */
export function chromiumHostArgs(alias: string | null): string[] {
  return alias ? [`--host-resolver-rules=MAP localhost ${alias}, MAP 127.0.0.1 ${alias}`] : [];
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A fetch whose connections to `localhost` go to the host alias. Only the address changes: the URL,
 * the Host header and the TLS server name stay `localhost`. IP literals skip DNS, so `127.0.0.1`
 * and `[::1]` are sent as `localhost`.
 */
export function hostAccessFetch(alias: string): typeof fetch {
  const agent = new Agent({
    connect: {
      lookup: (
        hostname: string,
        options: LookupOneOptions | LookupAllOptions,
        callback: LookupCallback,
      ) => {
        lookup(isLoopbackName(hostname) ? alias : hostname, options, callback as never);
      },
    },
  });
  return ((input: string | URL | Request, init?: RequestInit) => {
    // A whole Request keeps its method and body; only its connection goes through the agent.
    if (input instanceof Request)
      return undiciFetch(input as never, { ...(init as object), dispatcher: agent });
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1' || url.hostname === '[::1]') url.hostname = 'localhost';
    return undiciFetch(url, { ...(init as object), dispatcher: agent });
  }) as unknown as typeof fetch;
}
