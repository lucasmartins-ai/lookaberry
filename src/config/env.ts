import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://postgres:postgrespassword@127.0.0.1:5433/lookaberry?schema=public'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-3-5-haiku-latest'),
  OPENAI_API_KEY: z.string().optional().default(''),
  LOOKACRAWLER_URL: z.string().optional().default(''),
  JINA_API_KEY: z.string().optional().default(''),
  FIRECRAWL_API_KEY: z.string().optional().default(''),
  APOLLO_API_KEY: z.string().optional().default(''),
  DROPCONTACT_API_KEY: z.string().optional().default(''),
  ZEROBOUNCE_API_KEY: z.string().optional().default(''),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
