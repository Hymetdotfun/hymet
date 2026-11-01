-- HYMET reservation authorization and optional metadata fields.
ALTER TABLE launch_reservations
  ADD COLUMN IF NOT EXISTS authorization_signature text;
CREATE UNIQUE INDEX IF NOT EXISTS launch_reservations_auth_signature_unique
  ON launch_reservations(authorization_signature)
  WHERE authorization_signature IS NOT NULL;

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS additional_social_url text,
  ADD COLUMN IF NOT EXISTS website_url text,
  ADD COLUMN IF NOT EXISTS x_url text,
  ADD COLUMN IF NOT EXISTS telegram_url text,
  ADD COLUMN IF NOT EXISTS reservation_confirmed_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS market_snapshots (
  mint_address text PRIMARY KEY REFERENCES tokens(mint_address),
  source text NOT NULL,
  price_hype numeric(30,12),
  volume_24h_hype numeric(40,9),
  price_change_24h numeric(20,8),
  liquidity_usd numeric(30,8),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS market_snapshots_expiry_idx ON market_snapshots(expires_at);

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  source text PRIMARY KEY,
  last_slot bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
