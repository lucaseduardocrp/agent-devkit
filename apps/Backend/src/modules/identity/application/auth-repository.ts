export interface UserEntity {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly name: string;
  readonly emailVerifiedAt?: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SessionEntity {
  readonly id: string;
  readonly userId: string;
  readonly token: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly user?: UserEntity;
}

export interface CreateUserInput {
  readonly email: string;
  readonly passwordHash: string | null;
  readonly name: string;
  readonly emailVerifiedAt?: Date | null;
}

export type AuthCodePurpose = 'RESET_PASSWORD';

export interface AuthCodeEntity {
  readonly id: string;
  readonly email: string;
  readonly purpose: AuthCodePurpose;
  readonly codeHash: string;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AuthRepository {
  findByEmail(email: string): Promise<UserEntity | null>;
  findById(id: string): Promise<UserEntity | null>;
  createUser(input: CreateUserInput): Promise<UserEntity>;
  deleteUser(userId: string): Promise<void>;
  updateUser(
    userId: string,
    input: { passwordHash?: string; emailVerifiedAt?: Date },
  ): Promise<UserEntity>;
  createAuthCode(input: {
    email: string;
    purpose: AuthCodePurpose;
    codeHash: string;
    expiresAt: Date;
  }): Promise<AuthCodeEntity>;
  findLatestAuthCode(email: string, purpose: AuthCodePurpose): Promise<AuthCodeEntity | null>;
  incrementAuthCodeAttempts(id: string): Promise<void>;
  consumeAuthCode(id: string, consumedAt: Date): Promise<void>;
  findUserByOAuth(provider: string, providerUserId: string): Promise<UserEntity | null>;
  linkOAuthIdentity(userId: string, provider: string, providerUserId: string): Promise<void>;
  createSession(input: CreateSessionInput): Promise<SessionEntity>;
  findSessionByToken(token: string): Promise<SessionEntity | null>;
  deleteSessionByToken(token: string): Promise<void>;
  deleteExpiredSessions(now?: Date): Promise<number>;
}
