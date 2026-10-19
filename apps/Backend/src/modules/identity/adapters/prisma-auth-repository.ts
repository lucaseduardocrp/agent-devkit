import type {
  AuthRepository,
  AuthCodeEntity,
  AuthCodePurpose,
  CreateSessionInput,
  CreateUserInput,
  SessionEntity,
  UserEntity,
} from '../application/auth-repository.js';

interface UserDelegate {
  findUnique(arguments_: { where: { email?: string; id?: string } }): Promise<UserEntity | null>;
  create(arguments_: {
    data: {
      email: string;
      passwordHash: string | null;
      name: string;
      emailVerifiedAt?: Date | null;
    };
  }): Promise<UserEntity>;
  update?(arguments_: {
    where: { id: string };
    data: { passwordHash?: string; emailVerifiedAt?: Date };
  }): Promise<UserEntity>;
  delete(arguments_: { where: { id: string } }): Promise<UserEntity>;
}

interface AuthCodeDelegate {
  create(arguments_: {
    data: { email: string; purpose: string; codeHash: string; expiresAt: Date };
  }): Promise<AuthCodeEntity>;
  findFirst(arguments_: {
    where: { email: string; purpose: string; consumedAt: null };
    orderBy: { createdAt: 'desc' };
  }): Promise<AuthCodeEntity | null>;
  update(arguments_: {
    where: { id: string };
    data: { attempts?: { increment: number }; consumedAt?: Date };
  }): Promise<AuthCodeEntity>;
}

interface OAuthIdentityDelegate {
  findUnique(arguments_: {
    where: { provider_providerUserId: { provider: string; providerUserId: string } };
    include: { user: boolean };
  }): Promise<{ user: UserEntity } | null>;
  upsert(arguments_: {
    where: { provider_providerUserId: { provider: string; providerUserId: string } };
    create: { userId: string; provider: string; providerUserId: string };
    update: Record<string, never>;
  }): Promise<unknown>;
}

interface SessionWithUser extends SessionEntity {
  user: UserEntity;
}

interface SessionDelegate {
  create(arguments_: {
    data: { userId: string; token: string; expiresAt: Date };
    include?: { user: boolean };
  }): Promise<SessionWithUser>;
  findUnique(arguments_: {
    where: { token: string };
    include?: { user: boolean };
  }): Promise<SessionWithUser | null>;
  deleteMany(arguments_: {
    where: { token?: string; expiresAt?: { lte: Date } };
  }): Promise<{ count: number }>;
}

export interface PrismaAuthClient {
  readonly userRecord: UserDelegate;
  readonly sessionRecord: SessionDelegate;
  readonly authCodeRecord?: AuthCodeDelegate;
  readonly oAuthIdentityRecord?: OAuthIdentityDelegate;
}

export class PrismaAuthRepository implements AuthRepository {
  public constructor(private readonly client: PrismaAuthClient) {}

  public async findByEmail(email: string): Promise<UserEntity | null> {
    return this.client.userRecord.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
  }

  public async findById(id: string): Promise<UserEntity | null> {
    return this.client.userRecord.findUnique({
      where: { id },
    });
  }

  public async createUser(input: CreateUserInput): Promise<UserEntity> {
    return this.client.userRecord.create({
      data: {
        email: input.email.toLowerCase().trim(),
        passwordHash: input.passwordHash,
        name: input.name,
        emailVerifiedAt: input.emailVerifiedAt,
      },
    });
  }

  public async deleteUser(userId: string): Promise<void> {
    await this.client.userRecord.delete({ where: { id: userId } });
  }

  public async updateUser(
    userId: string,
    input: { passwordHash?: string; emailVerifiedAt?: Date },
  ): Promise<UserEntity> {
    if (!this.client.userRecord.update)
      throw new Error('Auth repository does not support user updates.');
    return this.client.userRecord.update({ where: { id: userId }, data: input });
  }

  public async createAuthCode(input: {
    email: string;
    purpose: AuthCodePurpose;
    codeHash: string;
    expiresAt: Date;
  }): Promise<AuthCodeEntity> {
    if (!this.client.authCodeRecord) throw new Error('Auth repository does not support codes.');
    return this.client.authCodeRecord.create({ data: input });
  }

  public async findLatestAuthCode(
    email: string,
    purpose: AuthCodePurpose,
  ): Promise<AuthCodeEntity | null> {
    if (!this.client.authCodeRecord) throw new Error('Auth repository does not support codes.');
    return this.client.authCodeRecord.findFirst({
      where: { email: email.toLowerCase().trim(), purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async incrementAuthCodeAttempts(id: string): Promise<void> {
    if (!this.client.authCodeRecord) throw new Error('Auth repository does not support codes.');
    await this.client.authCodeRecord.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  public async consumeAuthCode(id: string, consumedAt: Date): Promise<void> {
    if (!this.client.authCodeRecord) throw new Error('Auth repository does not support codes.');
    await this.client.authCodeRecord.update({ where: { id }, data: { consumedAt } });
  }

  public async findUserByOAuth(
    provider: string,
    providerUserId: string,
  ): Promise<UserEntity | null> {
    if (!this.client.oAuthIdentityRecord) return null;
    const identity = await this.client.oAuthIdentityRecord.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
      include: { user: true },
    });
    return identity?.user ?? null;
  }

  public async linkOAuthIdentity(
    userId: string,
    provider: string,
    providerUserId: string,
  ): Promise<void> {
    if (!this.client.oAuthIdentityRecord)
      throw new Error('Auth repository does not support OAuth.');
    await this.client.oAuthIdentityRecord.upsert({
      where: { provider_providerUserId: { provider, providerUserId } },
      create: { userId, provider, providerUserId },
      update: {},
    });
  }

  public async createSession(input: CreateSessionInput): Promise<SessionEntity> {
    return this.client.sessionRecord.create({
      data: {
        userId: input.userId,
        token: input.token,
        expiresAt: input.expiresAt,
      },
      include: { user: true },
    });
  }

  public async findSessionByToken(token: string): Promise<SessionEntity | null> {
    return this.client.sessionRecord.findUnique({
      where: { token },
      include: { user: true },
    });
  }

  public async deleteSessionByToken(token: string): Promise<void> {
    await this.client.sessionRecord.deleteMany({
      where: { token },
    });
  }

  public async deleteExpiredSessions(now: Date = new Date()): Promise<number> {
    const result = await this.client.sessionRecord.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return result.count;
  }
}
