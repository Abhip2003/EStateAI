import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.url({ protocol: /^postgresql?$/ }),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined)),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  BCRYPT_COST: z.coerce.number().int().min(4).max(31).default(12),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1).default('15m'),
  JWT_ISSUER: z.string().min(1).default('estateai'),
  JWT_AUDIENCE: z.string().min(1).default('estateai-api'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:\n');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

const env = loadEnv();

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,
  database: Object.freeze({
    url: env.DATABASE_URL,
  }),
  redis: Object.freeze({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB,
  }),
  security: Object.freeze({
    bcryptCost: env.BCRYPT_COST,
  }),
  jwt: Object.freeze({
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  }),
  refreshToken: Object.freeze({
    ttlDays: env.REFRESH_TOKEN_TTL_DAYS,
  }),
});
