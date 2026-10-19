import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Prisma CLI operations (especially migrations) need a session-stable
    // connection. Keep DATABASE_URL pooled for the application runtime and
    // provide DIRECT_URL for migrations in hosted environments such as Neon.
    url: process.env.DIRECT_URL ?? env('DATABASE_URL'),
  },
});
