import { describe, expect, it } from 'vitest';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import type {
  EmailMessage,
  EmailSender,
} from '../src/modules/identity/application/email-sender.js';

class CapturingEmailSender implements EmailSender {
  public messages: EmailMessage[] = [];

  public send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  public latestCode(): string {
    const match = this.messages.at(-1)?.text.match(/\b\d{6}\b/);
    if (!match) throw new Error('Verification code was not sent.');
    return match[0];
  }
}

describe('registration and account recovery', () => {
  it('authenticates a new account without sending a verification email', async () => {
    const sender = new CapturingEmailSender();
    const service = new AuthService(new InMemoryAuthRepository(), {
      emailSender: sender,
    });

    const registration = await service.register({
      email: 'verify@example.com',
      name: 'Verified User',
      password: 'Password123!',
    });

    expect(sender.messages).toHaveLength(0);
    await expect(service.getMe(registration.token)).resolves.toMatchObject({
      email: 'verify@example.com',
    });
    await expect(
      service.login({ email: 'verify@example.com', password: 'Password123!' }),
    ).resolves.toMatchObject({ user: { email: 'verify@example.com' } });
  });

  it('resets a password with a single-use emailed code', async () => {
    const sender = new CapturingEmailSender();
    const service = new AuthService(new InMemoryAuthRepository(), {
      emailSender: sender,
    });
    await service.loginWithOAuth({
      provider: 'google',
      providerUserId: 'google-user',
      email: 'recover@example.com',
      name: 'Recovery User',
      emailVerified: true,
    });

    await service.requestPasswordReset('recover@example.com');
    const code = sender.latestCode();
    const reset = await service.resetPassword('recover@example.com', code, 'NewPassword123!');
    expect(reset.token).toHaveLength(64);
    await expect(
      service.resetPassword('recover@example.com', code, 'OtherPassword123!'),
    ).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    await expect(
      service.login({ email: 'recover@example.com', password: 'NewPassword123!' }),
    ).resolves.toMatchObject({ user: { email: 'recover@example.com' } });
  });
});
