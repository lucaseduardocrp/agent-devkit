import { isIP } from 'node:net';
import type { CookieHooks } from './http-transport.js';
import type { Cookie } from './types.js';

// Node built-ins only: copied to the CLI with the rest of the engine.

interface StoredCookie {
  readonly cookie: Cookie;
  /** Insertion order: older cookies come first among equal paths (RFC 6265 §5.4). */
  readonly created: number;
}

/** RFC 6265 cookie jar: domain and path matching, expiry, Secure, host-only cookies. */
export class CookieJar implements CookieHooks {
  private readonly cookies = new Map<string, StoredCookie>();
  private sequence = 0;

  constructor(
    initial: readonly Cookie[] = [],
    private readonly now: () => number = Date.now,
  ) {
    for (const cookie of initial) this.set(cookie);
  }

  /** The `Cookie` header for a request to `url`, or undefined when no cookie applies. */
  cookieHeader(url: URL): string | undefined {
    const host = hostnameOf(url);
    const path = url.pathname || '/';
    const secure = isSecureCapable(url);
    const now = this.now();
    const matching = [...this.cookies.values()]
      .filter(({ cookie }) => !isExpired(cookie, now))
      .filter(({ cookie }) =>
        cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain),
      )
      .filter(({ cookie }) => pathMatches(path, cookie.path))
      .filter(({ cookie }) => !cookie.secure || secure)
      .sort((a, b) => b.cookie.path.length - a.cookie.path.length || a.created - b.created);
    if (matching.length === 0) return undefined;
    return matching.map(({ cookie }) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /** Stores the `Set-Cookie` headers of a response from `url`. */
  store(url: URL, setCookieHeaders: readonly string[]): void {
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header, url, this.now());
      if (!cookie) continue;
      if (cookie.expires !== undefined && cookie.expires <= this.now()) {
        this.cookies.delete(keyOf(cookie));
      } else {
        this.put(cookie);
      }
    }
  }

  /** Cookies not expired, for the runtime state. */
  all(): Cookie[] {
    const now = this.now();
    return [...this.cookies.values()]
      .map(({ cookie }) => cookie)
      .filter((cookie) => !isExpired(cookie, now));
  }

  set(cookie: Cookie): void {
    this.put({
      ...cookie,
      domain: normalizeDomain(cookie.domain),
      path: cookie.path.startsWith('/') ? cookie.path : '/',
    });
  }

  delete(domain: string, name: string, path?: string): void {
    const normalized = normalizeDomain(domain);
    for (const [key, { cookie }] of this.cookies) {
      if (cookie.domain !== normalized || cookie.name !== name) continue;
      if (path !== undefined && cookie.path !== path) continue;
      this.cookies.delete(key);
    }
  }

  clear(): void {
    this.cookies.clear();
  }

  private put(cookie: Cookie): void {
    const key = keyOf(cookie);
    // Replacing a cookie keeps its creation time (RFC 6265 §5.3 step 11.3).
    const created = this.cookies.get(key)?.created ?? this.sequence++;
    this.cookies.set(key, { cookie, created });
  }
}

function keyOf(cookie: Cookie): string {
  return `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
}

function isExpired(cookie: Cookie, now: number): boolean {
  return cookie.expires !== undefined && cookie.expires <= now;
}

function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\./, '').toLowerCase();
}

/** Browsers treat localhost as a secure context, so Secure cookies work over http there. */
function isSecureCapable(url: URL): boolean {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  const host = hostnameOf(url);
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
  );
}

/** RFC 6265 §5.1.3: the host is the domain or a subdomain of it (never for IP addresses). */
function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith(`.${domain}`) && isIP(host) === 0;
}

/** RFC 6265 §5.1.4. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** RFC 6265 §5.1.4: the directory of the request path. */
function defaultPath(url: URL): string {
  const path = url.pathname;
  if (!path.startsWith('/')) return '/';
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}

/** RFC 6265 §5.2 and §5.3; undefined when the cookie must be ignored. */
function parseSetCookie(header: string, url: URL, now: number): Cookie | undefined {
  const [pair = '', ...attributes] = header.split(';');
  const equals = pair.indexOf('=');
  if (equals < 0) return undefined;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (!name) return undefined;

  const host = hostnameOf(url);
  let expires: number | undefined;
  let maxAge: number | undefined;
  let domain = '';
  let path: string | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: string | undefined;
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const raw = index < 0 ? '' : attribute.slice(index + 1).trim();
    switch (key) {
      case 'expires': {
        const time = Date.parse(raw);
        if (!Number.isNaN(time)) expires = time;
        break;
      }
      case 'max-age':
        if (/^-?\d+$/.test(raw)) maxAge = Number(raw);
        break;
      case 'domain':
        if (raw) domain = normalizeDomain(raw);
        break;
      case 'path':
        path = raw.startsWith('/') ? raw : undefined;
        break;
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'samesite':
        sameSite = raw || undefined;
        break;
    }
  }

  let hostOnly = true;
  if (domain && domain !== host) {
    // Single labels (`com`, `local`) act as public suffixes: nobody may set cookies for them.
    if (!domain.includes('.') || !domainMatches(host, domain)) return undefined;
    hostOnly = false;
  }
  if (secure && !isSecureCapable(url)) return undefined;

  // Max-Age wins over Expires (§5.3 step 3).
  const expiry = maxAge !== undefined ? (maxAge <= 0 ? 0 : now + maxAge * 1000) : expires;
  return {
    name,
    value,
    domain: hostOnly ? host : domain,
    path: path ?? defaultPath(url),
    ...(expiry !== undefined ? { expires: expiry } : {}),
    ...(secure ? { secure } : {}),
    ...(httpOnly ? { httpOnly } : {}),
    hostOnly,
    ...(sameSite ? { sameSite } : {}),
  };
}
