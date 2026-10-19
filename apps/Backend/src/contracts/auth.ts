import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8),
  name: z.string().trim().min(1),
});

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const emailCodeSchema = z.object({
  email: z.string().trim().email(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

export const emailOnlySchema = z.object({ email: z.string().trim().email() });

export const resetPasswordSchema = emailCodeSchema.extend({
  password: z.string().min(8),
});

export const createAccessTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['full', 'read']).default('full'),
  /** Days until expiry (1-365); null creates a token without expiry. */
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface AuthResponse {
  readonly user: UserProfile;
  readonly token: string;
  readonly expiresAt: string;
}
