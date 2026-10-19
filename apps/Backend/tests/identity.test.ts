import { describe, expect, it } from 'vitest';
import {
  InMemoryIdentityService,
  createOpaqueToken,
} from '../src/modules/identity/application/identity-service.js';

describe('identity service', () => {
  it('registers and authenticates an identity', async () => {
    const service = new InMemoryIdentityService();
    const identity = await service.register(' User@Example.com ', 'password');
    await expect(service.authenticate('user@example.com', 'password')).resolves.toEqual(identity);
    expect(createOpaqueToken()).toHaveLength(64);
  });

  it('rejects invalid registration and duplicate accounts', async () => {
    const service = new InMemoryIdentityService();
    await expect(service.register('invalid', 'password')).rejects.toMatchObject({
      code: 'VALID_EMAIL_REQUIRED',
    });
    await expect(service.register('user@example.com', 'short')).rejects.toMatchObject({
      code: 'PASSWORD_TOO_SHORT',
    });
    await service.register('user@example.com', 'password');
    await expect(service.register('USER@example.com', 'password')).rejects.toMatchObject({
      code: 'IDENTITY_EXISTS',
    });
  });

  it('rejects invalid credentials and unauthorized ownership', async () => {
    const service = new InMemoryIdentityService();
    const identity = await service.register('user@example.com', 'password');
    await expect(service.authenticate('user@example.com', 'wrongpass')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(() =>
      service.authorize({ requestId: 'request-1', actorId: identity.id }, identity.id),
    ).not.toThrow();
    expect(() => service.authorize({ requestId: 'request-1' }, identity.id)).toThrow(
      'Access denied',
    );
  });
});
