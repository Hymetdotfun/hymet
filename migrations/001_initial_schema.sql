-- PostgreSQL baseline schema for HYMET reservations, verified launches, and fee indexes.

CREATE TABLE creators (
  wallet_address text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creators_wallet_nonempty CHECK (length(wallet_address) BETWEEN 32 AND 64)
);

CREATE TABLE launch_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_wallet text NOT NULL REFERENCES creators(wallet_address),
  name text NOT NULL,
  ticker text NOT NULL,
  name_key text NOT NULL,
  ticker_key text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','submitted','confirmed','failed','expired')),
  idempotency_key text NOT NULL UNIQUE,
  transaction_signature text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_reason text
);
CREATE UNIQUE INDEX launch_reservations_active_name_key ON launch_reservations(name_key) WHERE status IN ('reserved','submitted','confirmed');
CREATE UNIQUE INDEX launch_reservations_active_ticker_key ON launch_reservations(ticker_key) WHERE status IN ('reserved','submitted','confirmed');
CREATE INDEX launch_reservations_expiry ON launch_reservations(expires_at) WHERE status = 'reserved';

CREATE TABLE tokens (
  mint_address text PRIMARY KEY,
  reservation_id uuid NOT NULL UNIQUE REFERENCES launch_reservations(id),
  creator_wallet text NOT NULL REFERENCES creators(wallet_address),
  name text NOT NULL,
  ticker text NOT NULL,
  name_key text NOT NULL UNIQUE,
  ticker_key text NOT NULL UNIQUE,
  description text NOT NULL,
  metadata_uri text NOT NULL,
  artwork_uri text NOT NULL,
  quote_mint text NOT NULL,
  decimals smallint NOT NULL DEFAULT 9 CHECK (decimals = 9),
  supply numeric(30,0) NOT NULL DEFAULT 1000000000000000000 CHECK (supply = 1000000000000000000),
  trading_fee_bps integer NOT NULL CHECK (trading_fee_bps BETWEEN 0 AND 300),
  creator_share_of_remaining_bps integer NOT NULL CHECK (creator_share_of_remaining_bps BETWEEN 0 AND 10000),
  holder_share_of_remaining_bps integer NOT NULL CHECK (holder_share_of_remaining_bps BETWEEN 0 AND 10000),
  status text NOT NULL CHECK (status IN ('bonding','graduating','graduated','failed')),
  launch_signature text NOT NULL UNIQUE,
  confirmed_slot bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (creator_share_of_remaining_bps + holder_share_of_remaining_bps = 10000)
);
CREATE INDEX tokens_created_at_idx ON tokens(created_at DESC);
CREATE INDEX tokens_creator_idx ON tokens(creator_wallet,created_at DESC);

CREATE TABLE pools (
  pool_address text PRIMARY KEY,
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  protocol text NOT NULL CHECK (protocol IN ('meteora_dbc','meteora_damm_v2')),
  quote_mint text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','migrated','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mint_address,protocol)
);
CREATE INDEX pools_mint_idx ON pools(mint_address);

CREATE TABLE trading_events (
  signature text PRIMARY KEY,
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  pool_address text NOT NULL REFERENCES pools(pool_address),
  slot bigint NOT NULL,
  block_time timestamptz,
  side text NOT NULL CHECK (side IN ('buy','sell','migration')),
  wallet_address text,
  base_amount numeric(40,0),
  quote_amount numeric(40,0),
  quote_mint text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trading_events_mint_time_idx ON trading_events(mint_address,block_time DESC);
CREATE INDEX trading_events_slot_idx ON trading_events(slot DESC);

CREATE TABLE fee_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  source_signature text NOT NULL,
  source text NOT NULL CHECK (source IN ('dbc_creator_fee','damm_partner_fee','damm_creator_fee')),
  gross_amount numeric(40,0) NOT NULL CHECK (gross_amount >= 0),
  protocol_cost numeric(40,0) NOT NULL DEFAULT 0 CHECK (protocol_cost >= 0),
  distributable_amount numeric(40,0) NOT NULL CHECK (distributable_amount >= 0),
  quote_mint text NOT NULL,
  accrued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_signature,source)
);
CREATE INDEX fee_accruals_mint_time_idx ON fee_accruals(mint_address,accrued_at DESC);

CREATE TABLE fee_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  accrual_id uuid NOT NULL UNIQUE REFERENCES fee_accruals(id),
  distributable_amount numeric(40,0) NOT NULL CHECK (distributable_amount >= 0),
  hymet_amount numeric(40,0) NOT NULL CHECK (hymet_amount >= 0),
  creator_amount numeric(40,0) NOT NULL CHECK (creator_amount >= 0),
  holder_amount numeric(40,0) NOT NULL CHECK (holder_amount >= 0),
  quote_mint text NOT NULL,
  transaction_signature text NOT NULL UNIQUE,
  settled_at timestamptz NOT NULL DEFAULT now(),
  CHECK (hymet_amount + creator_amount + holder_amount = distributable_amount)
);
CREATE INDEX fee_settlements_mint_time_idx ON fee_settlements(mint_address,settled_at DESC);

CREATE TABLE holder_reward_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  wallet_address text NOT NULL,
  epoch bigint NOT NULL,
  snapshot_slot bigint NOT NULL,
  token_balance numeric(40,0) NOT NULL CHECK (token_balance >= 0),
  reward_amount numeric(40,0) NOT NULL CHECK (reward_amount >= 0),
  claimed_amount numeric(40,0) NOT NULL DEFAULT 0 CHECK (claimed_amount >= 0 AND claimed_amount <= reward_amount),
  quote_mint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mint_address,wallet_address,epoch)
);
CREATE INDEX holder_entitlements_wallet_idx ON holder_reward_entitlements(wallet_address,mint_address);

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  wallet_address text NOT NULL,
  claim_type text NOT NULL CHECK (claim_type IN ('creator','holder')),
  entitlement_id uuid REFERENCES holder_reward_entitlements(id),
  amount numeric(40,0) NOT NULL CHECK (amount > 0),
  quote_mint text NOT NULL,
  transaction_signature text NOT NULL UNIQUE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_type = 'holder' AND entitlement_id IS NOT NULL) OR claim_type = 'creator')
);
CREATE INDEX claims_wallet_idx ON claims(wallet_address,claimed_at DESC);

CREATE TABLE migration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  from_pool text NOT NULL REFERENCES pools(pool_address),
  to_pool text NOT NULL REFERENCES pools(pool_address),
  signature text NOT NULL UNIQUE,
  slot bigint NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mint_address)
);

CREATE TABLE indexer_checkpoints (
  source text PRIMARY KEY,
  last_slot bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
