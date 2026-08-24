/**
 * S15: TOTP Two-Factor Authentication (RFC 6238)
 *
 * Implements time-based one-time passwords for admin API key protection.
 * Uses SHA-1 HMAC with 30-second time steps and 6-digit codes.
 *
 * Canonical data in English; user-facing messages in pt-BR.
 *
 * Lifecycle:
 *   1. Admin calls POST /api/v1/admin/totp/setup → get otpauth:// URI + secret
 *   2. User scans QR code in authenticator app
 *   3. Admin calls POST /api/v1/admin/totp/confirm with first code → enable TOTP
 *   4. From now on, admin routes require X-TOTP header
 *   5. If TOTP device lost, use backup code (one-time, one per use)
 */

import crypto from 'node:crypto';

// ──────────────────────────────── Constants ────────────────────────────────

const DIGITS = 6;
const STEP_SECONDS = 30;
const ALGORITHM = 'sha1';
const BACKUP_CODE_LENGTH = 8;
const BACKUP_CODE_COUNT = 10;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

// ──────────────────────────────── Store Interface ────────────────────────────────

export interface TotpStore {
  totpSecret: {
    upsert(args: {
      where: { apiKeyId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ id: string; apiKeyId: string; enabled: boolean; backupCodeCount: number }>;
    findUnique(args: { where: { apiKeyId: string } }): Promise<{
      id: string;
      apiKeyId: string;
      encryptedSecret: string;
      enabled: boolean;
      backupCodesHashed: string[];
      backupCodeCount: number;
    } | null>;
    delete(args: { where: { apiKeyId: string } }): Promise<{ id: string }>;
  };
  apiKey: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<{ requireTotp: boolean } | null>;
  };
}

// ──────────────────────────────── Helpers ────────────────────────────────

/** Generate 20 random bytes, encode as base32 (human-readable, RFC 4648). */
function generateBase32Secret(): string {
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

/** Encode bytes → base32 (A-Z 2-7, per RFC 4648). */
export function base32Encode(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decode base32 → Buffer. */
export function base32Decode(b32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = b32.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** HMAC-based One-Time Password per RFC 4226 + RFC 6238. */
export function hotp(secretB32: string, counter: bigint): string {
  const key = base32Decode(secretB32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(counter);
  const hmac = crypto.createHmac(ALGORITHM, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** DIGITS;
  return otp.toString().padStart(DIGITS, '0');
}

// ──────────────────────────────── Core TOTP API ────────────────────────────────

/** Compute the current and next TOTP values for a secret. */
function totpValues(secretB32: string): { current: string; previous: string; next: string } {
  const counter = BigInt(Math.floor(Date.now() / 1000 / STEP_SECONDS));
  return {
    current: hotp(secretB32, counter),
    previous: hotp(secretB32, counter - 1n),
    next: hotp(secretB32, counter + 1n),
  };
}

/**
 * Verify a TOTP code against a secret.
 * Accepts a ±1 step drift to account for clock skew.
 */
export function verifyTotp(secretB32: string, code: string): boolean {
  if (code.length !== DIGITS || !/^\d{6}$/.test(code)) return false;
  const values = totpValues(secretB32);
  return code === values.current || code === values.previous || code === values.next;
}

/**
 * Generate a new TOTP secret and return the URI for a QR code.
 */
export function generateTotpSecret(keyName: string): {
  secretB32: string;
  otpauthUri: string;
  secretPreview: string;
} {
  const issuer = process.env.TOTP_ISSUER || 'LookaBerry';
  const secretB32 = generateBase32Secret();
  const label = encodeURIComponent(`${issuer}:${keyName}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  const otpauthUri = `otpauth://totp/${label}?${params.toString()}`;
  const secretPreview = secretB32.slice(0, 8) + '…' + secretB32.slice(-4);
  return { secretB32, otpauthUri, secretPreview };
}

// ──────────────────────────────── Encryption helpers ────────────────────────────────

/** Derive an encryption key from the TOTP_ENCRYPTION_KEY env var. Fallback to a dev key. */
function getEncryptionKey(): Buffer {
  const key = process.env.TOTP_ENCRYPTION_KEY || 'lookaberry-totp-encryption-key-dev-only';
  return crypto.createHash('sha256').update(key).digest(); // 32 bytes = AES-256
}

/** Encrypt a TOTP secret before storing in the database. */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return encrypted.toString('base64');
}

/** Decrypt a TOTP secret from the database. */
function decryptSecret(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(encryptedBase64, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ──────────────────────────────── Backup Codes ────────────────────────────────

/** Generate backup codes (one-time recovery tokens). Returns plain + hashed pairs. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): {
  plain: string[];
  hashed: string[];
} {
  const plain: string[] = [];
  const hashed: string[] = [];

  for (let i = 0; i < count; i++) {
    const code = crypto
      .randomBytes(BACKUP_CODE_LENGTH / 2)
      .toString('hex')
      .slice(0, BACKUP_CODE_LENGTH)
      .toUpperCase();
    plain.push(code);
    hashed.push(crypto.createHash('sha256').update(code).digest('hex'));
  }

  return { plain, hashed };
}

/** Verify and consume a backup code. Returns true if valid (and code is consumed). */
export function verifyBackupCode(hashedCodes: string[], code: string): {
  valid: boolean;
  remaining: string[];
} {
  const normalized = code.toUpperCase().replace(/[^A-F0-9]/g, '');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const idx = hashedCodes.indexOf(hash);

  if (idx === -1) {
    return { valid: false, remaining: hashedCodes };
  }

  const remaining = [...hashedCodes];
  remaining.splice(idx, 1);
  return { valid: true, remaining };
}

// ──────────────────────────────── Store Operations ────────────────────────────────

/**
 * Set up TOTP for an API key — generates a secret and backs up codes.
 * Returns the otpauth:// URI and plaintext backup codes.
 * The TOTP is NOT yet enabled (the user must confirm).
 */
export async function setupTotp(
  store: TotpStore,
  apiKeyId: string,
  keyName: string,
): Promise<{
  otpauthUri: string;
  secretPreview: string;
  backupCodes: string[];
}> {
  const { secretB32, otpauthUri, secretPreview } = generateTotpSecret(keyName);
  const encrypted = encryptSecret(secretB32);
  const { plain: backupCodes, hashed: backupCodesHashed } = generateBackupCodes();

  await store.totpSecret.upsert({
    where: { apiKeyId },
    create: {
      apiKeyId,
      encryptedSecret: encrypted,
      enabled: false,
      backupCodesHashed,
      backupCodeCount: backupCodes.length,
    },
    update: {
      encryptedSecret: encrypted,
      enabled: false,
      backupCodesHashed,
      backupCodeCount: backupCodes.length,
    },
  });

  return { otpauthUri, secretPreview, backupCodes };
}

/**
 * Confirm TOTP setup by verifying a code from the authenticator app.
 * If valid, enables TOTP and sets requireTotp on the API key.
 */
export async function confirmTotp(
  store: TotpStore,
  apiKeyId: string,
  code: string,
): Promise<{ confirmed: boolean }> {
  const record = await store.totpSecret.findUnique({ where: { apiKeyId } });
  if (!record) throw new Error('TOTP setup not initiated for this key');

  const secretB32 = decryptSecret(record.encryptedSecret);

  if (!verifyTotp(secretB32, code)) {
    return { confirmed: false };
  }

  await store.totpSecret.upsert({
    where: { apiKeyId },
    create: {
      apiKeyId,
      encryptedSecret: record.encryptedSecret,
      enabled: true,
      backupCodesHashed: record.backupCodesHashed,
      backupCodeCount: record.backupCodeCount,
    },
    update: { enabled: true },
  });

  await store.apiKey.update({
    where: { id: apiKeyId },
    data: { requireTotp: true },
  });

  return { confirmed: true };
}

/**
 * Disable TOTP for an API key.
 * Requires either the current TOTP code OR a valid backup code.
 */
export async function disableTotp(
  store: TotpStore,
  apiKeyId: string,
  code?: string,
): Promise<{ disabled: boolean; reason?: string }> {
  const record = await store.totpSecret.findUnique({ where: { apiKeyId } });
  if (!record || !record.enabled) {
    return { disabled: false, reason: 'TOTP not enabled for this key' };
  }

  if (code) {
    const secretB32 = decryptSecret(record.encryptedSecret);

    // Try TOTP code first
    if (verifyTotp(secretB32, code)) {
      await store.totpSecret.delete({ where: { apiKeyId } });
      await store.apiKey.update({
        where: { id: apiKeyId },
        data: { requireTotp: false },
      });
      return { disabled: true };
    }

    // Try as backup code
    const backupResult = verifyBackupCode(record.backupCodesHashed, code);
    if (backupResult.valid) {
      await store.totpSecret.upsert({
        where: { apiKeyId },
        create: { apiKeyId, encryptedSecret: record.encryptedSecret, enabled: true, backupCodesHashed: backupResult.remaining, backupCodeCount: backupResult.remaining.length },
        update: { backupCodesHashed: backupResult.remaining, backupCodeCount: backupResult.remaining.length },
      });
      return { disabled: true };
    }

    return { disabled: false, reason: 'Invalid TOTP or backup code' };
  }

  // No code provided — require admin confirmation in a separate step
  return { disabled: false, reason: 'Verification code required to disable TOTP' };
}

/**
 * Regenerate backup codes for an existing TOTP setup.
 * Requires a valid TOTP code to authorize.
 */
export async function regenerateBackupCodes(
  store: TotpStore,
  apiKeyId: string,
  totpCode: string,
): Promise<{
  backupCodes: string[];
  success: boolean;
  reason?: string;
}> {
  const record = await store.totpSecret.findUnique({ where: { apiKeyId } });
  if (!record || !record.enabled) {
    return { backupCodes: [], success: false, reason: 'TOTP not enabled' };
  }

  const secretB32 = decryptSecret(record.encryptedSecret);
  if (!verifyTotp(secretB32, totpCode)) {
    return { backupCodes: [], success: false, reason: 'Invalid TOTP code' };
  }

  const { plain: backupCodes, hashed: backupCodesHashed } = generateBackupCodes();

  await store.totpSecret.upsert({
    where: { apiKeyId },
    create: { apiKeyId, encryptedSecret: record.encryptedSecret, enabled: true, backupCodesHashed, backupCodeCount: backupCodes.length },
    update: { backupCodesHashed, backupCodeCount: backupCodes.length },
  });

  return { backupCodes, success: true };
}

/**
 * Validate TOTP at request time. Called by the auth middleware for admin routes.
 * Returns true if the provided code is valid (TOTP or backup).
 * Also consumes the backup code if one was used.
 */
export async function validateRequestTotp(
  store: TotpStore,
  apiKeyId: string,
  code: string,
): Promise<boolean> {
  const record = await store.totpSecret.findUnique({ where: { apiKeyId } });
  if (!record || !record.enabled) return false;

  const secretB32 = decryptSecret(record.encryptedSecret);

  // Try TOTP first (fast, no state change)
  if (verifyTotp(secretB32, code)) return true;

  // Try backup code (consumes it on success)
  const result = verifyBackupCode(record.backupCodesHashed, code);
  if (result.valid) {
    await store.totpSecret.upsert({
      where: { apiKeyId },
      create: { apiKeyId, encryptedSecret: record.encryptedSecret, enabled: true, backupCodesHashed: result.remaining, backupCodeCount: result.remaining.length },
      update: { backupCodesHashed: result.remaining, backupCodeCount: result.remaining.length },
    });
    return true;
  }

  return false;
}

// ──────────────────────────────── Internal exports for testing ────────────────────────────────