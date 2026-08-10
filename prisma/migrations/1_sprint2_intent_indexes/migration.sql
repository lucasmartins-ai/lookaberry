CREATE INDEX IF NOT EXISTS idx_intent_signals_active_expiry_weight
  ON intent_signals(is_active, expires_at, intent_weight DESC);
