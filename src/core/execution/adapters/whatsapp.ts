import type { ChannelAdapter, ExecutionContext, ExecutionResult } from '../types.js';
import type { ChannelCapability } from '../../channels/types.js';
import type { RecommendedAction } from '../../decision/types.js';
import { channelRegistry } from '../../channels/registry.js';
import { renderSimpleTemplate } from '../../whatsapp/template.js';

const SUPPORTED_CAPABILITIES: ChannelCapability[] = [
  'sendMessage',
  'readMessages',
  'followUp',
  'verifyDelivery',
];

const STUB_ERROR = 'WhatsApp channel NOT_IMPLEMENTED — no WHATSAPP_API_TOKEN configured.';

// Meta error codes that indicate an invalid/blocked phone number
const INVALID_PHONE_CODES = new Set([131026, 131047, 133016]);

// Meta error codes for template/auth config errors
const CONFIG_ERROR_CODES = new Set([131030]);

export interface WhatsAppAdapterDependencies {
  /** Injectable fetch (tests) */
  fetchImpl?: typeof fetch;
  /** Best-effort hook to flag a lead's phone INVALID after a permanent failure (tests) */
  markLeadPhoneInvalid?: (leadId: string) => Promise<void>;
  /** Look up the wamid stored on the message record (tests) */
  findExternalWamid?: (messageId: string) => Promise<string | null>;
}

