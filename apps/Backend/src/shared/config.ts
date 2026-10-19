import { z } from 'zod';

const runtimeConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    DATABASE_PROVIDER: z.literal('postgres').optional(),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(?:ql)?:\/\//, 'DATABASE_URL must be a PostgreSQL connection URL.')
      .optional(),
  })
  .superRefine((config, context) => {
    if ((config.DATABASE_PROVIDER === undefined) !== (config.DATABASE_URL === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'DATABASE_PROVIDER and DATABASE_URL must be configured together.',
        path: ['DATABASE_PROVIDER'],
      });
    }
  });

export interface RuntimeConfig {
  readonly nodeEnv: z.infer<typeof runtimeConfigSchema>['NODE_ENV'];
  readonly port: number;
  readonly logLevel: z.infer<typeof runtimeConfigSchema>['LOG_LEVEL'];
  readonly databaseProvider?: z.infer<typeof runtimeConfigSchema>['DATABASE_PROVIDER'];
  readonly databaseUrl?: string;
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = runtimeConfigSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.DATABASE_PROVIDER === undefined
      ? {}
      : { databaseProvider: parsed.DATABASE_PROVIDER }),
    ...(parsed.DATABASE_URL === undefined ? {} : { databaseUrl: parsed.DATABASE_URL }),
  };
}
