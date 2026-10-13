-- API keys are stored as SHA-256 hex of the plain key (see hashApiKey in src/core/security/apiKeys.ts).
-- Hash any legacy plaintext keys in place. Guarded because api_keys may have been created via db push.
DO $$
BEGIN
  IF to_regclass('public.api_keys') IS NOT NULL THEN
    UPDATE api_keys
       SET key = encode(sha256(convert_to(key, 'UTF8')), 'hex')
     WHERE key !~ '^[0-9a-f]{64}$';
  END IF;
END $$;
