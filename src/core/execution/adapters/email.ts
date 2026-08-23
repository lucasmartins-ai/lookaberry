import type { ChannelAdapter, ExecutionContext, ExecutionResult } from '../types.js';
import type { ChannelCapability } from '../../channels/types.js';
import type { RecommendedAction } from '../../decision/types.js';
import { channelRegistry } from '../../channels/registry.js';
import { renderEmailTemplate, type RenderedEmail } from '../../email/template.js';
import { prisma } from '../../../db/client.js';
import { config } from '../../../config/env.js';

const SUPPORTED_CAPABILITIES: ChannelCapability[] = ['sendMessage', 'followUp', 'verifyDelivery'];

const RESEND_API_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 15_000;
const STUB_ERROR = 'Email channel NOT_IMPLEMENTED — no EMAIL_PROVIDER configured.';

/** Error raised by provider calls, optionally carrying the HTTP status code */
export class EmailProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EmailProviderError';
    this.status = status;
  }
}

export interface SmtpLikeTransport {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>;
  close?(): Promise<void>;
}

export interface EmailAdapterDependencies {
  /** Injectable fetch (tests) */
  fetchImpl?: typeof fetch;
  /** Injectable nodemailer transport factory (tests) */
  createTransport?: (opts: Record<string, unknown>) => SmtpLikeTransport;
  /** Best-effort hook to flag a lead's email INVALID after a hard bounce (tests) */
  markLeadEmailInvalid?: (leadId: string) => Promise<void>;
  /** Look up the provider email id stored on the message record (tests) */
  findExternalEmailId?: (messageId: string) => Promise<string | null>;
}

