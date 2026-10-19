import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type {
  AuthResponse,
  LoginInput,
  RegisterInput,
  UserProfile,
} from '../../../contracts/auth.js';
import { ApplicationError } from '../../../shared/errors.js';
import { hashPassword, verifyPassword } from '../domain/password.js';
import type {
  AuthCodePurpose,
  AuthRepository,
  SessionEntity,
  UserEntity,
} from './auth-repository.js';
import type { EmailSender } from './email-sender.js';
import { UnavailableEmailSender } from './email-sender.js';
import type { OAuthProfile } from './oauth-provider.js';
import { isAccessToken, type AccessTokenScope, type AccessTokenService } from './access-tokens.js';

/** Who a bearer token belongs to and how it was issued. */
export interface AuthenticatedToken {
  readonly user: UserEntity;
  readonly kind: 'session' | 'access-token';
  readonly scope: AccessTokenScope;
}

export interface AuthServiceOptions {
  readonly sessionDurationDays?: number;
  readonly codeDurationMinutes?: number;
  readonly emailSender?: EmailSender;
  readonly codeSecret?: string;
  readonly accessTokens?: AccessTokenService;
}

const DEFAULT_SESSION_DURATION_DAYS = 7;
const DEFAULT_CODE_DURATION_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;

export class AuthService {
  private readonly sessionDurationDays: number;
  private readonly codeDurationMinutes: number;
  private readonly emailSender: EmailSender;
  private readonly codeSecret: string;
  private readonly accessTokens?: AccessTokenService;

  public constructor(
    private readonly repository: AuthRepository,
    options: AuthServiceOptions = {},
  ) {
    this.sessionDurationDays = options.sessionDurationDays ?? DEFAULT_SESSION_DURATION_DAYS;
    this.codeDurationMinutes = options.codeDurationMinutes ?? DEFAULT_CODE_DURATION_MINUTES;
    this.emailSender = options.emailSender ?? new UnavailableEmailSender();
    this.codeSecret = options.codeSecret || randomBytes(32).toString('hex');
    this.accessTokens = options.accessTokens;
  }

