import { describe, expect, it } from 'vitest';
import { CookieJar } from '../src/modules/apitests/engine/cookie-jar.js';
import { LayeredScope } from '../src/modules/apitests/engine/variables.js';

describe('LayeredScope', () => {
  it('keeps the secret mark a name carries in another layer', () => {
    const scope = new LayeredScope({ collection: [{ key: 'token', value: 'a', secret: true }] });
    scope.setIn('runtime', 'token', 'captured');
    expect(scope.get('token')?.secret).toBe(true);
    expect(scope.get('token')?.value).toBe('captured');
    expect(scope.isSecret('token')).toBe(true);
    expect(scope.isSecret('other')).toBe(false);
  });

  it('skips disabled rows and rows with a blank key when a layer is assigned', () => {
    const scope = new LayeredScope({ collection: [{ key: 'base', value: 'https://api.test' }] });
    scope.assign('folder', [
      { key: 'url', value: '{{base}}/x' },
      { key: 'off', value: 'no', enabled: false },
      { key: '   ', value: 'blank' },
    ]);
    expect(scope.record('folder')).toEqual({ url: 'https://api.test/x' });
  });

  it('replaces a layer while keeping the secret marks', () => {
    const scope = new LayeredScope({ environment: [{ key: 'pass', value: 'a', secret: true }] });
    scope.replace('environment', { pass: 'b', plain: 'c' });
    expect(scope.get('pass')).toEqual({ value: 'b', secret: true });
    expect(scope.get('plain')).toEqual({ value: 'c', secret: false });
    expect([...scope.values()].length).toBe(2);
  });
});

describe('CookieJar', () => {
  it('serves a URL whose scheme leaves the path empty', () => {
    const jar = new CookieJar([
      { name: 'a', value: '1', domain: 'a.test', path: '/', secure: false, httpOnly: false, hostOnly: true },
    ]);
    expect(jar.cookieHeader(new URL('tcp://a.test'))).toBe('a=1');
  });

  it('stores a cookie whose path is not absolute under the root', () => {
    const jar = new CookieJar();
    jar.set({
      name: 'a',
      value: '1',
      domain: 'a.test',
      path: 'relative',
      secure: false,
      httpOnly: false,
      hostOnly: true,
    });
    expect(jar.all()[0]?.path).toBe('/');
  });

  it('reads the Expires, Path and SameSite attributes of a Set-Cookie header', () => {
    const jar = new CookieJar([], () => Date.parse('2026-01-01T00:00:00Z'));
    jar.store(new URL('https://a.test/deep/page'), [
      'keep=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT; SameSite=Lax',
      'bad=1; Expires=not-a-date',
      'relative=1; Path=nonsense',
      'blank=1; SameSite=',
    ]);
    const byName = new Map(jar.all().map((cookie) => [cookie.name, cookie]));
    expect(byName.get('keep')?.sameSite).toBe('Lax');
    expect(byName.get('keep')?.expires).toBe(Date.parse('2031-01-01T00:00:00Z'));
    expect(byName.get('bad')?.expires).toBeUndefined();
    // A Path that is not absolute is dropped, so the cookie keeps the request's directory.
    expect(byName.get('relative')?.path).toBe('/deep');
    expect(byName.get('blank')?.sameSite).toBeUndefined();
  });

  it('falls back to the root for a URL with no path at all', () => {
    const jar = new CookieJar();
    jar.store(new URL('tcp://a.test'), ['a=1']);
    expect(jar.all()[0]?.path).toBe('/');
  });
});
