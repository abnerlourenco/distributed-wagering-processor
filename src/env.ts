import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  POSTGRES_USER: z.string().min(1),
});

const resolvedDatabaseUrl = `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`;

const env = envSchema.parse(process.env)

export {env, resolvedDatabaseUrl};
