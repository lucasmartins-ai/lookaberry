/**
 * S15 Unit Tests: TOTP Two-Factor Authentication
 *
 * Covers:
 * - TOTP code generation & verification (RFC 6238)
 * - ±1 step drift tolerance for clock skew
 * - Backup code generation, verification, and consumption
 * - Setup → Confirm lifecycle
 * - Disable via TOTP code or backup code
 * - Regenerate backup codes (requires valid TOTP)
 * - Auth middleware integration (X-TOTP header)
 * - Invalid/reused codes rejected
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

import {
  verifyTotp,
  generateTotpSecret,
  generateBackupCodes,
  verifyBackupCode,
  setupTotp,
  confirmTotp,
  disableTotp,
  regenerateBackupCodes,
  validateRequestTotp,
  base32Encode,
  base32Decode,
  encryptSecret,
  hotp,
  type TotpStore,
} from '../../src/core/security/totp.js';

// ─────────────────────────── Mock Store ───────────────────────────

function makeTotpStore(): TotpStore & { _secrets: Map<string, any>; _keys: Map<string, any> } {
  const secrets = new Map<string, any>();
  const keys = new Map<string, any>();

  return {
    _secrets: secrets,
    _keys: keys,
    totpSecret: {
      upsert: vi.fn(async (args: any) => {
        const existing = secrets.get(args.where.apiKeyId);
        const merged = { ...(existing ?? {}), ...args.create, ...args.update };
        secrets.set(args.where.apiKeyId, merged);
        return { id: merged.id ?? 'ts-1', apiKeyId: args.where.apiKeyId, enabled: merged.enabled ?? false, backupCodeCount: (merged.backupCodesHashed ?? []).length };
      }),
      findUnique: vi.fn(async (args: any) => secrets.get(args.where.apiKeyId) ?? null),
      delete: vi.fn(async (args: any) => {
        secrets.delete(args.where.apiKeyId);
        return { id: 'deleted' };
      }),
    },
    apiKey: {
      update: vi.fn(async (args: any) => {
        const key = keys.get(args.where.id) ?? {};
        Object.assign(key, args.data);
        keys.set(args.where.id, key);
        return key;
      }),
      findUnique: vi.fn(async (args: any) => keys.get(args.where.id) ?? null),
    },
  };
}

// ─────────────────────────── Primitives ───────────────────────────

describe('TOTP primitives', () => {
  it('generates a valid base32 secret', () => {
    const { secretB32 } = generateTotpSecret('test-key');
    // Must be valid base32 (only A-Z 2-7)
    expect(secretB32).toMatch(/^[A-Z2-7]+$/);
    expect(secretB32.length).toBeGreaterThanOrEqual(16);
  });

  it('generates a valid otpauth URI', () => {
    const { otpauthUri, secretB32 } = generateTotpSecret('my-key');
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUri).toContain('issuer=LookaBerry');
    expect(otpauthUri).toContain('secret=');
    expect(otpauthUri).toContain('my-key');
  });

  it('verifies a freshly generated TOTP code', () => {
    const { secretB32 } = generateTotpSecret('test');
    const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
    const code = hotp(secretB32, counter);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secretB32, code)).toBe(true);
  });

  it('accepts code from previous step (±1 drift)', () => {
    const { secretB32 } = generateTotpSecret('test');
    const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
    const previousCode = hotp(secretB32, counter - 1n);
    expect(verifyTotp(secretB32, previousCode)).toBe(true);
  });

  it('accepts code from next step (±1 drift)', () => {
    const { secretB32 } = generateTotpSecret('test');
    const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
    const nextCode = hotp(secretB32, counter + 1n);
    expect(verifyTotp(secretB32, nextCode)).toBe(true);
  });

  it('rejects code from 2 steps ago', () => {
    const { secretB32 } = generateTotpSecret('test');
    const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
    const oldCode = hotp(secretB32, counter - 2n);
    expect(verifyTotp(secretB32, oldCode)).toBe(false);
  });

  it('rejects non-numeric code', () => {
    const { secretB32 } = generateTotpSecret('test');
    expect(verifyTotp(secretB32, 'abcdef')).toBe(false);
  });

  it('rejects wrong-length code', () => {
    const { secretB32 } = generateTotpSecret('test');
    expect(verifyTotp(secretB32, '1234')).toBe(false);
    expect(verifyTotp(secretB32, '1234567')).toBe(false);
  });

  it('rejects code from a different secret', () => {
    const { secretB32: s1 } = generateTotpSecret('a');
    const { secretB32: s2 } = generateTotpSecret('b');
    const code1 = hotp(s1, BigInt(Math.floor(Date.now() / 1000 / 30)));
    expect(verifyTotp(s2, code1)).toBe(false);
  });

  it('base32 roundtrip preserves data', () => {
    const original = crypto.randomBytes(20);
    const encoded = base32Encode(original);
    const decoded = base32Decode(encoded);
    expect(decoded).toEqual(original);
  });
});

// ─────────────────────────── Backup Codes ───────────────────────────

describe('Backup codes', () => {
  it('generates 10 codes by default', () => {
    const { plain, hashed } = generateBackupCodes();
    expect(plain).toHaveLength(10);
    expect(hashed).toHaveLength(10);
    expect(plain[0]).toMatch(/^[A-F0-9]{8}$/);
  });

  it('verifies a valid backup code', () => {
    const { plain, hashed } = generateBackupCodes();
    const result = verifyBackupCode(hashed, plain[0]);
    expect(result.valid).toBe(true);
    expect(result.remaining).toHaveLength(9);
  });

  it('consumes the code on verification', () => {
    const { plain, hashed } = generateBackupCodes();
    const r1 = verifyBackupCode(hashed, plain[0]);
    expect(r1.valid).toBe(true);
    // Verify again with the remaining list — same code should fail
    const r2 = verifyBackupCode(r1.remaining, plain[0]);
    expect(r2.valid).toBe(false);
  });

  it('rejects invalid code', () => {
    const { hashed } = generateBackupCodes();
    const result = verifyBackupCode(hashed, '00000000');
    expect(result.valid).toBe(false);
    expect(result.remaining).toHaveLength(10); // Unchanged
  });

  it('is case-insensitive', () => {
    const { plain, hashed } = generateBackupCodes();
    const lower = plain[0].toLowerCase();
    const result = verifyBackupCode(hashed, lower);
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────── Lifecycle ───────────────────────────

describe('TOTP lifecycle', () => {
  let store: ReturnType<typeof makeTotpStore>;

  beforeEach(() => {
    store = makeTotpStore();
  });

  describe('setupTotp', () => {
    it('returns otpauth URI and backup codes', async () => {
      const result = await setupTotp(store, 'key-1', 'test-key');
      expect(result.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect(result.backupCodes).toHaveLength(10);
    });

    it('persists encrypted secret (not plaintext)', async () => {
      await setupTotp(store, 'key-1', 'test-key');
      const record = store._secrets.get('key-1');
      expect(record.encryptedSecret).toBeDefined();
      expect(record.encryptedSecret).not.toBe(record.secretB32);
    });

    it('sets enabled=false initially', async () => {
      await setupTotp(store, 'key-1', 'test-key');
      const record = store._secrets.get('key-1');
      expect(record.enabled).toBe(false);
    });
  });

  describe('confirmTotp', () => {
    it('enables TOTP and marks key', async () => {
      const { secretB32 } = generateTotpSecret('k');
      // Bypass setup: directly insert encrypted
      store._secrets.set('key-2', {
        apiKeyId: 'key-2',
        encryptedSecret: encryptSecret(secretB32),
        enabled: false,
        backupCodesHashed: [],
        backupCodeCount: 0,
      });

      const code = hotp(secretB32, BigInt(Math.floor(Date.now() / 1000 / 30)));
      const result = await confirmTotp(store, 'key-2', code);
      expect(result.confirmed).toBe(true);

      const record = store._secrets.get('key-2');
      expect(record.enabled).toBe(true);
      expect(store.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ requireTotp: true }),
        }),
      );
    });

    it('rejects invalid code', async () => {
      const { secretB32 } = generateTotpSecret('k');
      store._secrets.set('key-3', {
        apiKeyId: 'key-3',
        encryptedSecret: encryptSecret(secretB32),
        enabled: false,
        backupCodesHashed: [],
        backupCodeCount: 0,
      });

      const result = await confirmTotp(store, 'key-3', '000000');
      expect(result.confirmed).toBe(false);
      // Key should NOT have requireTotp set
      expect(store.apiKey.update).not.toHaveBeenCalled();
    });

    it('throws if setup not initiated', async () => {
      await expect(confirmTotp(store, 'nonexistent', '123456')).rejects.toThrow('setup not initiated');
    });
  });

  describe('disableTotp', () => {
    it('disables with valid TOTP code', async () => {
      const { secretB32 } = generateTotpSecret('k');
      store._secrets.set('key-4', {
        apiKeyId: 'key-4',
        encryptedSecret: encryptSecret(secretB32),
        enabled: true,
        backupCodesHashed: [],
        backupCodeCount: 0,
      });
      store._keys.set('key-4', { requireTotp: true });

      const code = hotp(secretB32, BigInt(Math.floor(Date.now() / 1000 / 30)));
      const result = await disableTotp(store, 'key-4', code);
      expect(result.disabled).toBe(true);
      expect(store.totpSecret.delete).toHaveBeenCalled();
    });

    it('disables with backup code', async () => {
      const { plain: backupCodes, hashed: backupCodesHashed } = generateBackupCodes();
      store._secrets.set('key-5', {
        apiKeyId: 'key-5',
        encryptedSecret: encryptSecret('AAAAAAAAAAAAAA'),
        enabled: true,
        backupCodesHashed,
        backupCodeCount: backupCodes.length,
      });

      const result = await disableTotp(store, 'key-5', backupCodes[0]);
      expect(result.disabled).toBe(true);
    });

    it('rejects invalid code', async () => {
      store._secrets.set('key-6', {
        apiKeyId: 'key-6',
        encryptedSecret: encryptSecret('AAAAAAAAAAAAAA'),
        enabled: true,
        backupCodesHashed: [],
        backupCodeCount: 0,
      });

      const result = await disableTotp(store, 'key-6', '000000');
      expect(result.disabled).toBe(false);
      expect(result.reason).toContain('Invalid');
    });

    it('rejects when not enabled', async () => {
      const result = await disableTotp(store, 'no-key');
      expect(result.disabled).toBe(false);
      expect(result.reason).toContain('not enabled');
    });
  });

  describe('regenerateBackupCodes', () => {
    it('regenerates with valid TOTP', async () => {
      const { secretB32 } = generateTotpSecret('k');
      store._secrets.set('key-7', {
        apiKeyId: 'key-7',
        encryptedSecret: encryptSecret(secretB32),
        enabled: true,
        backupCodesHashed: ['old-hash'],
        backupCodeCount: 1,
      });

      const code = hotp(secretB32, BigInt(Math.floor(Date.now() / 1000 / 30)));
      const result = await regenerateBackupCodes(store, 'key-7', code);
      expect(result.success).toBe(true);
      expect(result.backupCodes).toHaveLength(10);
    });

    it('rejects with invalid TOTP', async () => {
      store._secrets.set('key-8', {
        apiKeyId: 'key-8',
        encryptedSecret: encryptSecret('AAAAAAAAAAAAAA'),
        enabled: true,
        backupCodesHashed: [],
        backupCodeCount: 0,
      });

      const result = await regenerateBackupCodes(store, 'key-8', '000000');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('Invalid TOTP code');
    });
  });

  describe('validateRequestTotp (auth middleware)', () => {
    it('returns true for valid TOTP code', async () => {
      const { secretB32 } = generateTotpSecret('k');
      store._secrets.set('key-9', {
        apiKeyId: 'key-9',
        encryptedSecret: encryptSecret(secretB32),
        enabled: true,
        backupCodesHashed: [],
        backupCodeCount: 0,
      });

      const code = hotp(secretB32, BigInt(Math.floor(Date.now() / 1000 / 30)));
      const result = await validateRequestTotp(store, 'key-9', code);
      expect(result).toBe(true);
    });

    it('returns false when not enabled', async () => {
      const result = await validateRequestTotp(store, 'no-key', '123456');
      expect(result).toBe(false);
    });

    it('consumes backup code on success', async () => {
      const { plain: backupCodes, hashed: backupCodesHashed } = generateBackupCodes();
      store._secrets.set('key-10', {
        apiKeyId: 'key-10',
        encryptedSecret: encryptSecret('AAAAAAAAAAAAAA'),
        enabled: true,
        backupCodesHashed,
        backupCodeCount: backupCodes.length,
      });

      const result = await validateRequestTotp(store, 'key-10', backupCodes[0]);
      expect(result).toBe(true);

      // Backup code should be consumed
      const record = store._secrets.get('key-10');
      expect(record.backupCodesHashed).toHaveLength(9);
    });

    it('rejects consumed backup code', async () => {
      const { plain: backupCodes, hashed: backupCodesHashed } = generateBackupCodes();
      store._secrets.set('key-11', {
        apiKeyId: 'key-11',
        encryptedSecret: encryptSecret('AAAAAAAAAAAAAA'),
        enabled: true,
        backupCodesHashed,
        backupCodeCount: backupCodes.length,
      });

      // First use
      await validateRequestTotp(store, 'key-11', backupCodes[0]);
      // Reuse same code
      const result = await validateRequestTotp(store, 'key-11', backupCodes[0]);
      expect(result).toBe(false);
    });
  });
});