  public async register(input: RegisterInput): Promise<AuthResponse> {
    const normalizedEmail = normalizeEmail(input.email);
    const existing = await this.repository.findByEmail(normalizedEmail);
    if (existing) {
      throw new ApplicationError(
        'IDENTITY_EXISTS',
        'An account with this email already exists.',
        409,
      );
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.repository.createUser({
      email: normalizedEmail,
      passwordHash,
      name: input.name.trim(),
      emailVerifiedAt: new Date(),
    });
    return this.authResponse(user);
  }

  public async requestPasswordReset(email: string): Promise<void> {
    const user = await this.repository.findByEmail(normalizeEmail(email));
    if (!user) return;
    await this.sendCode(user.email, 'RESET_PASSWORD');
  }

  public async resetPassword(email: string, code: string, password: string): Promise<AuthResponse> {
    const normalizedEmail = normalizeEmail(email);
    await this.verifyCode(normalizedEmail, 'RESET_PASSWORD', code);
    const user = await this.repository.findByEmail(normalizedEmail);
    if (!user) throw new ApplicationError('INVALID_CODE', 'Invalid or expired code.', 400);
    const updated = await this.repository.updateUser(user.id, {
      passwordHash: await hashPassword(password),
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    });
    return this.authResponse(updated);
  }

  public async login(input: LoginInput): Promise<AuthResponse> {
    const normalizedEmail = normalizeEmail(input.email);
    const user = await this.repository.findByEmail(normalizedEmail);
    if (!user) {
      throw new ApplicationError('INVALID_CREDENTIALS', 'Invalid email or password.', 401);
    }

    if (!user.passwordHash) {
      throw new ApplicationError(
        'PASSWORD_LOGIN_UNAVAILABLE',
        'Use a connected login provider.',
        401,
      );
    }

    const isValid = await verifyPassword(input.password, user.passwordHash);
    if (!isValid) {
      throw new ApplicationError('INVALID_CREDENTIALS', 'Invalid email or password.', 401);
    }

    return this.authResponse(user);
  }

  public async loginWithOAuth(profile: OAuthProfile): Promise<AuthResponse> {
    if (!profile.emailVerified) {
      throw new ApplicationError(
        'OAUTH_EMAIL_REQUIRED',
        'A verified provider email is required.',
        422,
      );
    }
    let user = await this.repository.findUserByOAuth(profile.provider, profile.providerUserId);
    if (!user) {
      user = await this.repository.findByEmail(normalizeEmail(profile.email));
      if (!user) {
        user = await this.repository.createUser({
          email: normalizeEmail(profile.email),
          name: profile.name.trim() || profile.email,
          passwordHash: null,
          emailVerifiedAt: new Date(),
        });
      } else if (!user.emailVerifiedAt) {
        user = await this.repository.updateUser(user.id, { emailVerifiedAt: new Date() });
      }
      await this.repository.linkOAuthIdentity(user.id, profile.provider, profile.providerUserId);
    }
    return this.authResponse(user);
  }

  public async getMe(token: string): Promise<UserProfile> {
    const user = await this.authenticateToken(token);
    if (!user) {
      throw new ApplicationError('UNAUTHORIZED', 'Invalid or expired session.', 401);
    }
    return toUserProfile(user);
  }

  public async logout(token: string): Promise<void> {
    const cleanToken = token.trim();
    if (cleanToken) {
      await this.repository.deleteSessionByToken(cleanToken);
    }
  }

  public async authenticateToken(token: string): Promise<UserEntity | null> {
    return (await this.authenticate(token))?.user ?? null;
  }

  public async authenticate(token: string): Promise<AuthenticatedToken | null> {
    const cleanToken = token.trim();
    if (!cleanToken) {
      return null;
    }
    if (isAccessToken(cleanToken)) {
      const verified = await this.accessTokens?.verify(cleanToken);
      return verified ? { ...verified, kind: 'access-token' } : null;
    }
    const user = await this.authenticateSession(cleanToken);
    return user ? { user, kind: 'session', scope: 'full' } : null;
  }

  private async authenticateSession(cleanToken: string): Promise<UserEntity | null> {
    const session = await this.repository.findSessionByToken(cleanToken);
    if (!session) {
      return null;
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.repository.deleteSessionByToken(cleanToken);
      return null;
    }

    if (session.user) {
      return session.user;
    }

    return this.repository.findById(session.userId);
  }

  private async createSessionForUser(userId: string): Promise<SessionEntity> {
    const token = createOpaqueToken();
    const expiresAt = new Date(Date.now() + this.sessionDurationDays * 24 * 60 * 60 * 1000);
    return this.repository.createSession({
      userId,
      token,
      expiresAt,
    });
  }

  private async authResponse(user: UserEntity): Promise<AuthResponse> {
    const session = await this.createSessionForUser(user.id);
    return {
      user: toUserProfile(user),
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  private async sendCode(email: string, purpose: AuthCodePurpose): Promise<void> {
    const latest = await this.repository.findLatestAuthCode(email, purpose);
    if (latest && Date.now() - latest.createdAt.getTime() < 60_000) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.repository.createAuthCode({
      email,
      purpose,
      codeHash: this.hashCode(code),
      expiresAt: new Date(Date.now() + this.codeDurationMinutes * 60_000),
    });
    try {
      await this.emailSender.send({
        to: email,
        subject: 'Recover your adk account',
        text: `Use code ${code} to recover your account. It expires in ${this.codeDurationMinutes} minutes.`,
        html: `<p>Use this code to recover your account:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>It expires in ${this.codeDurationMinutes} minutes.</p>`,
      });
    } catch {
      throw new ApplicationError(
        'EMAIL_DELIVERY_FAILED',
        'The email could not be delivered. Check the SMTP configuration.',
        503,
      );
    }
  }

  private async verifyCode(email: string, purpose: AuthCodePurpose, code: string): Promise<void> {
    const challenge = await this.repository.findLatestAuthCode(email, purpose);
    if (
      !challenge ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.attempts >= MAX_CODE_ATTEMPTS
    ) {
      throw new ApplicationError('INVALID_CODE', 'Invalid or expired code.', 400);
    }
    const expected = Buffer.from(challenge.codeHash, 'hex');
    const received = Buffer.from(this.hashCode(code.trim()), 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      await this.repository.incrementAuthCodeAttempts(challenge.id);
      throw new ApplicationError('INVALID_CODE', 'Invalid or expired code.', 400);
    }
    await this.repository.consumeAuthCode(challenge.id, new Date());
  }

  private hashCode(code: string): string {
    return createHmac('sha256', this.codeSecret).update(code).digest('hex');
  }
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}

export function toUserProfile(user: UserEntity): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
