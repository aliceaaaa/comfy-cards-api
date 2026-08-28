import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => {
    return `  ${issue.path.join('.')}: ${issue.message}`;
  });

  console.error(`Invalid environment variables:\n${details.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;

export function getAllowedOrigins(): string[] | true {
  if (!env.WEB_ORIGIN) {
    return true;
  }

  const origins = env.WEB_ORIGIN.split(',')
    .map((origin) => {
      return origin.trim();
    })
    .filter((origin) => {
      return origin.length > 0;
    });

  if (origins.length === 0) {
    return true;
  }

  return origins;
}
