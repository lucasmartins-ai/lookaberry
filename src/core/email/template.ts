/**
 * Email template rendering.
 *
 * Templates use `{{variable}}` substitution (no logic). A template may carry
 * a subject line using the convention:
 *
 *   Subject: Quick intro
 *
 *   Hi {{firstName}}! ...
 *
 * If the template has no `Subject:` line, the rendered subject is empty and the
 * whole template is treated as the body.
 *
 * Supported default variables: firstName, companyName, signalTitle,
 * personalizedBody, senderName, senderCompany. Unknown / missing variables are
 * left as their original `{{placeholder}}` token.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailTemplateOptions {
  /** Emit a 1x1 tracking pixel and rewrite links through the click redirect proxy */
  trackingEnabled?: boolean;
  /** Message ID used to build tracking URLs (open pixel / click redirect) */
  messageId?: string;
  /** Public base URL of this server, e.g. https://app.example.com */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'http://localhost:3000';
const MAX_SUBJECT_LENGTH = 100;
const UNKNOWN_MESSAGE_ID = 'unknown';

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Split "Subject: ..." + body convention out of a raw template */
function splitSubject(template: string): { subject: string; body: string } {
  const lines = template.split(/\r?\n/);
  if (lines.length > 0 && /^Subject:/i.test(lines[0].trim())) {
    const subject = lines[0].trim().replace(/^Subject:\s*/i, '');
    const body = lines.slice(1).join('\n').replace(/^\s*\r?\n/, '');
    return { subject, body };
  }
  return { subject: '', body: template };
}

/** Substitute {{var}} tokens; missing variables keep their placeholder */
function substitute(template: string, variables: Record<string, string>): string {
  return template.replace(VARIABLE_PATTERN, (match, key: string) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : match;
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Turn bare http(s) URLs into <a> links */
function linkify(value: string): string {
  return value.replace(/(https?:\/\/[^\s<>"']+)/g, url => `<a href="${url}">${url}</a>`);
}

/** Rewrite hrefs through the click-tracking redirect proxy */
function rewriteClickLinks(html: string, baseUrl: string, messageId: string): string {
  return html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (match, url: string) =>
      `href="${baseUrl}/api/v1/email/track/click/${encodeURIComponent(messageId)}?url=${encodeURIComponent(url)}"`,
  );
}

function buildHtml(
  body: string,
  opts: { trackingEnabled: boolean; baseUrl: string; messageId: string },
): string {
  let html = escapeHtml(body);
  html = linkify(html);
  if (opts.trackingEnabled) {
    html = rewriteClickLinks(html, opts.baseUrl, opts.messageId);
  }
  html = html.replace(/\r?\n/g, '<br>\n');

  const pixel = opts.trackingEnabled
    ? `<img src="${opts.baseUrl}/api/v1/email/track/open/${encodeURIComponent(opts.messageId)}" width="1" height="1" alt="" style="display:none" />`
    : '';

  return `<html><body>${html}${pixel}</body></html>`;
}

/**
 * Render an email template into subject + HTML + plain-text versions.
 *
 * @param template  Raw template, optionally starting with `Subject: <line>`.
 * @param variables Values for `{{var}}` substitution.
 * @param options   Tracking / base URL configuration.
 */
export function renderEmailTemplate(
  template: string,
  variables: Record<string, string>,
  options: EmailTemplateOptions = {},
): RenderedEmail {
  const { subject: rawSubject, body: rawBody } = splitSubject(template);

  const subject = truncate(substitute(rawSubject, variables).trim(), MAX_SUBJECT_LENGTH);
  const text = substitute(rawBody, variables).trim();

  const trackingEnabled = options.trackingEnabled ?? true;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const messageId = options.messageId ?? UNKNOWN_MESSAGE_ID;

  const html = buildHtml(text, { trackingEnabled, baseUrl, messageId });

  return { subject, html, text };
}
