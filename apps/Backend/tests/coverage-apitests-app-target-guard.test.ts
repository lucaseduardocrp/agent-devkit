import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const { isBlockedHostname, isPrivateAddress, remoteTargetGuard } =
  await import('../src/modules/apitests/application/target-guard.js');

beforeEach(() => lookup.mockReset());

describe('isBlockedHostname', () => {
  it('blocks local names and loopback or link-local addresses', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'ip6-loopback',
      'api.localhost',
      '[::1]',
      '::',
      'fe80::1',
      '127.0.0.9',
      '0.0.0.0',
      '169.254.169.254',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it('lets public names and addresses through', () => {
    for (const host of ['example.com', '93.184.216.34', '2001:db8::1', '169.255.0.1']) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
  });
});

describe('isPrivateAddress', () => {
  it('recognises the private IPv4 ranges and unique-local IPv6', () => {
    for (const address of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.0.1',
      '::ffff:10.0.0.1',
      'fc00::1',
      'FD12::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('does not flag public addresses, near misses or non-addresses', () => {
    for (const address of [
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '100.63.0.1',
      '100.128.0.1',
      '2001:db8::1',
      '1.2.3',
      '1.2.3.999',
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('remoteTargetGuard resolving names', () => {
  it('allows names that resolve to public addresses and caches the check per host', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34' }, { address: '2001:db8::1' }]);
    const guard = remoteTargetGuard();
    await expect(guard(new URL('https://example.com/a'))).resolves.toBeUndefined();
    await expect(guard(new URL('https://example.com/b'))).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true });
  });

  it('blocks names that resolve to a private or loopback address', async () => {
    const guard = remoteTargetGuard();
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34' }, { address: '10.0.0.5' }]);
    await expect(guard(new URL('https://internal.example.com/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
      statusCode: 400,
    });
    lookup.mockResolvedValueOnce([{ address: '127.0.0.1' }]);
    await expect(guard(new URL('https://rebind.example.com/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
  });

  it('opens the private network when allowed but never loopback', async () => {
    const guard = remoteTargetGuard({ allowPrivateNetwork: true });
    lookup.mockResolvedValueOnce([{ address: '10.0.0.5' }]);
    await expect(guard(new URL('https://internal.example.com/'))).resolves.toBeUndefined();
    lookup.mockResolvedValueOnce([{ address: '169.254.169.254' }]);
    await expect(guard(new URL('https://meta.example.com/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
  });

  it('checks IP literals, bracketed or not, without a DNS lookup', async () => {
    const guard = remoteTargetGuard();
    await expect(guard(new URL('http://93.184.216.34/'))).resolves.toBeUndefined();
    await expect(guard(new URL('http://[2001:db8::1]/'))).resolves.toBeUndefined();
    await expect(guard(new URL('http://192.168.0.1/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
    await expect(guard(new URL('http://[fd00::1]/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});