/**
 * Send a message via WhatsApp Business Cloud API (Meta Graph API).
 *
 * Required env vars (see src/config/env.ts):
 * - WHATSAPP_API_TOKEN       — System User token (Bearer)
 * - WHATSAPP_PHONE_NUMBER_ID — Business phone number ID
 * - WHATSAPP_API_VERSION     — e.g. v21.0
 * - WHATSAPP_TEMPLATE_NAME   — Approved message template name
 * - WHATSAPP_TEMPLATE_LANGUAGE — Template language (default: en)
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelId = 'whatsapp' as const;

  private readonly fetchImpl: typeof fetch;
  private readonly markLeadPhoneInvalidFn: (leadId: string) => Promise<void>;
  private readonly findExternalWamidFn: (messageId: string) => Promise<string | null>;

  constructor(deps: WhatsAppAdapterDependencies = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.markLeadPhoneInvalidFn = deps.markLeadPhoneInvalid ?? this.markLeadPhoneInvalidDefault;
    this.findExternalWamidFn = deps.findExternalWamid ?? this.findExternalWamidDefault;
  }

  canHandle(capability: ChannelCapability): boolean {
    return SUPPORTED_CAPABILITIES.includes(capability);
  }

  private getConfig() {
    return {
      apiToken: process.env.WHATSAPP_API_TOKEN ?? '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
      apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
      templateName: process.env.WHATSAPP_TEMPLATE_NAME ?? '',
      templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en',
      followupTemplateName: process.env.WHATSAPP_FOLLOWUP_TEMPLATE_NAME ?? '',
      countryCode: process.env.WHATSAPP_COUNTRY_CODE ?? '55',
    };
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

    const cfg = this.getConfig();

    // Backward compat: no API token → stub behavior
    if (!cfg.apiToken) {
      console.warn('[WhatsAppAdapter] WHATSAPP_API_TOKEN not configured — using stub behavior.');
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
        externalId: `dry-run:whatsapp:${action.capability}:${context.lead.id}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    try {
      switch (action.capability) {
        case 'sendMessage':
          return await this.sendMessage(context, false, cfg);
        case 'followUp':
          return await this.sendMessage(context, true, cfg);
        case 'readMessages':
          return await this.readMessages();
        case 'verifyDelivery':
          return await this.verifyDelivery(context, cfg);
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
      // Invalid phone number → mark lead (best-effort)
      if (!result.success && !result.retryable && this.isInvalidPhoneError(err)) {
        await this.markLeadPhoneInvalidFn(context.lead.id);
      }
      return result;
    }
  }

  // ─────────────────────────── sending ───────────────────────────

  private normalizePhone(phone: string | null, countryCode: string): string | null {
    if (!phone) return null;
    const trimmed = phone.trim();
    // Already E.164
    if (trimmed.startsWith('+')) return trimmed;
    // Just digits — prepend country code default
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return null;
    return `+${countryCode}${digits}`;
  }

  private renderBody(body: string, context: ExecutionContext): string {
    return renderSimpleTemplate(body, {
      firstName: context.lead.firstName,
      companyName: context.company.name,
    });
  }

  private async sendMessage(
    context: ExecutionContext,
    isFollowUp: boolean,
    cfg: ReturnType<WhatsAppAdapter['getConfig']>,
  ): Promise<ExecutionResult> {
    const phone = context.lead.phone;
    if (!phone) {
      return {
        success: false,
        error: 'Lead has no phone number — cannot send WhatsApp message.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    const normalizedPhone = this.normalizePhone(phone, cfg.countryCode);
    if (!normalizedPhone) {
      return {
        success: false,
        error: `Cannot normalize phone number: "${phone}"`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    // Choose template: followUp uses followup template (fallback to main)
    const templateName = isFollowUp
      ? (cfg.followupTemplateName || cfg.templateName)
      : cfg.templateName;
    if (!templateName) {
      return {
        success: false,
        error: 'No WHATSAPP_TEMPLATE_NAME configured — a Meta-approved template is required for business-initiated messages.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    const renderedBody = this.renderBody(context.message.body, context);
    const bodyParams: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: renderedBody }];

    const payload = {
      messaging_product: 'whatsapp' as const,
      to: normalizedPhone,
      type: 'template' as const,
      template: {
        name: templateName,
        language: { code: cfg.templateLanguage },
        components: [
          {
            type: 'body' as const,
            parameters: bodyParams,
          },
        ],
      },
    };

    const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const status = res.status;
      // Try to extract Meta error code from response
      let metaErrorCode: number | undefined;
      try {
        const json = JSON.parse(body);
        metaErrorCode = json?.error?.code ?? json?.error?.error_data?.details?.split('(')
          .pop()?.split(')')[0]
          ? Number(json.error.error_data.details.split('(').pop()?.split(')')[0])
          : undefined;
      } catch {}
      throw new WhatsAppProviderError(
        `WhatsApp API error ${status}: ${body.slice(0, 500)}`,
        status,
        metaErrorCode,
      );
    }

    const data = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
    };
    const wamid = data.messages?.[0]?.id;
    if (!wamid) throw new WhatsAppProviderError('WhatsApp API returned no message id');

    return { success: true, externalId: wamid, retryable: false, rateLimitHit: false };
  }

  // ─────────────────────────── readMessages (stub — replies via webhook) ───────────────────────────

  private async readMessages(): Promise<ExecutionResult> {
    // WhatsApp replies come via webhook, not polling — return empty list
    return { success: true, externalId: 'whatsapp:inbox:empty', retryable: false, rateLimitHit: false };
  }

  // ─────────────────────────── delivery verification ───────────────────────────

  private async verifyDelivery(
    context: ExecutionContext,
    cfg: ReturnType<WhatsAppAdapter['getConfig']>,
  ): Promise<ExecutionResult> {
    const wamid = await this.findExternalWamidFn(context.message.id);
    if (!wamid) {
      return {
        success: false,
        error: 'No wamid found for this message — cannot verify delivery.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    // Dry-run wamid
    if (wamid.startsWith('dry-run:')) {
      return { success: true, externalId: wamid, retryable: false, rateLimitHit: false };
    }

    const url = `https://graph.facebook.com/${cfg.apiVersion}/${wamid}?fields=status`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new WhatsAppProviderError(
        `WhatsApp API error ${res.status}: ${body.slice(0, 500)}`,
        res.status,
      );
    }

    const data = (await res.json().catch(() => ({}))) as { status?: string };
    const status = data.status ?? 'unknown';

    switch (status) {
      case 'delivered':
      case 'read':
      case 'sent':
        return { success: true, externalId: wamid, retryable: false, rateLimitHit: false };
      case 'failed':
        return {
          success: false,
          externalId: wamid,
          error: `WhatsApp message failed (status: ${status})`,
          retryable: false,
          rateLimitHit: false,
        };
      default:
        return {
          success: false,
          externalId: wamid,
          error: `Unknown WhatsApp delivery status: ${status}`,
          retryable: true,
          rateLimitHit: false,
        };
    }
  }

  // ─────────────────────────── error classification ───────────────────────────

  private isInvalidPhoneError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof WhatsAppProviderError && err.metaErrorCode !== undefined) {
      return INVALID_PHONE_CODES.has(err.metaErrorCode);
    }
    const lower = msg.toLowerCase();
    return (
      lower.includes('131026') ||
      lower.includes('131047') ||
      lower.includes('133016') ||
      lower.includes('invalid recipient') ||
      lower.includes('invalid phone') ||
      lower.includes('not a valid whatsapp')
    );
  }

  private classifyError(err: unknown): ExecutionResult {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const status = err instanceof WhatsAppProviderError ? err.status : undefined;
    const metaCode = err instanceof WhatsAppProviderError ? err.metaErrorCode : undefined;

    // Rate limit (429)
    if (status === 429 || msg.includes('429') || lower.includes('rate limit')) {
      const profile = channelRegistry.getProfile('whatsapp');
      const pauseMs = profile?.safetyPauseMs ?? 24 * 60 * 60 * 1_000;
      return {
        success: false,
        error: msg,
        retryable: true,
        rateLimitHit: true,
        channelPausedUntil: new Date(Date.now() + pauseMs),
      };
    }

    // Invalid phone number (Meta error codes)
    if (this.isInvalidPhoneError(err)) {
      return { success: false, error: msg, retryable: false, rateLimitHit: false };
    }

    // Template / authentication config errors (401, 403, code 131030)
    if (
      status === 401 ||
      status === 403 ||
      (metaCode !== undefined && CONFIG_ERROR_CODES.has(metaCode)) ||
      lower.includes('authentication') ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden') ||
      lower.includes('131030')
    ) {
      return { success: false, error: msg, retryable: false, rateLimitHit: false };
    }

    // Network / timeout errors
    if (
      lower.includes('econnrefused') ||
      lower.includes('econnreset') ||
      lower.includes('etimedout') ||
      lower.includes('enotfound') ||
      lower.includes('timeout') ||
      lower.includes('fetch failed') ||
      lower.includes('network') ||
      lower.includes('abort') ||
      lower.includes('socket')
    ) {
      return { success: false, error: msg, retryable: true, rateLimitHit: false };
    }

    // Provider API errors (4xx) — could be config or transient
    if (status !== undefined && status >= 400 && status < 500) {
      // 400 Bad Request with unknown codes are not retryable
      return { success: false, error: msg, retryable: false, rateLimitHit: false };
    }

    // Default: retryable (5xx, unknown)
    return { success: false, error: msg, retryable: true, rateLimitHit: false };
  }

  // ─────────────────────────── DB hooks (best-effort) ───────────────────────────

  private async markLeadPhoneInvalidDefault(leadId: string): Promise<void> {
    try {
      const { prisma } = await import('../../../db/client.js');
      await prisma.lead.update({
        where: { id: leadId },
        data: { phoneStatus: 'INVALID' },
      });
      console.warn(`[WhatsAppAdapter] Marked lead ${leadId} phone as INVALID.`);
    } catch (err) {
      console.warn(
        `[WhatsAppAdapter] Could not mark lead ${leadId} phone INVALID: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async findExternalWamidDefault(messageId: string): Promise<string | null> {
    try {
      const { prisma } = await import('../../../db/client.js');
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

export class WhatsAppProviderError extends Error {
  readonly status?: number;
  readonly metaErrorCode?: number;

  constructor(message: string, status?: number, metaErrorCode?: number) {
    super(message);
    this.name = 'WhatsAppProviderError';
    this.status = status;
    this.metaErrorCode = metaErrorCode;
  }
}