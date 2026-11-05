import { describe, expect, it } from 'vitest';
import { CookieJar } from '../src/modules/apitests/engine/cookie-jar.js';

const T0 = Date.UTC(2025, 0, 1);

function jar(now = () => T0): CookieJar {
  return new CookieJar([], now);
}

describe('CookieJar', () => {
  it('stores host-only cookies with the default path', () => {
    const cookies = jar();
    cookies.store(new URL('https://api.example.com/v1/users/42'), ['sid=abc; HttpOnly']);
    expect(cookies.all()).toEqual([
      {
        name: 'sid',
        value: 'abc',
        domain: 'api.example.com',
        path: '/v1/users',
        httpOnly: true,
        hostOnly: true,
      },
    ]);
    expect(cookies.cookieHeader(new URL('https://api.example.com/v1/users/7'))).toBe('sid=abc');
    expect(cookies.cookieHeader(new URL('https://api.example.com/v1/other'))).toBeUndefined();
    expect(cookies.cookieHeader(new URL('https://sub.api.example.com/v1/users/7'))).toBeUndefined();
  });

  it('shares domain cookies with subdomains', () => {
    const cookies = jar();
    cookies.store(new URL('https://www.example.com/'), ['a=1; Domain=.Example.com; Path=/']);
    expect(cookies.cookieHeader(new URL('https://api.example.com/x'))).toBe('a=1');
    expect(cookies.cookieHeader(new URL('https://example.com/'))).toBe('a=1');
    expect(cookies.cookieHeader(new URL('https://notexample.com/'))).toBeUndefined();
  });

  it('rejects cookies for unrelated domains and single-label suffixes', () => {
    const cookies = jar();
    cookies.store(new URL('https://www.example.com/'), [
      'a=1; Domain=other.com',
      'b=2; Domain=com',
      'c=3; Domain=www.example.com.evil',
      'novalue',
      '=x',
    ]);
    expect(cookies.all()).toEqual([]);
    // A single label that is the host itself is a host-only cookie.
    cookies.store(new URL('http://intranet/'), ['d=4; Domain=intranet']);
    expect(cookies.all()).toMatchObject([{ name: 'd', domain: 'intranet', hostOnly: true }]);
  });

  it('expires cookies with Expires and Max-Age, Max-Age winning', () => {
    let now = T0;
    const cookies = jar(() => now);
    const url = new URL('https://example.com/');
    cookies.store(url, [
      `a=1; Expires=${new Date(T0 + 60_000).toUTCString()}`,
      `b=2; Max-Age=10; Expires=${new Date(T0 + 3600_000).toUTCString()}`,
      'c=3',
    ]);
    expect(cookies.cookieHeader(url)).toBe('a=1; b=2; c=3');
    now = T0 + 11_000;
    expect(cookies.cookieHeader(url)).toBe('a=1; c=3');
    now = T0 + 61_000;
    expect(cookies.all().map((cookie) => cookie.name)).toEqual(['c']);
  });

  it('deletes cookies with Max-Age=0 or a past Expires', () => {
    const cookies = jar();
    const url = new URL('https://example.com/');
    cookies.store(url, ['a=1', 'b=2']);
    cookies.store(url, ['a=; Max-Age=0', 'b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    expect(cookies.all()).toEqual([]);
  });

  it('sends Secure cookies over https and to localhost only', () => {
    const cookies = jar();
    cookies.store(new URL('https://example.com/'), ['s=1; Secure; SameSite=Lax']);
    cookies.store(new URL('http://example.com/'), ['t=2; Secure']);
    expect(cookies.all()).toMatchObject([{ name: 's', secure: true, sameSite: 'Lax' }]);
    expect(cookies.cookieHeader(new URL('http://example.com/'))).toBeUndefined();
    expect(cookies.cookieHeader(new URL('https://example.com/'))).toBe('s=1');

    cookies.store(new URL('http://localhost:3000/'), ['l=1; Secure']);
    expect(cookies.cookieHeader(new URL('http://localhost:3000/'))).toBe('l=1');
  });

  it('orders by path length, then creation, and replaces in place', () => {
    const cookies = jar();
    cookies.store(new URL('https://example.com/'), [
      'a=1; Path=/',
      'b=2; Path=/api/v1',
      'c=3; Path=/api',
    ]);
    cookies.store(new URL('https://example.com/'), ['a=9; Path=/']);
    expect(cookies.cookieHeader(new URL('https://example.com/api/v1/x'))).toBe('b=2; c=3; a=9');
    expect(cookies.cookieHeader(new URL('https://example.com/apiv2'))).toBe('a=9');
  });

  it('sets, deletes and clears cookies directly', () => {
    const cookies = new CookieJar(
      [{ name: 'x', value: '1', domain: '.example.com', path: '/' }],
      () => T0,
    );
    expect(cookies.cookieHeader(new URL('https://a.example.com/'))).toBe('x=1');
    cookies.set({ name: 'y', value: '2', domain: 'example.com', path: '/a' });
    cookies.set({ name: 'y', value: '3', domain: 'example.com', path: '/b' });
    cookies.delete('example.com', 'y', '/a');
    expect(cookies.all().map((cookie) => `${cookie.name}${cookie.path}`)).toEqual(['x/', 'y/b']);
    cookies.delete('.example.com', 'y');
    expect(cookies.all()).toHaveLength(1);
    cookies.clear();
    expect(cookies.all()).toEqual([]);
  });
});
