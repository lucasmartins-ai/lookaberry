/**
 * S15: Secrets Masking & Payload Sanitization
 *
 * Ensures no credentials, tokens, or sensitive data leak into:
 * - Log messages (structured and unstructured)
 * - Webhook payloads stored in DB
 * - Audit log entries
 * - Error messages returned to clients
 * - Response bodies
 *
 * Strategy:
 * - Mask known secret patterns (API keys, tokens, passwords)
 * - Redact webhook payload fields known to carry credentials
 * - Sanitize before writing to any log or persistent store
 */

// ──────────────────────────────── Patterns ────────────────────────────────

/** Key names that indicate a value should be redacted entirely */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /api[_-]?token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
  /auth/i,
  /signature/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /session[_-]?key/i,
  /cookie/i,
  /jwt/i,
  /bearer/i,
];

/** Bearer token pattern: "Bearer sk_abc123..." or "Bearer eyJhbG..." */
const BEARER_PATTERN = /Bearer\s+([A-Za-z0-9_\-./=+]+)/gi;

/** API key patterns: sk_, lb_, whsec_, sg_, etc. */
const API_KEY_PATTERNS = [
  /\b(sk_[A-Za-z0-9_\-]{16,})\b/g,
  /\b(lb_[A-Za-z0-9_\-]{16,})\b/g,
  /\b(whsec_[A-Za-z0-9_\-]{16,})\b/g,
  /\b(sg\.[A-Za-z0-9_\-.]{32,})\b/g,
  /\b(xkeysib-[A-Za-z0-9\-]{32,})\b/g,
  /\b(key-[A-Za-z0-9]{32,})\b/g,
];

// ──────────────────────────────── Core Functions ────────────────────────────────

/**
 * Check if a key name indicates a secret value.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Mask a value: if the value looks like a secret, replace with [REDACTED].
 */
export function maskValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);

  if (isSecretKey(key)) {
    return '[REDACTED]';
  }

  // Mask known API key patterns
  let masked = valueStr;
  for (const pattern of API_KEY_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (match.length <= 8) return match.slice(0, 2) + '***';
      return match.slice(0, 4) + '...' + match.slice(-4);
    });
  }

  masked = masked.replace(BEARER_PATTERN, (_full, _token) => 'Bearer [REDACTED]');

  if (valueStr !== masked) return masked;
  return value;
}

/**
 * Recursively sanitize an object, masking all secret values.
 * Mutates the input object in place for performance.
 */
export function sanitizeObject(obj: unknown, depth = 0): unknown {
  if (depth > 20) return obj; // Safety limit
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, depth + 1));
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = sanitizeObject(
        isSecretKey(key) ? '[REDACTED]' : maskValue(key, record[key]),
        depth + 1,
      );
    }
  }

  return obj;
}

/**
 * Sanitize a string (log line, error message, etc) by masking API keys and tokens.
 */
export function sanitizeText(text: string): string {
  let sanitized = text;

  // Mask known API key patterns
  for (const pattern of API_KEY_PATTERNS) {
    sanitized = sanitized.replace(pattern, (_match, p1: string) => {
      if (p1.length <= 8) return p1.slice(0, 2) + '***';
      return p1.slice(0, 4) + '...' + p1.slice(-4);
    });
  }

  // Mask bearer tokens
  sanitized = sanitized.replace(BEARER_PATTERN, 'Bearer [REDACTED]');

  return sanitized;
}

/**
 * Sanitize webhook payload before storing.
 * Known fields that might carry credentials in webhook payloads:
 * - Resend: data.email.from, data.email.to, data.email.headers
 * - Smartlead: api_key, access_token
 * - Unipile: account_id, access_token
 * - Meta WhatsApp: messaging_product, contacts, messages (but NOT PII in body)
 */
export function sanitizeWebhookPayload(payload: unknown, provider: string): unknown {
  // Clone so we don't mutate the original
  let sanitized: unknown;
  try {
    sanitized = JSON.parse(JSON.stringify(payload));
  } catch {
    return payload;
  }

  // Provider-specific redactions
  switch (provider) {
    case 'resend': {
      const p = sanitized as Record<string, unknown>;
      if (p.data && typeof p.data === 'object') {
        const data = p.data as Record<string, unknown>;
        // Keep tracking info but redact auth headers
        if (data.email && typeof data.email === 'object') {
          const email = data.email as Record<string, unknown>;
          if (email.headers) email.headers = '[REDACTED]';
        }
      }
      break;
    }
    case 'smartlead':
    case 'unipile': {
      const p = sanitized as Record<string, unknown>;
      delete p.api_key;
      delete p.access_token;
      if (p.payload && typeof p.payload === 'object') {
        const payload = p.payload as Record<string, unknown>;
        delete payload.api_key;
        delete payload.access_token;
      }
      break;
    }
  }

  return sanitizeObject(sanitized);
}

/**
 * Mask a URL to hide query parameters that might contain tokens.
 * e.g., "https://example.com?token=secret" → "https://example.com?token=[REDACTED]"
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let modified = false;

    parsed.searchParams.forEach((value, key) => {
      if (isSecretKey(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
        modified = true;
      }
    });

    return modified ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Safe JSON stringify that automatically sanitizes secret keys.
 * Use this instead of JSON.stringify for any object that might
 * contain secrets (e.g., request bodies, webhook payloads, error details).
 */
export function safeStringify(obj: unknown, space?: number): string {
  const clone = JSON.parse(JSON.stringify(obj));
  sanitizeObject(clone);
  return JSON.stringify(clone, null, space);
}

/**
 * Create a safe logger wrapper that automatically sanitizes message strings
 * and structured data before writing.
 */
export function sanitizeLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...entry };

  // Mask any secret values in the log entry
  for (const key of Object.keys(sanitized)) {
    sanitized[key] = maskValue(key, sanitized[key]);
  }

  // Sanitize HTTP headers if present
  if (sanitized.headers && typeof sanitized.headers === 'object') {
    sanitized.headers = sanitizeObject(sanitized.headers);
  }

  // Sanitize request body if present
  if (sanitized.body && typeof sanitized.body === 'string') {
    try {
      const parsed = JSON.parse(sanitized.body as string);
      sanitizeObject(parsed);
      sanitized.body = JSON.stringify(parsed);
    } catch {
      // Not JSON — leave as is but strip if it looks like a token
      sanitized.body = sanitizeText(sanitized.body as string);
    }
  }

  return sanitized;
}