function parseBool(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

function env(key: keyof typeof config): string | boolean | number | undefined {
  return process.env[key] ?? config[key];
}

export class EmailAdapter implements ChannelAdapter {
  readonly channelId = 'email' as const;

  private readonly fetchImpl: typeof fetch;
  private readonly createTransport: EmailAdapterDependencies['createTransport'];
  private readonly markLeadEmailInvalidFn: (leadId: string) => Promise<void>;
  private readonly findExternalEmailIdFn: (messageId: string) => Promise<string | null>;

  constructor(deps: EmailAdapterDependencies = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.createTransport = deps.createTransport;
    this.markLeadEmailInvalidFn = deps.markLeadEmailInvalid ?? this.markLeadEmailInvalidDefault;
    this.findExternalEmailIdFn = deps.findExternalEmailId ?? this.findExternalEmailIdDefault;
  }

  canHandle(capability: ChannelCapability): boolean {
    return SUPPORTED_CAPABILITIES.includes(capability);
  }

  /** Resolve the configured provider; anything other than resend/smtp falls back to the stub */
  private getProvider(): 'resend' | 'smtp' | 'none' {
    const raw = env('EMAIL_PROVIDER');
    if (raw === 'resend' || raw === 'smtp') return raw;
    if (raw && raw !== 'none') {
      console.warn(`[EmailAdapter] Unknown EMAIL_PROVIDER "${raw}" — falling back to stub behavior.`);
    }
    return 'none';
  }

  async execute(action: RecommendedAction, context: ExecutionContext): Promise<ExecutionResult> {
    if (!this.canHandle(action.capability)) {
      return {
        success: false,
        error: `Unsupported capability: ${action.capability}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    // Backward compat: no provider configured → stub behavior
    const provider = this.getProvider();
    if (provider === 'none') {
      return {
        success: false,
        error: STUB_ERROR,
        retryable: false,
        rateLimitHit: false,
      };
    }

    if (context.dryRun) {
      return {
        success: true,
        externalId: `dry-run:email:${action.capability}:${context.lead.id}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    if (!context.lead.email) {
      return {
        success: false,
        error: 'Lead has no email address — cannot send.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    try {
      switch (action.capability) {
        case 'sendMessage':
          return await this.sendEmail(context, false, provider);
        case 'followUp':
          return await this.sendEmail(context, true, provider);
        case 'verifyDelivery':
          return await this.verifyDelivery(context, provider);
        default:
          return {
            success: false,
            error: `Unsupported capability: ${action.capability}`,
            retryable: false,
            rateLimitHit: false,
          };
      }
    } catch (err) {
      const result = this.classifyError(err);
      // Hard bounces: flag the lead's email so future steps skip it (best-effort)
      if (result.success === false && !result.retryable && this.isHardBounceError(err)) {
        await this.markLeadEmailInvalidFn(context.lead.id);
      }
      return result;
    }
  }

  // ─────────────────────────── sending ───────────────────────────

  private renderMessage(context: ExecutionContext, isFollowUp: boolean): RenderedEmail {
    const subject = isFollowUp ? `Re: ${context.message.subject ?? ''}` : (context.message.subject ?? '');
    const variables: Record<string, string> = {
      firstName: context.lead.firstName,
      companyName: context.company.name,
      senderName: String(env('EMAIL_FROM_NAME') ?? ''),
    };
    const template = subject
      ? `Subject: ${subject}\n\n${context.message.body}`
      : context.message.body;

    return renderEmailTemplate(template, variables, {
      trackingEnabled: parseBool(env('EMAIL_TRACKING_ENABLED') as string | boolean),
      messageId: context.message.id,
      baseUrl: String(env('PUBLIC_BASE_URL') ?? 'http://localhost:3000'),
    });
  }

  private async sendEmail(
    context: ExecutionContext,
    isFollowUp: boolean,
    provider: 'resend' | 'smtp',
  ): Promise<ExecutionResult> {
    const rendered = this.renderMessage(context, isFollowUp);
    const to = context.lead.email as string;
    const fromName = String(env('EMAIL_FROM_NAME') ?? '');
    const fromAddress = String(env('EMAIL_FROM_ADDRESS') ?? '');
    const replyTo = String(env('EMAIL_REPLY_TO') ?? '');
    const from = fromName ? `"${fromName.replace(/"/g, '\\"')}" <${fromAddress}>` : fromAddress;

    const externalId = provider === 'resend'
      ? await this.sendViaResend(context, to, from, replyTo, rendered)
      : await this.sendViaSmtp(context, to, from, replyTo, rendered);

    return { success: true, externalId, retryable: false, rateLimitHit: false };
  }

  private async sendViaResend(
    context: ExecutionContext,
    to: string,
    from: string,
    replyTo: string,
    rendered: RenderedEmail,
  ): Promise<string> {
    const apiKey = String(env('RESEND_API_KEY') ?? '');
    if (!apiKey) throw new EmailProviderError('RESEND_API_KEY is not configured — cannot send via Resend.');
    if (!from) throw new EmailProviderError('EMAIL_FROM_ADDRESS is not configured — cannot send via Resend.');

    const payload = {
      from,
      to: [to],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      reply_to: replyTo || undefined,
      headers: { 'X-Message-ID': context.message.id },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Message-ID': context.message.id,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new EmailProviderError(`Resend request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new EmailProviderError(`Resend API error ${res.status}: ${body.slice(0, 500)}`, res.status);
    }

    const data = await res.json().catch(() => ({}));
    const emailId = typeof (data as { id?: unknown }).id === 'string' ? (data as { id: string }).id : undefined;
    if (!emailId) throw new EmailProviderError('Resend API returned no email id');
    return emailId;
  }

  private async sendViaSmtp(
    context: ExecutionContext,
    to: string,
    from: string,
    replyTo: string,
    rendered: RenderedEmail,
  ): Promise<string> {
    const host = String(env('SMTP_HOST') ?? '');
    if (!host) throw new EmailProviderError('SMTP_HOST is not configured — cannot send via SMTP.');
    if (!from) throw new EmailProviderError('EMAIL_FROM_ADDRESS is not configured — cannot send via SMTP.');

    const port = Number(env('SMTP_PORT') ?? 587);
    const user = String(env('SMTP_USER') ?? '');
    const pass = String(env('SMTP_PASS') ?? '');
    const secure = parseBool(env('SMTP_SECURE') as string | boolean);

    const nodemailer = await import('nodemailer');
    const transport = (this.createTransport ?? nodemailer.createTransport.bind(nodemailer))({
      host,
      port,
      secure,
      ...(user ? { auth: { user, pass } } : {}),
      timeout: REQUEST_TIMEOUT_MS,
    }) as SmtpLikeTransport;

    try {
      const info = await transport.sendMail({
        from,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(replyTo ? { replyTo } : {}),
        headers: { 'X-Message-ID': context.message.id },
      });
      return info.messageId ?? `smtp:${context.message.id}`;
    } finally {
      if (typeof transport.close === 'function') {
        await transport.close().catch(() => {});
      }
    }
  }

  // ─────────────────────────── delivery verification ───────────────────────────

  private async verifyDelivery(
    context: ExecutionContext,
    provider: 'resend' | 'smtp',
  ): Promise<ExecutionResult> {
    if (provider === 'smtp') {
      // SMTP has no real delivery tracking — the server already accepted at send time
      return { success: true, externalId: context.message.id, retryable: false, rateLimitHit: false };
    }
    return this.verifyViaResend(context);
  }

  private async verifyViaResend(context: ExecutionContext): Promise<ExecutionResult> {
    const apiKey = String(env('RESEND_API_KEY') ?? '');
    if (!apiKey) throw new EmailProviderError('RESEND_API_KEY is not configured — cannot verify delivery via Resend.');

    const emailId = await this.findExternalEmailIdFn(context.message.id);
    if (!emailId) {
      return {
        success: false,
        error: 'No external Resend email id found for this message — cannot verify delivery.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${RESEND_API_URL}/${encodeURIComponent(emailId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new EmailProviderError(`Resend delivery check timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new EmailProviderError(`Resend API error ${res.status}: ${body.slice(0, 500)}`, res.status);
    }

    const data = (await res.json().catch(() => ({}))) as { last_event?: unknown; status?: unknown };
    const status = typeof data.last_event === 'string'
      ? data.last_event
      : typeof data.status === 'string' ? data.status : 'unknown';

    switch (status) {
      case 'delivered':
      case 'opened':
      case 'clicked':
        return { success: true, externalId: emailId, retryable: false, rateLimitHit: false };
      case 'bounced':
        return {
          success: false,
          externalId: emailId,
          error: `Email bounced (status: ${status})`,
          retryable: false,
          rateLimitHit: false,
        };
      case 'complained':
        return {
          success: false,
          externalId: emailId,
          error: `SPAM complaint (status: ${status})`,
          retryable: false,
          rateLimitHit: false,
        };
      case 'scheduled':
      case 'queued':
      case 'pending':
        return {
          success: false,
          externalId: emailId,
          error: `Email still in transit (status: ${status})`,
          retryable: true,
          rateLimitHit: false,
        };
      default:
        return {
          success: false,
          externalId: emailId,
          error: `Unknown delivery status: ${status}`,
          retryable: true,
          rateLimitHit: false,
        };
    }
  }

  // ─────────────────────────── error classification ───────────────────────────

  private isHardBounceError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    return (
      lower.includes('550') ||
      lower.includes('address rejected') ||
      lower.includes('invalid email') ||
      lower.includes('no such user') ||
      lower.includes('no such recipient') ||
      lower.includes('does not exist') ||
      lower.includes('mailbox unavailable') ||
      lower.includes('recipient rejected')
    );
  }

  private classifyError(err: unknown): ExecutionResult {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const status = err instanceof EmailProviderError ? err.status : undefined;

    // Rate limit (429)
    if (status === 429 || msg.includes('429') || lower.includes('rate limit')) {
      const profile = channelRegistry.getProfile('email');
      const pauseMs = profile?.safetyPauseMs ?? 24 * 60 * 60 * 1_000;
      return {
        success: false,
        error: msg,
        retryable: true,
        rateLimitHit: true,
        channelPausedUntil: new Date(Date.now() + pauseMs),
      };
    }

    // Hard bounce — invalid / permanently rejected recipient
    if (this.isHardBounceError(err)) {
      return { success: false, error: msg, retryable: false, rateLimitHit: false };
    }

    // Soft bounce — mailbox full, temporary rejection
    if (
      lower.includes('mailbox full') ||
      lower.includes('quota exceeded') ||
      lower.includes('421') ||
      lower.includes('450') ||
      lower.includes('451') ||
      lower.includes('try again later') ||
      lower.includes('temporary')
    ) {
      return { success: false, error: msg, retryable: true, rateLimitHit: false };
    }

    // SPAM complaint
    if (lower.includes('complaint') || lower.includes('spam')) {
      return { success: false, error: msg, retryable: false, rateLimitHit: false };
    }

    // Auth / configuration errors (invalid credentials, forbidden)
    if (
      status === 401 || status === 403 ||
      lower.includes('invalid login') ||
      lower.includes('authentication failed') ||
      lower.includes('535') ||
      lower.includes('credentials') ||
      lower.includes('not configured')
    ) {
      return { success: false, error: msg, retryable: false, rateLimitHit: false };
    }

    // Provider API validation errors (4xx) — retryable unless clearly permanent
    if (status !== undefined && status >= 400 && status < 500) {
      return { success: false, error: msg, retryable: true, rateLimitHit: false };
    }

    // Network / timeout
    if (
      lower.includes('econnrefused') ||
      lower.includes('econnreset') ||
      lower.includes('etimedout') ||
      lower.includes('enotfound') ||
      lower.includes('timeout') ||
      lower.includes('fetch failed') ||
      lower.includes('network') ||
      lower.includes('socket') ||
      lower.includes('eai_again')
    ) {
      return { success: false, error: msg, retryable: true, rateLimitHit: false };
    }

    // Default: retryable
    return { success: false, error: msg, retryable: true, rateLimitHit: false };
  }

  // ─────────────────────────── DB hooks (best-effort) ───────────────────────────

  private async markLeadEmailInvalidDefault(leadId: string): Promise<void> {
    try {
      await prisma.lead.update({
        where: { id: leadId },
        data: { emailStatus: 'INVALID' },
      });
      console.warn(`[EmailAdapter] Marked lead ${leadId} email as INVALID after hard bounce.`);
    } catch (err) {
      console.warn(
        `[EmailAdapter] Could not mark lead ${leadId} email INVALID: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async findExternalEmailIdDefault(messageId: string): Promise<string | null> {
    try {
      const message = await prisma.outreachMessage.findUnique({
        where: { id: messageId },
        select: { externalMessageId: true },
      });
      return message?.externalMessageId ?? null;
    } catch {
      return null;
    }
  }
}
