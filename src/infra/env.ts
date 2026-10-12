import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  LOCALSTACK_ENDPOINT: z.string().url().default('http://localhost:4566'),
  LOCALSTACK_QUEUE_NAME: z.string().min(1).default('wagering-events'),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  POSTGRES_USER: z.string().min(1),
});

const env = envSchema.parse(process.env);
const resolvedDatabaseUrl = `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;

export { env, resolvedDatabaseUrl };
