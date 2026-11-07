-- $HYMET burn tracker. Additive: two new tables, no existing value changes.
-- token_burns holds each confirmed SPL burn instruction once (a transaction can burn more than once, so the instruction path is
-- part of the key). token_burn_checkpoints holds the last slot at which the indexed burns matched the mint's supply reduction.
CREATE TABLE IF NOT EXISTS token_burns (
  mint_address text NOT NULL,
  signature text NOT NULL,
  instruction_path text NOT NULL,
  slot bigint NOT NULL CHECK (slot >= 0),
  block_time timestamptz,
  amount_raw numeric(20,0) NOT NULL CHECK (amount_raw > 0),
  authority text NOT NULL,
  token_account text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint_address, signature, instruction_path)
);
CREATE INDEX IF NOT EXISTS token_burns_mint_slot ON token_burns (mint_address, slot DESC);
CREATE TABLE IF NOT EXISTS token_burn_checkpoints (
  mint_address text PRIMARY KEY,
  verified_slot bigint NOT NULL CHECK (verified_slot >= 0),
  supply_raw numeric(20,0) NOT NULL CHECK (supply_raw >= 0),
  burned_raw numeric(20,0) NOT NULL CHECK (burned_raw >= 0),
  verified_at timestamptz NOT NULL,
  last_attempt_at timestamptz,
  last_error text
);
