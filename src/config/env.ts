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

  // S7: Security hardening
  API_KEYS: z.string().default(''),
  ELEVATED_API_KEYS: z.string().default(''),
  WEBHOOK_SECRET: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001,http://localhost:5173'),
  RATE_LIMIT_DEFAULT_RPM: z.coerce.number().default(100),
  RATE_LIMIT_ELEVATED_RPM: z.coerce.number().default(300),
  RATE_LIMIT_WEBHOOK_RPM: z.coerce.number().default(600),
  MAX_BODY_SIZE_BYTES: z.coerce.number().default(1_048_576),

  // S8: Email execution
  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'none']).default('none'),
  RESEND_API_KEY: z.string().default(''),
  RESEND_WEBHOOK_SECRET: z.string().default(''),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_SECURE: z.coerce.boolean().default(false),
  EMAIL_REPLY_TO: z.string().default(''),
  EMAIL_FROM_NAME: z.string().default(''),
  EMAIL_FROM_ADDRESS: z.string().default(''),
  EMAIL_TRACKING_ENABLED: z.coerce.boolean().default(true),
  // Public base URL used to build tracking pixel / click redirect URLs
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),

  // S9: WhatsApp Business Cloud API (Meta Graph API)
  WHATSAPP_API_TOKEN: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_TEMPLATE_NAME: z.string().default(''),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),
  WHATSAPP_FOLLOWUP_TEMPLATE_NAME: z.string().default(''),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_COUNTRY_CODE: z.string().default('55'),

  // S10: Campaign Engine — Smart Scheduling
  SCHEDULE_BUSINESS_HOURS_START: z.string().default('09:00'),
  SCHEDULE_BUSINESS_HOURS_END: z.string().default('18:00'),
  SCHEDULE_DAYS_OF_WEEK: z.string().default('1,2,3,4,5'),
  SCHEDULE_RESPECT_LEAD_TIMEZONE: z.coerce.boolean().default(true),
  SCHEDULE_DEFAULT_TIMEZONE: z.string().default('America/Sao_Paulo'),
  WHATSAPP_BUSINESS_HOURS_START: z.string().default('08:00'),
  WHATSAPP_BUSINESS_HOURS_END: z.string().default('20:00'),

  // S10: A/B Testing
  AB_TEST_MIN_SAMPLES: z.coerce.number().default(100),
  AB_TEST_CONFIDENCE: z.coerce.number().default(0.95),
  AB_TEST_AUTO_PROMOTE: z.coerce.boolean().default(false),

  // S10: Global Cadence Control
  GLOBAL_MAX_MESSAGES_PER_MINUTE: z.coerce.number().default(60),
  GLOBAL_MAX_MESSAGES_PER_HOUR: z.coerce.number().default(1000),
  PER_CHANNEL_MAX_PER_MINUTE: z.coerce.number().default(20),

  // S15: Security & Governance
  ANONYMIZATION_SALT: z.string().default('lookaberry-anonymization-v1'),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

/**
 * S12: Fail-fast production safety checks.
 * In production, the API must not start with empty webhook secrets or
 * an empty API key list — that would leave the service wide open.
 */
export function assertProductionSafety(): void {
  if (config.NODE_ENV !== 'production') return;

  const missing: string[] = [];
  if (!config.API_KEYS.trim()) missing.push('API_KEYS');
  if (!config.WEBHOOK_SECRET.trim()) missing.push('WEBHOOK_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `Production safety check failed — missing required env vars: ${missing.join(', ')}`,
    );
  }
}
